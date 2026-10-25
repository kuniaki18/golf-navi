// Turn a per-hole table read from a course guide page into a checked scorecard (see add-scorecard.mjs).
//   node tools/card-from-table.mjs <courseId> <sourceUrl> <table.json> [teePrefix]
// table.json: { courses: [{ name, teeNames: [...], holes: [{ no, par, yards: [...] }] }], teeTotals: { course: { tee: total } } }
// Tee roles from the names: back = Back/Blue/Black/Champion/バック (longest), regular = Regular/Reg/White/レギュラー,
// front = Front/フロント, ladies = Ladies/Red/レディース. When a club lists several green sets (A / B), teePrefix picks one.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const [id, source, file, prefix] = process.argv.slice(2);
const t = JSON.parse(fs.readFileSync(file, 'utf8'));
const role = (n) => {
  const s = String(n).toLowerCase();
  if (/ladies|lady|red|レディース|レディ|赤/.test(s)) return 'ladies';
  if (/front|フロント|gold|ゴールド|シニア|senior/.test(s)) return 'front';
  if (/reg|white|レギュラー|白/.test(s)) return 'yd';
  if (/back|blue|black|champ|バック|青|黒|tournament|トーナメント|フル/.test(s)) return 'back';
  return null;
};
const nameOf = (c, i, all) => (all.length === 1 ? '' : String(c.name || '').replace(/(コース|course)$/i, '').trim() || `${i + 1}`);
const totals = {};
const courses = t.courses.map((c, i, all) => {
  // tees in use: optionally only one green set (e.g. 'A')
  let idx = c.teeNames.map((n, k) => ({ n, k })).filter((x) => !prefix || String(x.n).startsWith(prefix));
  const roles = {};
  for (const x of idx) { const r = role(String(x.n).replace(prefix || '', '')); if (r && roles[r] == null) roles[r] = x.k; }
  // a 'tournament' and a 'back' tee: keep the back as back (the tournament tee is rarely played)
  const tb = idx.find((x) => /tournament|トーナメント|champ/i.test(x.n)), bk = idx.find((x) => /back|バック/i.test(x.n));
  if (tb && bk) roles.back = bk.k;
  if (roles.yd == null) { // no regular named: the middle tee by length
    const byLen = idx.map((x) => ({ ...x, s: c.holes.reduce((a, h) => a + (h.yards[x.k] || 0), 0) })).sort((a, b) => b.s - a.s);
    const used = new Set(Object.values(roles));
    const mid = byLen.filter((x) => !used.has(x.k));
    if (mid.length) roles.yd = mid[Math.floor((mid.length - 1) / 2)].k;
  }
  if (roles.yd == null) throw new Error(`${c.name}: no regular tee among ${c.teeNames.join(', ')}`);
  const tt = t.teeTotals?.[c.name] || {};
  for (const [r, k] of Object.entries(roles)) { const v = tt[c.teeNames[k]]; if (v != null) totals[r] = (totals[r] || 0) + v; }
  return { name: nameOf(c, i, all), holes: c.holes.map((h) => { const o = { par: h.par }; for (const [r, k] of Object.entries(roles)) if (h.yards[k] != null) o[r] = h.yards[k]; return o; }) };
});
// totals only when every course had them for that tee
for (const r of Object.keys(totals)) if (!t.courses.every((c) => Object.keys(t.teeTotals?.[c.name] || {}).some((n) => courses.length && n))) delete totals[r];
const card = { id, source: `公表されているコース情報（パー・ヤード）${source}`, totals, courses };
const out = file.replace(/\.json$/, '.card.json');
fs.writeFileSync(out, JSON.stringify(card));
process.stdout.write(execFileSync(process.execPath, [new URL('./add-scorecard.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), out], { encoding: 'utf8' }));
