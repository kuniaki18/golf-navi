// Swing check: on-device pose estimation (MediaPipe Pose Landmarker, free, nothing uploaded),
// phase detection (address / top / impact / finish), swing metrics, advice with drills, history, and AI coaching.
import { $, $$, esc, toast, clamp, md, uid } from './util.js';
import { state, save } from './store.js';
import { askClaude, COACH_SYSTEM, hasAI } from './ai.js';
import { evaluate } from './swingeval.js';
export { evaluate };

// Version-pinned. Dynamic import() cannot carry Subresource Integrity, so this is the one CDN load without it.
const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
let landmarker = null, loading = null;
let frames = []; // [{t, lm:[{x,y,v}]}] (x,y in canvas px)
let result = null;
let cv, ctx, vid;
let raf = 0;
const EDGES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32]];

export function initSwing() {
  cv = $('#swStage'); ctx = cv.getContext('2d'); vid = $('#swVid');
  Object.assign(vid.style, { position: 'fixed', left: '-10px', top: '0', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
  vid.hidden = false;
  $('#swCapture').onchange = (e) => load(e.target.files[0]);
  $('#swPick').onchange = (e) => load(e.target.files[0]);
  $('#swPlay').onclick = () => { if (vid.paused) { vid.play(); loop(); } else vid.pause(); };
  $('#swSpeed').onchange = () => (vid.playbackRate = Number($('#swSpeed').value));
  $('#swScrub').oninput = () => { vid.pause(); vid.currentTime = (Number($('#swScrub').value) / 1000) * vid.duration; };
  $('#swAnalyze').onclick = analyze;
  $('#swAi').onclick = aiCoach;
  $('#swPhases').onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) { vid.pause(); vid.currentTime = Number(b.dataset.t); } };
  $('#swHistory').onclick = (e) => { const b = e.target.closest('[data-del]'); if (!b) return; state.swings = (state.swings || []).filter((s) => s.id !== b.dataset.del); save('swing'); renderHistory(); };
  for (const id of ['swView', 'swHand']) { $('#' + id).value = state.ui[id] || $('#' + id).value; $('#' + id).onchange = () => { state.ui[id] = $('#' + id).value; save('ui'); }; }
  vid.addEventListener('seeked', draw);
  vid.addEventListener('timeupdate', () => { if (vid.duration) { $('#swScrub').value = Math.round((vid.currentTime / vid.duration) * 1000); $('#swTime').textContent = vid.currentTime.toFixed(2); } });
  vid.addEventListener('play', () => ($('#swPlay').textContent = '一時停止'));
  vid.addEventListener('pause', () => ($('#swPlay').textContent = '再生'));
  renderHistory();
}

function load(file) {
  if (!file) return;
  if (vid.src) URL.revokeObjectURL(vid.src);
  vid.src = URL.createObjectURL(file); vid.load();
  frames = []; result = null;
  vid.onloadedmetadata = () => {
    const s = Math.min(1, 960 / Math.max(vid.videoWidth, vid.videoHeight));
    cv.width = Math.round(vid.videoWidth * s); cv.height = Math.round(vid.videoHeight * s);
    $('#swStageWrap').hidden = false; $('#swControls').hidden = false; $('#swResult').hidden = true;
    vid.play().then(() => { vid.pause(); vid.currentTime = 0; }).catch(() => {});
    setTimeout(draw, 300);
    $('#swStatus').textContent = vid.duration > 8 ? '動画が長いので、最初の8秒を解析します（スイング部分だけの動画がおすすめ）' : '「スイングを解析」を押してください';
  };
}

function loop() { cancelAnimationFrame(raf); const f = () => { draw(); if (!vid.paused) raf = requestAnimationFrame(f); }; raf = requestAnimationFrame(f); }

function nearestFrame(t) {
  if (!frames.length) return null;
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (frames[m].t < t) lo = m + 1; else hi = m; }
  const f = frames[lo]; return Math.abs(f.t - t) < 0.12 ? f : null;
}

