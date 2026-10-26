// Course data. Primary source: the nationwide dataset bundled with the app (built from OpenStreetMap,
// see tools/extract.mjs). Fallback: the live Overpass API. Plus holes the user mapped themselves.
import { centroid, polygonCentroid, dist, nearestOnLine, lineLength, fetchJSON, sleep } from './util.js';
import { greensAround } from './geo.js';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

export async function overpass(query, { onRetry, rounds = 3 } = {}) {
  for (let round = 0; round < rounds; round++) {
    for (const ep of ENDPOINTS) {
      try {
        const j = await fetchJSON(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
        }, 60000);
        if (j.elements && !/error|timed out|out of memory/i.test(j.remark || '')) return j;
      } catch {}
    }
    if (round < rounds - 1) { onRetry?.(round + 1); await sleep(3000 * 2 ** round); }
  }
  throw new Error('地図サーバーが混み合っています。少し待って「コースデータ再取得」を押してください');
}

// ---------------- nationwide course index ----------------
let bundled = null, bundledMeta = null;
export async function bundledCourses() {
  if (bundled) return bundled;
  try {
    const j = await fetchJSON('data/courses-jp.json', {}, 45000);
    bundledMeta = { count: j.count, withHoles: j.withHoles, generatedAt: j.generatedAt };
    bundled = j.courses.map((c) => ({
      id: c.id, name: c.n, kana: c.k || '', lat: c.a, lon: c.o, bounds: c.b || null, holes: c.h || null,
      website: c.w || '', phone: c.ph || '', pref: c.p || '', operator: c.op || '',
      hasDetail: !!c.d, holesMapped: c.hm || 0, holesEst: c.em || 0, scorecard: !!c.sc, greensMapped: c.gm || 0, private: c.ac === 'private', source: 'osm', approx: !!c.ap, unnamed: !!c.un, address: c.ad ? c.p + c.ad.replace(c.p, '') : c.p || '',
      _s: searchKey(c.n + ' ' + (c.k || '') + ' ' + (c.op || '') + ' ' + (c.ad || '') + ' ' + (c.p || '')),
    }));
  } catch { bundled = []; }
  return bundled;
}
export const bundleInfo = () => bundledMeta;

