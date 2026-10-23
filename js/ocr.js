// Scorecard reader: photo of a (handwritten) scorecard → every player's strokes per hole.
// 1st choice: Claude vision (handles handwriting, OUT/IN, par-relative notation).
// Fallback without an API key: Tesseract.js on the device (works best on clear printed numbers).
import { askClaude, hasAI } from './ai.js';

const TESS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
// Subresource Integrity: the browser refuses the script if the CDN copy was altered.
// (Its worker / WASM files are fetched by the library itself and cannot carry SRI.)
const TESS_SRI = 'sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F';

async function toJpeg(file, max = 1800, mono = false) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  const g = c.getContext('2d'); g.drawImage(bmp, 0, 0, c.width, c.height);
  if (mono) {
    // grayscale + contrast stretch helps OCR on photos of paper
    const d = g.getImageData(0, 0, c.width, c.height), a = d.data;
    let lo = 255, hi = 0;
    for (let i = 0; i < a.length; i += 4) { const v = 0.3 * a[i] + 0.59 * a[i + 1] + 0.11 * a[i + 2]; a[i] = v; lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const k = 255 / Math.max(1, hi - lo);
    const W = c.width, H = c.height;
    // binarize with a local threshold (handles shadows on paper), then erase table grid lines:
    // long horizontal / vertical dark runs are lines, digits are short strokes
    const gray = new Float32Array(W * H);
    for (let p = 0, i = 0; p < W * H; p++, i += 4) gray[p] = Math.max(0, Math.min(255, (a[i] - lo) * k));
    const integ = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += gray[y * W + x]; integ[(y + 1) * (W + 1) + x + 1] = integ[y * (W + 1) + x + 1] + row; } }
    const R = Math.max(8, Math.round(Math.min(W, H) / 40));
    const ink = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - R), x1 = Math.min(W, x + R), y0 = Math.max(0, y - R), y1 = Math.min(H, y + R);
      const mean = (integ[y1 * (W + 1) + x1] - integ[y0 * (W + 1) + x1] - integ[y1 * (W + 1) + x0] + integ[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
      ink[y * W + x] = gray[y * W + x] < mean * 0.82 ? 1 : 0;
    }
    const hRun = Math.max(40, Math.round(W * 0.05)), vRun = Math.max(40, Math.round(H * 0.12));
    const erase = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) { let s = -1; for (let x = 0; x <= W; x++) { const on = x < W && ink[y * W + x]; if (on && s < 0) s = x; if (!on && s >= 0) { if (x - s >= hRun) for (let q = s; q < x; q++) erase[y * W + q] = 1; s = -1; } } }
    for (let x = 0; x < W; x++) { let s = -1; for (let y = 0; y <= H; y++) { const on = y < H && ink[y * W + x]; if (on && s < 0) s = y; if (!on && s >= 0) { if (y - s >= vRun) for (let q = s; q < y; q++) erase[q * W + x] = 1; s = -1; } } }
    for (let p = 0, i = 0; p < W * H; p++, i += 4) { const v = ink[p] && !erase[p] ? 0 : 255; a[i] = a[i + 1] = a[i + 2] = v; a[i + 3] = 255; }
    g.putImageData(d, 0, 0);
  }
  return c;
}

export async function readScorecard(file, { pars, onStatus } = {}) {
  if (hasAI()) {
    try { return await readWithClaude(file, pars, onStatus); }
    catch (e) { onStatus?.(`AIの読み取りに失敗しました（${e.message}）。端末内OCRで読み取ります…`); }
  }
  return readWithTesseract(file, onStatus);
}

async function readWithClaude(file, pars, onStatus) {
  onStatus?.('AIがスコアカードを読み取っています…');
  const c = await toJpeg(file, 2000);
  const img = c.toDataURL('image/jpeg', 0.88).split(',')[1];
  const prompt = `ゴルフのスコアカードの写真です。全プレーヤーの各ホールの打数を読み取ってください。
- 手書きの数字を丁寧に読む。読めないマスは null。
- OUT/IN/TOTAL 欄は合計なので holes に入れない。合計欄が読めたら total に入れる。
- 「0, +1, -1, △, ○」などパーとの差で書かれている場合は、パーの行（無ければ ${pars ? JSON.stringify(pars) : 'パー4'}）を使って打数に直す。
- パット数が小さく併記されていれば putts に入れる（無ければ省略）。
- 9ホールしかなければ holes の残りは null。
次のJSONだけを返してください（説明文なし）:
{"course":"コース名 or null","date":"YYYY-MM-DD or null","par":[18個 or null],"players":[{"name":"名前","holes":[18個],"putts":[18個] ,"total":数値 or null}]}`;
  const text = await askClaude({ system: 'あなたはゴルフのスコアカードを正確に読み取るOCRアシスタントです。JSONのみを出力します。', prompt, images: [img], maxTokens: 2000 });
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('読み取り結果を解釈できませんでした');
  const j = JSON.parse(m[0]);
  return normalize(j, 'ai');
}

