// Swing evaluation from 2D pose landmarks (pure; unit-tested in tools/test).
// Input: frames [{ t (s), lm: [33 × {x, y, v}] }] in pixel coordinates (MediaPipe Pose indices).
// Every metric states how it was measured, its target range, how the score is derived, and how visible the
// joints it relies on were. Metrics whose joints are not clearly visible are reported as 判定不可 and are
// excluded from the total. The total is a reference value: it depends on camera angle, distance and frame
// rate, and a video alone cannot tell the ball flight or the effect on the score.
import { clamp } from './util.js';

export const MIN_VIS = 0.6;          // landmark visibility needed to judge a metric
const STILL_FRAMES = 8;              // ≈0.27 s at 30 fps
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, v: Math.min(a.v ?? 1, b.v ?? 1) });
const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const angle = (a, b, c) => { const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y }; const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1); return (Math.acos(clamp(cos, -1, 1)) * 180) / Math.PI; };
const smooth = (arr, k = 2) => arr.map((_, i) => { let s = 0, n = 0; for (let j = Math.max(0, i - k); j <= Math.min(arr.length - 1, i + k); j++) { s += arr[j]; n++; } return s / n; });
const minVis = (lm, ids) => Math.min(...ids.map((i) => lm[i]?.v ?? 0));

/** find the address: the last still moment (hands below the shoulders) before the backswing */
export function findAddress(fr, hx, hy, TL) {
  // the main swing motion = the fastest hand movement in the clip
  let peak = 1, best = 0;
  for (let i = 1; i < fr.length; i++) { const sp = Math.hypot(hx[i] - hx[i - 1], hy[i] - hy[i - 1]) / Math.max(1e-3, fr[i].t - fr[i - 1].t); if (sp > best) { best = sp; peak = i; } }
  let found = -1;
  for (let e = STILL_FRAMES - 1; e < peak; e++) {
    const s0 = e - STILL_FRAMES + 1;
    let mx = 0, my = 0;
    for (let i = s0; i <= e; i++) { mx += hx[i]; my += hy[i]; }
    mx /= STILL_FRAMES; my /= STILL_FRAMES;
    let spread = 0;
    for (let i = s0; i <= e; i++) spread = Math.max(spread, Math.hypot(hx[i] - mx, hy[i] - my));
    const shoulderY = (fr[e].lm[11].y + fr[e].lm[12].y) / 2;
    if (spread < 0.04 * TL && my > shoulderY + 0.3 * TL) found = e; // keep the latest still window before the peak
  }
  return { index: found >= 0 ? found : 0, detected: found >= 0, peak };
}

