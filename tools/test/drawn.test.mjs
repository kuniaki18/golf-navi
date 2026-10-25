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

test("the player's own tee + green replaces a drawn hole; a tee alone does not", () => {
  const f = parseCompact(j);
  const g = { lat: 36.6, lon: 138.6 }, t = { lat: 36.601, lon: 138.6 };
  const h2 = buildHoles(f, { 2: { tee: t, green: g } }).find((h) => h.key === '2');
  assert.equal(h2.source, 'user'); assert.ok(!h2.drawn);
  const h3 = buildHoles(f, { 3: { tee: t } }).find((h) => h.key === '3');
  assert.ok(h3.drawn);
});
