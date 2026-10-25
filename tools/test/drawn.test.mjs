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
