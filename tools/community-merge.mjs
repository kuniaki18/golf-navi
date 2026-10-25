// Runs in GitHub Actions every few hours: pull hole registrations from the public relay, validate them,
// and merge into data/community/<courseId>.json (median of everyone's taps per hole).
import fs from 'node:fs';
const TOPIC = process.env.TOPIC || 'kunikuni-golf-holes-v1';
const STATE = 'data/community/_state.json';
// test / mistaken submissions that must never be merged
const BLOCKED = fs.existsSync('data/community/_blocked.json') ? JSON.parse(fs.readFileSync('data/community/_blocked.json', 'utf8')) : { ids: [], by: [] };
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { since: '12h' };
const courses = new Map(JSON.parse(fs.readFileSync('data/courses-jp.json', 'utf8')).courses.map((c) => [c.id, c]));

const R = 6371008.8, rad = Math.PI / 180;
const dist = (a, b) => { const dLa = (b.lat - a.lat) * rad, dLo = (b.lon - a.lon) * rad; const s = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
const ok = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

const res = await fetch(`https://ntfy.sh/${TOPIC}/json?poll=1&since=${encodeURIComponent(st.since)}`);
const lines = (await res.text()).split('\n').filter(Boolean);
let accepted = 0, rejected = 0, lastId = st.since;
const touched = new Set();
for (const line of lines) {
  let m; try { m = JSON.parse(line); } catch { continue; }
  if (m.event !== 'message') continue;
  lastId = m.id;
  if (BLOCKED.ids.includes(m.id)) { rejected++; continue; }
  let s; try { s = JSON.parse(m.message); } catch { rejected++; continue; }
  if (BLOCKED.by.includes(s.by)) { rejected++; continue; }
  const c = courses.get(s.courseId);
  if (s.t === 'sc') {
    // scorecard: 1–4 courses of 9 / 18 holes, par 3–6, 50–700 y
    const cs = Array.isArray(s.courses) ? s.courses.slice(0, 4) : [];
    const valid = c && cs.length && cs.every((k) => Array.isArray(k.holes) && [9, 18].includes(k.holes.length) && k.holes.every((h) => [3, 4, 5, 6].includes(h.par) && h.yd >= 50 && h.yd <= 700 && (h.back == null || (h.back >= h.yd && h.back <= 750))));
    if (!valid) { rejected++; continue; }
    const f = `data/community/${s.courseId}.json`;
    const doc = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { courseId: s.courseId, name: c.n, subs: {} };
    (doc.scSubs ??= {})[s.by] = { courses: cs.map((k) => ({ name: String(k.name || '').slice(0, 12), holes: k.holes.map((h) => (h.back != null ? { par: h.par, yd: h.yd, back: h.back } : { par: h.par, yd: h.yd })) })), at: s.at };
    fs.mkdirSync('data/community', { recursive: true });
    fs.writeFileSync(f, JSON.stringify(doc));
    touched.add(f); accepted++;
    continue;
  }
  const key = String(s.key || '');
  if (!c || !/^\d{1,2}(-\d)?$/.test(key) || !ok(s.tee) || !ok(s.green) || (s.mid && !ok(s.mid))) { rejected++; continue; }
  const center = { lat: c.a, lon: c.o };
  const reach = c.b ? dist({ lat: c.b[0], lon: c.b[1] }, { lat: c.b[2], lon: c.b[3] }) / 2 + 800 : 2500;
  const len = dist(s.tee, s.green);
  if (dist(center, s.tee) > reach || dist(center, s.green) > reach || len < 50 || len > 700 || (s.par && ![3, 4, 5, 6].includes(s.par))) { rejected++; continue; }
  const f = `data/community/${s.courseId}.json`;
  const doc = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { courseId: s.courseId, name: c.n, subs: {} };
  const list = (doc.subs[key] ??= []).filter((x) => x.by !== s.by); // one vote per device, latest wins
  list.push({ tee: s.tee, green: s.green, mid: s.mid || null, par: s.par, by: s.by, at: s.at });
  doc.subs[key] = list.slice(-15);
  fs.mkdirSync('data/community', { recursive: true });
  fs.writeFileSync(f, JSON.stringify(doc));
  touched.add(f); accepted++;
}
// rebuild the consensus holes for each touched course
for (const f of touched) {
  const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  doc.holes = {};
  for (const [key, subs] of Object.entries(doc.subs || {})) {
    const med = (k) => { const ps = subs.map((x) => x[k]).filter(Boolean); return ps.length ? { lat: median(ps.map((p) => p.lat)), lon: median(ps.map((p) => p.lon)) } : null; };
    const pars = subs.map((x) => x.par).filter(Boolean);
    doc.holes[key] = { tee: med('tee'), green: med('green'), mid: subs.filter((x) => x.mid).length * 2 > subs.length ? med('mid') : null, par: pars.length ? median(pars) : null, votes: subs.length, updatedAt: Math.max(...subs.map((x) => x.at || 0)) };
  }
  // scorecard: the version most devices agree on (ties: the newest)
  if (doc.scSubs) {
    const votes = new Map();
    for (const sub of Object.values(doc.scSubs)) { const k = JSON.stringify(sub.courses); const v = votes.get(k) || { courses: sub.courses, n: 0, at: 0 }; v.n++; v.at = Math.max(v.at, sub.at || 0); votes.set(k, v); }
    const best = [...votes.values()].sort((a, b) => b.n - a.n || b.at - a.at)[0];
    doc.scorecard = { courses: best.courses, votes: best.n, devices: Object.keys(doc.scSubs).length, updatedAt: best.at };
  }
  doc.updatedAt = new Date().toISOString();
  fs.writeFileSync(f, JSON.stringify(doc));
}
fs.writeFileSync(STATE, JSON.stringify({ since: lastId, runAt: new Date().toISOString() }));
// index of courses with community holes (for the course list badge)
const idx = {};
for (const f of fs.readdirSync('data/community')) { if (!f.endsWith('.json') || f.startsWith('_')) continue; const d = JSON.parse(fs.readFileSync('data/community/' + f, 'utf8')); idx[d.courseId] = Object.keys(d.holes || {}).length; }
fs.writeFileSync('data/community/_index.json', JSON.stringify(idx));
console.log(`messages ${lines.length}, accepted ${accepted}, rejected ${rejected}, courses ${touched.size}`);
