// Shot tracer: draw the ball flight over a swing video, trim, and export a new video.
import { $, toast, clamp, sleep, shareOrDownload } from './util.js';

const vid = () => $('#vid');
let cv, ctx;
let tIn = 0, tOut = 0;
let tr = { start: null, apex: null, end: null };
let armed = null; // 'start' | 'apex' | 'end'
let raf = 0, exporting = false;
const FRAME = 1 / 30;

export function initTracer() {
  cv = $('#stage'); ctx = cv.getContext('2d');
  const v = vid();
  Object.assign(v.style, { position: 'fixed', left: '-10px', top: '0', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
  v.hidden = false;
  $('#vidCapture').onchange = (e) => load(e.target.files[0]);
  $('#vidPick').onchange = (e) => load(e.target.files[0]);
  $('#vPlay').onclick = togglePlay;
  $('#vScrub').oninput = () => { const v2 = vid(); v2.pause(); v2.currentTime = (Number($('#vScrub').value) / 1000) * v2.duration; };
  $('#vBack').onclick = () => step(-1);
  $('#vFwd').onclick = () => step(1);
  $('#vSpeed').onchange = () => (vid().playbackRate = Number($('#vSpeed').value));
  $('#vTrimIn').onclick = () => { tIn = vid().currentTime; if (tOut <= tIn) tOut = vid().duration; trimInfo(); };
  $('#vTrimOut').onclick = () => { tOut = vid().currentTime; if (tOut <= tIn) tIn = 0; trimInfo(); };
  $('#trStart').onclick = () => arm('start');
  $('#trApex').onclick = () => arm('apex');
  $('#trEnd').onclick = () => arm('end');
  $('#trReset').onclick = () => { tr = { start: null, apex: null, end: null }; arm(null); stepsUI(); draw(); };
  $('#trPreview').onclick = () => { if (!ready()) return toast('①〜③をタップして弾道を作ってください'); const v2 = vid(); v2.currentTime = Math.max(tIn, tr.start.t - 0.8); v2.play(); loop(); };
  $('#trExport').onclick = exportVideo;
  $('#trAuto').onclick = autoDetect;
  ['trColor', 'trWidth', 'ovClub', 'ovCarry'].forEach((id) => $('#' + id).addEventListener('input', draw));
  cv.addEventListener('pointerdown', onTap);
  v.addEventListener('seeked', draw);
  v.addEventListener('timeupdate', () => {
    if (!exporting && v.duration && tOut && v.currentTime >= tOut) { v.pause(); v.currentTime = tIn; }
    syncScrub();
  });
  v.addEventListener('pause', () => ($('#vPlay').textContent = '再生'));
  v.addEventListener('play', () => ($('#vPlay').textContent = '一時停止'));
}

function load(file) {
  if (!file) return;
  const v = vid();
  if (v.src) URL.revokeObjectURL(v.src);
  v.src = URL.createObjectURL(file);
  v.load();
  v.onloadedmetadata = () => {
    const s = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
    cv.width = Math.round(v.videoWidth * s); cv.height = Math.round(v.videoHeight * s);
    tIn = 0; tOut = v.duration;
    tr = { start: null, apex: null, end: null };
    $('#stageWrap').hidden = false; $('#vidControls').hidden = false;
    stepsUI(); trimInfo();
    // iOS needs a play/pause to render the first frame
    v.play().then(() => { v.pause(); v.currentTime = 0; }).catch(() => {});
    hint('インパクトのコマまで進めて「① インパクト」→ボールをタップ');
    setTimeout(draw, 300);
  };
}

function togglePlay() { const v = vid(); if (v.paused) { if (v.currentTime >= tOut - 0.05) v.currentTime = tIn; v.play(); loop(); } else v.pause(); }
function loop() { cancelAnimationFrame(raf); const f = () => { draw(); if (!vid().paused || exporting) raf = requestAnimationFrame(f); }; raf = requestAnimationFrame(f); }
function step(n) { const v = vid(); v.pause(); v.currentTime = clamp(v.currentTime + n * FRAME, 0, v.duration); }
function syncScrub() { const v = vid(); if (!v.duration) return; $('#vScrub').value = Math.round((v.currentTime / v.duration) * 1000); $('#vTime').textContent = v.currentTime.toFixed(2); }
function trimInfo() { $('#trimInfo').textContent = `書き出し範囲: ${tIn.toFixed(2)}秒 〜 ${tOut.toFixed(2)}秒（${(tOut - tIn).toFixed(1)}秒）`; }
function hint(t) { $('#stageHint').textContent = t || ''; }
const ready = () => tr.start && tr.end;

function arm(which) {
  armed = which;
  stepsUI();
  hint({ start: 'インパクトの瞬間のボールをタップ', apex: '弾道の一番高い所をタップ', end: '落下点（または画面から消える所）のコマでタップ' }[which] || '');
}
function stepsUI() {
  const map = { start: '#trStart', apex: '#trApex', end: '#trEnd' };
  for (const [k, sel] of Object.entries(map)) {
    const li = $(sel).parentElement;
    li.classList.toggle('done', !!tr[k]);
    li.classList.toggle('arm', armed === k);
  }
}

function onTap(e) {
  if (!armed) return;
  const r = cv.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * cv.width;
  const y = ((e.clientY - r.top) / r.height) * cv.height;
  const t = vid().currentTime;
  if (armed === 'start') tr.start = { x, y, t };
  if (armed === 'apex') tr.apex = { x, y };
  if (armed === 'end') tr.end = { x, y, t };
  if (tr.start && tr.end && tr.end.t - tr.start.t < 0.3) tr.end.t = tr.start.t + 2.5;
  const next = armed === 'start' ? 'apex' : armed === 'apex' ? 'end' : null;
  arm(tr[next] ? null : next);
  if (!armed && ready()) hint('「プレビュー」で確認、「動画を書き出し」で保存');
  draw();
}

// quadratic curve that passes through apex at its highest point
function curve() {
  const s = tr.start, e = tr.end;
  const a = tr.apex || { x: (s.x + e.x) / 2, y: Math.min(s.y, e.y) - cv.height * 0.35 };
  const c = { x: 2 * a.x - (s.x + e.x) / 2, y: 2 * a.y - (s.y + e.y) / 2 };
  return (u) => ({ x: (1 - u) ** 2 * s.x + 2 * (1 - u) * u * c.x + u * u * e.x, y: (1 - u) ** 2 * s.y + 2 * (1 - u) * u * c.y + u * u * e.y });
}

function draw() {
  const v = vid();
  if (!cv.width || v.readyState < 2) return;
  ctx.drawImage(v, 0, 0, cv.width, cv.height);
  const t = v.currentTime;
  // markers while editing
  if (!exporting) for (const k of ['start', 'apex', 'end']) if (tr[k]) { ctx.fillStyle = 'rgba(255,214,10,.9)'; ctx.beginPath(); ctx.arc(tr[k].x, tr[k].y, 6, 0, 7); ctx.fill(); }
  if (!ready()) return;
  const p = clamp((t - tr.start.t) / (tr.end.t - tr.start.t), 0, 1);
  if (t < tr.start.t) return;
  const prog = 1 - (1 - p) ** 1.7; // ball looks fast at first, slower far away
  const f = curve();
  const N = 80, upto = Math.max(2, Math.round(N * prog));
  const w = Number($('#trWidth').value) * (cv.width / 720);
  const color = $('#trColor').value;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const pass of [{ lw: w * 2.6, a: 0.25, blur: w * 3 }, { lw: w, a: 1, blur: w }]) {
    ctx.beginPath();
    for (let i = 0; i <= upto; i++) {
      const q = f(i / N);
      // line gets thinner as the ball flies away
      if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
    }
    ctx.strokeStyle = color; ctx.globalAlpha = pass.a; ctx.lineWidth = pass.lw; ctx.shadowColor = color; ctx.shadowBlur = pass.blur;
    ctx.stroke();
  }
  // ball head
  const head = f(upto / N);
  ctx.globalAlpha = 1; ctx.shadowBlur = w * 2; ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(head.x, head.y, w * 0.9, 0, 7); ctx.fill();
  ctx.restore();
  // overlay text
  const club = $('#ovClub').value.trim(), carry = $('#ovCarry').value.trim();
  if ((club || carry) && p > 0.6) {
    const fs = Math.round(cv.width / 22);
    ctx.save();
    ctx.globalAlpha = clamp((p - 0.6) / 0.25, 0, 1);
    ctx.font = `700 ${fs}px "Barlow Condensed", sans-serif`;
    const txt = [club, carry && `${carry} YDS`].filter(Boolean).join('  ·  ');
    const tw = ctx.measureText(txt).width;
    const x = fs * 0.8, y = cv.height - fs * 1.2;
    ctx.fillStyle = 'rgba(10,26,18,.78)'; roundRect(x - fs * 0.5, y - fs * 1.05, tw + fs, fs * 1.45, fs * 0.3); ctx.fill();
    ctx.fillStyle = '#ffd60a'; ctx.fillText(txt, x, y);
    ctx.restore();
  }
  ctx.save(); ctx.globalAlpha = 0.7; ctx.fillStyle = '#fff'; ctx.font = `600 ${Math.round(cv.width / 40)}px "Barlow Condensed", sans-serif`;
  ctx.fillText('GOLF NAVI', cv.width - cv.width / 7, cv.height - cv.width / 40); ctx.restore();
}
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

// ---------- auto detection (best effort; works best with a tripod and a sky background) ----------
async function seek(t) { const v = vid(); return new Promise((res) => { const on = () => { v.removeEventListener('seeked', on); res(); }; v.addEventListener('seeked', on); v.currentTime = t; }); }
function grab(off) { const o = off.getContext('2d', { willReadFrequently: true }); o.drawImage(vid(), 0, 0, off.width, off.height); return o.getImageData(0, 0, off.width, off.height).data; }

async function autoDetect() {
  if (!tr.start) { toast('先に「① インパクト」でボールの位置をタップしてください', 3500); return; }
  const v = vid(); v.pause();
  hint('ボールを探しています…');
  const off = document.createElement('canvas');
  const sc = 320 / cv.width; off.width = 320; off.height = Math.round(cv.height * sc);
  const W = off.width, H = off.height;
  let pos = { x: tr.start.x * sc, y: tr.start.y * sc };
  const t0 = tr.start.t;
  await seek(t0);
  let prev = grab(off);
  const track = [];
  let miss = 0, rad = 18;
  for (let k = 1; k <= 120 && miss < 6; k++) {
    const t = t0 + k * FRAME;
    if (t > v.duration) break;
    await seek(t);
    const cur = grab(off);
    let best = 0, bx = 0, by = 0;
    const x0 = Math.max(0, Math.floor(pos.x - rad)), x1 = Math.min(W - 1, Math.ceil(pos.x + rad));
    const y0 = Math.max(0, Math.floor(pos.y - rad * 1.6)), y1 = Math.min(H - 1, Math.ceil(pos.y + rad * 0.6));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = (y * W + x) * 4;
      const lum = cur[i] + cur[i + 1] + cur[i + 2];
      const diff = Math.abs(lum - (prev[i] + prev[i + 1] + prev[i + 2]));
      const score = diff * (lum > 480 ? 1.6 : 0.6);
      if (score > best) { best = score; bx = x; by = y; }
    }
    if (best > 90 && k > 2) { pos = { x: bx, y: by }; track.push({ x: bx / sc, y: by / sc, t }); miss = 0; rad = Math.max(10, rad * 0.95); }
    else { miss++; rad = Math.min(40, rad * 1.25); }
    prev = cur;
  }
  if (track.length < 5) { hint(''); toast('自動で見つけられませんでした。②③をタップで指定してください', 4000); arm('apex'); return; }
  const apex = track.reduce((m, p) => (p.y < m.y ? p : m), track[0]);
  const last = track[track.length - 1];
  tr.apex = { x: apex.x, y: apex.y };
  tr.end = { x: last.x, y: last.y, t: last.t };
  stepsUI(); arm(null);
  hint('検出しました。ずれていたら②③をタップし直してください');
  await seek(tr.start.t); draw();
}

