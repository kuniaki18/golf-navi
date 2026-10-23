import test from 'node:test';
import assert from 'node:assert/strict';
import { GpsFilter, sigmaOf } from '../../js/gpsfilter.js';
import { dist } from '../../js/util.js';
import { at, rng, gauss } from './helpers.mjs';

test('stationary: reported uncertainty is never better than the receiver accuracy (correlated errors)', () => {
  const g = new GpsFilter(); const r = rng(7);
  // a constant 4 m bias (multipath) plus 1 m noise, receiver says ±5 m
  let st;
  for (let i = 0; i < 10; i++) st = g.push({ ...at(4 + gauss(r), gauss(r)), acc: 5, t: 1000 * i, speed: 0 });
  assert.equal(st.mode, 'stable');
  assert.ok(st.sigma >= 5, `sigma ${st.sigma} must be >= 5`);
  // the bias is NOT removed by averaging — the filter must not pretend otherwise
  assert.ok(dist(st.pos, at(0, 0)) > 2.5);
});

test('walking: the position follows the latest fix (no lag)', () => {
  const g = new GpsFilter(); let st;
  for (let i = 0; i < 10; i++) st = g.push({ ...at(0, 1.3 * i), acc: 5, t: 1000 * i, speed: 1.3 });
  assert.equal(st.mode, 'moving');
  assert.ok(dist(st.pos, at(0, 1.3 * 9)) < 0.01);
});

test('walking without a speed field is detected from displacement', () => {
  const g = new GpsFilter(); let st;
  for (let i = 0; i < 6; i++) st = g.push({ ...at(0, 4 * i), acc: 4, t: 1000 * i });
  assert.equal(st.mode, 'moving');
  assert.ok(dist(st.pos, at(0, 20)) < 0.01);
});

test('stale position: age grows when fixes stop', () => {
  const g = new GpsFilter();
  g.push({ ...at(0, 0), acc: 5, t: 0, speed: 0 });
  assert.equal(g.isStale(5000), false);
  assert.equal(g.isStale(11000), true);
  assert.equal(Math.round(g.age(30000)), 30);
});

test('precise measurement locks, holds through jitter, releases when walking away', () => {
  const g = new GpsFilter(); const r = rng(3);
  g.push({ ...at(0, 0), acc: 6, t: 0, speed: 0 });
  g.startMeasure(1000);
  for (let i = 1; i <= 7; i++) g.push({ ...at(gauss(r), gauss(r)), acc: 6, t: 1000 + i * 1000, speed: 0 });
  assert.equal(g.state.mode, 'lock');
  assert.ok(g.state.sigma >= 6 * 0.8 - 1e-9, 'precise sigma stays conservative');
  const locked = g.state.pos;
  g.push({ ...at(2, 1), acc: 6, t: 10000, speed: 0 });
  assert.equal(g.state.mode, 'lock');
  assert.deepEqual(g.state.pos, locked);
  g.push({ ...at(0, 15), acc: 6, t: 12000, speed: 1.4 });
  assert.equal(g.state.mode, 'moving');
});

test('a hopeless fix does not replace a good position', () => {
  const g = new GpsFilter();
  g.push({ ...at(0, 0), acc: 5, t: 0, speed: 0 });
  const before = g.state.pos;
  g.push({ ...at(300, 0), acc: 120, t: 1000 });
  assert.deepEqual(g.state.pos, before);
});

test('sigmaOf', () => {
  assert.equal(sigmaOf([{ acc: 5 }, { acc: 5 }, { acc: 5 }]), 5);
  assert.ok(sigmaOf([{ acc: 3 }, { acc: 12 }, { acc: 12 }]) >= 6.9);
});