/** fold the many ways Japanese course names are written so search finds them */
export function normalize(s) {
  return String(s || '')
    .normalize('NFKC').toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60)) // katakana → hiragana
    .replace(/ゖ/g, 'が')
    .replace(/[\s・･\-‐ー－_.'’"()（）「」&＆]/g, '');
}
/** abbreviations golfers use: CC, GC, G … */
function abbr(n) {
  return n
    .replace(/(かんとり|かんつり)(くらぶ|倶楽部)|countryclub/g, 'cc')
    .replace(/ごるふ(くらぶ|倶楽部)|golfclub/g, 'gc')
    .replace(/ごるふこす|golfcourse|golflinks|ごるふりんくす/g, 'g')
    .replace(/ごるふ場|ごるふじょう/g, '')
    .replace(/倶楽部/g, 'くらぶ');
}
const searchKey = (s) => { const n = normalize(s); return n + '|' + abbr(n); };

export async function searchCourses(q, { pref } = {}) {
  const all = await bundledCourses();
  let list = pref ? all.filter((c) => c.pref === pref) : all;
  const terms = String(q || '').trim().split(/[\s　]+/).map(normalize).filter(Boolean);
  if (terms.length) list = list.filter((c) => terms.every((t) => c._s.includes(t) || c._s.includes(abbr(t))));
  return list;
}

export async function coursesInPref(pref) {
  const all = await bundledCourses();
  const hit = all.filter((c) => c.pref === pref);
  if (hit.length) return hit;
  const q = `[out:json][timeout:60];area["name"="${pref}"]["admin_level"="4"]->.a;nwr["leisure"="golf_course"](area.a);out tags center bb;`;
  const j = await overpass(q);
  return (j.elements || []).map(toCourse).filter(Boolean);
}

export async function coursesNear(lat, lon, km = 25) {
  const all = await bundledCourses();
  if (all.length) return all.filter((c) => dist({ lat, lon }, c) <= km * 1000);
  const j = await overpass(`[out:json][timeout:40];nwr["leisure"="golf_course"](around:${Math.round(km * 1000)},${lat},${lon});out tags center bb;`);
  return (j.elements || []).map(toCourse).filter(Boolean);
}

/** find the course closest to a coordinate (used to attach GORA courses to map data) */
export async function matchCourse(lat, lon) {
  const list = await coursesNear(lat, lon, 3);
  list.sort((a, b) => dist({ lat, lon }, a) - dist({ lat, lon }, b));
  return list[0] || null;
}

function toCourse(el) {
  const t = el.tags || {};
  const c = el.center || (el.lat ? { lat: el.lat, lon: el.lon } : null);
  if (!c || !(t.name || t['name:ja'])) return null;
  const b = el.bounds;
  return {
    id: `osm-${el.type}-${el.id}`, name: t.name || t['name:ja'], kana: t['name:ja-Hira'] || '',
    lat: c.lat, lon: c.lon, bounds: b ? [b.minlat, b.minlon, b.maxlat, b.maxlon] : null,
    holes: t.holes ? Number(t.holes) : null, phone: t.phone || '', website: t.website || '', address: '', source: 'osm',
  };
}

// ---------------- course detail (holes, greens, hazards) ----------------
const EMPTY = () => ({ holes: [], greens: [], tees: [], bunkers: [], water: [], fairways: [], pins: [], source: 'none' });

export async function courseFeatures(course, { onRetry, liveFallback = true } = {}) {
  const id = course.osmId || course.id;
  const known = (await bundledCourses()).find((x) => x.id === id);
  if (/^osm-/.test(id) && (!known || known.hasDetail)) {
    try { const j = await fetchJSON(`data/c/${id}.json`, {}, 30000); return { ...parseCompact(j), source: 'bundle' }; }
    catch (e) { if (e.status && e.status !== 404) throw e; }
  }
  if (!liveFallback) return EMPTY();
  // not in the bundle (new or unmapped course): ask the live server once
  let [s, w, n, e] = course.bounds || [course.lat - 0.012, course.lon - 0.015, course.lat + 0.012, course.lon + 0.015];
  const pad = 0.002; s -= pad; w -= pad; n += pad; e += pad;
  const j = await overpass(`[out:json][timeout:60][bbox:${s},${w},${n},${e}];(way["golf"];relation["golf"];way["natural"="water"];relation["natural"="water"];);out geom;`, { onRetry, rounds: 2 });
  return { ...parseFeatures(j.elements || []), source: 'live' };
}

const pts = (flat) => { const out = []; for (let i = 0; i + 1 < flat.length; i += 2) out.push({ lat: flat[i], lon: flat[i + 1] }); return out; };
let seq = 0;
function poly(rings, kind) { const p = pts(rings[0] || []); return { id: `${kind}${seq++}`, pts: p, c: p.length ? polygonCentroid(p) : null }; }

export function parseCompact(j) {
  const f = EMPTY();
  for (const h of j.holes || []) {
    const p = pts(h.g); const ref = parseInt(h.r, 10);
    f.holes.push({ id: `h${seq++}`, pts: p, c: centroid(p), ref: Number.isFinite(ref) ? ref : null, par: h.p || null, hcp: h.h || null, distTag: h.d || null, name: h.n || '', drawn: !!h.m, fixedSet: Number.isInteger(h.s) ? h.s : null });
  }
  for (const [k, arr] of [['greens', j.greens], ['tees', j.tees], ['bunkers', j.bunkers], ['water', j.water], ['fairways', j.fairways]]) {
    for (const rings of arr || []) { const x = poly(rings, k); if (x.c) f[k].push(x); }
  }
  for (const p of j.pins || []) { const q = pts(p); if (q.length) f.pins.push({ id: `p${seq++}`, pts: q, c: q[0] }); }
  // estimated holes (tools/auto-holes.mjs): used like registered holes, lowest priority
  f.estHoles = {};
  for (const h of j.est || []) f.estHoles[h.k] = { tee: h.tee, mid: h.mid, green: h.green, par: h.par, est: true };
  return f;
}

function geomOf(el) {
  if (el.geometry) return el.geometry.map((p) => ({ lat: p.lat, lon: p.lon }));
  if (el.members) return el.members.filter((m) => m.role !== 'inner' && m.geometry).flatMap((m) => m.geometry.map((p) => ({ lat: p.lat, lon: p.lon })));
  return [];
}
export function parseFeatures(elements) {
  const f = EMPTY();
  for (const el of elements) {
    const t = el.tags || {};
    const g = geomOf(el);
    if (!g.length) continue;
    const kind = t.golf || (t.natural === 'water' ? 'water_hazard' : '');
    const base = { id: `${el.type}/${el.id}`, pts: g, c: polygonCentroid(g) };
    if (kind === 'hole') { const ref = parseInt(t.ref, 10); f.holes.push({ ...base, ref: Number.isFinite(ref) ? ref : null, par: t.par ? parseInt(t.par, 10) : null, hcp: t.handicap ? parseInt(t.handicap, 10) : null, distTag: t.dist ? parseFloat(t.dist) : null, name: t.name || '' }); }
    else if (kind === 'green') f.greens.push(base);
    else if (kind === 'tee') f.tees.push(base);
    else if (kind === 'bunker') f.bunkers.push(base);
    else if (kind === 'water_hazard' || kind === 'lateral_water_hazard') f.water.push(base);
    else if (kind === 'fairway') f.fairways.push(base);
    else if (kind === 'pin') f.pins.push(base);
  }
  return f;
}

function nearestGreen(f, p, within = 60) {
  let best = null, bd = within;
  for (const gr of f.greens) {
    const d = Math.min(dist(p, gr.c), ...gr.pts.map((q) => dist(p, q)));
    if (d < bd) { bd = d; best = gr; }
  }
  return best;
}

/**
 * Ordered hole model: { no, key, par, line, tee, green (polygon|null), center, lengthM, source }.
 * Mapped holes from the dataset come first; holes the user mapped (or the app learned) fill the gaps.
 */
export function buildHoles(f, userHoles = {}) {
  const holes = f.holes.filter((h) => h.pts.length >= 2).map((h) => {
    const end = h.pts[h.pts.length - 1];
    const green = nearestGreen(f, end, 90);
    const lengthM = h.distTag && h.distTag > 50 ? h.distTag : null;
    return { no: h.ref, par: h.par, hcp: h.hcp, name: h.name, line: h.pts, tee: h.pts[0], green, center: green ? green.c : end, lengthM: lengthM || lineLength(h.pts), source: 'osm', drawn: !!h.drawn, fixedSet: h.fixedSet ?? null };
  });
  holes.sort((a, b) => (a.no ?? 99) - (b.no ?? 99));
  assignSets(holes);
  // holes we drew for a 27-hole club carry their course (scorecard order), so no routing guess is needed
  for (const h of holes) if (h.fixedSet != null) h.set = h.fixedSet;
  for (const h of holes) if (h.no != null) h.key = h.set ? `${h.no}-${h.set + 1}` : String(h.no);
  let i = 0;
  for (const h of holes) if (h.no == null) { h.no = 100 + (++i); h.key = `x${i}`; }

  // user / learned holes
  const have = new Set(holes.map((h) => h.key));
  const out = [...holes];
  // keys: "n" (course A) or "n-s" (course s); placeholders 1–18 only when nothing at all is mapped
  const keys = new Set(Object.keys(userHoles));
  if (!holes.length && !Object.values(userHoles).some((u) => u?.est)) for (let n = 1; n <= 18; n++) keys.add(String(n));
  for (const key of keys) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(key); if (!m) continue;
    const n = Number(m[1]), set = m[2] ? Number(m[2]) - 1 : 0;
    const u = userHoles[key];
    if (u?.hidden) continue;
    if (have.has(key)) {
      const h = out.find((x) => x.key === key);
      // a hole drawn by us from the aerial photo gives way to the player's own registration — only one tapped by hand
      // (not auto-learned) and of a believable length: an old stray tap once made 草津温泉 1番 1,500 yd
      const own = h.drawn && u?.tee && u?.green && !u.est && !u.learned && !u.community && [u.tee, u.mid, u.green].filter(Boolean);
      const r = own ? lineLength(own) / h.lengthM : 0;
      if (own && r > 0.7 && r < 1.4) out.splice(out.indexOf(h), 1);
      else {
        // user may correct par on a mapped hole
        if (u?.par) h.par = u.par;
        continue;
      }
    }
    if (u?.tee || u?.green) {
      const line = [u.tee, ...(u.mid ? [u.mid] : []), u.green].filter(Boolean);
      const green = u.green ? nearestGreen(f, u.green, 40) : null;
      out.push({ no: n, key, set, par: u.par || null, line: line.length >= 2 ? line : [], tee: u.tee || null, green, center: u.green || null, lengthM: line.length >= 2 ? lineLength(line) : 0, source: u.learned ? 'learned' : u.community ? 'community' : u.est ? 'est' : 'user' });
    } else {
      out.push({ no: n, key, set, par: u?.par || null, line: [], tee: null, green: null, center: null, lengthM: 0, source: 'none' });
    }
  }
  // 2-green systems: keep both outlines as separate targets (never their midpoint)
  for (const h of out) {
    if (!h.center) continue;
    const around = greensAround(f.greens, h.green?.c || h.center, 70);
    if (!h.green && around[0] && dist(around[0].c, h.center) < 30) h.green = around[0];
    const opts = h.green ? [h.green, ...around.filter((g) => g !== h.green)] : around;
    if (opts.length >= 2) h.greenOptions = opts.slice(0, 2);
  }
  // estimate par from length when the data has none (shown as 推定)
  for (const h of out) if (!h.par && h.lengthM) { const y = h.lengthM / 0.9144; h.par = y < 250 ? 3 : y < 470 ? 4 : 5; h.parEst = true; }
  return out.sort((a, b) => a.no - b.no || String(a.key).localeCompare(String(b.key)));
}