// ---------- export ----------
async function exportVideo() {
  if (!ready()) { toast('先に弾道を作ってください'); return; }
  if (!cv.captureStream || !window.MediaRecorder) { toast('この端末は動画の書き出しに未対応です'); return; }
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const stream = cv.captureStream(30);
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6e6 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const v = vid();
  exporting = true; arm(null); hint('');
  $('#exportStatus').textContent = '書き出し中…（最後まで再生されるまで待ってください）';
  v.pause(); await seek(tIn); draw();
  rec.start(200);
  v.playbackRate = Number($('#vSpeed').value);
  await v.play();
  loop();
  await new Promise((res) => { const iv = setInterval(() => { if (v.currentTime >= tOut - 0.03 || v.ended) { clearInterval(iv); res(); } }, 30); });
  v.pause();
  await sleep(250);
  rec.stop();
  await new Promise((r) => (rec.onstop = r));
  exporting = false;
  const type = (mime || 'video/webm').split(';')[0];
  const blob = new Blob(chunks, { type });
  $('#exportStatus').textContent = `完成しました（${(blob.size / 1e6).toFixed(1)}MB）`;
  await shareOrDownload({ title: 'ショットトレーサー', text: 'Golf Navi', filename: `shot-${Date.now()}.${type.includes('mp4') ? 'mp4' : 'webm'}`, blob });
  draw();
}
