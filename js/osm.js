// Course data from OpenStreetMap via the Overpass API (free, nationwide, no key).
import { centroid, dist, nearestOnLine, lineLength, fetchJSON, sleep } from './util.js';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

export async function overpass(query, { onRetry } = {}) {
  let lastErr;
  // public servers are often busy: try every mirror, then back off and retry
  for (let round = 0; round < 4; round++) {
    for (const ep of ENDPOINTS) {
      try {
        const j = await fetchJSON(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
        }, 70000);
        if (j.elements) return j;
        lastErr = new Error('応答が不正です');
      } catch (e) { lastErr = e; }
    }
    if (round < 3) { onRetry?.(round + 1); await sleep(3000 * 2 ** round); }
  }
  throw new Error('地図サーバーが混み合っています。少し待って「コースデータ再取得」を押してください');
}

/** bundled nationwide list (data/courses-jp.json) so searching works even when the servers are busy */
let bundled = null;
export async function bundledCourses() {
  if (bundled) return bundled;
  try { const j = await fetchJSON('data/courses-jp.json'); bundled = j.courses.map((c) => ({ id: c.id, name: c.n, kana: c.k || '', lat: c.a, lon: c.o, bounds: c.b || null, holes: c.h || null, website: c.w || '', address: c.p || '', pref: c.p || '', source: 'osm' })); }
  catch { bundled = []; }
  return bundled;
}

function toCourse(el) {
  const t = el.tags || {};
  const c = el.center || (el.lat ? { lat: el.lat, lon: el.lon } : null);
  if (!c) return null;
  const b = el.bounds;
  return {
    id: `osm-${el.type}-${el.id}`,
    name: t.name || t['name:ja'] || '名称不明のゴルフ場',
    kana: t['name:ja-Hira'] || t['name:ja_kana'] || '',
    lat: c.lat, lon: c.lon,
    bounds: b ? [b.minlat, b.minlon, b.maxlat, b.maxlon] : null,
    holes: t.holes ? Number(t.holes) : null,
    phone: t.phone || t['contact:phone'] || '',
    website: t.website || t['contact:website'] || '',
    address: [t['addr:province'], t['addr:city'], t['addr:quarter'], t['addr:neighbourhood']].filter(Boolean).join(''),
    source: 'osm',
  };
}

export async function coursesInPref(pref) {
  const all = await bundledCourses();
  const hit = all.filter((c) => c.pref === pref);
  if (hit.length) return hit;
  const q = `[out:json][timeout:60];area["name"="${pref}"]["admin_level"="4"]->.a;nwr["leisure"="golf_course"](area.a);out tags center bb;`;
  const j = await overpass(q);
  return (j.elements || []).map(toCourse).filter(Boolean).filter((c) => c.name !== '名称不明のゴルフ場' || c.bounds);
}

export async function coursesNear(lat, lon, km = 25) {
  const all = await bundledCourses();
  if (all.length) return all.filter((c) => dist({ lat, lon }, c) <= km * 1000);
  const q = `[out:json][timeout:40];nwr["leisure"="golf_course"](around:${Math.round(km * 1000)},${lat},${lon});out tags center bb;`;
  const j = await overpass(q);
  return (j.elements || []).map(toCourse).filter(Boolean);
}

/** find the OSM course closest to a coordinate (used to attach GORA courses to map data) */
export async function matchCourse(lat, lon) {
  const list = await coursesNear(lat, lon, 3);
  list.sort((a, b) => dist({ lat, lon }, a) - dist({ lat, lon }, b));
  return list[0] || null;
}

function geomOf(el) {
  if (el.geometry) return el.geometry.map((p) => ({ lat: p.lat, lon: p.lon }));
  if (el.members) {
    const outer = el.members.filter((m) => m.role !== 'inner' && m.geometry);
    return outer.flatMap((m) => m.geometry.map((p) => ({ lat: p.lat, lon: p.lon })));
  }
  return [];
}

/** download holes, greens, tees, bunkers and water inside a course */
export async function courseFeatures(course) {
  let [s, w, n, e] = course.bounds || [course.lat - 0.012, course.lon - 0.015, course.lat + 0.012, course.lon + 0.015];
  const pad = 0.002; s -= pad; w -= pad; n += pad; e += pad;
  const q = `[out:json][timeout:60][bbox:${s},${w},${n},${e}];
(
  way["golf"];
  relation["golf"];
  way["natural"="water"];
  relation["natural"="water"];
  way["natural"="wood"];
);
out geom;`;
  const j = await overpass(q);
  return parseFeatures(j.elements || []);
}