/**
 * 27/36-hole clubs map several holes with the same number. Split them into separate courses by following
 * the routing: the next hole's tee is the one closest to the previous hole's green.
 */
function assignSets(holes) {
  const byNo = new Map();
  for (const h of holes) if (h.no != null) (byNo.get(h.no) || byNo.set(h.no, []).get(h.no)).push(h);
  const multi = Math.max(0, ...[...byNo.values()].map((a) => a.length));
  for (const h of holes) h.set = 0;
  if (multi < 2) return;
  const nos = [...byNo.keys()].sort((a, b) => a - b);
  const chains = [];
  for (const n of nos) {
    const pool = byNo.get(n).slice();
    // greedy matching: shortest green→tee walk first
    const pairs = [];
    for (const ch of chains) for (const h of pool) { const last = ch[ch.length - 1]; if (last.no === n - 1 || last.no === n - 2) pairs.push({ ch, h, d: dist(last.center, h.tee) }); }
    pairs.sort((a, b) => a.d - b.d);
    const used = new Set(), extended = new Set();
    for (const p of pairs) { if (used.has(p.h) || extended.has(p.ch) || p.d > 900) continue; p.ch.push(p.h); used.add(p.h); extended.add(p.ch); }
    for (const h of pool) if (!used.has(h)) chains.push([h]);
  }
  // join broken pieces: a chain that starts right after another ends (by number) and close by
  for (let merged = true; merged;) {
    merged = false;
    for (const a of chains) {
      if (!a.length) continue; // emptied by an earlier merge in this pass
      const end = a[a.length - 1];
      let best = null, bd = 1200;
      for (const b of chains) {
        if (b === a || !b.length) continue;
        const nums = new Set(a.map((h) => h.no));
        if (b[0].no <= end.no || b.some((h) => nums.has(h.no))) continue;
        const d = dist(end.center, b[0].tee);
        if (d < bd) { bd = d; best = b; }
      }
      if (best) { a.push(...best.splice(0)); merged = true; }
    }
    for (let i = chains.length - 1; i >= 0; i--) if (!chains[i].length) chains.splice(i, 1);
  }
  // biggest chains first (main courses), then number them A, B, C…
  chains.sort((a, b) => b.length - a.length || (a[0].no ?? 0) - (b[0].no ?? 0));
  chains.forEach((ch, i) => ch.forEach((h) => (h.set = i)));
  // when mappers named the holes after their course ("East Hole 1", "西 3番"), the names win over the routing guess;
  // each name keeps the set number most of its holes already had, so saved registrations stay on the same course
  const label = (n) => { const m = String(n || '').match(/\b(east|west|north|south|central|middle)\b|(東|西|南|北|中)/i); return m ? (m[1] || m[2]).toLowerCase() : null; };
  const numbered = holes.filter((h) => h.no != null && h.no <= 18);
  const named = numbered.filter((h) => label(h.name));
  const names = [...new Set(named.map((h) => label(h.name)))];
  if (names.length < 2 || named.length < numbered.length * 0.8) return;
  const votes = names.map((nm) => { const c = {}; for (const h of named) if (label(h.name) === nm) c[h.set] = (c[h.set] || 0) + 1; return { nm, c }; });
  const taken = new Set(), setOf = {};
  for (const v of votes.sort((a, b) => Math.max(...Object.values(b.c)) - Math.max(...Object.values(a.c)))) {
    const best = Object.entries(v.c).sort((a, b) => b[1] - a[1]).map(([s]) => Number(s)).find((s) => !taken.has(s));
    const s = best ?? Math.max(-1, ...taken, ...holes.map((h) => h.set)) + 1;
    taken.add(s); setOf[v.nm] = s;
  }
  for (const h of named) h.set = setOf[label(h.name)];
}
export const setLabel = (i) => `コース${'ABCDEFGH'[i] || i + 1}`;

