// Green slope from 国土地理院 elevation (1m laser where available, otherwise 5m / 10m DEM).
// Fits a plane to a grid of elevations inside the green and reports the slope WITH its uncertainty.
// Limits (by design): a plane cannot represent tiers or local undulation, the DEM may predate a green
// rebuild, and grain (芝目) or green speed are not in elevation data at all.
import { dist, bearing, xy, fetchJSON } from './util.js';
import { elevations, elevationSource } from './advice.js';

const CK = 'golfnavi:greens:v2';
function cacheGet(id) { try { return JSON.parse(localStorage.getItem(CK) || '{}')[id] || null; } catch { return null; } }
function cachePut(id, v) { try { const c = JSON.parse(localStorage.getItem(CK) || '{}'); c[id] = v; const ks = Object.keys(c); if (ks.length > 120) delete c[ks[0]]; localStorage.setItem(CK, JSON.stringify(c)); } catch {} }

// GSI returns elevations rounded to 0.1 m: a uniform rounding error has σ = 0.1/√12 ≈ 0.029 m
export const QUANT_SIGMA = 0.1 / Math.sqrt(12);

function inPoly(p, poly) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.lat > p.lat) !== (b.lat > p.lat) && p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon) ins = !ins;
  }
  return ins;
}
/** distance (m) from p to the outline's edges */
function edgeDist(p, poly) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const A = xy(p, poly[j]), B = xy(p, poly[i]);
    const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, -(A.x * dx + A.y * dy) / L2));
    best = Math.min(best, Math.hypot(A.x + t * dx, A.y + t * dy));
  }
  return best;
}

/**
 * Least-squares plane z = a·x + b·y + c over points {x, y, z} (meters, x east, y north).
 * Returns slope %, downhill bearing, and standard errors from the residuals (floored by the 0.1 m rounding).
 */
export function fitPlane(points) {
  const n = points.length;
  if (n < 5) return null;
  let Sxx = 0, Sxy = 0, Syy = 0, Sx = 0, Sy = 0, Sz = 0, Sxz = 0, Syz = 0;
  for (const { x, y, z } of points) { Sxx += x * x; Sxy += x * y; Syy += y * y; Sx += x; Sy += y; Sz += z; Sxz += x * z; Syz += y * z; }
  const M = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]], V = [Sxz, Syz, Sz];
  const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det3(M); if (Math.abs(D) < 1e-9) return null;
  const col = (k) => M.map((r, i) => r.map((v, j) => (j === k ? V[i] : v)));
  const a = det3(col(0)) / D, b = det3(col(1)) / D, c = det3(col(2)) / D;
  let rss = 0;
  for (const { x, y, z } of points) rss += (z - (a * x + b * y + c)) ** 2;
  const rms = Math.sqrt(rss / n);
  const s2 = Math.max(rss / Math.max(1, n - 3), QUANT_SIGMA ** 2);
  // inverse of the normal matrix → parameter covariance s²·(XᵀX)⁻¹ (only the a/b block is needed)
  const cof = (r, cl) => { const m = M.filter((_, i) => i !== r).map((row) => row.filter((_, j) => j !== cl)); return m[0][0] * m[1][1] - m[0][1] * m[1][0]; };
  const varA = (s2 * cof(0, 0)) / D, varB = (s2 * cof(1, 1)) / D, covAB = (-s2 * cof(0, 1)) / D;
  const g = Math.hypot(a, b);
  const pct = g * 100;
  // standard error of the gradient magnitude and of its direction (delta method)
  const seG = g > 1e-9 ? Math.sqrt(Math.max(0, (a * a * varA + b * b * varB + 2 * a * b * covAB) / (g * g))) : Math.sqrt((varA + varB) / 2);
  const seDir = g > 1e-9 ? (Math.sqrt(Math.max(0, (b * b * varA + a * a * varB - 2 * a * b * covAB))) / (g * g)) * (180 / Math.PI) : 180;
  const downBearing = ((Math.atan2(-a, -b) * 180) / Math.PI + 360) % 360;
  return { a, b, pct, pctSE: seG * 100, dirSE: Math.min(180, seDir), downBearing, rms, n };
}

