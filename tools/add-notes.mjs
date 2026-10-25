// Per-hole course-guide notes, stored next to the official scorecard in the same course / hole order.
//   node tools/add-notes.mjs <notes.json>
// notes.json: { id, source, courses: { "<scorecard course name, '' for an 18-hole card>": ["hole 1 note", …] } }
// Notes are short summaries of the facts (uphill, OB side, slope, bunkers) written in our own words, not copies.
import fs from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const n = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sc = JSON.parse(fs.readFileSync(new URL(`data/sc/${n.id}.json`, ROOT), 'utf8'));
const errs = [];
const courses = sc.courses.map((c) => {
  const list = n.courses[c.name || ''] ?? (sc.courses.length === 1 ? Object.values(n.courses)[0] : null);
  if (!list) { errs.push(`no notes for course "${c.name}"`); return { holes: [] }; }
  if (list.length !== c.holes.length) errs.push(`${c.name || '18H'}: ${list.length} notes for ${c.holes.length} holes`);
  for (const [i, t] of list.entries()) if (t != null && (typeof t !== 'string' || t.length > 70)) errs.push(`${c.name || ''} ${i + 1}: note must be a string of at most 70 characters`);
  return { holes: list.map((t) => t || null) };
});
if (errs.length) { console.error('NOT ADDED:\n  ' + errs.join('\n  ')); process.exit(1); }
fs.mkdirSync(new URL('data/notes/', ROOT), { recursive: true });
fs.writeFileSync(new URL(`data/notes/${n.id}.json`, ROOT), JSON.stringify({ source: n.source, courses }));
console.log('notes added', n.id, courses.map((c) => c.holes.filter(Boolean).length).join('/'));