export function parseFeatures(elements) {
  const f = { holes: [], greens: [], tees: [], bunkers: [], water: [], fairways: [], pins: [], trees: [] };
  for (const el of elements) {
    const t = el.tags || {};
    const g = geomOf(el);
    if (!g.length && el.type !== 'node') continue;
    const kind = t.golf || (t.natural === 'water' ? 'water_hazard' : t.natural === 'wood' ? 'wood' : '');
    const base = { id: `${el.type}/${el.id}`, pts: g, c: g.length ? centroid(g) : { lat: el.lat, lon: el.lon } };
    switch (kind) {
      case 'hole': {
        const ref = parseInt(t.ref, 10);
        f.holes.push({ ...base, ref: Number.isFinite(ref) ? ref : null, par: t.par ? parseInt(t.par, 10) : null, hcp: t.handicap ? parseInt(t.handicap, 10) : null, distTag: t.dist ? parseFloat(t.dist) : null, name: t.name || '' });
        break;
      }
      case 'green': f.greens.push(base); break;
      case 'tee': f.tees.push(base); break;
      case 'bunker': f.bunkers.push(base); break;
      case 'water_hazard': case 'lateral_water_hazard': f.water.push({ ...base, lateral: kind === 'lateral_water_hazard' }); break;
      case 'fairway': f.fairways.push(base); break;
      case 'pin': f.pins.push(base); break;
      case 'wood': if (g.length > 4) f.trees.push(base); break;
    }
  }
  return f;
}

/**
 * Build an ordered hole model. Each hole: { no, par, line, tee, green (polygon or null), center, lengthM }.
 * Courses with 27/36 holes repeat refs; those are kept as separate entries with a course label.
 */
export function buildHoles(f) {
  const holes = f.holes
    .filter((h) => h.pts.length >= 2)
    .map((h) => {
      const end = h.pts[h.pts.length - 1];
      let green = null, best = 90;
      for (const gr of f.greens) {
        const d = Math.min(dist(end, gr.c), ...gr.pts.map((p) => dist(end, p)));
        if (d < best) { best = d; green = gr; }
      }
      const center = green ? green.c : end;
      const lengthM = h.distTag ? (h.distTag > 50 ? h.distTag : null) : null;
      return {
        no: h.ref, par: h.par, hcp: h.hcp, name: h.name, line: h.pts,
        tee: h.pts[0], green, center, lengthM: lengthM || lineLength(h.pts), osmId: h.id,
      };
    });
  holes.sort((a, b) => (a.no ?? 99) - (b.no ?? 99));
  // label duplicate hole numbers (27+ hole courses)
  const seen = {};
  for (const h of holes) {
    if (h.no == null) continue;
    seen[h.no] = (seen[h.no] || 0) + 1;
    h.key = seen[h.no] > 1 ? `${h.no}-${seen[h.no]}` : String(h.no);
  }
  let i = 0;
  for (const h of holes) if (h.no == null) { h.no = 100 + (++i); h.key = `x${i}`; }
  return holes;
}

/** hazards that matter for a hole, with distance along the hole and side */
export function hazardsForHole(hole, f) {
  if (!hole?.line?.length) return [];
  const list = [];
  const consider = (arr, type) => {
    for (const hz of arr) {
      const near = nearestOnLine(hz.c, hole.line);
      const reach = Math.max(...hz.pts.map((p) => dist(hz.c, p)), 5);
      if (near.d - reach > 35) continue;
      list.push({ type, hz, along: near.along, lateral: near.lateral, size: reach, nearGreen: dist(hz.c, hole.center) < 45 });
    }
  };
  consider(f.bunkers, 'bunker');
  consider(f.water, 'water');
  return list.sort((a, b) => a.along - b.along);
}

/** nearest hole to a position (for auto hole detection) */
export function nearestHole(holes, p) {
  let best = null, bd = Infinity;
  for (const h of holes) {
    const d = Math.min(nearestOnLine(p, h.line).d, dist(p, h.center) - 10);
    if (d < bd) { bd = d; best = h; }
  }
  return bd < 120 ? best : null;
}
