// Easy hole registration during a round (かんたん登録): the green registers itself when the player stands on a
// mapped green for a while, and the round moves on to the next hole after the score is in and the player walks off.
// Pure; unit-tested.
import { dist } from './util.js';

/** point-in-polygon (lat/lon ring), with a margin in metres around the green */
function inside(p, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.lat > p.lat) !== (b.lat > p.lat) && p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon) c = !c;
  }
  return c;
}
/** the mapped green the player is standing on (or within `margin` m of its edge), or null */
export function greenUnder(p, greens, margin = 4) {
  let best = null, bd = Infinity;
  for (const g of greens || []) {
    if (!g?.c) continue;
    const d = dist(p, g.c);
    if (d > 60) continue;
    const on = g.pts?.length >= 3 ? inside(p, g.pts) || g.pts.some((q) => dist(p, q) <= margin) : d <= 12;
    if (on && d < bd) { bd = d; best = g; }
  }
  return best;
}

/**
 * dwell on a green: call with every position fix. Returns the green once the player has stayed on it for `sec` s.
 * state: { g, since } kept by the caller between calls.
 */
export function dwellOnGreen(st, p, t, greens, { sec = 15, maxAcc = 15, acc = 5 } = {}) {
  if (!(acc <= maxAcc)) return { st, green: null };
  const g = greenUnder(p, greens);
  if (!g) return { st: { g: null, since: 0 }, green: null };
  if (st?.g !== g) return { st: { g, since: t }, green: null };
  return { st, green: t - st.since >= sec * 1000 ? g : null };
}

/** move on: the score of this hole is in, its green is known and the player has walked off it */
export function shouldAdvance({ strokes, green, me, hasNext, walkedOff = 50 }) {
  return !!(strokes && green && me && hasNext && dist(me, green) > walkedOff);
}
