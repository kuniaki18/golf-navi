// Picking the course automatically on arrival (by car): pure decisions, unit-tested in tools/test/autocourse.test.mjs.
import { dist } from './util.js';

const MARGIN = 0.0015;      // ≈150 m around the course outline (the car park and clubhouse are often just outside it)
const NEAR_M = 700;         // courses without an outline: this close to the centre
const SLOW_MS = 8.4;        // ≈30 km/h — driving into the car park, not past the course
const SLOW_DWELL = 15000;   // slow and inside this long
const ANY_DWELL = 90000;    // or inside this long at any speed (stuck in traffic beside the course still counts)
const HOLD_MS = 6 * 3600e3; // a course the player picked by hand while at the club is not overridden for this long

/** courses the point is at: inside the outline (+ margin) or near the centre, nearest centre first */
export function coursesAt(all, p) {
  const out = [];
  for (const c of all) {
    const b = c.bounds;
    const inside = b && p.lat >= b[0] - MARGIN && p.lat <= b[2] + MARGIN && p.lon >= b[1] - MARGIN && p.lon <= b[3] + MARGIN;
    const d = dist(p, c);
    if (inside || (!b && d < NEAR_M)) out.push({ c, d });
  }
  return out.sort((a, b) => a.d - b.d).map((x) => x.c);
}

/** speed (m/s) from the fix, else from the previous fix */
export function speedOf(fix, prev) {
  if (Number.isFinite(fix.speed) && fix.speed >= 0) return fix.speed;
  if (!prev || fix.t - prev.t < 1000) return null;
  return dist(prev, fix) / ((fix.t - prev.t) / 1000);
}

/**
 * What to do with a new position.
 * mem: { since: {courseId: firstSeenAt}, slowSince, prev } (kept by the caller between fixes)
 * ctx: { all, current, auto, round, rejected: {courseId: true}, hold: { at, lat, lon } | null, now }
 * returns { action: 'select' | 'ask' | null, course, others }
 */
export function decide(fix, mem, ctx) {
  const here = coursesAt(ctx.all, fix);
  const v = speedOf(fix, mem.prev);
  mem.prev = fix;
  // time inside each course (reset when the player leaves it)
  const since = {};
  for (const c of here) since[c.id] = mem.since?.[c.id] ?? fix.t;
  mem.since = since;
  if (v != null && v <= SLOW_MS) mem.slowSince ??= fix.t; else if (v != null) mem.slowSince = null;
  const none = { action: null, course: null, others: [] };
  if (!here.length) return none;
  // already on one of the courses here (e.g. the VIP and Royal courses of one club): nothing to do
  if (ctx.current && here.some((c) => c.id === ctx.current.id || c.id === ctx.current.osmId)) return none;
  const cands = here.filter((c) => !ctx.rejected?.[c.id]);
  if (!cands.length) return none;
  // picked by hand while at (or near) this club: leave it
  if (ctx.hold && ctx.now - ctx.hold.at < HOLD_MS && cands.some((c) => dist(ctx.hold, c) < 3000)) return none;
  const best = cands[0], others = cands.slice(1);
  const inside = fix.t - since[best.id];
  const arrived = (mem.slowSince != null && fix.t - mem.slowSince >= SLOW_DWELL && inside >= SLOW_DWELL) || inside >= ANY_DWELL;
  if (!arrived) return none;
  // never switch courses by itself during a round, or when the player turned automatic selection off
  return { action: ctx.auto && !ctx.round ? 'select' : 'ask', course: best, others };
}
