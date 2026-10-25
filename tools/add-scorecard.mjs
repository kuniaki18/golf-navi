// Add an official scorecard (par / yards per tee) for a course, with checks:
//  - par 3–6, yardages 50–700, back ≥ regular ≥ ladies, totals = the published totals (when given)
//  - courses with mapped holes: the map's hole lengths must agree with the card (≤ 15% median difference), and the
//    card's courses are put in the same order as the map's courses (sets) so 東 / 西 land on the right holes
//   node tools/add-scorecard.mjs <file.json>   file: { id, name?, source, courses: [{ name, holes: [{par,yd,back?,ladies?}] }], totals?: { yd, back?, ladies? } }
import fs from 'node:fs';
import { buildHoles } from '../js/osm.js';

const R = 6371008.8, rad = Math.PI / 180;
const dist = (a, b) => { const dLa = (b.lat - a.lat) * rad, dLo = (b.lon - a.lon) * rad; const s = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
const ROOT = new URL('../', import.meta.url);
const read = (p) => JSON.parse(fs.readFileSync(new URL(p, ROOT), 'utf8'));

export function check(card) {
  const errs = [];
  for (const c of card.courses) {
    if (![9, 18].includes(c.holes.length)) errs.push(`${c.name}: ${c.holes.length} holes`);
    c.holes.forEach((h, i) => {
      if (![3, 4, 5, 6].includes(h.par)) errs.push(`${c.name} ${i + 1}: par ${h.par}`);
      if (!(h.yd >= 50 && h.yd <= 700)) errs.push(`${c.name} ${i + 1}: yd ${h.yd}`);
      if (h.back != null && h.back < h.yd) errs.push(`${c.name} ${i + 1}: back ${h.back} < ${h.yd}`);
      if (h.ladies != null && h.ladies > h.yd) errs.push(`${c.name} ${i + 1}: ladies ${h.ladies} > ${h.yd}`);
      if (h.front != null && h.front > h.yd) errs.push(`${c.name} ${i + 1}: front ${h.front} > ${h.yd}`);
      if (h.par === 4 && h.yd > 500) errs.push(`${c.name} ${i + 1}: par 4 with ${h.yd} y (par / yards swapped?)`);
      if (h.par === 3 && h.yd > 290) errs.push(`${c.name} ${i + 1}: par 3 with ${h.yd} y`);
      if (h.par === 5 && h.yd < 380) errs.push(`${c.name} ${i + 1}: par 5 with ${h.yd} y`);
    });
  }
  const sum = (k) => card.courses.reduce((a, c) => a + c.holes.reduce((s, h) => s + (h[k] || 0), 0), 0);
  for (const k of ['yd', 'back', 'ladies']) if (card.totals?.[k] != null && sum(k) !== card.totals[k]) errs.push(`total ${k}: holes add up to ${sum(k)}, published ${card.totals[k]}`);
  return errs;
}

/** map hole lengths (yards) per set and hole number */
function mapLengths(id) {
  const f = new URL(`data/c/${id}.json`, ROOT);
  if (!fs.existsSync(f)) return null;
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!d.holes?.length) return null;
  const P = (flat, i) => ({ lat: flat[i], lon: flat[i + 1] });
  const pts = (flat) => { const o = []; for (let i = 0; i < flat.length; i += 2) o.push(P(flat, i)); return o; };
  const feats = { holes: d.holes.filter((h) => h.g?.length >= 4).map((h) => ({ ref: h.r ? Number(h.r) : null, par: h.p, pts: pts(h.g), distTag: h.d })), greens: [], tees: [], bunkers: [], water: [], fairways: [], pins: [] };
  const holes = buildHoles(feats, {});
  const sets = {};
  for (const h of holes) if (h.no <= 18 && h.lengthM) (sets[h.set || 0] ??= {})[h.no] = { y: h.lengthM / 0.9144, par: h.parEst ? null : h.par };
  return sets;
}

