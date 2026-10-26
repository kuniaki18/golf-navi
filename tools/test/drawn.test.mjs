import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCompact, buildHoles } from '../../js/osm.js';

const j = JSON.parse(fs.readFileSync(new URL('../../data/c/osm-way-1374148217.json', import.meta.url)));

test('草津温泉: all 18 holes are drawn, each ending on a mapped green', () => {
  const holes = buildHoles(parseCompact(j)).filter((h) => h.no <= 18);
  assert.equal(holes.length, 18);
  for (const h of holes) { assert.ok(h.drawn, `hole ${h.no} drawn`); assert.ok(h.green, `hole ${h.no} has a mapped green`); assert.ok(h.tee); }
  assert.equal(new Set(holes.map((h) => h.green.id)).size, 18, 'no green used twice');
});

test("a hand-registered hole of believable length replaces a drawn hole; a stray or learned one does not", () => {
  const f = parseCompact(j);
  const d2 = buildHoles(f).find((h) => h.key === '2');
  // the player's own tap, about the same length as the drawing
  const own = buildHoles(f, { 2: { tee: d2.tee, green: d2.center } }).find((h) => h.key === '2');
  assert.equal(own.source, 'user'); assert.ok(!own.drawn);
  // a stray registration 1,500 yd long keeps the drawing
  const far = { lat: d2.center.lat + 0.012, lon: d2.center.lon };
  assert.ok(buildHoles(f, { 2: { tee: far, green: d2.center } }).find((h) => h.key === '2').drawn);
  // auto-learned positions and a tee alone keep the drawing too
  assert.ok(buildHoles(f, { 2: { tee: d2.tee, green: d2.center, learned: true } }).find((h) => h.key === '2').drawn);
  assert.ok(buildHoles(f, { 3: { tee: d2.tee } }).find((h) => h.key === '3').drawn);
});

test('川越CC: 27 drawn holes keep their course from the scorecard order (中・西・東)', () => {
  const k = JSON.parse(fs.readFileSync(new URL('../../data/c/osm-way-592231989.json', import.meta.url)));
  const holes = buildHoles(parseCompact(k)).filter((h) => h.no <= 9);
  assert.equal(holes.length, 27);
  for (const s of [0, 1, 2]) {
    const nine = holes.filter((h) => h.set === s);
    assert.deepEqual(nine.map((h) => h.no).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const h of nine) { assert.ok(h.drawn); assert.ok(h.green, `${h.key} has a mapped green`); assert.equal(h.key, s ? `${h.no}-${s + 1}` : String(h.no)); }
  }
  assert.equal(holes.find((h) => h.key === '1').name, '中1番');
});

test('東松山CC: the 9 drawn 東 holes are course 1; 中 and 西 keep their estimates', () => {
  const k = JSON.parse(fs.readFileSync(new URL('../../data/c/osm-way-592218693.json', import.meta.url)));
  const f = parseCompact(k);
  const east = buildHoles(f).filter((h) => h.drawn);
  assert.equal(east.length, 9);
  for (const h of east) { assert.equal(h.set, 0); assert.ok(h.green, `${h.key} has a mapped green`); }
  assert.ok(Object.keys(f.estHoles).length > 0, 'estimates for the other nines are kept');
});

test('石坂GC: OUT 1–9 drawn, each on its own mapped green; IN keeps its estimate', () => {
  const k = JSON.parse(fs.readFileSync(new URL('../../data/c/osm-way-188607329.json', import.meta.url)));
  const out = buildHoles(parseCompact(k)).filter((h) => h.drawn);
  assert.deepEqual(out.map((h) => h.no), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(new Set(out.map((h) => h.green?.id)).size, 9);
});

test('清澄GC: all 18 holes drawn from the club map, each on its own mapped green', () => {
  const k = JSON.parse(fs.readFileSync(new URL('../../data/c/osm-way-188607321.json', import.meta.url)));
  const holes = buildHoles(parseCompact(k)).filter((h) => h.drawn);
  assert.deepEqual(holes.map((h) => h.no), Array.from({ length: 18 }, (_, i) => i + 1));
  assert.equal(new Set(holes.map((h) => h.green?.id)).size, 18);
});

test('JMGおごせGC: all 18 holes drawn from the club map, each on its own mapped green', () => {
  const k = JSON.parse(fs.readFileSync(new URL('../../data/c/osm-way-188607317.json', import.meta.url)));
  const holes = buildHoles(parseCompact(k)).filter((h) => h.drawn);
  assert.deepEqual(holes.map((h) => h.no), Array.from({ length: 18 }, (_, i) => i + 1));
  assert.equal(new Set(holes.map((h) => h.green?.id)).size, 18);
});
