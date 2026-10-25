import test from 'node:test';
import assert from 'node:assert/strict';
import { greenDistances, greenKey } from '../../js/geo.js';
import { buildHoles } from '../../js/osm.js';
import { estimate } from '../auto-holes.mjs';
import { centroid, dist } from '../../js/util.js';
import { at, square } from './helpers.mjs';

const Y = 1 / 0.9144;

test('front / center / back from the green outline', () => {
  const g = { pts: square(0, 0, 15) }; g.c = centroid(g.pts.slice(0, 4));
  const d = greenDistances(at(0, -150), g, g.c);
  assert.ok(Math.abs(d.center - 150 * Y) < 0.5);
  assert.ok(Math.abs(d.front - 135 * Y) < 0.5);
  assert.ok(Math.abs(d.back - 165 * Y) < 0.5);
});

test('without an outline, front / back are not invented', () => {
  const d = greenDistances(at(0, -150), null, at(0, 0));
  assert.equal(d.front, null);
  assert.equal(d.back, null);
});

test('2-green system: both greens become options and the target is a real green (never the midpoint)', () => {
  const gA = { pts: square(-18, 0, 10) }; gA.c = centroid(gA.pts.slice(0, 4));
  const gB = { pts: square(18, 0, 10) }; gB.c = centroid(gB.pts.slice(0, 4));
  const f = { holes: [], greens: [gA, gB], tees: [], bunkers: [], water: [], fairways: [], pins: [] };
  const holes = buildHoles(f, { 1: { tee: at(0, -380), green: gA.c, est: true } });
  const h = holes.find((x) => x.key === '1');
  assert.equal(h.greenOptions.length, 2);
  assert.ok(dist(h.center, gA.c) < 0.01);
  assert.equal(h.green, gA);
});

test('auto-holes estimate: target is one member of a 2-green complex', () => {
  const flat = (pts) => pts.flatMap((p) => [p.lat, p.lon]);
  const greens = [], fairways = [];
  // six holes in a row so the estimator has enough to work with; each has two greens 36 m apart
  for (let i = 0; i < 6; i++) {
    const x = i * 120;
    greens.push([flat(square(x - 18, 0, 9))], [flat(square(x + 18, 0, 9))]);
    fairways.push([flat([at(x - 12, -300), at(x + 12, -300), at(x + 12, -60), at(x - 12, -60), at(x - 12, -300)])]);
  }
  const est = estimate({ greens, fairways, tees: [] });
  assert.ok(est.length >= 6);
  const centres = greens.map((g) => { const p = []; for (let i = 0; i < g[0].length; i += 2) p.push({ lat: g[0][i], lon: g[0][i + 1] }); return centroid(p.slice(0, 4)); });
  for (const h of est) {
    const nearest = Math.min(...centres.map((c) => dist(c, h.green)));
    assert.ok(nearest < 0.5, `estimated target ${nearest.toFixed(1)} m from a real green`);
  }
});

test('slope cache key follows the green, not the hole number', () => {
  const g1 = { c: at(0, 0), pts: square(0, 0, 10) }, g2 = { c: at(40, 0), pts: square(40, 0, 10) };
  assert.notEqual(greenKey(g1), greenKey(g2));
  assert.equal(greenKey(g1), greenKey({ ...g1 }));
});

test('36-hole club: holes named after their course (East / West) stay on that course even if the routing is confusing', () => {
  const mk = (label, x0, no, swapTo) => {
    const x = swapTo ?? x0; // East 1 drawn next to the West course (as at 霞ヶ関)
    return { ref: no, par: 4, name: `${label} Hole ${no}`, pts: [at(x, no * 400), at(x, no * 400 + 300)], distTag: null };
  };
  const holes = [];
  for (let n = 1; n <= 18; n++) { holes.push(mk('West', 0, n)); holes.push(mk('East', 3000, n, n === 1 ? 20 : undefined)); }
  const f = { holes, greens: [], tees: [], bunkers: [], water: [], fairways: [], pins: [] };
  const out = buildHoles(f, {});
  const setOf = (label) => new Set(out.filter((h) => h.name?.startsWith(label)).map((h) => h.set));
  assert.equal(setOf('East').size, 1);
  assert.equal(setOf('West').size, 1);
  assert.notDeepEqual([...setOf('East')], [...setOf('West')]);
});