/** worst elevation source among the samples: 1m laser < 5m laser < 5m photo < 10m / other */
export function sourceGrade(srcs) {
  const rank = (s) => (/1m/.test(s) ? 1 : /5m.*レーザ/.test(s) ? 2 : /5m/.test(s) ? 3 : 4);
  const worst = Math.max(...srcs.map(rank));
  return { worst, label: { 1: '1mメッシュ（レーザ測量）', 2: '5mメッシュ（レーザ測量）', 3: '5mメッシュ（写真測量）', 4: '10mメッシュ等（等高線由来）' }[worst] };
}

/** confidence of a fitted slope: 高 / 中 / 低 / 判定不可 */
export function confidence(fit, grade, shapeKnown = true) {
  if (!fit) return { level: 'none', label: '判定不可', reason: '高さデータが足りません' };
  if (grade.worst >= 4) return { level: 'none', label: '判定不可', reason: '10mメッシュなど粗いデータのため、グリーン上の傾斜は計算できません' };
  const z = fit.pctSE > 0 ? fit.pct / fit.pctSE : 0;
  let level = z >= 4 && fit.n >= 12 ? 'high' : z >= 2.5 && fit.n >= 9 ? 'mid' : z >= 1.5 ? 'low' : 'none';
  if (grade.worst === 3 && level === 'high') level = 'mid';
  if (!shapeKnown && level === 'high') level = 'mid';
  if (fit.rms > 0.12 && level !== 'none') level = level === 'high' ? 'mid' : 'low'; // tiers / undulation: a plane fits poorly
  const label = { high: '高', mid: '中', low: '低', none: '判定不可' }[level];
  const reason = level === 'none' ? '傾斜が小さいか、データのばらつきが大きく、方向を判断できません'
    : fit.rms > 0.12 ? '段差や大きな起伏があり、1枚の平面では表しきれません'
      : `傾斜 ${fit.pct.toFixed(1)}% に対して誤差 ±${fit.pctSE.toFixed(1)}%`;
  return { level, label, reason };
}

/** analyse a green → { pct, pctSE, downBearing, dirSE, rms, n, src, conf, shapeKnown } */
export async function analyzeGreen(green, center, key) {
  const cached = key && cacheGet(key);
  if (cached) return cached;
  const pts = green?.pts?.length > 3 ? green.pts : null;
  const c = center || green?.c;
  if (!c) return null;
  // grid (~3–5 m) inside the outline, keeping ≥1.5 m away from its edge (collar / bunker lips),
  // or a 8 m radius disk around the centre when the outline is unknown
  let s, w, n, e;
  if (pts) { s = Math.min(...pts.map((p) => p.lat)); n = Math.max(...pts.map((p) => p.lat)); w = Math.min(...pts.map((p) => p.lon)); e = Math.max(...pts.map((p) => p.lon)); }
  else { s = c.lat - 0.000075; n = c.lat + 0.000075; w = c.lon - 0.00009; e = c.lon + 0.00009; }
  const sizeM = Math.max(dist({ lat: s, lon: w }, { lat: n, lon: w }), dist({ lat: s, lon: w }, { lat: s, lon: e }));
  const steps = Math.max(5, Math.min(8, Math.round(sizeM / 4)));
  const samples = [];
  for (let i = 0; i <= steps; i++) for (let j = 0; j <= steps; j++) {
    const p = { lat: s + ((n - s) * i) / steps, lon: w + ((e - w) * j) / steps };
    if (pts ? inPoly(p, pts) && edgeDist(p, pts) >= 1.5 : dist(p, c) <= 8) samples.push(p);
  }
  if (samples.length < 6) samples.push(c);
  const zs = await elevations(samples);
  const ok = samples.map((p, i) => ({ p, z: zs[i] })).filter((x) => Number.isFinite(x.z));
  if (ok.length < 5) return null;
  const fit = fitPlane(ok.map(({ p, z }) => { const v = xy(c, p); return { x: v.x, y: v.y, z }; }));
  if (!fit) return null;
  const grade = sourceGrade(ok.map((x) => elevationSource(x.p) || ''));
  const conf = confidence(fit, grade, !!pts);
  const res = { ...fit, src: grade.label, grade: grade.worst, conf, shapeKnown: !!pts, at: Date.now() };
  // only cache complete answers (a partial failure should be retried next time)
  if (key && ok.length === samples.length) cachePut(key, res);
  return res;
}

