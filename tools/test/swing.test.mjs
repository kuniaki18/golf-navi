import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../../js/swingeval.js';
import { rng, gauss } from './helpers.mjs';

// synthetic face-on swing at 30 fps: address (still) → backswing 1.0 s → downswing 0.33 s → follow-through
// out(i, p, k): true when landmark i (frame k) lies outside the video frame (close-up filming)
function swing({ fps = 30, lead = 0, noise = 0, seed = 1, wristVis = 0.9, out = null } = {}) {
  const r = rng(seed), fr = []; let t = 0;
  const base = () => {
    const lm = Array.from({ length: 33 }, () => ({ x: 500, y: 500, v: 0.9 }));
    const P = (i, x, y) => (lm[i] = { x: x + noise * gauss(r), y: y + noise * gauss(r), v: 0.9 });
    P(0, 500, 250); P(7, 480, 250); P(8, 520, 250); P(11, 560, 330); P(12, 440, 330); P(13, 560, 430); P(14, 440, 430);
    P(23, 540, 560); P(24, 460, 560); P(25, 545, 700); P(26, 455, 700); P(27, 550, 830); P(28, 450, 830);
    return lm;
  };
  const push = (hx, hy) => {
    const lm = base(); lm[15] = { x: hx, y: hy, v: wristVis }; lm[16] = { x: hx + 10, y: hy, v: wristVis };
    if (out) lm.forEach((p, i) => { if (out(i, p, fr.length)) p.o = true; });
    fr.push({ t, lm }); t += 1 / fps;
  };
  for (let i = 0; i < lead; i++) push(700 - i * 4, 450 + (i % 5) * 6); // walking in / waggle before the address
  for (let i = 0; i < 0.5 * fps; i++) push(500, 600);
  const B = Math.round(1.0 * fps), D = Math.round(0.33 * fps), F = Math.round(0.5 * fps);
  for (let i = 0; i <= B; i++) push(500 - 250 * Math.sin((i / B) * Math.PI / 2), 600 - 380 * Math.sin((i / B) * Math.PI / 2));
  for (let i = 1; i <= D; i++) push(250 + 250 * (i / D) ** 2, 220 + 380 * (i / D) ** 2);
  for (let i = 1; i <= F; i++) push(500 + 260 * Math.sin((i / F) * Math.PI / 2), 600 - 420 * Math.sin((i / F) * Math.PI / 2));
  for (let i = 0; i < 0.3 * fps; i++) push(760, 180);
  return fr;
}
const scores = (r) => Object.fromEntries(r.metrics.map((m) => [m.key, m.score]));

test('same video → same result (deterministic)', () => {
  const a = evaluate(swing(), 'face', 'right'), b = evaluate(swing(), 'face', 'right');
  assert.deepEqual(scores(a), scores(b));
  assert.equal(a.score, b.score);
});

test('tempo is measured from time stamps (≈3:1 here) at 30 and 60 fps', () => {
  for (const fps of [30, 60]) {
    const r = evaluate(swing({ fps }), 'face', 'right');
    assert.ok(Math.abs(r.tempo.ratio - 3.0) < 0.45, `fps ${fps} tempo ${r.tempo.ratio}`);
  }
});

test('starting the recording early does not change the result (address = still moment before the swing)', () => {
  const plain = evaluate(swing(), 'face', 'right');
  const early = evaluate(swing({ lead: 30 }), 'face', 'right');
  assert.equal(early.notes.some((n) => /最初のコマ/.test(n)), false, 'address must be detected');
  for (const k of Object.keys(scores(plain))) assert.ok(Math.abs(scores(plain)[k] - scores(early)[k]) <= 2, `${k}: ${scores(plain)[k]} vs ${scores(early)[k]}`);
});

test('small landmark jitter changes scores only a little', () => {
  const a = evaluate(swing({ noise: 0 }), 'face', 'right'), b = evaluate(swing({ noise: 2, seed: 4 }), 'face', 'right');
  assert.ok(Math.abs(a.score - b.score) <= 8, `${a.score} vs ${b.score}`);
});

test('metrics whose joints are hidden are 判定不可 and excluded from the total', () => {
  const r = evaluate(swing({ wristVis: 0.3 }), 'face', 'right');
  const arm = r.metrics.find((m) => m.key === 'arm');
  assert.equal(arm.valid, false);
  assert.equal(arm.score, null);
  assert.ok(r.metrics.filter((m) => m.valid).every((m) => Number.isFinite(m.score)));
});

test('every metric explains its basis', () => {
  const r = evaluate(swing(), 'face', 'right');
  for (const m of r.metrics) assert.ok(m.basis && m.basis.length > 20, m.key);
});

test('close-up: feet cut off → knee / finish 判定不可, the rest still scored', () => {
  const r = evaluate(swing({ out: (i, p) => p.y > 760 }), 'face', 'right');
  const by = Object.fromEntries(r.metrics.map((m) => [m.key, m]));
  assert.equal(by.knee.valid, false);
  assert.equal(by.finish.valid, false);
  assert.match(by.knee.advice, /足元/);
  assert.ok(r.score != null && r.validCount >= 4);
  assert.ok(r.notes.some((n) => /足元が映っていません/.test(n)));
  const full = evaluate(swing(), 'face', 'right');
  for (const k of ['head', 'hipsway', 'turn', 'tempo']) assert.equal(by[k].score, Object.fromEntries(full.metrics.map((m) => [m.key, m.score]))[k], k);
});

test('close-up: hands leave the frame at the top → tempo still measured, arm 判定不可', () => {
  const r = evaluate(swing({ out: (i, p) => (i === 15 || i === 16) && p.y < 300 }), 'face', 'right');
  const by = Object.fromEntries(r.metrics.map((m) => [m.key, m]));
  assert.equal(by.arm.valid, false);
  assert.ok(by.tempo.valid && Math.abs(r.tempo.ratio - 3) < 0.45);
  assert.ok(r.notes.some((n) => /トップの手元の位置はAIの推定/.test(n)));
});

test('upper body only (hips and below out of frame) → still analysed with an estimated scale', () => {
  const r = evaluate(swing({ out: (i, p) => p.y > 500 && i !== 15 && i !== 16 }), 'face', 'right');
  assert.ok(r.scaleEstimated);
  assert.ok(r.notes.some((n) => /腰が映っていない/.test(n)));
  assert.ok(r.metrics.find((m) => m.key === 'head').valid);
});
