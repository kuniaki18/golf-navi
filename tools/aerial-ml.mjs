// Learn to recognise putting greens in 国土地理院 aerial photos from courses whose greens / fairways / bunkers / water
// are mapped in OpenStreetMap, and measure it on courses the model has never seen.
//   node tools/aerial-ml.mjs train            → trains on part of the mapped courses, reports test precision / recall
//   node tools/aerial-ml.mjs detect <id>       → greens found for one course (uses the saved model)
import fs from 'node:fs';
import path from 'node:path';
import { mosaic, courses, blur, components, morph, dist, tx, ty, latOf, lonOf, Z } from './aerial-detect.mjs';

const rad = Math.PI / 180;
const MODEL = new URL('../data/aerial-model.json', import.meta.url);
const CLASSES = ['other', 'green', 'fairway', 'bunker', 'water'];

// ---------- features ----------
function fields(m) {
  const { w, h, px } = m, N = w * h;
  const L = new Float32Array(N), T = new Float32Array(N), B = new Float32Array(N), L2 = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    const r = px[p * 3], g = px[p * 3 + 1], b = px[p * 3 + 2];
    const l = 0.3 * r + 0.59 * g + 0.11 * b; L[p] = l; L2[p] = l * l; T[p] = g - (r + b) / 2; B[p] = b - r;
  }
  // normalise brightness per course (photos differ by season / haze)
  const sorted = Array.from(L.filter((_, i) => i % 7 === 0)).sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1] || 128, spread = (sorted[Math.floor(sorted.length * 0.9)] - sorted[Math.floor(sorted.length * 0.1)]) || 40;
  const sd = (k) => { const a = blur(L, w, h, k), a2 = blur(L2, w, h, k), o = new Float32Array(N); for (let p = 0; p < N; p++) o[p] = Math.sqrt(Math.max(0, a2[p] - a[p] * a[p])); return o; };
  const f = {
    L, T, B, med, spread,
    m2: blur(L, w, h, 2), m6: blur(L, w, h, 6), m15: blur(L, w, h, 15),
    s2: sd(2), s5: sd(5), s12: sd(12),
    t5: blur(T, w, h, 5), t15: blur(T, w, h, 15),
  };
  // bright, neutral pixels (sand) nearby — greens usually have bunkers next to them
  const sand = new Float32Array(N); for (let p = 0; p < N; p++) sand[p] = (L[p] - med) / spread > 1.1 && Math.abs(T[p]) < 6 ? 1 : 0;
  f.sand15 = blur(sand, w, h, 15); f.sand4 = blur(sand, w, h, 4);
  return f;
}
const NF = 15;
function feat(f, p, out, o = 0) {
  const n = (v) => (v - f.med) / f.spread;
  out[o] = n(f.L[p]); out[o + 1] = f.T[p] / 10; out[o + 2] = f.B[p] / 20; out[o + 3] = n(f.m2[p]); out[o + 4] = n(f.m6[p]); out[o + 5] = n(f.m15[p]);
  out[o + 6] = f.s2[p] / 10; out[o + 7] = f.s5[p] / 10; out[o + 8] = f.s12[p] / 10; out[o + 9] = f.t5[p] / 10; out[o + 10] = f.t15[p] / 10;
  out[o + 11] = f.sand15[p] * 4; out[o + 12] = f.sand4[p] * 4; out[o + 13] = (f.m2[p] - f.m15[p]) / f.spread; out[o + 14] = (f.s5[p] - f.s12[p]) / 10;
}

// ---------- ground truth raster from OSM polygons ----------
function rasterize(m, d) {
  const { w, h } = m, lab = new Uint8Array(w * h);
  const toPx = (lat, lon) => [(tx(lon) - m.x0) * 256, (ty(lat) - m.y0) * 256];
  const fill = (polys, cls) => {
    for (const rings of polys || []) {
      const ring = (Array.isArray(rings[0]) ? rings[0] : rings); const pts = [];
      for (let i = 0; i < ring.length; i += 2) pts.push(toPx(ring[i], ring[i + 1]));
      if (pts.length < 3) continue;
      const ys = pts.map((p) => p[1]), y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
      for (let y = y0; y <= y1; y++) {
        const xs = [];
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y)) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi)); }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k])); x <= Math.min(w - 1, Math.floor(xs[k + 1])); x++) lab[y * w + x] = cls;
      }
    }
  };
  fill(d.fairways, 2); fill(d.water, 4); fill(d.bunkers, 3); fill(d.greens, 1);
  return lab;
}

