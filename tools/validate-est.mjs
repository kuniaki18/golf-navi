// How good are the automatically estimated holes? Run the estimator on courses whose holes are mapped in
// OpenStreetMap (as if the holes were unknown) and compare with the real holes.
//   node tools/validate-est.mjs
import fs from 'node:fs';
import { estimate } from './auto-holes.mjs';

const R = 6371008.8, rad = Math.PI / 180;
const dist = (a, b) => { const dLa = (b.lat - a.lat) * rad, dLo = (b.lon - a.lon) * rad; const s = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
const idx = JSON.parse(fs.readFileSync(new URL('../data/courses-jp.json', import.meta.url), 'utf8')).courses;
const P = (flat, i) => ({ lat: flat[i], lon: flat[i + 1] });
let T = { courses: 0, holes: 0, greenOk: 0, numberOk: 0, teeOk: 0, teeKnown: 0, parOk: 0, lenErr: [] };
for (const c of idx.filter((x) => x.hm >= 18)) {
  const d = JSON.parse(fs.readFileSync(new URL(`../data/c/${c.id}.json`, import.meta.url), 'utf8'));
  const truth = (d.holes || []).filter((h) => h.r && h.g?.length >= 4).map((h) => ({ no: Number(h.r), par: h.p, tee: P(h.g, 0), green: P(h.g, h.g.length - 2) }));
  if (truth.length < 18) continue;
  const est = estimate({ greens: d.greens, fairways: d.fairways, tees: d.tees });
  if (!est.length) continue;
  T.courses++;
  for (const t of truth) {
    T.holes++;
    // the estimated hole whose green is this hole's green (any number)
    const e = est.find((x) => x.green && dist(x.green, t.green) < 30);
    if (!e) continue;
    T.greenOk++;
    if (Number(e.k) === t.no) T.numberOk++;
    if (e.tee) { T.teeKnown++; if (dist(e.tee, t.tee) < 40) T.teeOk++; T.lenErr.push(Math.abs(dist(e.tee, e.green) - dist(t.tee, t.green)) / dist(t.tee, t.green)); }
    if (e.par === t.par) T.parOk++;
  }
}
const pc = (a, b) => `${((100 * a) / Math.max(1, b)).toFixed(0)}%`;
T.lenErr.sort((a, b) => a - b);
console.log(`courses ${T.courses}, holes ${T.holes}`);
console.log(`green of the hole found: ${pc(T.greenOk, T.holes)}`);
console.log(`…with the right hole number: ${pc(T.numberOk, T.holes)}`);
console.log(`tee estimated: ${pc(T.teeKnown, T.holes)}, tee within 40 m: ${pc(T.teeOk, T.holes)}`);
console.log(`par right: ${pc(T.parOk, T.holes)}`);
console.log(`length error median ${(T.lenErr[T.lenErr.length >> 1] * 100 || 0).toFixed(0)}%`);