function draw() {
  if (!cv.width || vid.readyState < 2) return;
  ctx.drawImage(vid, 0, 0, cv.width, cv.height);
  const f = nearestFrame(vid.currentTime);
  if (result?.ref) drawReference(result.ref);
  if (f) drawSkeleton(f.lm);
  if (result) {
    const ph = result.phases;
    const name = vid.currentTime <= ph.start.t ? 'アドレス' : vid.currentTime <= ph.top.t ? 'バックスイング' : vid.currentTime <= ph.impact.t + 0.03 ? 'ダウンスイング' : 'フォロー';
    label(name, 12, 26);
  }
}
function drawSkeleton(lm, color = '#30d5ff') {
  ctx.save(); ctx.lineWidth = Math.max(2, cv.width / 260); ctx.lineCap = 'round';
  for (const [a, b] of EDGES) {
    if (lm[a].v < 0.4 || lm[b].v < 0.4) continue;
    ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(lm[a].x, lm[a].y); ctx.lineTo(lm[b].x, lm[b].y); ctx.stroke();
  }
  ctx.fillStyle = '#ffd60a';
  for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) if (lm[i].v >= 0.4) { ctx.beginPath(); ctx.arc(lm[i].x, lm[i].y, Math.max(3, cv.width / 200), 0, 7); ctx.fill(); }
  ctx.restore();
}
function drawReference(ref) {
  // address head circle and spine line: shows head movement and early extension at a glance
  ctx.save(); ctx.setLineDash([6, 6]); ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.beginPath(); ctx.arc(ref.head.x, ref.head.y, ref.headR, 0, 7); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,214,10,.85)'; ctx.beginPath(); ctx.moveTo(ref.hip.x, ref.hip.y); ctx.lineTo(ref.sh.x + (ref.sh.x - ref.hip.x) * 0.4, ref.sh.y + (ref.sh.y - ref.hip.y) * 0.4); ctx.stroke();
  ctx.restore();
}
function label(text, x, y) {
  ctx.save(); ctx.font = `700 ${Math.round(cv.width / 26)}px "Zen Kaku Gothic New", sans-serif`;
  const w = ctx.measureText(text).width + 16; ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(x - 6, y - cv.width / 26, w, cv.width / 26 + 10);
  ctx.fillStyle = '#fff'; ctx.fillText(text, x + 2, y); ctx.restore();
}

// ---------------- pose estimation ----------------
async function getLandmarker() {
  if (landmarker) return landmarker;
  if (!loading) loading = (async () => {
    const vision = await import(`${MP}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${MP}/wasm`);
    const make = (delegate) => vision.PoseLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: 'VIDEO', numPoses: 1, minPoseDetectionConfidence: 0.4, minTrackingConfidence: 0.4 });
    try { landmarker = await make('GPU'); } catch { landmarker = await make('CPU'); }
    return landmarker;
  })();
  try { return await loading; } catch (e) { loading = null; throw e; }
}
const seek = (t) => new Promise((res) => { const on = () => { vid.removeEventListener('seeked', on); res(); }; vid.addEventListener('seeked', on); vid.currentTime = t; });

