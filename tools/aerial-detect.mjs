// Pilot: find putting greens (and bunkers) in 国土地理院 aerial photos, and measure it against courses whose greens
// are mapped in OpenStreetMap. Nothing found here is shown as fact in the app: results are 推定 (estimates).
//   node tools/aerial-detect.mjs eval [n]        → precision / recall on n mapped courses
//   node tools/aerial-detect.mjs <courseId>      → detections for one course (JSON)
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';

const Z = 17, TILE = 256;
const CACHE = new URL('./.cache/tiles/', import.meta.url);
fs.mkdirSync(CACHE, { recursive: true });
const R = 6371008.8, rad = Math.PI / 180;
const dist = (a, b) => { const dLa = (b.lat - a.lat) * rad, dLo = (b.lon - a.lon) * rad; const s = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
const tx = (lon) => ((lon + 180) / 360) * 2 ** Z;
const ty = (lat) => ((1 - Math.log(Math.tan(lat * rad) + 1 / Math.cos(lat * rad)) / Math.PI) / 2) * 2 ** Z;
const lonOf = (x) => (x / 2 ** Z) * 360 - 180;
const latOf = (y) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** Z))) / rad;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tile(x, y) {
  const f = new URL(`${Z}_${x}_${y}.jpg`, CACHE);
  if (fs.existsSync(f)) return fs.readFileSync(f);
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${Z}/${x}/${y}.jpg`);
      if (r.status === 404) return null;
      if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); fs.writeFileSync(f, b); await sleep(60); return b; }
    } catch {}
    await sleep(800);
  }
  return null;
}

/** RGB mosaic of the course box: { w, h, px (Uint8 rgb), x0, y0 } in tile-pixel coordinates */
async function mosaic(b) {
  const x0 = Math.floor(tx(b[1])), x1 = Math.floor(tx(b[3])), y0 = Math.floor(ty(b[2])), y1 = Math.floor(ty(b[0]));
  const nx = x1 - x0 + 1, ny = y1 - y0 + 1, w = nx * TILE, h = ny * TILE;
  const px = new Uint8Array(w * h * 3);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const buf = await tile(x0 + i, y0 + j); if (!buf) continue;
    let img; try { img = jpeg.decode(buf, { useTArray: true }); } catch { continue; }
    for (let yy = 0; yy < TILE; yy++) for (let xx = 0; xx < TILE; xx++) {
      const s = (yy * img.width + xx) * 4, d = ((j * TILE + yy) * w + i * TILE + xx) * 3;
      px[d] = img.data[s]; px[d + 1] = img.data[s + 1]; px[d + 2] = img.data[s + 2];
    }
  }
  return { w, h, px, x0, y0 };
}

/** connected components of a mask (4-neighbour). [{ n, sx, sy, minX, maxX, minY, maxY, edge }] */
function components(mask, w, h, minN = 1) {
  const lab = new Int32Array(w * h).fill(-1), out = [], st = [];
  for (let p = 0; p < w * h; p++) {
    if (!mask[p] || lab[p] >= 0) continue;
    const c = { n: 0, sx: 0, sy: 0, minX: w, maxX: 0, minY: h, maxY: 0, edge: 0, id: out.length };
    st.push(p); lab[p] = c.id;
    while (st.length) {
      const q = st.pop(), x = q % w, y = (q / w) | 0;
      c.n++; c.sx += x; c.sy += y; if (x < c.minX) c.minX = x; if (x > c.maxX) c.maxX = x; if (y < c.minY) c.minY = y; if (y > c.maxY) c.maxY = y;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const r = ny * w + nx;
        if (mask[r] && lab[r] < 0) { lab[r] = c.id; st.push(r); } else if (!mask[r]) c.edge++;
      }
    }
    if (c.n >= minN) out.push(c);
  }
  return { comps: out, lab };
}

/** box blur of a Float32 field (radius r) */
function blur(f, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) { let s = 0; for (let x = -r; x <= r; x++) s += f[y * w + Math.min(w - 1, Math.max(0, x))]; for (let x = 0; x < w; x++) { tmp[y * w + x] = s / (2 * r + 1); s += f[y * w + Math.min(w - 1, x + r + 1)] - f[y * w + Math.max(0, x - r)]; } }
  for (let x = 0; x < w; x++) { let s = 0; for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]; for (let y = 0; y < h; y++) { out[y * w + x] = s / (2 * r + 1); s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; } }
  return out;
}

/** binary morphology with a square kernel (via box blur): dilate = any pixel set, erode = all pixels set */
function morph(mask, w, h, r, op) {
  if (r <= 0) return mask;
  const f = new Float32Array(w * h); for (let p = 0; p < w * h; p++) f[p] = mask[p];
  const b = blur(f, w, h, r), out = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) out[p] = op === 'dilate' ? (b[p] > 0.001 ? 1 : 0) : (b[p] > 0.999 ? 1 : 0);
  return out;
}
export const PARAMS = { smoothMax: 5.5, tint: 3, closeM: 2, openM: 3, sandL: 205, minArea: 250, maxArea: 1600, minFill: 0.6, maxAspect: 2.3, sandNear: 14, needSand: true };

/** detections in a mosaic: greens [{ lat, lon, areaM2 }], bunkers [...] */
export function detect(m, lat, P = PARAMS) {
  const { w, h, px } = m;
  const mpp = (156543.03392 * Math.cos(lat * rad)) / 2 ** Z; // metres per pixel
  const L = new Float32Array(w * h), L2 = new Float32Array(w * h);
  const grass = new Uint8Array(w * h), sand = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const r = px[p * 3], g = px[p * 3 + 1], b = px[p * 3 + 2];
    const l = 0.3 * r + 0.59 * g + 0.11 * b; L[p] = l; L2[p] = l * l;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx ? (mx - mn) / mx : 0;
    // aerial photos are often pale (winter, haze): use the green tint relative to red/blue, not saturation
    const tint = g - (r + b) / 2;
    grass[p] = tint >= P.tint && l > 50 && l < P.sandL - 12 ? 1 : 0;
    sand[p] = l >= P.sandL && Math.abs(r - g) < 14 && r - b < 60 ? 1 : 0;
  }
  // texture: local standard deviation of brightness over ~5 m; greens are mown short → very smooth
  const k = Math.max(2, Math.round(2.5 / mpp));
  const mu = blur(L, w, h, k), mu2 = blur(L2, w, h, k);
  const smooth = new Uint8Array(w * h);
  let sm = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) sm[p] = grass[p] && Math.sqrt(Math.max(0, mu2[p] - mu[p] * mu[p])) < P.smoothMax ? 1 : 0;
  // close small holes (flag, cup, shadows), then open to cut the thin collar joining a green to its fairway
  const rc = Math.round(P.closeM / mpp), ro = Math.round(P.openM / mpp);
  sm = morph(morph(sm, w, h, rc, 'dilate'), w, h, rc, 'erode');
  sm = morph(morph(sm, w, h, ro, 'erode'), w, h, ro, 'dilate');
  smooth.set(sm);
  const a1 = mpp * mpp;
  const sandC = components(sand, w, h, Math.round(15 / a1));
  const bunkers = sandC.comps.filter((c) => c.n * a1 <= 1500);
  const sandLab = sandC.lab;
  const { comps, lab } = components(smooth, w, h, Math.round(P.minArea / a1));
  comps.lab = lab;
  const greens = [];
  for (const c of comps) {
    const area = c.n * a1, bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
    const fill = c.n / (bw * bh), aspect = Math.max(bw, bh) / Math.min(bw, bh);
    if (area > P.maxArea || fill < P.minFill || aspect > P.maxAspect) continue;
    // a bunker within sandNear metres of the green's box
    const pad = Math.round(P.sandNear / mpp); let near = false;
    for (let y = Math.max(0, c.minY - pad); y <= Math.min(h - 1, c.maxY + pad) && !near; y += 2) for (let x = Math.max(0, c.minX - pad); x <= Math.min(w - 1, c.maxX + pad); x += 2) if (sandLab[y * w + x] >= 0 && bunkers.some((bk) => bk.id === sandLab[y * w + x])) { near = true; break; }
    if (P.needSand && !near) continue;
    const cx = m.x0 + c.sx / c.n / TILE, cy = m.y0 + c.sy / c.n / TILE;
    greens.push({ lat: latOf(cy), lon: lonOf(cx), areaM2: Math.round(area), sand: near });
  }
  const toLL = (c) => ({ lat: latOf(m.y0 + c.sy / c.n / TILE), lon: lonOf(m.x0 + c.sx / c.n / TILE), areaM2: Math.round(c.n * a1) });
  return { greens, bunkers: bunkers.map(toLL), mpp, debug: { smooth, comps, w, h } };
}

const courses = () => JSON.parse(fs.readFileSync(new URL('../data/courses-jp.json', import.meta.url), 'utf8')).courses;
const centroidOf = (flat) => { let la = 0, lo = 0, n = 0; for (let i = 0; i < flat.length; i += 2) { la += flat[i]; lo += flat[i + 1]; n++; } return { lat: la / n, lon: lo / n }; };

/** compare with OSM greens: a detection within 15 m of a mapped green centre counts as correct */
export function score(found, truth, tol = 15) {
  const used = new Set(); let tp = 0;
  for (const f of found) { let bi = -1, bd = tol; truth.forEach((t, i) => { if (used.has(i)) return; const d = dist(f, t); if (d < bd) { bd = d; bi = i; } }); if (bi >= 0) { used.add(bi); tp++; } }
  return { tp, fp: found.length - tp, fn: truth.length - tp };
}

async function evaluate(n, P) {
  const list = courses().filter((c) => c.hm >= 18 && c.gm >= 18 && c.b && (c.b[2] - c.b[0]) * 111 < 2.2).slice(0, n);
  let T = { tp: 0, fp: 0, fn: 0 };
  for (const c of list) {
    const d = JSON.parse(fs.readFileSync(new URL(`../data/c/${c.id}.json`, import.meta.url), 'utf8'));
    const truth = (d.greens || []).map((g) => centroidOf(g[0] || g));
    const m = await mosaic(c.b);
    const r = detect(m, c.a, P);
    const s = score(r.greens, truth);
    T = { tp: T.tp + s.tp, fp: T.fp + s.fp, fn: T.fn + s.fn };
    console.log(`${c.n.slice(0, 14).padEnd(14)} truth ${String(truth.length).padStart(2)} found ${String(r.greens.length).padStart(3)} correct ${String(s.tp).padStart(2)}`);
  }
  const prec = T.tp / Math.max(1, T.tp + T.fp), rec = T.tp / Math.max(1, T.tp + T.fn);
  console.log(`TOTAL precision ${(prec * 100).toFixed(0)}%  recall ${(rec * 100).toFixed(0)}%  (${T.tp} correct, ${T.fp} wrong, ${T.fn} missed)`);
  return { prec, rec, ...T };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'eval') await evaluate(Number(arg) || 8, PARAMS);
  else if (cmd === 'grid') {
    const res = [];
    for (const smoothMax of [4.5, 5.5, 7]) for (const openM of [2, 3, 4.5]) for (const needSand of [true, false]) { const P = { ...PARAMS, smoothMax, openM, needSand }; const log = console.log; console.log = () => {}; const r = await evaluate(Number(arg) || 6, P); console.log = log; res.push({ smoothMax, openM, needSand, ...r }); log(smoothMax, openM, needSand, 'prec', (r.prec * 100).toFixed(0), 'rec', (r.rec * 100).toFixed(0)); }
  }
  else if (cmd) { const c = courses().find((x) => x.id === cmd); const m = await mosaic(c.b); console.log(JSON.stringify(detect(m, c.a))); }
}
export { evaluate, mosaic, courses, blur, components, morph, dist, tx, ty, latOf, lonOf, Z };
