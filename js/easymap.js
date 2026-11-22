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

/**
 * Hands-free caddie at the ball: true once the player has stood still for `sec` seconds at a new spot on the hole
 * (away from the tee, 30–280 y from the pin, and 25 m on from where the caddie last spoke).
 * st: { anchor, since } kept by the caller; returns { st, speak }
 */
export function atBall(st, p, t, { pin, tee, last, acc = 5, sec = 8, maxAcc = 15 } = {}) {
  if (!pin || !(acc <= maxAcc)) return { st: null, speak: false };
  const toPin = dist(p, pin);
  if (toPin < 27 || toPin > 256 || (tee && dist(p, tee) < 30) || (last && dist(p, last) < 25)) return { st: null, speak: false };
  // still = within 4 m of where the player stopped
  if (!st?.anchor || dist(st.anchor, p) > 4) return { st: { anchor: p, since: t }, speak: false };
  return { st, speak: t - st.since >= sec * 1000 };
}