// ---------- a small neural network (NF → H → H → 5), trained with Adam ----------
function initNet(H = 24, seed = 7) {
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 - 0.5; };
  const mat = (a, b) => Float32Array.from({ length: a * b }, () => rnd() * Math.sqrt(6 / (a + b)));
  return { H, W1: mat(NF, H), b1: new Float32Array(H), W2: mat(H, H), b2: new Float32Array(H), W3: mat(H, 5), b3: new Float32Array(5) };
}
function forward(net, x, cache) {
  const { H, W1, b1, W2, b2, W3, b3 } = net;
  const h1 = cache?.h1 || new Float32Array(H), h2 = cache?.h2 || new Float32Array(H), o = cache?.o || new Float32Array(5);
  for (let j = 0; j < H; j++) { let v = b1[j]; for (let i = 0; i < NF; i++) v += x[i] * W1[i * H + j]; h1[j] = v > 0 ? v : 0.01 * v; }
  for (let j = 0; j < H; j++) { let v = b2[j]; for (let i = 0; i < H; i++) v += h1[i] * W2[i * H + j]; h2[j] = v > 0 ? v : 0.01 * v; }
  let mx = -Infinity; for (let k = 0; k < 5; k++) { let v = b3[k]; for (let i = 0; i < H; i++) v += h2[i] * W3[i * 5 + k]; o[k] = v; if (v > mx) mx = v; }
  let s = 0; for (let k = 0; k < 5; k++) { o[k] = Math.exp(o[k] - mx); s += o[k]; } for (let k = 0; k < 5; k++) o[k] /= s;
  return { h1, h2, o };
}
function train(net, X, Y, { epochs = 8, lr = 0.003, batch = 256 } = {}) {
  const { H } = net, keys = ['W1', 'b1', 'W2', 'b2', 'W3', 'b3'];
  const m = {}, v = {}, g = {}; for (const k of keys) { m[k] = new Float32Array(net[k].length); v[k] = new Float32Array(net[k].length); g[k] = new Float32Array(net[k].length); }
  const n = Y.length, idx = Array.from({ length: n }, (_, i) => i); let step = 0;
  const x = new Float32Array(NF), d3 = new Float32Array(5), d2 = new Float32Array(H), d1 = new Float32Array(H), cache = { h1: new Float32Array(H), h2: new Float32Array(H), o: new Float32Array(5) };
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    let loss = 0;
    for (let b0 = 0; b0 < n; b0 += batch) {
      for (const k of keys) g[k].fill(0);
      const end = Math.min(n, b0 + batch);
      for (let t = b0; t < end; t++) {
        const s0 = idx[t]; for (let i = 0; i < NF; i++) x[i] = X[s0 * NF + i];
        const { h1, h2, o } = forward(net, x, cache); const y = Y[s0];
        loss -= Math.log(o[y] + 1e-9);
        for (let k = 0; k < 5; k++) d3[k] = o[k] - (k === y ? 1 : 0);
        for (let i = 0; i < H; i++) { let s = 0; for (let k = 0; k < 5; k++) { g.W3[i * 5 + k] += h2[i] * d3[k]; s += net.W3[i * 5 + k] * d3[k]; } d2[i] = s * (h2[i] > 0 ? 1 : 0.01); }
        for (let k = 0; k < 5; k++) g.b3[k] += d3[k];
        for (let i = 0; i < H; i++) { let s = 0; for (let j = 0; j < H; j++) { g.W2[i * H + j] += h1[i] * d2[j]; s += net.W2[i * H + j] * d2[j]; } d1[i] = s * (h1[i] > 0 ? 1 : 0.01); }
        for (let j = 0; j < H; j++) g.b2[j] += d2[j];
        for (let i = 0; i < NF; i++) for (let j = 0; j < H; j++) g.W1[i * H + j] += x[i] * d1[j];
        for (let j = 0; j < H; j++) g.b1[j] += d1[j];
      }
      step++; const bs = end - b0;
      for (const k of keys) { const P = net[k], G = g[k], M = m[k], V = v[k]; for (let i = 0; i < P.length; i++) { const gi = G[i] / bs; M[i] = 0.9 * M[i] + 0.1 * gi; V[i] = 0.999 * V[i] + 0.001 * gi * gi; P[i] -= (lr * (M[i] / (1 - 0.9 ** step))) / (Math.sqrt(V[i] / (1 - 0.999 ** step)) + 1e-8); } }
    }
    console.log(`  epoch ${ep + 1}: loss ${(loss / n).toFixed(3)}`);
  }
}

