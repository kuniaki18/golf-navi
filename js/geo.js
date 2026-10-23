// Pure geometry used by the rangefinder (unit-tested in tools/test).
import { dist, bearing, xy } from './util.js';

const m2y = (m) => m / 0.9144;

/**
 * Distances (yards) from p to a green: center, and front/back along the line of play.
 * Front/back come only from the green outline; without an outline they are null (never invented).
 */
export function greenDistances(p, green, center) {
  const out = { center: m2y(dist(p, center)), front: null, back: null };
  const pts = green?.pts;
  if (!pts || pts.length < 3) return out;
  const b = (bearing(p, center) * Math.PI) / 180, ux = Math.sin(b), uy = Math.cos(b);
  let lo = Infinity, hi = -Infinity;
  // project the outline onto the line of play; only edge points within 18m of the line count
  for (const q of pts) {
    const { x, y } = xy(p, q);
    const along = x * ux + y * uy, off = Math.abs(x * uy - y * ux);
    if (off > 18) continue;
    lo = Math.min(lo, along); hi = Math.max(hi, along);
  }
  if (!isFinite(lo) || hi - lo < 1) return out;
  out.front = m2y(lo); out.back = m2y(hi);
  return out;
}

/** greens near a point (for 2-green systems): the closest outlines within `within` meters */
export function greensAround(greens, c, within = 70) {
  return (greens || []).filter((g) => g.c).map((g) => ({ g, d: dist(g.c, c) })).filter((x) => x.d <= within).sort((a, b) => a.d - b.d).map((x) => x.g);
}

/** small, stable hash of a green's geometry: used as a cache key that survives hole renumbering */
export function greenKey(green, center) {
  const c = green?.c || center;
  if (!c) return '';
  const n = green?.pts?.length || 0;
  return `${c.lat.toFixed(5)},${c.lon.toFixed(5)}:${n}`;
}
