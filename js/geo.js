// Pure geometry used by the rangefinder (unit-tested in tools/test).
import { dist, bearing, xy, unxy } from './util.js';

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

/**
 * A pin from a 3x3 choice (row: -1 front, 0 middle, 1 back; col: -1 left, 0 centre, 1 right), as seen from `from`.
 * With an outline the pin sits 60% of the way from the centre to that edge; without one a typical green (≈28 m deep, 24 m wide) is assumed.
 */
export function pinPreset(green, center, from, row, col) {
  if (!center) return null;
  if (!from || dist(from, center) < 5) return { ...center };
  const b = (bearing(from, center) * Math.PI) / 180, ux = Math.sin(b), uy = Math.cos(b);
  // distance from the centre to the outline along a direction (dx, dy), or null without a usable outline
  const pts = green?.pts?.length >= 3 ? green.pts.map((q) => xy(center, q)) : null;
  const edge = (dx, dy) => {
    if (!pts) return null;
    let best = null;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], c = pts[(i + 1) % pts.length], ex = c.x - a.x, ey = c.y - a.y;
      const den = dx * ey - dy * ex; if (Math.abs(den) < 1e-9) continue;
      const t = (a.x * ey - a.y * ex) / den, u = (a.x * dy - a.y * dx) / den;
      if (t > 0 && u >= 0 && u <= 1 && (best == null || t < best)) best = t;
    }
    return best != null && best >= 3 && best <= 40 ? best : null;
  };
  const hi = edge(ux, uy) ?? 14, lo = -(edge(-ux, -uy) ?? 14);
  const right = edge(uy, -ux) ?? 12, left = -(edge(-uy, ux) ?? 12);
  const at = (v, a, z) => (v < 0 ? a * 0.6 : v > 0 ? z * 0.6 : 0); // 0.6 of the way from the centre to the edge
  const along = at(row, lo, hi), side = at(col, left, right);
  return unxy(center, { x: along * ux + side * uy, y: along * uy - side * ux });
}
