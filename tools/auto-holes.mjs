// Estimate hole layouts for courses whose greens/fairways are mapped but holes are not.
// green complexes (2-green systems merged) ← fairway axis → estimated tee; routing order → estimated numbers.
// Adds `est` (estimated holes) to data/c/<id>.json and `em` (count) to courses-jp.json.
// usage: node tools/auto-holes.mjs data [courseId]
import fs from 'node:fs';
const DIR = process.argv[2] || 'data';
const only = process.argv[3];
const R = 6371008.8, rad = Math.PI / 180;
const pts = (f) => { const o = []; for (let i = 0; i + 1 < f.length; i += 2) o.push({ lat: f[i], lon: f[i + 1] }); return o; };
const dist = (a, b) => { const dLa = (b.lat - a.lat) * rad, dLo = (b.lon - a.lon) * rad; const s = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
const cen = (p) => ({ lat: p.reduce((a, x) => a + x.lat, 0) / p.length, lon: p.reduce((a, x) => a + x.lon, 0) / p.length });
const xy = (o, p) => ({ x: (p.lon - o.lon) * rad * R * Math.cos(o.lat * rad), y: (p.lat - o.lat) * rad * R });
const unxy = (o, v) => ({ lat: o.lat + v.y / (rad * R), lon: o.lon + v.x / (rad * R * Math.cos(o.lat * rad)) });
const r6 = (p) => p && { lat: Math.round(p.lat * 1e6) / 1e6, lon: Math.round(p.lon * 1e6) / 1e6 };

function axis(poly) {
  // principal axis of a polygon → two far ends (meters-accurate)
  const o = cen(poly); const v = poly.map((p) => xy(o, p));
  let sxx = 0, syy = 0, sxy = 0; for (const q of v) { sxx += q.x * q.x; syy += q.y * q.y; sxy += q.x * q.y; }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy); const ux = Math.cos(th), uy = Math.sin(th);
  let lo = Infinity, hi = -Infinity; for (const q of v) { const t = q.x * ux + q.y * uy; lo = Math.min(lo, t); hi = Math.max(hi, t); }
  let wlo = Infinity, whi = -Infinity; for (const q of v) { const t = -q.x * uy + q.y * ux; wlo = Math.min(wlo, t); whi = Math.max(whi, t); }
  return { o, a: unxy(o, { x: ux * lo, y: uy * lo }), b: unxy(o, { x: ux * hi, y: uy * hi }), len: hi - lo, width: whi - wlo, ux, uy };
}

export function estimate(d) {
  const greens = (d.greens || []).map((g) => pts(g[0])).filter((p) => p.length > 2).map((p) => ({ p, c: cen(p), area: p.length }));
  if (greens.length < 6) return [];
  // practice greens are usually tiny-count outliers near the clubhouse; keep all, merge pairs within 55m (2-green system)
  const comps = [];
  for (const g of greens) {
    const near = comps.find((cp) => cp.members.length < 2 && dist(cp.c, g.c) < 55);
    if (near) { near.members.push(g); near.c = cen(near.members.map((m) => m.c)); } else comps.push({ members: [g], c: g.c });
  }
  const fws = (d.fairways || []).map((f) => pts(f[0])).filter((p) => p.length > 3).map(axis).filter((a) => a.len > 60 && a.len > a.width * 1.3);
  const tees = (d.tees || []).map((t) => pts(t[0])).filter((p) => p.length).map((p) => ({ c: cen(p) }));
  // pair each fairway to the green complex at one of its ends
  const holes = [];
  const usedComp = new Set();
  const pairs = [];
  for (const f of fws) for (const cp of comps) {
    const da = dist(f.a, cp.c), db = dist(f.b, cp.c);
    const dNear = Math.min(da, db);
    if (dNear > 110) continue;
    pairs.push({ f, cp, d: dNear, greenEnd: da < db ? 'a' : 'b' });
  }
  pairs.sort((x, y) => x.d - y.d);
  const usedF = new Set();
  for (const pr of pairs) {
    if (usedF.has(pr.f) || usedComp.has(pr.cp)) continue;
    usedF.add(pr.f); usedComp.add(pr.cp);
    const far = pr.greenEnd === 'a' ? pr.f.b : pr.f.a;
    // tee: a mapped tee behind the fairway if any, else ~45m beyond the fairway's far end
    const away = xy(pr.cp.c, far); const L = Math.hypot(away.x, away.y) || 1;
    let tee = unxy(pr.cp.c, { x: away.x * (1 + 45 / L), y: away.y * (1 + 45 / L) });
    const mapped = tees.filter((t) => dist(t.c, tee) < 90).sort((a, b) => dist(a.c, tee) - dist(b.c, tee))[0];
    if (mapped) tee = mapped.c;
    const len = dist(tee, pr.cp.c);
    if (len < 180 || len > 640) continue;
    holes.push({ tee, mid: pr.f.o, green: pr.cp.c, comp: pr.cp, len });
  }
  // par 3s: green complexes without a fairway; tee from a mapped tee 100–230m away, else left without a tee
  for (const cp of comps) {
    if (usedComp.has(cp) || cp.members.length === 0) continue;
    const t = tees.map((x) => ({ x, d: dist(x.c, cp.c) })).filter((z) => z.d > 90 && z.d < 240).sort((a, b) => a.d - b.d)[0];
    holes.push({ tee: t ? t.x.c : null, mid: null, green: cp.c, comp: cp, len: t ? t.d : 0, par3: true });
  }
  if (holes.length < 6) return [];
  // routing: the next hole's tee is close to the previous hole's green. Greedy chain from the hole whose
  // tee is farthest from any green (often #1 by the clubhouse is not detectable) — numbers are estimates.
  const remaining = holes.slice();
  const ordered = [];
  const start = remaining.filter((h) => h.tee).sort((a, b) => Math.min(...holes.filter((x) => x !== b).map((x) => dist(x.green, b.tee))) - Math.min(...holes.filter((x) => x !== a).map((x) => dist(x.green, a.tee))))[0] || remaining[0];
  let cur = start; remaining.splice(remaining.indexOf(cur), 1); ordered.push(cur);
  while (remaining.length) {
    let best = null, bd = Infinity;
    for (const h of remaining) { const d0 = dist(cur.green, h.tee || h.green) - (h.tee ? 0 : 150); if (d0 < bd) { bd = d0; best = h; } }
    remaining.splice(remaining.indexOf(best), 1); ordered.push(best); cur = best;
  }
  return ordered.map((h, i) => {
    const y = h.len / 0.9144;
    return { k: String(i + 1), tee: r6(h.tee), mid: r6(h.mid), green: r6(h.green), par: h.par3 ? 3 : y < 250 ? 3 : y < 470 ? 4 : 5 };
  });
}

const idx = JSON.parse(fs.readFileSync(`${DIR}/courses-jp.json`, 'utf8'));
let n = 0, holesN = 0;
for (const c of idx.courses) {
  if (!c.d || (c.hm || 0) >= 3 || (only && c.id !== only)) continue;
  const f = `${DIR}/c/${c.id}.json`;
  if (!fs.existsSync(f)) continue;
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const est = estimate(d);
  if (est.length >= 6) { d.est = est; fs.writeFileSync(f, JSON.stringify(d)); c.em = est.length; n++; holesN += est.length; }
  else if (d.est) { delete d.est; fs.writeFileSync(f, JSON.stringify(d)); delete c.em; }
}
fs.writeFileSync(`${DIR}/courses-jp.json`, JSON.stringify(idx));
console.log(`courses with estimated holes: ${n}, holes: ${holesN}`);
