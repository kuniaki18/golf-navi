// Which mapped tee and green belong to which hole? Uses the course's tee / green outlines from OpenStreetMap and the
// scorecard (par, yards): hole n's tee → green distance fits its yardage (shorter for doglegs), and hole n+1's tee is a
// short walk from hole n's green. Beam search over the 18 holes.
//   node tools/route-tees-greens.mjs eval          → accuracy on courses whose holes are mapped (ground truth)
//   node tools/route-tees-greens.mjs <courseId>    → assignment for a course with a scorecard in data/sc
import fs from 'node:fs';
import path from 'node:path';

const R = 6371008.8, rad = Math.PI / 180;
const dist = (a, b) => { const dLa = (b.lat - a.lat) * rad, dLo = (b.lon - a.lon) * rad; const s = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
const ROOT = new URL('../', import.meta.url);
const read = (p) => JSON.parse(fs.readFileSync(new URL(p, ROOT), 'utf8'));
const cen = (ring) => { const r = Array.isArray(ring[0]) ? ring[0] : ring; let a = 0, b = 0, n = 0; for (let i = 0; i < r.length; i += 2) { a += r[i]; b += r[i + 1]; n++; } return { lat: a / n, lon: b / n }; };

/**
 * @param tees   [{lat,lon}] tee centres; greens [{lat,lon}] green centres
 * @param card   [{ par, y }] per hole in playing order (yards of the tee set that the map most likely shows)
 * @returns { holes: [{ tee, green, ti, gi, ratio }], score, margin } or null
 */
/** point in polygon ([{lat,lon}]) */
function inPoly(p, pts) { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const a = pts[i], b = pts[j]; if ((a.lat > p.lat) !== (b.lat > p.lat) && p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon) c = !c; } return c; }
/** share of the tee → green line (middle part) that runs over a mapped fairway */
function fairwayShare(t, g, fws) {
  if (!fws?.length) return null;
  let n = 0, k = 0;
  for (let i = 2; i <= 8; i++) { const p = { lat: t.lat + ((g.lat - t.lat) * i) / 10, lon: t.lon + ((g.lon - t.lon) * i) / 10 }; n++; if (fws.some((f) => inPoly(p, f))) k++; }
  return k / n;
}
export function route(tees, greens, card, { beam = 2500, walk = 260, fairways = null } = {}) {
  const Y = 0.9144;
  // candidate (tee, green) pairs per hole
  const pairs = card.map((h) => {
    const want = h.y * Y, out = [];
    const lo = h.par === 3 ? 0.85 : 0.7, hi = h.par === 3 ? 1.12 : 1.08;
    for (let ti = 0; ti < tees.length; ti++) for (let gi = 0; gi < greens.length; gi++) {
      const d = dist(tees[ti], greens[gi]), r = d / want;
      if (r < lo || r > hi) continue;
      // straight-line ratio: par 3 should be ≈1; par 4/5 may be shorter (doglegs) but rarely by much
      let c = h.par === 3 ? Math.abs(Math.log(r)) * 3 : Math.max(0, Math.log(0.97 / r)) * 1.5 + Math.max(0, Math.log(r / 1.02)) * 3;
      // par 4 / 5: the line should mostly run over a fairway (when fairways are mapped)
      const fs0 = h.par === 3 ? null : fairwayShare(tees[ti], greens[gi], fairways);
      if (fs0 != null) { if (fs0 < 0.25) continue; c += (1 - fs0) * 1.5; }
      out.push({ ti, gi, r, c });
    }
    return out;
  });
  let states = [{ tees: [], greens: [], used: new Set(), usedT: new Set(), cost: 0, path: [] }];
  for (let n = 0; n < card.length; n++) {
    const next = [];
    for (const s of states) {
      const prevG = n ? greens[s.path[n - 1].gi] : null;
      for (const p of pairs[n]) {
        if (s.used.has(p.gi) || s.usedT.has(p.ti)) continue;
        let w = 0;
        if (prevG && n !== 9) { const d = dist(prevG, tees[p.ti]); if (d > walk) continue; w = d / 400; }
        next.push({ s, p, cost: s.cost + p.c + w });
      }
    }
    if (!next.length) return null;
    next.sort((a, b) => a.cost - b.cost);
    states = next.slice(0, beam).map(({ s, p, cost }) => {
      const used = new Set(s.used); used.add(p.gi);
      // a tee box of one hole is never another hole's tee: block other tees close to this one only for itself
      const usedT = new Set(s.usedT); usedT.add(p.ti);
      return { used, usedT, cost, path: [...s.path, p] };
    });
  }
  const best = states[0];
  // how unique is the answer: best alternative that differs in some green
  const alt = states.find((x) => x.path.some((p, i) => p.gi !== best.path[i].gi));
  return { holes: best.path.map((p) => ({ tee: tees[p.ti], green: greens[p.gi], ti: p.ti, gi: p.gi, ratio: p.r })), score: best.cost / card.length, margin: alt ? (alt.cost - best.cost) / card.length : Infinity };
}