function main() {
  const card = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const idx = read('data/courses-jp.json');
  const c = idx.courses.find((x) => x.id === card.id);
  if (!c) throw new Error('unknown course ' + card.id);
  const errs = check(card);
  // agree with the map
  const ml = mapLengths(card.id);
  if (ml) {
    const sets = Object.keys(ml).map(Number);
    // the map's line may start at any tee: compare with the closest tee of the card
    const err = (course, set) => { const d = course.holes.map((h, i) => (ml[set][i + 1] ? Math.min(...['yd', 'back', 'front', 'ladies'].filter((t) => h[t]).map((t) => Math.abs(ml[set][i + 1].y - h[t]) / h[t])) : null)).filter((x) => x != null).sort((a, b) => a - b); return d.length >= 4 ? d[d.length >> 1] : null; };
    const parDiff = (course, set) => course.holes.map((h, i) => [i + 1, h.par, ml[set][i + 1]?.par]).filter(([, a, b]) => b && a !== b);
    if (sets.length === card.courses.length && sets.length > 1) {
      // choose the order of the card's courses that best fits the map's sets
      const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
      let best = null;
      for (const p of perms(card.courses.map((_, i) => i))) { const e = p.map((ci, si) => err(card.courses[ci], sets[si])); const m = Math.max(...e.map((x) => x ?? 0)); if (!best || m < best.m) best = { p, m, e }; }
      card.courses = best.p.map((i) => card.courses[i]);
      console.log('map check: order', card.courses.map((k) => k.name).join(' / '), 'median length difference', best.e.map((x) => x == null ? '-' : (x * 100).toFixed(0) + '%').join(' / '));
      card.courses.forEach((k, i) => { const pd = parDiff(k, sets[i]); if (pd.length) { console.log(`  par differs from the map on ${k.name}:`, pd.map(([n, a, b]) => `${n}番 card ${a} / map ${b}`).join(', ')); if (pd.length > 3) errs.push(`${k.name}: par differs from the map on ${pd.length} holes`); } });
      if (best.m > 0.15) errs.push(`map lengths disagree with the card (${(best.m * 100).toFixed(0)}%)`);
    } else if (sets.length === 1 && card.courses.length === 1) {
      const e = err(card.courses[0], sets[0]);
      console.log('map check: median length difference', e == null ? '-' : (e * 100).toFixed(0) + '%');
      if (e != null && e > 0.15) errs.push(`map lengths disagree with the card (${(e * 100).toFixed(0)}%)`);
    } else console.log('map check: skipped (map has', sets.length, 'courses, card', card.courses.length + ')');
  }
  if (errs.length) { console.error('NOT ADDED:\n  ' + errs.join('\n  ')); process.exit(1); }
  const out = { name: card.name || c.n, source: card.source, courses: card.courses.map((k) => ({ name: k.name, holes: k.holes.map((h) => { const o = { par: h.par, yd: h.yd }; for (const t of ['back', 'front', 'ladies']) if (h[t] != null) o[t] = h[t]; return o; }) })) };
  fs.writeFileSync(new URL(`data/sc/${card.id}.json`, ROOT), JSON.stringify(out));
  c.sc = 1;
  fs.writeFileSync(new URL('data/courses-jp.json', ROOT), JSON.stringify(idx));
  // keep the flag through re-extraction
  const fixF = new URL('tools/name-fix.json', ROOT); const fix = JSON.parse(fs.readFileSync(fixF, 'utf8'));
  fix[card.id] = { ...(fix[card.id] || {}), sc: 1 }; fs.writeFileSync(fixF, JSON.stringify(fix, null, 2));
  console.log('added', c.n, out.courses.map((k) => `${k.name || '18H'} ${k.holes.length}H par ${k.holes.reduce((a, h) => a + h.par, 0)} ${k.holes.reduce((a, h) => a + h.yd, 0)}y`).join(' | '));
}
if (process.argv[2]) main();
