import test from 'node:test';
import assert from 'node:assert/strict';
import { ninesOf, defaultPlan, planHoles, planPars } from '../../js/round.js';

const H = (no, set = 0, par = 4) => ({ no, set, key: set ? `${no}-${set + 1}` : String(no), par, source: 'osm', center: { lat: 35, lon: 139 } });
const name = (s) => ['中コース', '西コース', '東コース'][s];

test('18-hole course → OUT and IN', () => {
  const all = Array.from({ length: 18 }, (_, i) => H(i + 1));
  const n = ninesOf(all, name);
  assert.deepEqual(n.map((x) => x.name), ['OUT（1〜9番）', 'IN（10〜18番）']);
  const plan = defaultPlan(n);
  const hs = planHoles(all, plan);
  assert.equal(hs.length, 18);
  assert.deepEqual(hs.map((h) => h.no), Array.from({ length: 18 }, (_, i) => i + 1));
  assert.deepEqual(hs.map((h) => h.roundIdx), Array.from({ length: 18 }, (_, i) => i));
});

test('27-hole club → three nines; any two in any order; scorecard columns follow the playing order', () => {
  const all = [0, 1, 2].flatMap((s) => Array.from({ length: 9 }, (_, i) => H(i + 1, s, s === 1 && i === 0 ? 5 : 4)));
  const n = ninesOf(all, name);
  assert.deepEqual(n.map((x) => x.name), ['中コース', '西コース', '東コース']);
  const hs = planHoles(all, { front: n[1], back: n[2] }); // 西 → 東
  assert.equal(hs.length, 18);
  assert.equal(hs[0].key, '1-2');
  assert.equal(hs[9].key, '1-3');
  assert.equal(hs[9].roundIdx, 9);
  assert.equal(hs[0].nineName, '西コース');
  assert.equal(planPars(null, hs, null)[0], 5);
});

test('half round (front only) and missing holes become placeholders', () => {
  const all = [H(1), H(2), H(4)];
  const n = ninesOf(all, name);
  assert.equal(n.length, 1);
  const hs = planHoles(all, { front: n[0], back: null });
  assert.equal(hs.length, 9);
  assert.equal(hs[2].source, 'none');
  assert.equal(hs[2].key, '3');
});

test('official scorecard pars override the map', () => {
  const all = Array.from({ length: 18 }, (_, i) => H(i + 1));
  const hs = planHoles(all, defaultPlan(ninesOf(all, name)));
  const sc = { courses: [{ holes: Array.from({ length: 18 }, (_, i) => ({ par: i === 17 ? 5 : 3 })) }] };
  const p = planPars(null, hs, sc);
  assert.equal(p[0], 3);
  assert.equal(p[17], 5);
});

test('27-hole club with an 18-hole map: offered by official names; third course becomes empty holes to register', async () => {
  const { scRow } = await import('../../js/round.js');
  const all = Array.from({ length: 18 }, (_, i) => H(i + 1));
  const sc = { courses: ['中', '西', '東'].map((n, k) => ({ name: n, holes: Array.from({ length: 9 }, (_, i) => ({ par: k === 1 && i === 0 ? 5 : 4, yd: 300 + k })) })) };
  const n = ninesOf(all, name, sc);
  assert.deepEqual(n.map((x) => x.name), ['中コース', '西コース', '東コース']);
  assert.deepEqual(n.map((x) => x.mapped), [9, 9, 0]);
  const hs = planHoles(all, { front: n[1], back: n[2] }); // 西 → 東
  assert.equal(hs[0].no, 10);          // 西 = the map's holes 10–18
  assert.equal(hs[0].dispNo, 1);       // shown as 西コース 1番
  assert.equal(scRow(hs[0], sc).par, 5);
  assert.equal(hs[9].source, 'none');  // 東 is not on the map yet
  assert.equal(planPars(null, hs, sc)[0], 5);
  assert.notEqual(hs[9].key, hs[0].key);
});

test('36-hole club with two 18-hole cards and no map: both courses can be chosen', () => {
  const all = Array.from({ length: 18 }, (_, i) => ({ no: i + 1, set: 0, key: String(i + 1), source: 'none', center: null }));
  const h18 = Array.from({ length: 18 }, () => ({ par: 4, yd: 380 }));
  const sc = { courses: [{ name: '草花', holes: h18 }, { name: '奥多摩', holes: h18 }] };
  const n = ninesOf(all, name, sc);
  assert.deepEqual(n.map((x) => x.short), ['草花コース OUT', '草花コース IN', '奥多摩コース OUT', '奥多摩コース IN']);
  const hs = planHoles(all, { front: n[2], back: n[3] });
  assert.equal(hs[0].set, 1);
  assert.equal(hs[0].key, '1-2');
  assert.equal(hs[17].key, '18-2');
});
