// Club selection: plays-like distance from wind, elevation, lie and temperature, then the best club.
import { fetchJSON, m2y } from './util.js';

const LIE = {
  tee: { f: 1.0, label: 'ティーアップ' },
  fairway: { f: 1.0, label: 'フェアウェイ' },
  first: { f: 1.02, label: 'ファーストカット' },
  rough: { f: 1.06, label: 'ラフ' },
  deep: { f: 1.15, label: '深いラフ' },
  bunker: { f: 1.1, label: 'バンカー' },
};

/**
 * @param {number} yards  straight-line distance to the target
 * @param {object} c      { head: m/s (+ head / − tail), elevM: target minus player (m), lie, tempC }
 */
export function playsLike(yards, c = {}) {
  const parts = [];
  let d = yards;
  if (c.head) {
    // rule of thumb: headwind costs ~1.8%/m·s, tailwind helps ~1%/m·s
    const adj = c.head > 0 ? yards * 0.018 * c.head : yards * 0.01 * c.head;
    d += adj; parts.push(`${c.head > 0 ? '向かい' : '追い'}風 ${Math.abs(c.head).toFixed(1)}m/s ${sign(adj)}y`);
  }
  if (c.elevM) {
    // uphill plays ~1y per 1y of rise; downhill helps a little less (longer hang time, steeper landing)
    const adj = m2y(c.elevM) * (c.elevM > 0 ? 1.0 : 0.8);
    d += adj; parts.push(`${c.elevM > 0 ? '打ち上げ' : '打ち下ろし'} ${Math.abs(c.elevM).toFixed(0)}m ${sign(adj)}y`);
  }
  if (Number.isFinite(c.tempC) && c.tempC < 15) {
    const adj = yards * 0.01 * ((15 - c.tempC) / 5);
    if (adj >= 1) { d += adj; parts.push(`気温${Math.round(c.tempC)}℃ ${sign(adj)}y`); }
  }
  const lie = LIE[c.lie] || LIE.fairway;
  if (lie.f !== 1) { const before = d; d *= lie.f; parts.push(`${lie.label} ${sign(d - before)}y`); }
  return { yards: d, parts };
}
const sign = (v) => (v >= 0 ? '+' : '−') + Math.abs(Math.round(v));

export function recommendClub(clubs, target) {
  const list = clubs.filter((c) => c.carry > 0 && !/^P(T|utter)$/i.test(c.name)).sort((a, b) => a.carry - b.carry);
  if (!list.length || !target) return null;
  if (target <= 20) return { club: { name: 'パター/寄せ', carry: target }, alt: null, margin: 0, note: 'グリーン周り。転がしで寄せましょう。' };
  const longest = list[list.length - 1];
  if (target > longest.carry + 5) {
    const leave = target - longest.carry;
    return { club: longest, alt: null, margin: longest.carry - target, note: `届かない距離です。${longest.name}で残り約${Math.round(leave)}yを残すか、得意距離が残る番手で刻みましょう。`, layup: true };
  }
  let idx = list.findIndex((c) => c.carry >= target - 3);
  if (idx < 0) idx = list.length - 1;
  const club = list[idx];
  const shorter = list[idx - 1];
  // if the shorter club is within 4y, mention it as the "hit it hard" option
  const alt = shorter && target - shorter.carry <= 6 ? shorter : list[idx + 1] || null;
  return { club, alt, margin: club.carry - target, note: '' };
}

/** current wind / temperature at the course (Open-Meteo, free, no key) */
const wxCache = new Map();
export async function weather(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = wxCache.get(key);
  if (hit && Date.now() - hit.t < 10 * 60e3) return hit.v;
  const j = await fetchJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation&wind_speed_unit=ms&timezone=Asia%2FTokyo`);
  const c = j.current || {};
  const v = { temp: c.temperature_2m, speed: c.wind_speed_10m, dir: c.wind_direction_10m, gust: c.wind_gusts_10m, rain: c.precipitation };
  wxCache.set(key, { t: Date.now(), v });
  return v;
}

/** head-wind component (m/s) for a shot heading `shotBearing` degrees; 10m wind is reduced to ball-flight height */
export function headComponent(wx, shotBearing) {
  if (!wx || !Number.isFinite(wx.speed)) return 0;
  const rel = ((wx.dir - shotBearing) * Math.PI) / 180;
  return wx.speed * 0.8 * Math.cos(rel);
}
export function crossComponent(wx, shotBearing) {
  if (!wx || !Number.isFinite(wx.speed)) return 0;
  const rel = ((wx.dir - shotBearing) * Math.PI) / 180;
  // positive = wind blowing from the left (pushes ball right)
  return -wx.speed * 0.8 * Math.sin(rel);
}

/**
 * terrain elevation in meters. 国土地理院 DEM (1m laser / 5m / 10m) first — precise enough for
 * 打ち上げ・打ち下ろし — then Open-Meteo (~90m) outside Japan or on failure.
 */
const elevCache = new Map();
const ek = (p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
async function gsiElevation(p) {
  const j = await fetchJSON(`https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${p.lon.toFixed(6)}&lat=${p.lat.toFixed(6)}&outtype=JSON`, {}, 8000);
  const v = Number(j.elevation);
  return Number.isFinite(v) ? { v, src: j.hsrc || 'GSI' } : null;
}
export async function elevations(points) {
  const out = [];
  for (const p of points) {
    const k = ek(p);
    if (!elevCache.has(k)) {
      let r = null;
      try { r = await gsiElevation(p); } catch {}
      if (!r) {
        try { const j = await fetchJSON(`https://api.open-meteo.com/v1/elevation?latitude=${p.lat}&longitude=${p.lon}`); r = { v: j.elevation?.[0], src: 'Open-Meteo' }; } catch {}
      }
      elevCache.set(k, r);
      if (elevCache.size > 400) elevCache.delete(elevCache.keys().next().value);
    }
    out.push(elevCache.get(k)?.v);
  }
  return out;
}
export function elevationSource(p) { return elevCache.get(ek(p))?.src || ''; }

export const compass = (deg) => ['北', '北東', '東', '南東', '南', '南西', '西', '北西'][Math.round(deg / 45) % 8];
