// Work out the hole routing of a course from its official scorecard (par / yards) + mapped greens + the aerial photo:
// each hole's tee is at the scorecard distance from its green, close to the previous green (or the clubhouse for
// holes 1 and 10), and the line tee → green runs over open grass (fairway), not forest. Beam search over orders.
//   node tools/route-from-scorecard.mjs <courseId> <sc.json> <clubhouseLat> <clubhouseLon> [out.json]
// The result is checked by eye on the aerial photo before it is used.
import fs from 'node:fs';
import { mosaic, courses, blur, tx, ty, latOf, lonOf } from './aerial-detect.mjs';

const [id, scFile, chLat, chLon, outFile] = process.argv.slice(2);
const c = courses().find((x) => x.id === id);
const d = JSON.parse(fs.readFileSync(new URL(`../data/c/${id}.json`, import.meta.url), 'utf8'));
const sc = JSON.parse(fs.readFileSync(scFile, 'utf8'));
const holesSc = sc.courses.flatMap((k) => k.holes);
const pad = 0.001, b = [c.b[0] - pad, c.b[1] - pad, c.b[2] + pad, c.b[3] + pad];
const m = await mosaic(b);
const { w, h, px } = m;
const mpp = (156543.03392 * Math.cos((c.a * Math.PI) / 180)) / 2 ** 17;
// open grass: bright, green-tinted, smooth (fairways, tees, greens); forest is darker and rough
const L = new Float32Array(w * h), L2 = new Float32Array(w * h);
for (let p = 0; p < w * h; p++) { const l = 0.3 * px[p * 3] + 0.59 * px[p * 3 + 1] + 0.11 * px[p * 3 + 2]; L[p] = l; L2[p] = l * l; }
const mu = blur(L, w, h, 3), mu2 = blur(L2, w, h, 3);
const open = new Float32Array(w * h);
for (let p = 0; p < w * h; p++) { const r = px[p * 3], g = px[p * 3 + 1], bb = px[p * 3 + 2]; const sd = Math.sqrt(Math.max(0, mu2[p] - mu[p] * mu[p])); open[p] = mu[p] > 105 && g - (r + bb) / 2 > 0 && sd < 14 ? 1 : 0; }
const openB = blur(open, w, h, 2);
const toPx = (lat, lon) => [(tx(lon) - m.x0) * 256, (ty(lat) - m.y0) * 256];
const toLL = (x, y) => ({ lat: latOf(m.y0 + y / 256), lon: lonOf(m.x0 + x / 256) });
const at = (x, y) => { const X = Math.round(x), Y = Math.round(y); return X < 0 || Y < 0 || X >= w || Y >= h ? 0 : openB[Y * w + X]; };
const frac = (a, g) => { let s = 0; const N = 40; for (let i = 0; i <= N; i++) s += at(a[0] + ((g[0] - a[0]) * i) / N, a[1] + ((g[1] - a[1]) * i) / N); return s / (N + 1); };
const D = (a, g) => Math.hypot(a[0] - g[0], a[1] - g[1]) * mpp;

const greens = d.greens.map((g) => { const r = g[0] || g; let la = 0, lo = 0, n = 0; for (let i = 0; i < r.length; i += 2) { la += r[i]; lo += r[i + 1]; n++; } return toPx(la / n, lo / n); });
const ch = toPx(Number(chLat), Number(chLon));

/** best tee for a green at `len` metres, within `near` metres of `from` */
function bestTee(g, len, from, near) {
  let best = null;
  for (const k of [0.95, 1, 1.05]) for (let a = 0; a < 360; a += 2) {
    const r = (len * k) / mpp, t = [g[0] + r * Math.cos((a * Math.PI) / 180), g[1] + r * Math.sin((a * Math.PI) / 180)];
    if (D(t, from) > near) continue;
    const f = frac(t, g) * 0.8 + at(t[0], t[1]) * 0.2 - Math.abs(k - 1) * 0.5;
    if (!best || f > best.f) best = { t, f };
  }
  return best;
}

let beam = [{ seq: [], tees: [], used: new Set(), score: 0 }];
for (let n = 0; n < holesSc.length; n++) {
  const len = holesSc[n].yd * 0.9144;
  const next = [];
  for (const st of beam) {
    const start = n === 0 || n === 9;
    const from = start ? ch : greens[st.seq[n - 1]], near = start ? 230 : 150;
    for (let gi = 0; gi < greens.length; gi++) {
      if (st.used.has(gi)) continue;
      if ((n === 8 || n === 17) && D(greens[gi], ch) > 330) continue; // 9th / 18th green near the clubhouse
      const bt = bestTee(greens[gi], len, from, near);
      if (!bt || bt.f < 0.4) continue;
      const used = new Set(st.used); used.add(gi);
      next.push({ seq: [...st.seq, gi], tees: [...st.tees, bt.t], used, score: st.score + bt.f });
    }
  }
  next.sort((a, b2) => b2.score - a.score);
  beam = next.slice(0, 4000);
  if (!beam.length) { console.log('no routing fits at hole', n + 1); process.exit(1); }
}
const best = beam[0];
console.log('score', (best.score / holesSc.length).toFixed(2), 'alternatives within 2%:', beam.filter((x) => x.score > best.score * 0.98).length);
const res = best.seq.map((gi, n) => ({ no: n + 1, par: holesSc[n].par, yd: holesSc[n].yd, green: gi, tee: toLL(...best.tees[n]), greenC: toLL(...greens[gi]), grass: Number(frac(best.tees[n], greens[gi]).toFixed(2)) }));
for (const r of res) console.log(r.no, 'par', r.par, r.yd + 'y', 'green#' + r.green, 'grass', r.grass);
if (outFile) fs.writeFileSync(outFile, JSON.stringify({ res, x0: m.x0, y0: m.y0, tees: best.tees, greensPx: greens }));
