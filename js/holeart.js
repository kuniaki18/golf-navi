// Course-guide style hole illustration drawn on the hole canvas instead of the aerial photo:
// trees along a rough corridor, fairway, bunkers, water, tee boxes and the green, all from the map data
// (OSM outlines + the hole's tee/green). Where the map has no fairway the band is an estimate.
import { dist } from './util.js';

const C = {
  bg: '#eef2ea', treeDark: '#2f6a22', tree: '#4f8f2a', treeLight: '#8cc63f', roughEdge: '#3f7a2b', rough: '#5a9f3d',
  fairway: '#8ccb5e', fairwayStripe: 'rgba(255,255,255,.07)', green: '#9edb72', fringe: '#6fb84c', tee: '#9edb72',
  sand: '#f1e8cc', sandEdge: '#d9c894', water: '#2f7fd6', waterEdge: '#9cc8f5',
};

// deterministic pseudo-random so the trees don't jump between frames
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const seedOf = (p) => Math.floor(Math.abs(p.lat * 1e5) + Math.abs(p.lon * 1e5) * 7);

/** point to polyline distance in screen px */
function distToLine(p, line) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

/** points every `step` px along a screen polyline, with the unit normal at each */
function densify(line, step) {
  const out = [];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], len = Math.hypot(b.x - a.x, b.y - a.y) || 1, nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    for (let d = 0; d < len; d += step) out.push({ x: a.x + ((b.x - a.x) * d) / len, y: a.y + ((b.y - a.y) * d) / len, nx, ny });
  }
  const l = line[line.length - 1], p = out[out.length - 1];
  out.push({ x: l.x, y: l.y, nx: p?.nx ?? 1, ny: p?.ny ?? 0 });
  return out;
}

function strokeLine(ctx, line, width, color) {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = width; ctx.strokeStyle = color;
  ctx.beginPath(); line.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.stroke();
}

function tree(ctx, x, y, r, rnd) {
  ctx.fillStyle = C.treeDark; ctx.beginPath(); ctx.arc(x + r * 0.15, y + r * 0.2, r, 0, 7); ctx.fill();
  ctx.fillStyle = rnd() < 0.5 ? C.tree : '#5c9c2c'; ctx.beginPath(); ctx.arc(x, y, r * 0.9, 0, 7); ctx.fill();
  ctx.fillStyle = C.treeLight; ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.42, 0, 7); ctx.fill();
}

/**
 * Paint the hole. f/S come from HoleView (frame and lat/lon → screen); returns { estimated } so the caller can label
 * a drawing whose fairway or green had to be guessed.
 */