/**
 * Putting read for a ball rolling from `from` to `pin`. Returns null pieces when the data can't support them:
 * up/down and the break are only stated when they are larger than twice their uncertainty.
 */
export function readPutt(slope, from, pin, hand = 'right') {
  if (!slope || !slope.conf || slope.conf.level === 'none') return null;
  const putt = bearing(from, pin);
  const rel = (((slope.downBearing - putt) % 360) + 540) % 360 - 180; // 0 = straight downhill, ±180 = uphill
  const along = Math.cos((rel * Math.PI) / 180) * slope.pct; // + downhill putt
  const side = Math.sin((rel * Math.PI) / 180) * slope.pct; // + slopes down to the right
  const se = slope.pctSE || 0;
  const sure = (v) => Math.abs(v) >= Math.max(0.4, 2 * se);
  const upDown = !sure(along) ? '上り下りははっきりしない' : along > 0 ? `下り（約${along.toFixed(1)}%）` : `上り（約${(-along).toFixed(1)}%）`;
  // down to the right → the ball curves right → slice line for a right-hander
  const breaksRight = side > 0;
  const lineName = (breaksRight ? hand === 'right' : hand !== 'right') ? 'スライスライン' : 'フックライン';
  const sideKnown = sure(side) && slope.conf.level !== 'low';
  const sideTxt = !sureSide(side, se) ? '曲がりははっきりしない（ほぼまっすぐか、データでは判断できない）'
    : sideKnown ? `${breaksRight ? '右' : '左'}に曲がる${lineName}（横の傾斜 約${Math.abs(side).toFixed(1)}%）`
      : `${breaksRight ? '右' : '左'}に曲がる可能性（信頼度が低いため参考）`;
  const aim = sideKnown ? `カップの${breaksRight ? '左' : '右'}側を狙う` : 'ラインは実際の傾斜を見て判断';
  return { upDown, sideTxt, aim, along, side, sideKnown };
}
const sureSide = (v, se) => Math.abs(v) >= Math.max(0.4, 2 * se);

/** green speed TENDENCY from the last days' weather (Open-Meteo). Not a measurement of the green. */
export async function greenCondition(lat, lon) {
  try {
    const j = await fetchJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=precipitation_sum,temperature_2m_max,sunshine_duration,wind_speed_10m_max&past_days=2&forecast_days=1&timezone=Asia%2FTokyo&wind_speed_unit=ms`);
    const d = j.daily; const rain = d.precipitation_sum.reduce((a, b) => a + (b || 0), 0);
    const sun = (d.sunshine_duration.at(-1) || 0) / 3600, tmax = d.temperature_2m_max.at(-1), wind = d.wind_speed_10m_max.at(-1);
    let speed, note;
    if (rain >= 10) { speed = '重めの可能性'; note = `この2日で雨${rain.toFixed(0)}mm（予報データ）。グリーンが重い可能性があります。`; }
    else if (rain >= 2) { speed = 'やや重めの可能性'; note = `少し雨（${rain.toFixed(1)}mm）が降っています（予報データ）。`; }
    else if (sun > 6 && (wind > 5 || tmax > 26)) { speed = '速めの可能性'; note = '晴れて乾燥・風もある予報。速くなりやすい条件です。'; }
    else { speed = '天気からは判断なし'; note = '天気は安定しています。'; }
    return { speed, note: note + '実際の速さはコース管理（刈り高・転圧）で決まるので、練習グリーンで確認してください。', rain };
  } catch { return null; }
}