async function analyze() {
  if (!vid.src) { toast('先に動画を撮影するか選んでください'); return; }
  const btn = $('#swAnalyze'); btn.disabled = true;
  const status = $('#swStatus'); const bar = $('#swProgress');
  try {
    status.textContent = 'AIモデルを準備中…（初回のみ10MB程度ダウンロード）'; bar.hidden = false; bar.value = 0;
    const lmk = await getLandmarker();
    vid.pause();
    const end = Math.min(vid.duration, 8);
    const fps = 30; // fixed, so results don't depend on how long the clip is
    const n = Math.floor(end * fps);
    const off = document.createElement('canvas'); off.width = cv.width; off.height = cv.height;
    const octx = off.getContext('2d', { willReadFrequently: false });
    frames = [];
    let ts = 0;
    for (let k = 0; k < n; k++) {
      const t = k / fps;
      await seek(Math.min(t, vid.duration - 0.01));
      octx.drawImage(vid, 0, 0, off.width, off.height);
      ts += 1000 / fps;
      const r = lmk.detectForVideo(off, Math.round(ts));
      const p = r.landmarks?.[0];
      if (p) frames.push({ t, lm: p.map((q) => ({ x: q.x * cv.width, y: q.y * cv.height, v: q.visibility ?? 1 })) });
      if (k % 4 === 0) { bar.value = k / n; status.textContent = `骨格を検出中… ${Math.round((k / n) * 100)}%`; ctx.drawImage(off, 0, 0); if (p) drawSkeleton(frames[frames.length - 1].lm); }
    }
    bar.hidden = true;
    if (frames.length < 10) throw new Error('体を検出できませんでした。全身が映るように、明るい場所で撮影してください');
    result = evaluate(frames, $('#swView').value, $('#swHand').value);
    await captureThumbs(result);
    renderResult(result);
    await saveSwing(result);
    status.textContent = '解析が完了しました。再生すると骨格と基準線が表示されます';
    await seek(result.phases.start.t); draw();
  } catch (e) {
    status.textContent = e.message || '解析に失敗しました';
    bar.hidden = true;
  } finally { btn.disabled = false; }
}

async function captureThumbs(r) {
  const out = [];
  const c = document.createElement('canvas'); const w = 360; c.width = w; c.height = Math.round((cv.height / cv.width) * w);
  for (const k of ['address', 'top', 'impact', 'finish']) {
    const f = r.phases[k];
    await seek(f.t);
    ctx.drawImage(vid, 0, 0, cv.width, cv.height); drawReference(r.ref); drawSkeleton(f.lm);
    c.getContext('2d').drawImage(cv, 0, 0, c.width, c.height);
    out.push({ k, t: f.t, img: c.toDataURL('image/jpeg', 0.72) });
  }
  r.thumbs = out;
}

const PHASE = { address: 'アドレス', top: 'トップ', impact: 'インパクト', finish: 'フィニッシュ' };
function renderResult(r) {
  $('#swResult').hidden = false;
  const prev = (state.swings || []).find((x) => x.view === r.view && x.score != null);
  const diff = prev && r.score != null ? (r.score > prev.score ? ' ↑' : r.score < prev.score ? ' ↓' : '') : '';
  $('#swScore').innerHTML = `<span class="v">${r.score ?? '—'}</span><span class="k">スイングスコア（参考値）${prev && r.score != null ? `・前回 ${prev.score}${diff}` : ''}</span><span class="t">${r.view === 'face' ? '正面' : '後方'}から · テンポ ${r.tempo.ratio.toFixed(1)}:1 · 判定できた項目 ${r.validCount}/${r.metrics.length}</span>`;
  $('#swNotes').innerHTML = [
    ...r.notes.map((n) => `<li>${esc(n)}</li>`),
    '<li>点数は判定できた項目の平均です。撮影の向き・距離・明るさ・コマ数で変わる参考値で、動画だけでは球筋やスコアへの影響は判定できません。前回と比べるときは同じ条件で撮影してください。</li>',
  ].join('');
  $('#swPhases').innerHTML = r.thumbs.map((x) => `<button class="phase" data-t="${x.t}"><img src="${x.img}" alt="${PHASE[x.k]}"><span>${PHASE[x.k]}</span></button>`).join('');
  const sorted = r.metrics.slice().sort((a, b) => (a.valid === b.valid ? (a.score ?? 0) - (b.score ?? 0) : a.valid ? -1 : 1));
  $('#swMetrics').innerHTML = sorted.map((m) => `<div class="metric ${!m.valid ? 'na' : m.score >= 70 ? 'ok' : 'warn'}">
    <div class="m-head"><b>${esc(m.name)}</b><span class="m-val">${esc(m.value)}</span><span class="m-score">${m.valid ? m.score : '判定不可'}</span></div>
    ${m.valid ? `<div class="bar"><i style="width:${m.score}%"></i></div>` : ''}
    <p>${esc(m.advice)}</p>${m.drill ? `<p class="drill"><b>ドリル</b> ${esc(m.drill)}</p>` : ''}
    <details class="basis"><summary>採点の根拠</summary><p>${esc(m.basis)}</p><p class="muted">使った関節の映り具合（信頼度）：${Math.round(m.conf * 100)}%（${Math.round(0.6 * 100)}%未満は判定しません）</p></details></div>`).join('');
  $('#swAiOut').hidden = true;
}