/** hazards that matter for a hole, with distance along the hole and side */
export function hazardsForHole(hole, f) {
  if (!hole?.line?.length || !f) return [];
  const list = [];
  const consider = (arr, type) => {
    for (const hz of arr) {
      if (!hz.c) continue;
      const near = nearestOnLine(hz.c, hole.line);
      const reach = Math.max(5, ...hz.pts.map((p) => dist(hz.c, p)));
      if (near.d - reach > 35) continue;
      if (near.along < 20 && near.d > 40) continue;
      list.push({ type, hz, along: near.along, lateral: near.lateral, size: reach, nearGreen: hole.center ? dist(hz.c, hole.center) < 45 : false });
    }
  };
  consider(f.bunkers, 'bunker');
  consider(f.water, 'water');
  for (const h of hole.aiHazards || []) list.push(h);
  return list.sort((a, b) => a.along - b.along);
}

/** nearest playable hole to a position (for auto hole detection) */
export function nearestHole(holes, p) {
  let best = null, bd = Infinity;
  for (const h of holes) {
    if (!h.center) continue;
    const d = Math.min(h.line.length >= 2 ? nearestOnLine(p, h.line).d : Infinity, dist(p, h.center) - 10, h.tee ? dist(p, h.tee) : Infinity);
    if (d < bd) { bd = d; best = h; }
  }
  return bd < 120 ? best : null;
}

/** greens closest to the player — used when a hole is not mapped yet */
export function greensNear(f, p, n = 4) {
  return (f?.greens || []).filter((g) => g.c).map((g) => ({ g, d: dist(p, g.c) })).sort((a, b) => a.d - b.d).slice(0, n);
}