export function drawHoleArt(ctx, f, S, d) {
  const h = d.hole, W = f.W, H = f.H;
  const pxPerM = f.s / (156543.03 * Math.cos((f.green.lat * Math.PI) / 180));
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
  const geo = h.line?.length >= 2 ? h.line : [h.tee || f.origin, f.green].filter(Boolean);
  if (geo.length < 2) return { estimated: true };
  let line = geo.map(S);
  // extend a little behind the tee and past the green
  const ext = (a, b, m) => { const len = Math.hypot(a.x - b.x, a.y - b.y) || 1; return { x: a.x + ((a.x - b.x) / len) * m * pxPerM, y: a.y + ((a.y - b.y) / len) * m * pxPerM }; };
  const n = line.length;
  line = [ext(line[0], line[1], 18), ...line, ext(line[n - 1], line[n - 2], 22)];
  const par = h.par || 4;
  const half = (par === 3 ? 26 : 36) * pxPerM;
  const rnd = rng(seedOf(f.green));

  // trees outside the rough, both sides, a few rows
  ctx.save();
  for (const p of densify(line, Math.max(6, 9 * pxPerM))) {
    for (const side of [-1, 1]) {
      for (let row = 0; row < 3; row++) {
        if (row && rnd() < 0.35) continue;
        const off = half + (5 + row * 9 + rnd() * 6) * pxPerM;
        const r = (5 + rnd() * 4) * pxPerM;
        tree(ctx, p.x + p.nx * off * side + (rnd() - 0.5) * 4 * pxPerM, p.y + p.ny * off * side + (rnd() - 0.5) * 4 * pxPerM, Math.max(3, r), rnd);
      }
    }
  }
  ctx.restore();

  // rough corridor
  strokeLine(ctx, line, half * 2 + 3 * pxPerM, C.roughEdge);
  strokeLine(ctx, line, half * 2, C.rough);

  const near = (arr, extra) => (arr || []).filter((x) => x.c && x.pts?.length && distToLine(S(x.c), line) < half + extra * pxPerM);
  const poly = (pts) => { ctx.beginPath(); pts.forEach((p, i) => { const q = S(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.closePath(); };

  // fairway: mapped outlines, else an estimated band from the landing area to the front of the green
  const fws = near(d.features?.fairways, 10);
  let estimated = false;
  if (fws.length) {
    for (const fw of fws) { poly(fw.pts); ctx.fillStyle = C.fairway; ctx.fill(); }
  } else if (par >= 4 && h.tee) {
    estimated = true;
    const total = dist(h.tee, f.green), from = Math.min(total * 0.38, 175), to = Math.max(from + 20, total - 22);
    const pts = densify(geo.map(S), 2);
    const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    const seg = pts.filter((_, i) => cum[i] / pxPerM >= from && cum[i] / pxPerM <= to);
    if (seg.length > 1) strokeLine(ctx, seg, (par === 5 ? 34 : 30) * pxPerM, C.fairway);
  }

  // water and bunkers
  for (const w of near(d.features?.water, 40)) { poly(w.pts); ctx.fillStyle = C.water; ctx.fill(); ctx.strokeStyle = C.waterEdge; ctx.lineWidth = 2; ctx.stroke(); }
  for (const b of near(d.features?.bunkers, 15)) { poly(b.pts); ctx.fillStyle = C.sand; ctx.fill(); ctx.strokeStyle = C.sandEdge; ctx.lineWidth = 1.2; ctx.stroke(); }

  // tee boxes
  const tees = near(d.features?.tees, 0).filter((t) => h.tee && dist(t.c, h.tee) < 60);
  if (tees.length) for (const t of tees) { poly(t.pts); ctx.fillStyle = C.tee; ctx.fill(); ctx.strokeStyle = C.fringe; ctx.lineWidth = 1; ctx.stroke(); }
  else if (h.tee) {
    const t = S(h.tee), a = Math.atan2(S(f.green).y - t.y, S(f.green).x - t.x);
    ctx.save(); ctx.translate(t.x, t.y); ctx.rotate(a); ctx.fillStyle = C.tee;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-9 * pxPerM, -6 * pxPerM, 18 * pxPerM, 12 * pxPerM, 3) : ctx.rect(-9 * pxPerM, -6 * pxPerM, 18 * pxPerM, 12 * pxPerM); ctx.fill(); ctx.restore();
  }

  // green: mapped outline or an estimated oval
  if (h.green?.pts?.length) {
    poly(h.green.pts); ctx.lineWidth = 3 * pxPerM; ctx.strokeStyle = C.fringe; ctx.stroke(); ctx.fillStyle = C.green; ctx.fill();
  } else {
    estimated = true;
    const g = S(f.green), a = Math.atan2(g.y - line[line.length - 2].y, g.x - line[line.length - 2].x);
    ctx.save(); ctx.translate(g.x, g.y); ctx.rotate(a);
    ctx.fillStyle = C.fringe; ctx.beginPath(); ctx.ellipse(0, 0, 17 * pxPerM, 13 * pxPerM, 0, 0, 7); ctx.fill();
    ctx.fillStyle = C.green; ctx.beginPath(); ctx.ellipse(0, 0, 15 * pxPerM, 11 * pxPerM, 0, 0, 7); ctx.fill();
    ctx.restore();
  }
  return { estimated };
}