async function saveSwing(r) {
  state.swings ??= [];
  const small = await Promise.all(r.thumbs.map((t) => shrink(t.img)));
  state.swings.unshift({ id: uid(), date: new Date().toISOString(), view: r.view, hand: r.hand, score: r.score, tempo: r.tempo, metrics: r.metrics.map(({ key, name, value, score, valid }) => ({ key, name, value, score, valid })), thumbs: r.thumbs.map((t, i) => ({ k: t.k, img: small[i] })) });
  state.swings = state.swings.slice(0, 10);
  save('swing');
  renderHistory();
}
function shrink(dataUrl) {
  // history keeps small thumbnails so local storage stays light
  return new Promise((res) => { const im = new Image(); im.onload = () => { const c = document.createElement('canvas'); c.width = 150; c.height = Math.round((im.height / im.width) * 150); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', 0.6)); }; im.onerror = () => res(''); im.src = dataUrl; });
}

function renderHistory() {
  const list = state.swings || [];
  $('#swHistory').innerHTML = list.length ? list.map((s) => `<div class="sw-h">
    <img src="${s.thumbs?.[1]?.img || ''}" alt="">
    <div><b>${s.score ?? '—'}</b> 点（参考） <span class="muted">${new Date(s.date).toLocaleDateString('ja-JP')} · ${s.view === 'face' ? '正面' : '後方'} · テンポ ${s.tempo?.ratio?.toFixed(1) ?? '-'}:1</span>
    <div class="muted">${s.metrics.filter((m) => m.score < 70).map((m) => esc(m.name)).join('・') || '課題なし'}</div></div>
    <button class="btn small" data-del="${s.id}">削除</button></div>`).join('') : '<p class="muted">解析したスイングがここに貯まり、前回との比較ができます。</p>';
}

async function aiCoach() {
  if (!result) { toast('先にスイングを解析してください'); return; }
  if (!hasAI()) { toast('設定でClaudeのAPIキーを入れるとAIコーチが使えます', 3500); return; }
  const out = $('#swAiOut'); out.hidden = false; out.innerHTML = '<p class="muted">AIコーチがスイングを見ています…</p>';
  const imgs = result.thumbs.map((t) => t.img.split(',')[1]);
  const prompt = `添付の4枚は私のゴルフスイングの「アドレス・トップ・インパクト・フィニッシュ」です（${result.view === 'face' ? '正面' : '飛球線後方'}から撮影、${result.hand === 'left' ? '左打ち' : '右打ち'}）。水色の線は骨格の自動検出、白い点線の円はアドレス時の頭の位置、黄色の点線はアドレス時の背骨の角度です。
自動計測の結果: ${JSON.stringify(result.metrics.map((m) => ({ 項目: m.name, 値: m.value, 点数: m.score })))} テンポ ${result.tempo.ratio.toFixed(1)}:1
次の形で、日本語でやさしく具体的に教えてください。
### 良いところ（2つ）
### いちばん直すべきポイント（1つに絞って、なぜそうなるか）
### 今日からできるドリル（2つ、回数つき）
### 次に撮るときのチェックポイント`;
  try {
    const text = await askClaude({ system: COACH_SYSTEM + '\nあなたはPGAティーチングプロとしてスイングを分析します。画像で確認できないことは断定しません。', prompt, images: imgs, maxTokens: 1500, onText: (t) => (out.innerHTML = md(t)) });
    out.innerHTML = md(text);
  } catch (e) { out.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

export function swingStats() { return (state.swings || []).slice(0, 5).map((s) => ({ date: s.date.slice(0, 10), score: s.score, view: s.view, weak: s.metrics.filter((m) => m.valid !== false && m.score != null && m.score < 70).map((m) => m.name) })); }