let tessLoading = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!tessLoading) tessLoading = new Promise((res, rej) => { const s = document.createElement('script'); s.src = TESS; s.integrity = TESS_SRI; s.crossOrigin = 'anonymous'; s.onload = () => res(window.Tesseract); s.onerror = () => rej(new Error('OCRエンジンを読み込めませんでした')); document.head.appendChild(s); });
  return tessLoading;
}

export async function readWithTesseract(file, onStatus) {
  onStatus?.('端末内OCRを準備中…（初回は日本語データ約15MBをダウンロード）');
  const T = await loadTesseract();
  const c = await toJpeg(file, 2200, true);
  const progress = (label) => (m) => { if (m.status === 'recognizing text') onStatus?.(`${label} ${Math.round(m.progress * 100)}%`); };
  // numbers: the English model keeps the spaces between digits; names: the Japanese model, matched by line position
  const { data: num } = await T.recognize(c, 'eng', { logger: progress('数字を認識中…') });
  let jpnLines = [];
  try { const { data: jp } = await T.recognize(c, 'jpn', { logger: progress('名前を認識中…') }); jpnLines = jp.lines || []; } catch {}
  const nameAt = (bbox) => {
    const mid = (bbox.y0 + bbox.y1) / 2;
    const l = jpnLines.find((x) => x.bbox.y0 <= mid && x.bbox.y1 >= mid);
    return l ? l.text.normalize('NFKC').split(/\d/)[0].replace(/\s+/g, '').replace(/[|｜\[\]()（）]/g, '') : '';
  };
  const players = []; let par = null;
  for (const line of num.lines || []) {
    const raw = line.text.replace(/[|｜\[\]]/g, ' ').normalize('NFKC');
    const tokens = raw.split(/\s+/).filter(Boolean);
    const nums = tokens.filter((t) => /^\d{1,2}$/.test(t)).map(Number);
    const strokes = nums.filter((n) => n >= 1 && n <= 15);
    if (strokes.length < 8) continue;
    const latin = tokens.filter((t) => !/^[\d.,:+\-]+$/.test(t)).join(' ').replace(/\b(OUT|IN|TOTAL|HOLE|HDCP)\b/gi, '').trim();
    if (/^(par|パー)/i.test(latin) || /^(パー|PAR)/i.test(nameAt(line.bbox))) { par = strokes.slice(0, 18); continue; }
    if (/^(hole|ホール|hdcp|ハンデ|yard|ヤード)/i.test(latin)) continue;
    const jname = nameAt(line.bbox);
    const name = (jname && /[^\x00-\x7f]/.test(jname) ? jname : latin || jname).slice(0, 12);
    const totals = nums.filter((n) => n > 15);
    players.push({ name: name || `プレーヤー${players.length + 1}`, holes: strokes.slice(0, 18), total: totals.length ? Math.max(...totals) : null });
  }
  if (!players.length) throw new Error('数字の行を見つけられませんでした。明るい場所で、カード全体を正面から撮ってください（AIキーを設定すると手書きも読めます）');
  return normalize({ players, par }, 'ocr');
}

function normalize(j, source) {
  const fix18 = (a) => Array.from({ length: 18 }, (_, i) => { const v = Number(a?.[i]); return Number.isFinite(v) && v >= 1 && v <= 20 ? Math.round(v) : null; });
  const players = (j.players || []).filter((p) => p && (p.holes || []).some((x) => x)).map((p) => ({
    name: String(p.name || '').trim() || '名前なし', holes: fix18(p.holes), putts: p.putts ? fix18(p.putts).map((x) => (x && x <= 6 ? x : null)) : null,
    total: Number(p.total) || null,
  }));
  if (!players.length) throw new Error('プレーヤーのスコアが見つかりませんでした');
  // flag rows whose written total disagrees with the per-hole sum
  for (const p of players) { const s = p.holes.reduce((a, x) => a + (x || 0), 0); p.check = p.total && s && p.total !== s ? `合計欄 ${p.total} と各ホールの合計 ${s} が違います` : ''; }
  return { source, course: j.course || null, date: j.date || null, par: j.par ? fix18(j.par) : null, players };
}