function mappedTruth(d) {
  const P = (f, i) => ({ lat: f[i], lon: f[i + 1] });
  const hs = (d.holes || []).filter((h) => h.r && h.g?.length >= 4).map((h) => {
    const g = h.g, pts = []; for (let i = 0; i < g.length; i += 2) pts.push(P(g, i));
    let len = 0; for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
    return { no: Number(h.r), par: h.p, tee: pts[0], green: pts[pts.length - 1], len, name: h.n || '' };
  });
  return hs;
}

async function evaluate() {
  const idx = read('data/courses-jp.json').courses.filter((c) => c.hm >= 18 && c.hm <= 19);
  let T = { courses: 0, solved: 0, holes: 0, ok: 0, okConf: 0, holesConf: 0 };
  const rows = [];
  for (const c of idx) {
    const d = read(`data/c/${c.id}.json`);
    const truth = mappedTruth(d).filter((h) => h.no >= 1 && h.no <= 18).sort((a, b) => a.no - b.no);
    if (truth.length !== 18 || new Set(truth.map((h) => h.no)).size !== 18 || truth.some((h) => !h.par)) continue;
    const tees = (d.tees || []).map(cen), greens = (d.greens || []).map(cen);
    if (tees.length < 18 || greens.length < 18) continue;
    if ((d.fairways || []).length < 9) continue; // the method needs mapped fairways
    T.courses++;
    // a scorecard stand-in: the mapped hole length (yards), ±5% like a real card vs. the drawn line
    let s = c.id.length; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
    const card = truth.map((h) => ({ par: h.par, y: (h.len / 0.9144) * (0.95 + rnd() * 0.1) }));
    const fws = (d.fairways || []).map((f) => { const r0 = Array.isArray(f[0]) ? f[0] : f; const o = []; for (let i = 0; i < r0.length; i += 2) o.push({ lat: r0[i], lon: r0[i + 1] }); return o; }).filter((p) => p.length >= 3);
    const r = route(tees, greens, card, { fairways: fws.length >= 9 ? fws : null });
    if (!r) { rows.push(`${c.n.slice(0, 16).padEnd(16)} no solution`); continue; }
    T.solved++;
    let ok = 0;
    r.holes.forEach((h, i) => { if (dist(h.green, truth[i].green) < 30 && dist(h.tee, truth[i].tee) < 60) ok++; });
    T.holes += 18; T.ok += ok;
    const conf = r.margin > 0.02;
    if (conf) { T.holesConf += 18; T.okConf += ok; }
    rows.push(`${c.n.slice(0, 16).padEnd(16)} ${String(ok).padStart(2)}/18  score ${r.score.toFixed(2)} margin ${r.margin === Infinity ? '∞' : r.margin.toFixed(3)}`);
  }
  console.log(rows.join('\n'));
  console.log(`\ncourses ${T.courses}, solved ${T.solved}; holes right ${T.ok}/${T.holes} (${((100 * T.ok) / Math.max(1, T.holes)).toFixed(0)}%)`);
  console.log(`confident answers only (margin > 0.02): ${T.okConf}/${T.holesConf} (${((100 * T.okConf) / Math.max(1, T.holesConf)).toFixed(0)}%)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))) {
  const [cmd] = process.argv.slice(2);
  if (cmd === 'eval') await evaluate();
}
