// Swing check: on-device pose estimation (MediaPipe Pose Landmarker, free, nothing uploaded),
// phase detection (address / top / impact / finish), swing metrics, advice with drills, history, and AI coaching.
import { $, $$, esc, toast, clamp, md, uid } from './util.js';
import { state, save } from './store.js';
import { askClaude, COACH_SYSTEM, hasAI } from './ai.js';

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
    const fps = end > 4 ? 24 : 30;
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

// ---------------- metrics ----------------
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const angle = (a, b, c) => { const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y }; const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1); return (Math.acos(clamp(cos, -1, 1)) * 180) / Math.PI; };

function smooth(arr, k = 2) { return arr.map((_, i) => { let s = 0, n = 0; for (let j = Math.max(0, i - k); j <= Math.min(arr.length - 1, i + k); j++) { s += arr[j]; n++; } return s / n; }); }

export function evaluate(fr, view, hand) {
  const L = hand === 'left' ? { sh: 12, el: 14, wr: 16, hip: 24, kn: 26, an: 28, tsh: 11, thip: 23, tan: 27 } : { sh: 11, el: 13, wr: 15, hip: 23, kn: 25, an: 27, tsh: 12, thip: 24, tan: 28 };
  const hands = fr.map((f) => mid(f.lm[15], f.lm[16]));
  const hy = smooth(hands.map((h) => h.y)), hx = smooth(hands.map((h) => h.x));
  const torso = (f) => d2(mid(f.lm[11], f.lm[12]), mid(f.lm[23], f.lm[24]));
  const TL = torso(fr[0]) || 100;
  // swing start: hands leave the address position
  const a0 = { x: hx[0], y: hy[0] };
  let s = fr.findIndex((_, i) => Math.hypot(hx[i] - a0.x, hy[i] - a0.y) > 0.18 * TL);
  if (s < 0) throw new Error('スイングの動きを検出できませんでした。アドレスからフィニッシュまで映る動画を使ってください');
  s = Math.max(0, s - 1);
  // impact: fastest hand speed after the hands have gone up, near address height
  const speed = hx.map((x, i) => (i ? Math.hypot(x - hx[i - 1], hy[i] - hy[i - 1]) : 0));
  let top = s;
  for (let i = s; i < fr.length; i++) { if (hy[i] < hy[top]) top = i; if (hy[i] > hy[top] + 0.6 * TL && i > top + 2) break; }
  let imp = -1, best = 0;
  for (let i = top + 1; i < fr.length; i++) { if (hy[i] > a0.y - 0.25 * TL && speed[i] + speed[i - 1] > best) { best = speed[i] + speed[i - 1]; imp = i; } if (imp > 0 && hy[i] < a0.y - 0.6 * TL) break; }
  if (imp < 0 || top <= s) throw new Error('トップとインパクトを判別できませんでした。カメラを固定して、体全体が入るように撮ってください');
  // refine impact to the frame where hands are lowest around the speed peak
  for (let i = Math.max(top + 1, imp - 3); i <= Math.min(fr.length - 1, imp + 2); i++) if (hy[i] > hy[imp]) imp = i;
  let fin = imp;
  for (let i = imp; i < fr.length; i++) if (hy[i] < hy[fin]) fin = i;
  const finEnd = Math.min(fr.length - 1, fin + 6);

  const A = fr[0].lm, T = fr[top].lm, I = fr[imp].lm, F = fr[finEnd].lm;
  const vis = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28].reduce((a, i) => a + A[i].v, 0) / 13;
  const metrics = [];
  const add = (key, name, value, unit, score, good, bad, drill) => metrics.push({ key, name, value, unit, score: Math.round(clamp(score, 0, 100)), advice: score >= 70 ? good : bad, drill: score >= 70 ? '' : drill });

  // tempo
  const back = (top - s) / (fr[1] ? 1 : 1), down = imp - top;
  const tempo = back / Math.max(1, down);
  const tb = (fr[top].t - fr[s].t), td = (fr[imp].t - fr[top].t);
  add('tempo', 'テンポ（バック:ダウン）', `${tempo.toFixed(1)} : 1`, '', 100 - Math.abs(tempo - 3) * 28,
    `プロに近い理想的なリズム（目安 3:1）。バックスイング${tb.toFixed(2)}秒・ダウン${td.toFixed(2)}秒。`,
    tempo < 3 ? `切り返しが早い（打ち急ぎ）。バックスイングをもう少しゆっくり、トップで「間」を作りましょう。` : `ダウンスイングがゆるんでいます。トップから一気に加速を。`,
    tempo < 3 ? '「イーチ・ニー・サン」でバックスイング、「シ」で打つ数え方で素振り10回' : '素振りで「ビュッ」と音がする位置を左足の前に持ってくる練習');

  const head0 = A[0], headT = T[0], headI = I[0];
  const hip0 = mid(A[23], A[24]), hipT = mid(T[23], T[24]), hipI = mid(I[23], I[24]);
  const sh0 = mid(A[11], A[12]), shI = mid(I[11], I[12]);
  const awayDir = Math.sign((A[L.tsh].x - A[L.sh].x) || 1); // direction from lead to trail side (away from target)

  if (view === 'face') {
    const sway = ((headT.x - head0.x) * awayDir) / TL;
    add('head', '頭の左右ブレ（トップ）', `${Math.round(Math.abs(sway) * 100)}%`, '', 100 - Math.max(0, Math.abs(sway) - 0.08) * 400,
      '頭の位置が安定していて、軸がブレていません。', '頭が右（後方）へ大きく動いています。ミート率が下がる原因です。',
      '頭の位置に目印（影や地面のマーク）を置き、そこから頭を動かさずにハーフスイング');
    const hipSway = ((hipT.x - hip0.x) * awayDir) / TL;
    add('hipsway', '腰のスウェー', `${Math.round(hipSway * 100)}%`, '', 100 - Math.max(0, hipSway - 0.06) * 450,
      'バックスイングで腰が流れず、回転できています。', 'バックスイングで腰が右に流れています（スウェー）。パワーが逃げ、振り遅れの原因に。',
      '右足の外側にクラブや棒を立て、腰が当たらないように回転する素振り');
    const shoulderTurn = 1 - d2(T[11], T[12]) / Math.max(1, d2(A[11], A[12]));
    add('turn', '肩の回転（目安）', `${Math.round(shoulderTurn * 100)}`, '', 40 + shoulderTurn * 140,
      '肩がしっかり回っています。', '肩の回転が浅く、手打ちになりがちです。',
      'クラブを胸の前で抱えて、左肩をあごの下まで回す体操を20回');
    const fwd = ((I[L.hip].x - A[L.hip].x) * -awayDir) / TL;
    add('shift', 'インパクトの体重移動', `${Math.round(fwd * 100)}%`, '', 55 + fwd * 300,
      'インパクトで左足側にしっかり乗れています。', 'インパクトで体重が右足に残っています（明治の大砲）。ダフリ・トップの原因に。',
      'インパクト後に右足のかかとを上げてつま先立ちになる「ステップ打ち」');
    const finBal = Math.abs(mid(F[23], F[24]).x - F[L.an].x) / TL;
    add('finish', 'フィニッシュのバランス', `${Math.round(finBal * 100)}%`, '', 100 - Math.max(0, finBal - 0.25) * 220,
      'フィニッシュで左足一本にきれいに乗れています。', 'フィニッシュで体が左足に乗り切れていません。',
      'フィニッシュの形で3秒止まる練習（毎球）');
  } else {
    const rise = (head0.y - headI.y) / TL;
    add('head', '頭の上下動（インパクト）', `${Math.round(rise * 100)}%`, '', 100 - Math.max(0, Math.abs(rise) - 0.05) * 450,
      '前傾したまま頭の高さが保たれています。', rise > 0 ? 'インパクトで頭が上がっています（伸び上がり）。トップ・シャンクの原因に。' : 'インパクトで頭が沈み込んでいます。ダフリの原因に。',
      '壁にお尻をつけてアドレスし、お尻が壁から離れないようにハーフスイング');
    const tilt0 = (Math.atan2(Math.abs(sh0.x - hip0.x), hip0.y - sh0.y) * 180) / Math.PI;
    const tiltI = (Math.atan2(Math.abs(shI.x - hipI.x), hipI.y - shI.y) * 180) / Math.PI;
    const ext = tilt0 - tiltI;
    add('spine', '前傾角の維持', `${tilt0.toFixed(0)}° → ${tiltI.toFixed(0)}°`, '', 100 - Math.max(0, ext - 4) * 7,
      '前傾角がキープできています。', `インパクトで前傾が${ext.toFixed(0)}°起き上がっています（アーリーエクステンション）。`,
      '椅子の背もたれにお尻を当てたまま打つイメージの素振り');
    const facing = Math.sign(A[0].x - mid(A[7], A[8]).x) || 1; // the golfer faces the ball
    const hipFwd = ((hipI.x - hip0.x) * facing) / TL;
    add('hipthrust', '腰の突っ込み（ボール方向）', `${Math.round(Math.abs(hipFwd) * 100)}%`, '', 100 - Math.max(0, Math.abs(hipFwd) - 0.08) * 400,
      '腰がボールに近づかず、スペースを保てています。', 'ダウンスイングで腰がボール側に出ています。手元の通り道がなくなりシャンクや右への球の原因に。',
      'お尻の後ろにクラブを立て、インパクトまでお尻を当てたままにする練習');
    add('setup', 'アドレスの前傾', `${tilt0.toFixed(0)}°`, '', 100 - Math.max(0, Math.abs(tilt0 - 38) - 7) * 6,
      'アドレスの前傾角は適正です（目安30〜45°）。', tilt0 < 30 ? '前傾が浅く、棒立ちのアドレスです。' : '前傾が深すぎます。',
      '股関節から上体を倒し、腕がだらんと真下に下がる位置で構える');
  }
  const leadArm = angle(T[L.sh], T[L.el], T[L.wr]);
  add('arm', 'トップでの左腕', `${leadArm.toFixed(0)}°`, '', 100 - Math.max(0, 160 - leadArm) * 3,
    '左腕が伸びて大きなアークが作れています。', '左ひじが曲がり、スイングアークが小さくなっています。',
    '左手1本でクラブを持ち、ひじを伸ばしたままハーフスイング');
  const knee = angle(A[L.hip], A[L.kn], A[L.an]);
  add('knee', 'アドレスのひざ', `${knee.toFixed(0)}°`, '', 100 - Math.max(0, Math.abs(knee - 158) - 10) * 5,
    'ひざの曲げ方は適正です。', knee > 170 ? 'ひざが伸びすぎています。下半身が使えません。' : 'ひざを曲げすぎています。',
    'ジャンプして着地した時の軽いひざの曲がりでアドレス');

  const score = Math.round(metrics.reduce((a, m) => a + m.score, 0) / metrics.length);
  return {
    view, hand, score, vis, metrics,
    phases: { address: fr[0], start: fr[s], top: fr[top], impact: fr[imp], finish: fr[finEnd] },
    ref: { head: { x: head0.x, y: head0.y }, headR: Math.max(10, d2(A[7], A[8]) * 0.75 || TL * 0.12), hip: hip0, sh: sh0 },
    tempo: { ratio: tempo, back: tb, down: td },
  };
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
  const prev = (state.swings || []).find((s) => s.view === r.view);
  $('#swScore').innerHTML = `<span class="v">${r.score}</span><span class="k">スイングスコア${prev ? `（前回 ${prev.score}${r.score > prev.score ? ' ↑' : r.score < prev.score ? ' ↓' : ''}）` : ''}</span><span class="t">${r.view === 'face' ? '正面' : '後方'}から · テンポ ${r.tempo.ratio.toFixed(1)}:1${r.vis < 0.6 ? ' · 体の一部が見えにくい動画のため精度が下がっています' : ''}</span>`;
  $('#swPhases').innerHTML = r.thumbs.map((x) => `<button class="phase" data-t="${x.t}"><img src="${x.img}" alt="${PHASE[x.k]}"><span>${PHASE[x.k]}</span></button>`).join('');
  const sorted = r.metrics.slice().sort((a, b) => a.score - b.score);
  $('#swMetrics').innerHTML = sorted.map((m) => `<div class="metric ${m.score >= 70 ? 'ok' : 'warn'}">
    <div class="m-head"><b>${esc(m.name)}</b><span class="m-val">${esc(m.value)}</span><span class="m-score">${m.score}</span></div>
    <div class="bar"><i style="width:${m.score}%"></i></div>
    <p>${esc(m.advice)}</p>${m.drill ? `<p class="drill"><b>ドリル</b> ${esc(m.drill)}</p>` : ''}</div>`).join('');
  $('#swAiOut').hidden = true;
}

async function saveSwing(r) {
  state.swings ??= [];
  const small = await Promise.all(r.thumbs.map((t) => shrink(t.img)));
  state.swings.unshift({ id: uid(), date: new Date().toISOString(), view: r.view, hand: r.hand, score: r.score, tempo: r.tempo, metrics: r.metrics.map(({ key, name, value, score }) => ({ key, name, value, score })), thumbs: r.thumbs.map((t, i) => ({ k: t.k, img: small[i] })) });
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
    <div><b>${s.score}</b> 点 <span class="muted">${new Date(s.date).toLocaleDateString('ja-JP')} · ${s.view === 'face' ? '正面' : '後方'} · テンポ ${s.tempo?.ratio?.toFixed(1) ?? '-'}:1</span>
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

export function swingStats() { return (state.swings || []).slice(0, 5).map((s) => ({ date: s.date.slice(0, 10), score: s.score, view: s.view, weak: s.metrics.filter((m) => m.score < 70).map((m) => m.name) })); }
