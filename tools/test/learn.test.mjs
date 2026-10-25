import test from 'node:test';
import assert from 'node:assert/strict';
import { findDwells, learnHoles } from '../../js/learn.js';
import { dist } from '../../js/util.js';
import { at, rng, gauss } from './helpers.mjs';

// a walked hole: stand on the tee, walk 330 m (stopping once for the 2nd shot), putt on the green, walk to the next tee
function walkHole(track, t, tee, green, r) {
  const push = (p, dt) => { t += dt; track.push([p.lat + gauss(r) * 2e-5, p.lon + gauss(r) * 2e-5, t]); };
  for (let i = 0; i < 8; i++) push(tee, 8);                        // 64 s on the tee
  const mid = { lat: (tee.lat + green.lat) / 2, lon: (tee.lon + green.lon) / 2 };
  for (let k = 1; k <= 10; k++) push({ lat: tee.lat + (mid.lat - tee.lat) * k / 10, lon: tee.lon + (mid.lon - tee.lon) * k / 10 }, 12);
  for (let i = 0; i < 4; i++) push(mid, 8);                        // 2nd shot (32 s)
  for (let k = 1; k <= 10; k++) push({ lat: mid.lat + (green.lat - mid.lat) * k / 10, lon: mid.lon + (green.lon - mid.lon) * k / 10 }, 12);
  for (let i = 0; i < 18; i++) push(green, 10);                    // 3 minutes on the green
  return t;
}

test('dwells: tee, second shot and green are found; walking is not', () => {
  const r = rng(2), track = [];
  walkHole(track, 0, at(0, 0), at(0, 330), r);
  const d = findDwells(track);
  assert.ok(d.length >= 2);
  assert.ok(dist(d[0].c, at(0, 0)) < 8);
  assert.ok(dist(d[d.length - 1].c, at(0, 330)) < 8);
});

test('learn: an estimated hole gets the walked tee and green; a mapped hole is never touched', () => {
  const r = rng(5), track = [];
  let t = walkHole(track, 0, at(0, 0), at(0, 330), r);
  const t2 = t + 60;
  walkHole(track, t2, at(40, 350), at(40, 700), r);
  const holes = [
    { roundIdx: 0, key: '1', source: 'est', tee: at(30, 10), center: at(25, 300) },   // estimate 30 m off
    { roundIdx: 1, key: '2', source: 'osm', tee: at(40, 350), center: at(40, 700) },
  ];
  const s = learnHoles(track, [[0, 0], [1, t2]], holes);
  assert.equal(s.length, 1);
  assert.equal(s[0].key, '1');
  assert.ok(dist(s[0].tee, at(0, 0)) < 8, 'tee');
  assert.ok(dist(s[0].green, at(0, 330)) < 8, 'green');
  assert.ok(s[0].moveGreen > 20);
});

test('learn: nothing when the estimate is already right or the track is too short', () => {
  const r = rng(9), track = [];
  walkHole(track, 0, at(0, 0), at(0, 330), r);
  assert.equal(learnHoles(track, [[0, 0]], [{ roundIdx: 0, key: '1', source: 'est', tee: at(2, 1), center: at(1, 331) }]).length, 0);
  assert.equal(learnHoles(track.slice(0, 5), [[0, 0]], [{ roundIdx: 0, key: '1', source: 'none' }]).length, 0);
});
