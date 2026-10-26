// Merge a fresh OSM extract (extract.mjs → <newDir>) into the live data without losing our own work:
// hand-drawn holes (m:1) and estimates stay until OSM maps real holes; index fields that extract.mjs does not
// produce (readings, scorecard flag, estimate count, …) are carried over; courses that vanished from OSM are kept
// when they have a scorecard, drawn holes or estimates.
// usage: node merge-osm.mjs <newDir> ../data
import fs from 'node:fs';

const [, , NEW, LIVE] = process.argv;
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const oldIdx = read(`${LIVE}/courses-jp.json`), newIdx = read(`${NEW}/courses-jp.json`);
const oldById = new Map(oldIdx.courses.map((c) => [c.id, c]));
const detail = (dir, id) => { try { return read(`${dir}/c/${id}.json`); } catch { return null; } };
const st = { carried: 0, keptDrawn: 0, keptEst: 0, osmReplaced: 0, keptGone: 0, newHoles: 0, newGreens: 0, files: 0 };

for (const c of newIdx.courses) {
  const o = oldById.get(c.id);
  if (o) for (const [k, v] of Object.entries(o)) if (c[k] === undefined && !['hm', 'gm', 'd', 'em'].includes(k)) { c[k] = v; st.carried++; }
  const nd = detail(NEW, c.id), od = detail(LIVE, c.id);
  const real = (nd?.holes || []).length;
  const drawn = (od?.holes || []).filter((h) => h.m);
  if (!o?.hm && real) st.newHoles++;
  if (!o?.gm && c.gm) st.newGreens++;
  let out = nd;
  if (od && !nd) out = od; // OSM features gone: keep what we had
  else if (nd && od) {
    if (!real && drawn.length) { out.holes = drawn; st.keptDrawn++; }
    else if (real && drawn.length) st.osmReplaced++;
    if (od.est) { out.est = od.est; st.keptEst++; } // estimates fill holes OSM has not mapped
  }
  if (out) {
    c.d = 1;
    const hm = (out.holes || []).length; if (hm) c.hm = hm; else delete c.hm;
    // a partly drawn club keeps its estimate flag; keep what the live index says when we had the course
    if (o) { if (o.em && out.est?.length) c.em = o.em; else delete c.em; } else if (out.est?.length && !hm) c.em = out.est.length; else delete c.em;
    fs.writeFileSync(`${LIVE}/c/${c.id}.json`, JSON.stringify(out)); st.files++;
  }
}
const newIds = new Set(newIdx.courses.map((c) => c.id));
for (const o of oldIdx.courses) {
  if (newIds.has(o.id)) continue;
  const od = detail(LIVE, o.id);
  if (o.sc || od?.est || (od?.holes || []).some((h) => h.m)) { newIdx.courses.push(o); st.keptGone++; }
}
newIdx.courses.sort((a, b) => (a.p || '').localeCompare(b.p || '', 'ja') || a.n.localeCompare(b.n, 'ja'));
newIdx.count = newIdx.courses.length;
newIdx.withHoles = newIdx.courses.filter((c) => c.hm).length;
fs.writeFileSync(`${LIVE}/courses-jp.json`, JSON.stringify(newIdx));
console.log(JSON.stringify({ before: { count: oldIdx.count, withHoles: oldIdx.courses.filter((c) => c.hm).length, withGreens: oldIdx.courses.filter((c) => c.gm).length },
  after: { count: newIdx.count, withHoles: newIdx.withHoles, withGreens: newIdx.courses.filter((c) => c.gm).length }, ...st }));