export function evaluate(fr, view, hand) {
  if (!fr || fr.length < 10) throw new Error('体を検出できたコマが少なすぎます');
  const L = hand === 'left' ? { sh: 12, el: 14, wr: 16, hip: 24, kn: 26, an: 28, tsh: 11 } : { sh: 11, el: 13, wr: 15, hip: 23, kn: 25, an: 27, tsh: 12 };
  const hands = fr.map((f) => mid(f.lm[15], f.lm[16]));
  const rawY = hands.map((h) => h.y);
  const hy = smooth(rawY), hx = smooth(hands.map((h) => h.x));
  const torso = (f) => d2(mid(f.lm[11], f.lm[12]), mid(f.lm[23], f.lm[24]));
  const TLs = fr.map(torso).filter((x) => x > 0).sort((a, b) => a - b);
  const TL = TLs[Math.floor(TLs.length / 2)] || 100; // median torso length: robust scale

  const addr = findAddress(fr, hx, hy, TL);
  const a = addr.index;
  const a0 = { x: hx[a], y: hy[a] };
  let s = fr.findIndex((_, i) => i > a && Math.hypot(hx[i] - a0.x, hy[i] - a0.y) > 0.18 * TL);
  if (s < 0) throw new Error('スイングの動きを検出できませんでした。アドレスからフィニッシュまで映る動画を使ってください');
  // walk back to where the hands actually started moving (the threshold above fires a few frames late)
  while (s > a + 1 && Math.hypot(hx[s - 1] - a0.x, hy[s - 1] - a0.y) > 0.02 * TL) s--;
  s = Math.max(a, s - 1);
  const speed = hx.map((x, i) => (i ? Math.hypot(x - hx[i - 1], hy[i] - hy[i - 1]) / Math.max(1e-3, fr[i].t - fr[i - 1].t) : 0));
  let top = s;
  for (let i = s; i < fr.length; i++) { if (hy[i] < hy[top]) top = i; if (hy[i] > hy[top] + 0.6 * TL && i > top + 2) break; }
  // refine the top on the raw hand height (smoothing shifts the turning point)
  { let t0 = top; for (let i = Math.max(s, top - 3); i <= Math.min(fr.length - 1, top + 3); i++) if (rawY[i] < rawY[t0]) t0 = i; top = t0; }
  let imp = -1, best = 0;
  // impact height uses the raw hand position: smoothing blurs the bottom of a fast downswing
  for (let i = top + 1; i < fr.length; i++) { if (rawY[i] > a0.y - 0.25 * TL && speed[i] + speed[i - 1] > best) { best = speed[i] + speed[i - 1]; imp = i; } if (imp > 0 && hy[i] < a0.y - 0.6 * TL) break; }
  if (imp < 0 || top <= s) throw new Error('トップとインパクトを判別できませんでした。カメラを固定して、体全体が入るように撮ってください');
  for (let i = Math.max(top + 1, imp - 3); i <= Math.min(fr.length - 1, imp + 2); i++) if (rawY[i] > rawY[imp]) imp = i;
  let fin = imp;
  for (let i = imp; i < fr.length; i++) if (hy[i] < hy[fin]) fin = i;
  const finEnd = Math.min(fr.length - 1, fin + 6);

  const A = fr[a].lm, T = fr[top].lm, I = fr[imp].lm, F = fr[finEnd].lm;
  const metrics = [];
  /**
   * @param need  [[landmarks, ids], ...] joints this metric relies on
   * @param basis how it is measured, the target, and how the score is derived
   */
  const add = (key, name, value, score, need, basis, good, bad, drill) => {
    const conf = Math.min(...need.map(([lm, ids]) => minVis(lm, ids)));
    const ok = conf >= MIN_VIS && Number.isFinite(score);
    metrics.push({ key, name, value, basis, conf: Math.round(conf * 100) / 100, valid: ok, score: ok ? Math.round(clamp(score, 0, 100)) : null,
      advice: !ok ? '関節がはっきり映っていないため判定できません（撮影の向き・明るさ・全身が映っているかを確認）' : score >= 70 ? good : bad, drill: ok && score < 70 ? drill : '' });
  };

  // tempo uses real time stamps, so dropped frames don't change it
  const tb = fr[top].t - fr[s].t, td = fr[imp].t - fr[top].t;
  const tempo = tb / Math.max(1 / 60, td);
  const timeRes = Math.max(...fr.slice(1).map((f, i) => f.t - fr[i].t)); // worst gap between analysed frames
  add('tempo', 'テンポ（バック:ダウン）', `${tempo.toFixed(1)} : 1`, 100 - Math.abs(tempo - 3) * 28, [[A, [15, 16]], [T, [15, 16]], [I, [15, 16]]],
    `バックスイング（始動→トップ）とダウンスイング（トップ→インパクト）の時間の比。目安3:1で満点、1ずれるごとに28点減点。コマ間隔${(timeRes * 1000).toFixed(0)}msのため、ダウンスイングの時間には±1コマの誤差があります。`,
    `理想に近いリズム（目安3:1）。バック${tb.toFixed(2)}秒・ダウン${td.toFixed(2)}秒。`,
    tempo < 3 ? '切り返しが早め（打ち急ぎの傾向）。トップで「間」を作りましょう。' : 'ダウンスイングがゆっくりめ。トップから加速を。',
    tempo < 3 ? '「イーチ・ニー・サン」でバックスイング、「シ」で打つ数え方で素振り10回' : '素振りで「ビュッ」と音がする位置を左足の前に持ってくる練習');

  const head0 = A[0], headT = T[0], headI = I[0];
  const hip0 = mid(A[23], A[24]), hipT = mid(T[23], T[24]), hipI = mid(I[23], I[24]);
  const sh0 = mid(A[11], A[12]), shI = mid(I[11], I[12]);
  const awayDir = Math.sign((A[L.tsh].x - A[L.sh].x) || 1);
  // camera-angle sanity check: shoulder width relative to the torso is large face-on, small down-the-line
  const shoulderRatio = d2(A[11], A[12]) / TL;
  const viewWarning = view === 'face' && shoulderRatio < 0.35 ? '肩幅が狭く映っています。後方（飛球線側）から撮った動画かもしれません。撮影の向きを確認してください。'
    : view === 'dtl' && shoulderRatio > 0.7 ? '肩幅が広く映っています。正面から撮った動画かもしれません。撮影の向きを確認してください。' : '';

  if (view === 'face') {
    const sway = ((headT.x - head0.x) * awayDir) / TL;
    add('head', '頭の左右ブレ（トップ）', `${Math.round(Math.abs(sway) * 100)}%`, 100 - Math.max(0, Math.abs(sway) - 0.08) * 400, [[A, [0]], [T, [0]]],
      'アドレス→トップでの鼻の左右移動 ÷ 胴の長さ。8%以内で満点、超えた分1%ごとに4点減点。', '頭の位置が安定しています。', '頭が後方へ大きく動いています。',
      '頭の位置に目印を置き、頭を動かさずにハーフスイング');
    const hipSway = ((hipT.x - hip0.x) * awayDir) / TL;
    add('hipsway', '腰のスウェー', `${Math.round(hipSway * 100)}%`, 100 - Math.max(0, hipSway - 0.06) * 450, [[A, [23, 24]], [T, [23, 24]]],
      'アドレス→トップでの腰の中心の後方移動 ÷ 胴の長さ。6%以内で満点、超えた分1%ごとに4.5点減点。', 'バックスイングで腰が流れず回転できています。', 'バックスイングで腰が後方に流れています（スウェー）。',
      '右足の外側に棒を立て、腰が当たらないように回転する素振り');
    const shoulderTurn = 1 - d2(T[11], T[12]) / Math.max(1, d2(A[11], A[12]));
    add('turn', '肩の回転（目安）', `${Math.round(shoulderTurn * 100)}`, 40 + shoulderTurn * 140, [[A, [11, 12]], [T, [11, 12]]],
      '正面から見た肩幅がトップでどれだけ狭くなるか（回転量の2Dでの目安）。狭くなるほど高得点。体の向きやカメラ位置で大きく変わる参考値。', '肩がしっかり回っています。', '肩の回転が浅めに見えます。',
      'クラブを胸の前で抱えて、左肩をあごの下まで回す体操を20回');
    const fwd = ((I[L.hip].x - A[L.hip].x) * -awayDir) / TL;
    add('shift', 'インパクトの体重移動', `${Math.round(fwd * 100)}%`, 55 + fwd * 300, [[A, [L.hip]], [I, [L.hip]]],
      'アドレス→インパクトでのリード側の腰の目標方向への移動 ÷ 胴の長さ。0%で55点、15%で100点。', 'インパクトでリード足側に乗れています。', 'インパクトで体重が後ろに残り気味です。',
      'インパクト後に後ろ足のかかとを上げる「ステップ打ち」');
    const finBal = Math.abs(mid(F[23], F[24]).x - F[L.an].x) / TL;
    add('finish', 'フィニッシュのバランス', `${Math.round(finBal * 100)}%`, 100 - Math.max(0, finBal - 0.25) * 220, [[F, [23, 24, L.an]]],
      'フィニッシュでの腰の中心とリード足首の左右のずれ ÷ 胴の長さ。25%以内で満点。', 'フィニッシュでリード足にきれいに乗れています。', 'フィニッシュでリード足に乗り切れていません。',
      'フィニッシュの形で3秒止まる練習（毎球）');
  } else {
    const rise = (head0.y - headI.y) / TL;
    add('head', '頭の上下動（インパクト）', `${Math.round(rise * 100)}%`, 100 - Math.max(0, Math.abs(rise) - 0.05) * 450, [[A, [0]], [I, [0]]],
      'アドレス→インパクトでの鼻の上下移動 ÷ 胴の長さ。5%以内で満点、超えた分1%ごとに4.5点減点。', '頭の高さが保たれています。', rise > 0 ? 'インパクトで頭が上がっています（伸び上がり）。' : 'インパクトで頭が沈み込んでいます。',
      '壁にお尻をつけてアドレスし、お尻が壁から離れないようにハーフスイング');
    const tilt0 = (Math.atan2(Math.abs(sh0.x - hip0.x), hip0.y - sh0.y) * 180) / Math.PI;
    const tiltI = (Math.atan2(Math.abs(shI.x - hipI.x), hipI.y - shI.y) * 180) / Math.PI;
    const ext = tilt0 - tiltI;
    add('spine', '前傾角の維持', `${tilt0.toFixed(0)}° → ${tiltI.toFixed(0)}°`, 100 - Math.max(0, ext - 4) * 7, [[A, [11, 12, 23, 24]], [I, [11, 12, 23, 24]]],
      '肩の中心と腰の中心を結んだ線の傾き（アドレス→インパクト）。起き上がりが4°以内で満点、超えた分1°ごとに7点減点。', '前傾角がキープできています。', `インパクトで前傾が${ext.toFixed(0)}°起き上がっています。`,
      '椅子の背もたれにお尻を当てたまま打つイメージの素振り');
    const facing = Math.sign(A[0].x - mid(A[7], A[8]).x) || 1;
    const hipFwd = ((hipI.x - hip0.x) * facing) / TL;
    add('hipthrust', '腰の突っ込み（ボール方向）', `${Math.round(Math.abs(hipFwd) * 100)}%`, 100 - Math.max(0, Math.abs(hipFwd) - 0.08) * 400, [[A, [0, 7, 8, 23, 24]], [I, [23, 24]]],
      'アドレス→インパクトでの腰の中心のボール方向への移動 ÷ 胴の長さ。8%以内で満点、超えた分1%ごとに4点減点。', '腰がボール側に出ず、スペースを保てています。', 'ダウンスイングで腰がボール側に出ています。',
      'お尻の後ろに棒を立て、インパクトまでお尻を当てたままにする練習');
    add('setup', 'アドレスの前傾', `${tilt0.toFixed(0)}°`, 100 - Math.max(0, Math.abs(tilt0 - 38) - 7) * 6, [[A, [11, 12, 23, 24]]],
      'アドレスでの肩の中心と腰の中心を結んだ線の傾き。目安31〜45°で満点、外れた分1°ごとに6点減点。', 'アドレスの前傾は目安の範囲です。', tilt0 < 31 ? '前傾が浅めです。' : '前傾が深めです。',
      '股関節から上体を倒し、腕が真下に下がる位置で構える');
  }
  const leadArm = angle(T[L.sh], T[L.el], T[L.wr]);
  add('arm', 'トップでのリード腕', `${leadArm.toFixed(0)}°`, 100 - Math.max(0, 160 - leadArm) * 3, [[T, [L.sh, L.el, L.wr]]],
    'トップでの肩・ひじ・手首の角度（180°でまっすぐ）。160°以上で満点、下回った分1°ごとに3点減点。2Dのため腕がカメラ方向に向くと実際より曲がって見えます。', 'リード腕が伸びています。', 'トップでリード腕のひじが曲がって見えます。',
    'リード手1本でクラブを持ち、ひじを伸ばしたままハーフスイング');
  const knee = angle(A[L.hip], A[L.kn], A[L.an]);
  add('knee', 'アドレスのひざ', `${knee.toFixed(0)}°`, 100 - Math.max(0, Math.abs(knee - 158) - 10) * 5, [[A, [L.hip, L.kn, L.an]]],
    'アドレスでの腰・ひざ・足首の角度。148〜168°で満点、外れた分1°ごとに5点減点。', 'ひざの曲げ方は目安の範囲です。', knee > 168 ? 'ひざが伸び気味です。' : 'ひざを曲げすぎています。',
    'ジャンプして着地した時の軽いひざの曲がりでアドレス');

  const valid = metrics.filter((m) => m.valid);
  const score = valid.length >= 3 ? Math.round(valid.reduce((s0, m) => s0 + m.score, 0) / valid.length) : null;
  const notes = [];
  if (!addr.detected) notes.push('アドレスで静止している場面が見つからなかったため、動画の最初のコマをアドレスとして扱いました。構えてから2秒ほど静止した状態で撮影すると正確になります。');
  if (viewWarning) notes.push(viewWarning);
  if (timeRes > 0.05) notes.push('解析できなかったコマがあり、テンポの精度が下がっています。');
  if (valid.length < metrics.length) notes.push(`${metrics.length - valid.length}項目は関節が見えにくく判定できませんでした（合計点に含めていません）。`);
  return {
    view, hand, score, metrics, notes, validCount: valid.length,
    phases: { address: fr[a], start: fr[s], top: fr[top], impact: fr[imp], finish: fr[finEnd] },
    ref: { head: { x: head0.x, y: head0.y }, headR: Math.max(10, d2(A[7], A[8]) * 0.75 || TL * 0.12), hip: hip0, sh: sh0 },
    tempo: { ratio: tempo, back: tb, down: td },
    vis: Math.min(...[0, 11, 12, 15, 16, 23, 24].map((i) => A[i].v ?? 0)),
  };
}
