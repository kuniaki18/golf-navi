import test from 'node:test';
import assert from 'node:assert/strict';
import { greenUnder, dwellOnGreen, shouldAdvance } from '../../js/easymap.js';
import { at } from './helpers.mjs';

const ring = (cx, cy, r) => Array.from({ length: 16 }, (_, i) => at(cx + r * Math.cos((i / 16) * 2 * Math.PI), cy + r * Math.sin((i / 16) * 2 * Math.PI)));
const greens = [{ id: 'a', c: at(0, 0), pts: ring(0, 0, 14) }, { id: 'b', c: at(200, 0), pts: ring(200, 0, 12) }];

test('standing on a mapped green (or just off its edge) finds it; the fairway does not', () => {
  assert.equal(greenUnder(at(5, 3), greens).id, 'a');
  assert.equal(greenUnder(at(16, 0), greens).id, 'a');     // 2 m off the edge
  assert.equal(greenUnder(at(40, 0), greens), null);
  assert.equal(greenUnder(at(198, 2), greens).id, 'b');
});

test('the green registers after the player stays on it, not when walking across', () => {
  let st = null, r;
  r = dwellOnGreen(st, at(0, 0), 0, greens); st = r.st; assert.equal(r.green, null);
  r = dwellOnGreen(st, at(3, 1), 8000, greens); st = r.st; assert.equal(r.green, null);
  r = dwellOnGreen(st, at(2, -2), 16000, greens); assert.equal(r.green.id, 'a');
  // walking off resets
  st = dwellOnGreen(null, at(0, 0), 0, greens).st;
  st = dwellOnGreen(st, at(60, 0), 5000, greens).st;
  assert.equal(dwellOnGreen(st, at(0, 0), 16000, greens).green, null);
  // poor GPS is ignored
  assert.equal(dwellOnGreen({ g: greens[0], since: 0 }, at(0, 0), 20000, greens, { acc: 40 }).green, null);
});

test('advance to the next hole only with a score, a known green and after walking off', () => {
  const g = at(0, 0);
  assert.equal(shouldAdvance({ strokes: 5, green: g, me: at(70, 0), hasNext: true }), true);
  assert.equal(shouldAdvance({ strokes: null, green: g, me: at(70, 0), hasNext: true }), false);
  assert.equal(shouldAdvance({ strokes: 5, green: g, me: at(20, 0), hasNext: true }), false);
  assert.equal(shouldAdvance({ strokes: 5, green: g, me: at(70, 0), hasNext: false }), false);
});

test('hands-free caddie at the ball: speaks after standing still at a new spot, not on the tee, green or while walking', async () => {
  const { atBall } = await import('../../js/easymap.js');
  const pin = at(0, 0), tee = at(0, -350);
  const run = (pts, ctx) => { let st = null, r; pts.forEach((p, i) => { r = atBall(st, p, i * 1000, { pin, tee, ...ctx }); st = r.st; }); return r.speak; };
  const still = (p, n) => Array(n).fill(p);
  assert.equal(run(still(at(0, -150), 10), {}), true);
  assert.equal(run(still(at(0, -150), 5), {}), false);                        // not long enough
  assert.equal(run(Array.from({ length: 12 }, (_, i) => at(0, -200 + i * 1.5)), {}), false); // walking
  assert.equal(run(still(at(0, -340), 12), {}), false);                       // on the tee
  assert.equal(run(still(at(0, -15), 12), {}), false);                        // on / next to the green
  assert.equal(run(still(at(0, -150), 12), { last: at(0, -160) }), false);    // already spoken here
  assert.equal(run(still(at(0, -150), 12), { acc: 30 }), false);              // poor GPS
});