// ---------- detection ----------
export function detectGreens(net, m, lat, { thr = 0.5, minArea = 200, maxArea = 1800, minFill = 0.5, step = 2 } = {}) {
  const f = fields(m), { w, h } = m;
  const mpp = (156543.03392 * Math.cos(lat * rad)) / 2 ** Z;
  const gw = Math.ceil(w / step), gh = Math.ceil(h / step);
  const prob = new Float32Array(gw * gh), x = new Float32Array(NF), cache = { h1: new Float32Array(net.H), h2: new Float32Array(net.H), o: new Float32Array(5) };
  for (let y = 0; y < gh; y++) for (let xx = 0; xx < gw; xx++) { feat(f, y * step * w + xx * step, x); prob[y * gw + xx] = forward(net, x, cache).o[1]; }
  const pb = blur(prob, gw, gh, 1);
  let mask = new Uint8Array(gw * gh); for (let p = 0; p < gw * gh; p++) mask[p] = pb[p] > thr ? 1 : 0;
  mask = morph(morph(mask, gw, gh, 1, 'dilate'), gw, gh, 1, 'erode');
  const a1 = (mpp * step) ** 2;
  const { comps } = components(mask, gw, gh, Math.round(minArea / a1));
  const out = [];
  for (const c of comps) {
    const area = c.n * a1, bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
    if (area > maxArea || c.n / (bw * bh) < minFill || Math.max(bw, bh) / Math.min(bw, bh) > 2.6) continue;
    out.push({ lat: latOf(m.y0 + (c.sy / c.n) * step / 256), lon: lonOf(m.x0 + (c.sx / c.n) * step / 256), areaM2: Math.round(area) });
  }
  return out;
}
const loadNet = () => { const j = JSON.parse(fs.readFileSync(MODEL, 'utf8')); for (const k of ['W1', 'b1', 'W2', 'b2', 'W3', 'b3']) j[k] = Float32Array.from(j[k]); return j; };
const cen = (rings) => { const r = Array.isArray(rings[0]) ? rings[0] : rings; let la = 0, lo = 0, n = 0; for (let i = 0; i < r.length; i += 2) { la += r[i]; lo += r[i + 1]; n++; } return { lat: la / n, lon: lo / n }; };
function score(found, truth, tol = 15) {
  const used = new Set(); let tp = 0;
  for (const f of found) { let bi = -1, bd = tol; truth.forEach((t, i) => { if (used.has(i)) return; const d = dist(f, t); if (d < bd) { bd = d; bi = i; } }); if (bi >= 0) { used.add(bi); tp++; } }
  return { tp, fp: found.length - tp, fn: truth.length - tp };
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const pool = courses().filter((c) => c.hm >= 18 && c.gm >= 18 && c.b && (c.b[2] - c.b[0]) * 111 < 2.2);
  if (cmd === 'train') {
    // every 3rd course is held out for testing (never seen in training)
    const trainSet = pool.filter((_, i) => i % 3 !== 0).slice(0, Number(arg) || 30), testSet = pool.filter((_, i) => i % 3 === 0).slice(0, 15);
    const X = [], Y = []; const PER = { 0: 1500, 1: 1500, 2: 1000, 3: 700, 4: 500 };
    const buf = new Float32Array(NF);
    for (const c of trainSet) {
      const d = JSON.parse(fs.readFileSync(new URL(`../data/c/${c.id}.json`, import.meta.url), 'utf8'));
      const m = await mosaic(c.b); const f = fields(m); const lab = rasterize(m, d);
      const byCls = [[], [], [], [], []]; for (let p = 0; p < lab.length; p += 3) byCls[lab[p]].push(p);
      for (let k = 0; k < 5; k++) { const arr = byCls[k]; for (let t = 0; t < Math.min(PER[k], arr.length); t++) { const p = arr[Math.floor(Math.random() * arr.length)]; feat(f, p, buf); X.push(...buf); Y.push(k); } }
      process.stdout.write('.');
    }
    console.log(`\nsamples ${Y.length} from ${trainSet.length} courses`);
    const net = initNet(); train(net, Float32Array.from(X), Uint8Array.from(Y));
    fs.writeFileSync(MODEL, JSON.stringify({ v: 1, classes: CLASSES, H: net.H, ...Object.fromEntries(['W1', 'b1', 'W2', 'b2', 'W3', 'b3'].map((k) => [k, Array.from(net[k], (x) => Math.round(x * 1e5) / 1e5)])), trainedOn: trainSet.map((c) => c.id) }));
    // test on unseen courses, a few thresholds
    const tests = [];
    for (const c of testSet) { const d = JSON.parse(fs.readFileSync(new URL(`../data/c/${c.id}.json`, import.meta.url), 'utf8')); tests.push({ c, m: await mosaic(c.b), truth: (d.greens || []).map(cen) }); }
    for (const thr of [0.4, 0.5, 0.6, 0.7]) {
      let T = { tp: 0, fp: 0, fn: 0 };
      for (const t of tests) { const s = score(detectGreens(net, t.m, t.c.a, { thr }), t.truth); T = { tp: T.tp + s.tp, fp: T.fp + s.fp, fn: T.fn + s.fn }; }
      console.log(`thr ${thr}: precision ${(100 * T.tp / Math.max(1, T.tp + T.fp)).toFixed(0)}%  recall ${(100 * T.tp / Math.max(1, T.tp + T.fn)).toFixed(0)}%  (${T.tp} correct, ${T.fp} wrong, ${T.fn} missed) on ${tests.length} unseen courses`);
    }
  } else if (cmd === 'detect') {
    const c = courses().find((x) => x.id === arg); const m = await mosaic(c.b);
    console.log(JSON.stringify(detectGreens(loadNet(), m, c.a)));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))) await main();
