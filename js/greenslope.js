// Green slope from 国土地理院 elevation (1m laser where available, otherwise 5m/10m DEM):
// sample a grid over the green, fit a plane, and turn it into putting advice (uphill/downhill, hook/slice).
import { dist, bearing, xy, fetchJSON } from './util.js';
import { elevations, elevationSource } from './advice.js';

const CK = 'golfnavi:greens:v1';
function cacheGet(id) { try { return JSON.parse(localStorage.getItem(CK) || '{}')[id] || null; } catch { return null; } }
function cachePut(id, v) { try { const c = JSON.parse(localStorage.getItem(CK) || '{}'); c[id] = v; const ks = Object.keys(c); if (ks.length > 120) delete c[ks[0]]; localStorage.setItem(CK, JSON.stringify(c)); } catch {} }

function inPoly(p, poly) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.lat > p.lat) !== (b.lat > p.lat) && p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon) ins = !ins;
  }
  return ins;
}

/** analyse a green: { pct, downBearing, points, src, range } */
export async function analyzeGreen(green, center, key) {
  const cached = key && cacheGet(key);
  if (cached) return cached;
  const pts = green?.pts?.length > 3 ? green.pts : null;
  const c = center || green?.c;
  // sampling grid (~4-5m spacing) inside the green outline, or a 24m square around the centre
  let s = 90, w = 180, n = -90, e = -180;
  if (pts) for (const p of pts) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon); }
  else { s = c.lat - 0.00011; n = c.lat + 0.00011; w = c.lon - 0.00013; e = c.lon + 0.00013; }
  const sizeM = Math.max(dist({ lat: s, lon: w }, { lat: n, lon: w }), dist({ lat: s, lon: w }, { lat: s, lon: e }));
  const steps = Math.max(4, Math.min(7, Math.round(sizeM / 5)));
  const samples = [];
  for (let i = 0; i <= steps; i++) for (let j = 0; j <= steps; j++) {
    const p = { lat: s + ((n - s) * i) / steps, lon: w + ((e - w) * j) / steps };
    if (!pts || inPoly(p, pts)) samples.push(p);
  }
  if (samples.length < 6) samples.push(c);
  const zs = await elevations(samples);
  const ok = samples.map((p, i) => ({ p, z: zs[i] })).filter((x) => Number.isFinite(x.z));
  if (ok.length < 5) return null;
  // least-squares plane z = a·x + b·y + c (x east, y north, meters)
  const o = c;
  let Sxx = 0, Sxy = 0, Syy = 0, Sx = 0, Sy = 0, Sz = 0, Sxz = 0, Syz = 0;
  const N = ok.length;
  for (const { p, z } of ok) { const v = xy(o, p); Sxx += v.x * v.x; Sxy += v.x * v.y; Syy += v.y * v.y; Sx += v.x; Sy += v.y; Sz += z; Sxz += v.x * z; Syz += v.y * z; }
  // solve 3x3 normal equations
  const M = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, N]], V = [Sxz, Syz, Sz];
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(M); if (Math.abs(D) < 1e-9) return null;
  const col = (k) => M.map((r, i) => r.map((x, j) => (j === k ? V[i] : x)));
  const a = det(col(0)) / D, b = det(col(1)) / D;
  const pct = Math.hypot(a, b) * 100;
  // downhill direction (bearing of -gradient)
  const downBearing = ((Math.atan2(-a, -b) * 180) / Math.PI + 360) % 360;
  const zsOk = ok.map((x) => x.z);
  const res = { pct, downBearing, range: Math.max(...zsOk) - Math.min(...zsOk), n: N, src: elevationSource(ok[0].p) || '国土地理院', at: Date.now() };
  if (key) cachePut(key, res);
  return res;
}

/** putting read for a ball coming from `from` toward the pin */
export function readPutt(slope, from, pin, hand = 'right') {
  if (!slope) return null;
  const putt = bearing(from, pin);
  const rel = (((slope.downBearing - putt) % 360) + 540) % 360 - 180; // 0 = downhill straight away, ±180 = uphill
  const along = Math.cos((rel * Math.PI) / 180) * slope.pct; // + downhill putt
  const side = Math.sin((rel * Math.PI) / 180) * slope.pct; // + slopes down to the right
  const flat = slope.pct < 0.6;
  const upDown = flat ? 'ほぼ平ら' : along > 0.3 ? `下り（${along.toFixed(1)}%）` : along < -0.3 ? `上り（${(-along).toFixed(1)}%）` : '上り下りは少ない';
  // break: down to the right → ball curves right → slice line for a right-hander
  const breaksRight = side > 0;
  const lineName = (breaksRight ? hand === 'right' : hand !== 'right') ? 'スライスライン' : 'フックライン';
  const sideTxt = Math.abs(side) < 0.4 ? 'ほぼまっすぐ' : `${breaksRight ? '右' : '左'}に曲がる${lineName}（横傾斜 ${Math.abs(side).toFixed(1)}%）`;
  const aim = Math.abs(side) < 0.4 ? 'カップの中央を狙う' : `カップの${breaksRight ? '左' : '右'}側を狙う`;
  return { upDown, sideTxt, aim, along, side };
}

/** green speed tendency from the last days' weather (Open-Meteo, free) */
export async function greenCondition(lat, lon) {
  try {
    const j = await fetchJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=precipitation_sum,temperature_2m_max,sunshine_duration,wind_speed_10m_max&past_days=2&forecast_days=1&timezone=Asia%2FTokyo&wind_speed_unit=ms`);
    const d = j.daily; const rain = d.precipitation_sum.reduce((a, b) => a + (b || 0), 0);
    const sun = (d.sunshine_duration.at(-1) || 0) / 3600, tmax = d.temperature_2m_max.at(-1), wind = d.wind_speed_10m_max.at(-1);
    let speed, note;
    if (rain >= 10) { speed = '重い'; note = `この2日で雨${rain.toFixed(0)}mm。グリーンは重く、ボールが止まりやすい。強めに打つ。`; }
    else if (rain >= 2) { speed = 'やや重い'; note = `少し雨（${rain.toFixed(1)}mm）が残っている。いつもよりしっかり打つ。`; }
    else if (sun > 6 && (wind > 5 || tmax > 26)) { speed = '速い'; note = '晴れて乾燥・風もあり、グリーンは速くなりやすい。下りは特に注意。'; }
    else { speed = '普通'; note = '天気は安定。練習グリーンでその日の速さを確認。'; }
    return { speed, note, rain };
  } catch { return null; }
}
