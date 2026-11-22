// Reading a photographed scorecard into a round: course name matching, which row is me, the date, the round.
// Pure; unit-tested (tools/test/cardrecord.test.mjs). The screen is in cardrecord.js.
import { fmtDate, uid } from './util.js';

const norm = (s) => String(s || '').normalize('NFKC').toLowerCase()
  .replace(/【[^】]*】|\([^)]*\)|（[^）]*）/g, '')
  .replace(/ゴルフ倶楽部|ゴルフクラブ|golf ?club|\bgc\b/g, 'gc').replace(/カントリー倶楽部|カントリークラブ|country ?club|\bcc\b/g, 'cc')
  .replace(/ゴルフ場|ゴルフコース|golf ?course|コース|course/g, '').replace(/[\s・･\-_.。、]/g, '');

/** longest common substring: [length, start in a, start in b] */
function lcs(a, b) {
  let best = [0, 0, 0]; const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) { const t = prev[j]; prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0; if (prev[j] > best[0]) best = [prev[j], i - prev[j], j - prev[j]]; diag = t; }
  }
  return best;
}
/** characters of a covered by common pieces (2+ characters) with b, e.g. 「ピートダイ」+「ロイヤル」 */
function covered(a, b) {
  let n = 0;
  for (;;) {
    const [l, i, j] = lcs(a, b); if (l < 2) return n;
    n += l; a = a.slice(0, i) + '\u0000' + a.slice(i + l); b = b.slice(0, j) + '\u0001' + b.slice(j + l);
  }
}

/** the course list entry whose name best matches the name read from the card (or null when nothing is close) */
export function matchCourseName(name, list) {
  const n = norm(name); if (n.length < 2) return null;
  let best = null, bs = 0;
  for (const c of list) {
    const m = norm(c.name); if (!m) continue;
    const s = covered(n, m) / Math.max(3, Math.min(n.length, m.length));
    if (s > bs || (s === bs && best && m.length < norm(best.name).length)) { bs = s; best = c; }
  }
  return bs >= 0.6 ? best : null;
}

/** which row is the player: same name as in the settings, else the only row, else unknown (-1) */
export function pickMe(players, myName) {
  const n = norm(myName);
  if (n) { const i = players.findIndex((p) => norm(p.name) === n || (norm(p.name).length >= 2 && (n.includes(norm(p.name)) || norm(p.name).includes(n)))); if (i >= 0) return i; }
  return players.length === 1 ? 0 : -1;
}

/** the round's date: from the card, else from the photo, else today (YYYY-MM-DD) */
export function cardDate(read, fileTime, now = Date.now()) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(read || '') && Math.abs(new Date(read) - now) < 400 * 864e5) return read;
  return fmtDate(new Date(Number.isFinite(fileTime) && fileTime > 0 && fileTime <= now ? fileTime : now));
}

/** a saved round from the card: my row becomes the scorecard, the others are the day's members */
export function roundFromCard(res, { date, course, courseId, me, pars }) {
  const par = (i) => { const p = res.par?.[i] ?? pars?.[i]; return p >= 3 && p <= 6 ? p : 4; };
  const mine = me >= 0 ? res.players[me] : null;
  const holes = Array.from({ length: 18 }, (_, i) => ({ par: par(i), strokes: mine?.holes[i] ?? null, putts: mine?.putts?.[i] ?? null, penalties: 0, fw: null, sand: 0 }));
  const players = res.players.filter((_, i) => i !== me).map((p) => ({ id: uid(), name: p.name, holes: p.holes, total: p.total || null }));
  return { id: uid(), date, course, courseId: courseId || null, holes, players, saved: true, fromCard: true };
}

