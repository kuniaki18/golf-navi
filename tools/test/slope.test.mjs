import test from 'node:test';
import assert from 'node:assert/strict';
import { fitPlane, confidence, sourceGrade, readPutt } from '../../js/greenslope.js';
import { at, rng, gauss } from './helpers.mjs';

// elevations on a 25 m green, 4 m grid, rounded to 0.1 m like the GSI API
function grid(fn, noise = 0, seed = 1) {
  const r = rng(seed), out = [];
  for (let x = -12; x <= 12; x += 4) for (let y = -12; y <= 12; y += 4) out.push({ x, y, z: Math.round((fn(x, y) + noise * gauss(r)) * 10) / 10 });
  return out;
}
const angDiff = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

test('a 2% slope rising to the east is recovered with its direction (downhill = west)', () => {
  const f = fitPlane(grid((x) => 50 + 0.02 * x, 0.02));
  assert.ok(Math.abs(f.pct - 2) < 0.3, `pct ${f.pct}`);
  assert.ok(angDiff(f.downBearing, 270) < 10, `dir ${f.downBearing}`);
  assert.ok(f.pctSE > 0 && f.pctSE < 0.5);
  const c = confidence(f, sourceGrade(['1m（レーザ）']));
  assert.equal(c.level, 'high');
});

test('a flat green with 0.1 m rounding is NOT given a direction', () => {
  const f = fitPlane(grid(() => 50.04, 0.03, 5));
  const c = confidence(f, sourceGrade(['5m（レーザ）']));
  assert.ok(['none', 'low'].includes(c.level), `level ${c.level} pct ${f.pct} se ${f.pctSE}`);
});

test('10 m mesh data is never used for a green read', () => {
  const f = fitPlane(grid((x) => 50 + 0.03 * x));
  assert.equal(confidence(f, sourceGrade(['10m'])).level, 'none');
});

test('a tiered green (step) is flagged as a poor plane fit', () => {
  const f = fitPlane(grid((x) => (x > 0 ? 50.6 : 50)));
  const c = confidence(f, sourceGrade(['1m（レーザ）']));
  assert.notEqual(c.level, 'high');
});

test('putt read: uphill / downhill and the break direction', () => {
  const slope = { ...fitPlane(grid((x) => 50 + 0.02 * x, 0.01)) };
  slope.conf = confidence(slope, sourceGrade(['1m（レーザ）']));
  // putting from east to west = straight downhill
  const down = readPutt(slope, at(5, 0), at(-5, 0), 'right');
  assert.match(down.upDown, /下り/);
  assert.match(down.sideTxt, /はっきりしない/);
  // putting south → north across a slope that falls to the west (left): breaks left = hook for a right-hander
  const across = readPutt(slope, at(0, -5), at(0, 5), 'right');
  assert.match(across.sideTxt, /左に曲がるフックライン/);
  assert.match(readPutt(slope, at(0, -5), at(0, 5), 'left').sideTxt, /スライスライン/);
});

test('putt read is withheld when the slope is not determinable', () => {
  const s = fitPlane(grid(() => 50, 0.03, 9)); s.conf = { level: 'none' };
  assert.equal(readPutt(s, at(0, -5), at(0, 5)), null);
});
