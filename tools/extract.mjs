// Extract every golf course in Japan (with holes, greens, tees, bunkers, water, fairways) from an OSM PBF.
// Three streaming passes: relations → ways → nodes. Writes data/courses-jp.json + data/c/<id>.json.
// usage: node --max-old-space-size=8192 extract.mjs japan-latest.osm.pbf ../golf-navi/data
import fs from 'node:fs';
import zlib from 'node:zlib';
import Pbf from 'pbf';

const [, , PBF_FILE, OUT_DIR] = process.argv;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

// ---------------- raw PBF block reader ----------------
function* blocks(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  let pos = 0;
  const lenBuf = Buffer.alloc(4);
  while (pos < size) {
    fs.readSync(fd, lenBuf, 0, 4, pos); pos += 4;
    const hlen = lenBuf.readUInt32BE(0);
    const hbuf = Buffer.alloc(hlen); fs.readSync(fd, hbuf, 0, hlen, pos); pos += hlen;
    const hdr = new Pbf(hbuf).readFields((tag, h, p) => { if (tag === 1) h.type = p.readString(); else if (tag === 3) h.datasize = p.readVarint(); }, {});
    const bbuf = Buffer.alloc(hdr.datasize); fs.readSync(fd, bbuf, 0, hdr.datasize, pos); pos += hdr.datasize;
    if (hdr.type !== 'OSMData') continue;
    const blob = new Pbf(bbuf).readFields((tag, b, p) => { if (tag === 1) b.raw = p.readBytes(); else if (tag === 3) b.zlib = p.readBytes(); }, {});
    yield { data: blob.raw || zlib.inflateSync(blob.zlib), progress: pos / size };
  }
  fs.closeSync(fd);
}

/** decode a PrimitiveBlock; `want` = { dense, ways, relations } callbacks */
function decodeBlock(data, want) {
  const pbf = new Pbf(data);
  const strings = [];
  let gran = 100, latOff = 0, lonOff = 0;
  const groups = [];
  pbf.readFields((tag, _, p) => {
    if (tag === 1) { const end = p.readVarint() + p.pos; while (p.pos < end) { const t = p.readVarint() >> 3; if (t === 1) strings.push(p.readString()); else p.skip(t); } }
    else if (tag === 2) { const len = p.readVarint(); groups.push([p.pos, p.pos + len]); p.pos += len; }
    else if (tag === 17) gran = p.readVarint();
    else if (tag === 19) latOff = p.readVarint(true);
    else if (tag === 20) lonOff = p.readVarint(true);
  }, null);
  for (const [s, e] of groups) {
    pbf.pos = s;
    while (pbf.pos < e) {
      const val = pbf.readVarint(), tag = val >> 3, type = val & 7;
      if (tag === 2 && want.dense) { const len = pbf.readVarint(); readDense(pbf, pbf.pos + len, strings, gran, latOff, lonOff, want.dense); }
      else if (tag === 3 && want.ways) { const len = pbf.readVarint(); want.ways(readWay(pbf, pbf.pos + len, strings)); }
      else if (tag === 4 && want.relations) { const len = pbf.readVarint(); want.relations(readRel(pbf, pbf.pos + len, strings)); }
      else pbf.skip(val);
    }
  }
}
function readTags(keys, vals, strings) { const t = {}; for (let i = 0; i < keys.length; i++) t[strings[keys[i]]] = strings[vals[i]]; return t; }
function readWay(pbf, end, strings) {
  let id = 0, keys = [], vals = [], refs = [];
  while (pbf.pos < end) {
    const v = pbf.readVarint(), tag = v >> 3;
    if (tag === 1) id = pbf.readVarint();
    else if (tag === 2) keys = pbf.readPackedVarint();
    else if (tag === 3) vals = pbf.readPackedVarint();
    else if (tag === 8) refs = pbf.readPackedSVarint();
    else pbf.skip(v);
  }
  let r = 0; for (let i = 0; i < refs.length; i++) { r += refs[i]; refs[i] = r; }
  return { id, tags: readTags(keys, vals, strings), refs };
}
function readRel(pbf, end, strings) {
  let id = 0, keys = [], vals = [], roles = [], mem = [], types = [];
  while (pbf.pos < end) {
    const v = pbf.readVarint(), tag = v >> 3;
    if (tag === 1) id = pbf.readVarint();
    else if (tag === 2) keys = pbf.readPackedVarint();
    else if (tag === 3) vals = pbf.readPackedVarint();
    else if (tag === 8) roles = pbf.readPackedVarint();
    else if (tag === 9) mem = pbf.readPackedSVarint();
    else if (tag === 10) types = pbf.readPackedVarint();
    else pbf.skip(v);
  }
  let m = 0; const members = mem.map((d, i) => { m += d; return { ref: m, type: types[i], role: strings[roles[i]] }; });
  return { id, tags: readTags(keys, vals, strings), members };
}
function readDense(pbf, end, strings, gran, latOff, lonOff, cb) {
  let ids = [], lats = [], lons = [], kv = [];
  while (pbf.pos < end) {
    const v = pbf.readVarint(), tag = v >> 3;
    if (tag === 1) ids = pbf.readPackedSVarint();
    else if (tag === 8) lats = pbf.readPackedSVarint();
    else if (tag === 9) lons = pbf.readPackedSVarint();
    else if (tag === 10) kv = pbf.readPackedVarint();
    else pbf.skip(v);
  }
  let id = 0, la = 0, lo = 0, k = 0;
  for (let i = 0; i < ids.length; i++) {
    id += ids[i]; la += lats[i]; lo += lons[i];
    let tags = null;
    if (kv.length) {
      while (k < kv.length && kv[k] !== 0) { (tags ??= {})[strings[kv[k]]] = strings[kv[k + 1]]; k += 2; }
      k++;
    }
    cb(id, (latOff + gran * la) * 1e-9, (lonOff + gran * lo) * 1e-9, tags);
  }
}
function pass(name, want) {
  let n = 0, last = 0;
  for (const b of blocks(PBF_FILE)) {
    decodeBlock(b.data, want);
    if (++n % 2000 === 0 && b.progress - last > 0.05) { last = b.progress; log(`${name} ${(b.progress * 100).toFixed(0)}%`); }
  }
}

// ---------------- what we keep ----------------
const GOLF = new Set(['hole', 'green', 'tee', 'bunker', 'fairway', 'water_hazard', 'lateral_water_hazard', 'pin', 'driving_range', 'rough']);
const isCourse = (t) => t.leisure === 'golf_course';
const isGolf = (t) => GOLF.has(t.golf);
const isWater = (t) => t.natural === 'water' || t.water === 'pond' || t.water === 'lake' || t.landuse === 'reservoir';

// pass 1: relations
const rels = [];
const relWayIds = new Set();
pass('relations', {
  relations: (r) => {
    if (!(isCourse(r.tags) || isGolf(r.tags) || (isWater(r.tags) && r.tags.type === 'multipolygon'))) return;
    const members = r.members.filter((m) => m.type === 1);
    rels.push({ id: r.id, tags: r.tags, members });
    for (const m of members) relWayIds.add(m.ref);
  },
});
log('relations kept', rels.length, 'member ways', relWayIds.size);

// things that carry a golf course's name without being the course outline:
// clubhouses, sport=golf areas, buildings / amenities named like a course
const GOLFNAME = /(カントリー|カンツリー|ゴルフ|倶楽部|ＧＣ|ＣＣ|\bG\.?C\b|\bC\.?C\b|golf|country ?club|links)/i;
const isNameSrc = (t) => !!t.name && !t.highway && !t.railway && !t.public_transport && !t.route && !t.bus && !t.boundary && !t.place
  && (t.sport === 'golf' || t.club === 'golf' || (GOLFNAME.test(t.name) && (t.building || t.amenity || t.leisure || t.tourism || t.club || t.sport || t.landuse || t.shop === undefined && t.office === undefined)));
const nameNodes = [];

// pass 2: ways
const ways = new Map(); // id -> {tags, refs}
pass('ways', {
  ways: (w) => {
    const t = w.tags;
    if (isCourse(t) || isGolf(t) || isWater(t) || relWayIds.has(w.id) || isNameSrc(t)) ways.set(w.id, { tags: t, refs: w.refs });
  },
});
log('ways kept', ways.size);

// pass 3: nodes (merge-join against sorted needed ids)
let need = new Float64Array([...new Set([...ways.values()].flatMap((w) => w.refs))]).sort();
const nlat = new Float64Array(need.length), nlon = new Float64Array(need.length);
const poiNodes = [];
let ptr = 0;
pass('nodes', {
  dense: (id, lat, lon, tags) => {
    while (ptr < need.length && need[ptr] < id) ptr++;
    if (ptr < need.length && need[ptr] === id) { nlat[ptr] = lat; nlon[ptr] = lon; }
    if (tags && (isCourse(tags) || tags.golf === 'pin' || tags.golf === 'tee' || tags.golf === 'green')) poiNodes.push({ id, lat, lon, tags });
    else if (tags && isNameSrc(tags)) nameNodes.push({ lat, lon, tags });
  },
});
log('nodes resolved', need.length, 'poi nodes', poiNodes.length);
function nodeIdx(id) { let lo = 0, hi = need.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (need[m] === id) return m; if (need[m] < id) lo = m + 1; else hi = m - 1; } return -1; }
function wayGeom(w) { const out = []; for (const r of w.refs) { const i = nodeIdx(r); if (i >= 0 && (nlat[i] || nlon[i])) out.push([nlat[i], nlon[i]]); } return out; }

// ---------------- geometry helpers ----------------
const R = 6371008.8, rad = Math.PI / 180;
const dist = (a, b) => { const dLa = (b[0] - a[0]) * rad, dLo = (b[1] - a[1]) * rad; const s = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
const bboxOf = (rings) => { let s = 90, w = 180, n = -90, e = -180; for (const r of rings) for (const [la, lo] of r) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); } return [s, w, n, e]; };
const centroid = (pts) => [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
function inRing(p, ring) { let ins = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [yi, xi] = ring[i], [yj, xj] = ring[j]; if ((yi > p[0]) !== (yj > p[0]) && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi) ins = !ins; } return ins; }
const inRings = (p, rings) => rings.some((r) => r.length > 3 && inRing(p, r));
// join relation member ways into rings
function joinRings(segs) {
  const rings = []; const pool = segs.filter((s) => s.length > 1).map((s) => s.slice());
  while (pool.length) {
    let ring = pool.shift();
    let guard = 0;
    while (guard++ < 5000 && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
      const end = ring[ring.length - 1];
      const i = pool.findIndex((s) => (s[0][0] === end[0] && s[0][1] === end[1]) || (s[s.length - 1][0] === end[0] && s[s.length - 1][1] === end[1]));
      if (i < 0) break;
      const s = pool.splice(i, 1)[0];
      ring = ring.concat(s[0][0] === end[0] && s[0][1] === end[1] ? s.slice(1) : s.reverse().slice(1));
    }
    rings.push(ring);
  }
  return rings;
}
// Douglas–Peucker in meters
function simplify(pts, tol) {
  if (pts.length < 5) return pts;
  const o = pts[0], k = Math.cos(o[0] * rad) * R * rad, kl = R * rad;
  const xy = pts.map((p) => [(p[1] - o[1]) * k, (p[0] - o[0]) * kl]);
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let md = 0, mi = -1;
    const [ax, ay] = xy[a], [bx, by] = xy[b]; const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
    for (let i = a + 1; i < b; i++) { const d = L < 1e-6 ? Math.hypot(xy[i][0] - ax, xy[i][1] - ay) : Math.abs(dy * xy[i][0] - dx * xy[i][1] + bx * ay - by * ax) / L; if (d > md) { md = d; mi = i; } }
    if (md > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const flat = (pts) => pts.flatMap(([a, b]) => [Math.round(a * 1e6) / 1e6, Math.round(b * 1e6) / 1e6]);

// ---------------- build features ----------------
const features = []; // {kind, tags, rings|line, c, bb, src}
const courses = [];
const usedAsRelMember = new Set();
for (const r of rels) {
  const outer = r.members.filter((m) => m.role !== 'inner').map((m) => ways.get(m.ref)).filter(Boolean).map(wayGeom);
  const rings = joinRings(outer);
  if (!rings.length || !rings[0].length) continue;
  const obj = { id: `osm-relation-${r.id}`, tags: r.tags, rings, bb: bboxOf(rings), c: centroid(rings.flat()) };
  if (isCourse(r.tags)) courses.push(obj);
  else features.push({ ...obj, kind: isGolf(r.tags) ? r.tags.golf : 'water' });
  if (!Object.keys(r.tags).some((k) => k !== 'type')) continue;
  for (const m of r.members) usedAsRelMember.add(m.ref);
}
for (const [id, w] of ways) {
  const t = w.tags;
  if (!(isCourse(t) || isGolf(t) || isWater(t))) continue;
  const g = wayGeom(w); if (g.length < 2) continue;
  const obj = { id: `osm-way-${id}`, tags: t, rings: [g], bb: bboxOf([g]), c: centroid(g) };
  if (isCourse(t)) courses.push(obj);
  else features.push({ ...obj, kind: isGolf(t) ? t.golf : 'water' });
}
for (const n of poiNodes) {
  const obj = { id: `osm-node-${n.id}`, tags: n.tags, rings: [], bb: [n.lat, n.lon, n.lat, n.lon], c: [n.lat, n.lon] };
  if (isCourse(n.tags)) courses.push({ ...obj, point: true });
  else features.push({ ...obj, kind: n.tags.golf, rings: [[[n.lat, n.lon]]] });
}
log('courses raw', courses.length, 'features', features.length);

// name sources (clubhouses etc.), names cleaned of facility words
const FACILITY = /\s*(の)?(クラブハウス|ｸﾗﾌﾞﾊｳｽ|クラブ・ハウス|レストラン|駐車場|フロント|事務所|ゲート|入口|入り口|管理棟|コテージ|ロッジ|売店|茶店|休憩所|スタート小屋|練習グリーン|カート庫)\s*$/;
const nameSrcs = [];
for (const n of nameNodes) nameSrcs.push({ name: n.tags.name.replace(FACILITY, '').trim(), c: [n.lat, n.lon], strong: n.tags.sport === 'golf' || n.tags.club === 'golf' || /クラブハウス/.test(n.tags.name), tags: n.tags });
for (const [, w] of ways) {
  const t = w.tags;
  if (isCourse(t) || isGolf(t) || isWater(t) || !isNameSrc(t)) continue;
  const g = wayGeom(w); if (!g.length) continue;
  nameSrcs.push({ name: t.name.replace(FACILITY, '').trim(), c: centroid(g), strong: t.sport === 'golf' || t.club === 'golf' || /クラブハウス/.test(t.name), tags: t, area: g.length > 3 ? dist([bboxOf([g])[0], bboxOf([g])[1]], [bboxOf([g])[2], bboxOf([g])[3]]) : 0 });
}
log('name sources', nameSrcs.length);

// course name & filtering
const UNNAMED = '名称未登録のゴルフ場';
const NOT_GOLF_EARLY = /パークゴルフ|マレットゴルフ|グラ[ウン]*ンド[・･]?ゴルフ|ゲートボール|練習場|打ち?っ?放し|ミニゴルフ|フットゴルフ|ディスクゴルフ/;
const RANGE = /練習場|打ち?っ?放し|打ちっぱなし|ドライビングレンジ|ゴルフレンジ|インドア|シミュレーション|ゴルフスタジオ|パター|パット|ゲートボール|パークゴルフ|グラウンドゴルフ|グランドゴルフ/;
for (const c of courses) {
  c.name = c.tags.name || c.tags['name:ja'] || c.tags.official_name || c.tags.operator || '';
  c.diag = dist([c.bb[0], c.bb[1]], [c.bb[2], c.bb[3]]);
}
// unnamed course outlines: borrow the name of a course point (or another named outline) inside / next to it
{
  // 1) a clubhouse / sport=golf name inside the outline
  for (const c of courses) {
    if (c.name || c.point || c.diag < 300) continue;
    const inside = nameSrcs.filter((n) => n.c[0] >= c.bb[0] - 0.003 && n.c[0] <= c.bb[2] + 0.003 && n.c[1] >= c.bb[1] - 0.003 && n.c[1] <= c.bb[3] + 0.003 && (inRings(n.c, c.rings) || dist(n.c, c.c) < c.diag / 2 + 200) && !NOT_GOLF_EARLY.test(n.name));
    inside.sort((a, b) => (b.strong ? 1 : 0) - (a.strong ? 1 : 0) || (GOLFNAME.test(b.name) ? 1 : 0) - (GOLFNAME.test(a.name) ? 1 : 0));
    if (inside[0]) { c.name = inside[0].name; c.nameFrom = 'clubhouse'; }
  }
  const named = courses.filter((c) => c.name);
  for (const c of courses) {
    if (c.name || c.point || c.diag < 300) continue;
    let best = null, bd = Infinity;
    for (const n of named) {
      if (n === c) continue;
      const inside = c.rings.some((r) => r.length > 3 && inRing(n.c, r));
      const d = dist(c.c, n.c);
      if ((inside || d < Math.max(400, c.diag / 2)) && d < bd) { bd = d; best = n; }
    }
    if (best) { c.name = best.name; c.borrowed = best; if (!best.point) best.mergedInto = c; }
  }
  // an outline that borrowed a name from another outline: keep the larger one only
  for (const c of courses) {
    if (!c.borrowed || c.borrowed.point) continue;
    if (c.borrowed.diag >= c.diag) c.name = ''; else c.borrowed.name = '';
  }
  // still unnamed but course-sized: keep for now; dropped later unless hole data is mapped inside
  for (const c of courses) if (!c.name && !c.point && c.diag > 800) { c.name = UNNAMED; c.unnamed = true; }
}
const NOT_GOLF = /パークゴルフ|マレットゴルフ|グラ[ウン]*ンド[・･]?ゴルフ|グランドゴルフ|ターゲットバード|ゲートボール|ゴルフ練習|練習場|打ち?っ?放し|打ちっぱなし|ミニゴルフ|フットゴルフ|ディスクゴルフ|アスレチックゴルフ|スナッグゴルフ|ゴルフ場跡|跡地/;
let list = courses.filter((c) => c.name && !NOT_GOLF.test(c.name) && !(c.tags.golf === 'driving_range') && !(RANGE.test(c.name) && c.diag < 600) && c.tags.golf_course !== 'driving_range' && c.tags.golf !== 'miniature' && c.tags['golf:course'] !== 'driving_range');
// one club mapped as several outlines with the same name → merge into one course
{
  const byName = new Map();
  for (const c of list) (byName.get(c.name) || byName.set(c.name, []).get(c.name)).push(c);
  const drop = new Set();
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => (a.point ? 1 : 0) - (b.point ? 1 : 0) || b.diag - a.diag);
    for (const keep of group) {
      if (drop.has(keep)) continue;
      for (const o of group) {
        if (o === keep || drop.has(o) || dist(keep.c, o.c) > 3000) continue;
        if (!o.point) { keep.rings = keep.rings.concat(o.rings); keep.bb = bboxOf(keep.rings); keep.c = centroid(keep.rings.flat()); keep.diag = dist([keep.bb[0], keep.bb[1]], [keep.bb[2], keep.bb[3]]); keep.point = false; }
        drop.add(o);
      }
    }
  }
  list = list.filter((c) => !drop.has(c));
}
// drop POI duplicates sitting inside (or within 600m of) a polygon with a similar name or any polygon
const polys = list.filter((c) => !c.point);
list = list.filter((c) => !c.point || !polys.some((p) => (inRings(c.c, p.rings) || dist(c.c, p.c) < 500)));
log('courses after filter', list.length);

// spatial grid for courses
const G = 0.05, grid = new Map();
const key = (la, lo) => `${Math.floor(la / G)},${Math.floor(lo / G)}`;
for (const c of list) for (let la = Math.floor(c.bb[0] / G) - 1; la <= Math.floor(c.bb[2] / G) + 1; la++) for (let lo = Math.floor(c.bb[1] / G) - 1; lo <= Math.floor(c.bb[3] / G) + 1; lo++) { const k = `${la},${lo}`; (grid.get(k) || grid.set(k, []).get(k)).push(c); }
const nearbyCourses = (p) => grid.get(key(p[0], p[1])) || [];

// assign features to courses
for (const c of list) c.f = [];
for (const f of features) {
  const cands = nearbyCourses(f.c);
  let best = null, bestScore = Infinity;
  for (const c of cands) {
    let score;
    if (!c.point && inRings(f.c, c.rings)) score = c.diag / 1e6; // inside: prefer the smallest containing course
    else if (!c.point) { const d = Math.min(...c.rings[0].filter((_, i) => i % 3 === 0).map((p) => dist(p, f.c))); score = d < (f.kind === 'water' ? 0 : 250) ? 10 + d : Infinity; }
    else { const d = dist(c.c, f.c); score = d < (f.kind === 'water' ? 900 : 1500) ? 1000 + d : Infinity; }
    if (score < bestScore) { bestScore = score; best = c; }
  }
  if (best) { best.f.push(f); f.assigned = true; }
}

// golf features that belong to no course outline: cluster them (single-link, 350m) into new courses
{
  const loose = features.filter((f) => !f.assigned && ['hole', 'green', 'tee', 'bunker', 'fairway'].includes(f.kind));
  const cell = 0.004, grid2 = new Map();
  loose.forEach((f, i) => { const k = `${Math.floor(f.c[0] / cell)},${Math.floor(f.c[1] / cell)}`; (grid2.get(k) || grid2.set(k, []).get(k)).push(i); });
  const comp = new Int32Array(loose.length).fill(-1);
  let nComp = 0;
  for (let i = 0; i < loose.length; i++) {
    if (comp[i] >= 0) continue;
    const stack = [i]; comp[i] = nComp;
    while (stack.length) {
      const a = loose[stack.pop()];
      const gy = Math.floor(a.c[0] / cell), gx = Math.floor(a.c[1] / cell);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const j of grid2.get(`${gy + dy},${gx + dx}`) || []) {
        if (comp[j] < 0 && dist(a.c, loose[j].c) < 350) { comp[j] = nComp; stack.push(j); }
      }
    }
    nComp++;
  }
  const groups = Array.from({ length: nComp }, () => []);
  loose.forEach((f, i) => groups[comp[i]].push(f));
  let made = 0;
  for (const g of groups) {
    const greens = g.filter((f) => f.kind === 'green').length, holesN = g.filter((f) => f.kind === 'hole').length;
    if (greens < 4 && holesN < 3) continue;
    const bb = bboxOf(g.flatMap((f) => f.rings));
    const c = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
    const diag = dist([bb[0], bb[1]], [bb[2], bb[3]]);
    const src = nameSrcs.filter((n) => dist(n.c, c) < diag / 2 + 600 && !NOT_GOLF_EARLY.test(n.name)).sort((a, b) => (b.strong ? 1 : 0) - (a.strong ? 1 : 0) || dist(a.c, c) - dist(b.c, c))[0];
    const ring = [[bb[0], bb[1]], [bb[0], bb[3]], [bb[2], bb[3]], [bb[2], bb[1]], [bb[0], bb[1]]];
    const course = { id: `osm-cluster-${Math.round(c[0] * 1e5)}-${Math.round(c[1] * 1e5)}`, tags: {}, rings: [ring], bb, c, diag, name: src ? src.name : UNNAMED, unnamed: !src, f: g, fromCluster: true };
    list.push(course); made++;
  }
  log('courses from feature clusters', made);
}

// prefecture lookup
const prefs = JSON.parse(fs.readFileSync(process.env.PREF_GEOJSON || new URL('./japan-pref.geojson', import.meta.url), 'utf8')).features.map((f) => {
  const polysP = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const rings = polysP.map((p) => p[0].map(([lo, la]) => [la, lo]));
  return { name: f.properties.nam_ja, rings, bbs: rings.map((r) => bboxOf([r])) };
});
function prefOf(p) {
  for (const pr of prefs) for (let i = 0; i < pr.rings.length; i++) { const b = pr.bbs[i]; if (p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3] && inRing(p, pr.rings[i])) return pr.name; }
  let best = '', bd = Infinity; // coastal points slightly outside the simplified outline
  for (const pr of prefs) for (const r of pr.rings) for (let i = 0; i < r.length; i += 20) { const d = dist(p, r[i]); if (d < bd) { bd = d; best = pr.name; } }
  return best;
}

// ---------------- write ----------------
fs.mkdirSync(`${OUT_DIR}/c`, { recursive: true });
for (const f of fs.readdirSync(`${OUT_DIR}/c`)) fs.unlinkSync(`${OUT_DIR}/c/${f}`);
const index = [];
let detailBytes = 0, withHoles = 0;
for (const c of list) {
  const holes = [], greens = [], tees = [], bunkers = [], water = [], fairways = [], pins = [];
  for (const f of c.f) {
    const ring0 = f.rings[0] || [];
    const t = f.tags;
    if (f.kind === 'hole') {
      if (ring0.length < 2) continue;
      holes.push({ r: t.ref ?? null, p: t.par ? parseInt(t.par, 10) || null : null, h: t.handicap ? parseInt(t.handicap, 10) || null : null, d: t.dist ? parseFloat(t.dist) || null : null, n: t.name || undefined, g: flat(ring0) });
    } else if (f.kind === 'pin') pins.push(flat(ring0));
    else {
      const rings = f.rings.filter((r) => r.length > 2).map((r) => flat(simplify(r, f.kind === 'green' ? 0.4 : 1.2)));
      if (!rings.length) { if (f.kind === 'tee' || f.kind === 'green') (f.kind === 'tee' ? tees : greens).push([flat(ring0)]); continue; }
      ({ green: greens, tee: tees, bunker: bunkers, fairway: fairways, water: water, water_hazard: water, lateral_water_hazard: water }[f.kind] || []).push(rings);
    }
  }
  // bbox from features for POI courses
  let bb = c.bb;
  if (c.point && c.f.length) bb = bboxOf(c.f.flatMap((f) => f.rings));
  if (c.unnamed && holes.length < 3 && greens.length < 4 && !(c.diag > 900 && !c.point)) continue;
  const pref = prefOf(c.c);
  if (c.unnamed) c.name = `${UNNAMED}（${pref}）`;
  const has = holes.length + greens.length;
  if (holes.length) withHoles++;
  const t = c.tags;
  index.push({
    id: c.id, n: c.name, k: t['name:ja-Hira'] || t['name:ja_kana'] || t['name:ja-Kana'] || undefined,
    a: Math.round(c.c[0] * 1e5) / 1e5, o: Math.round(c.c[1] * 1e5) / 1e5,
    b: c.point && !c.f.length ? undefined : bb.map((v) => Math.round(v * 1e5) / 1e5),
    p: pref, h: t.holes ? parseInt(t.holes, 10) || undefined : undefined,
    w: t.website || t['contact:website'] || t.url || undefined, ph: t.phone || t['contact:phone'] || undefined,
    hm: holes.length || undefined, gm: greens.length || undefined, d: has ? 1 : undefined,
    op: t.operator || undefined, ac: t.access === 'private' ? 'private' : undefined, un: c.unnamed ? 1 : undefined,
  });
  if (has) {
    const body = JSON.stringify({ v: 1, id: c.id, n: c.name, holes, greens, tees, bunkers, water, fairways, pins });
    detailBytes += body.length;
    fs.writeFileSync(`${OUT_DIR}/c/${c.id}.json`, body);
  }
}
// ---------------- official lists (Accordia / PGM) and Wikipedia: link, rename, or add ----------------
{
  const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60)).replace(/ゖ/g, 'が').replace(/[\s・･\-‐ー－_.'’"()（）「」&＆]/g, '');
  const core = (s) => norm(s).replace(/(かんとりー|かんつりー|かんとり|かんつり)(くらぶ|倶楽部)|ごるふ(くらぶ|倶楽部)|ごるふこーす|ごるふこす|ごるふ場|ごるふりんくす|countryclub|golfclub|golfcourse|[gc]c$|倶楽部|くらぶ|こーす|こす$|あこーでぃあごるふ|pgm/g, '');
  const sim = (a, b) => { const x = core(a), y = core(b); if (x.length < 2 || y.length < 2) return false; return x === y || (x.length >= 3 && y.includes(x)) || (y.length >= 3 && x.includes(y)); };
  const ext = [];
  for (const f of ['src-chains.json', 'src-wikipedia.json']) {
    const p = new URL('./' + f, import.meta.url);
    if (fs.existsSync(p)) for (const e of JSON.parse(fs.readFileSync(p, 'utf8'))) ext.push({ ...e, op: e.chain || e.op });
  }
  let linked = 0, renamed = 0, added = 0;
  for (const e of ext) {
    if (!e.name || NOT_GOLF.test(e.name)) continue;
    const hasPos = Number.isFinite(e.lat);
    const near = (c, km) => !hasPos || dist([c.a, c.o], [e.lat, e.lon]) < km * 1000;
    const match = index.find((c) => !c.un && sim(c.n, e.name) && near(c, 40));
    if (match) { if (e.op && !match.op) match.op = e.op; if (e.url) match.w ||= e.url; linked++; continue; }
    if (!hasPos) continue;
    const r = e.precise ? 6 : 15;
    const un = index.filter((c) => c.un && near(c, r)).sort((a, b) => dist([a.a, a.o], [e.lat, e.lon]) - dist([b.a, b.o], [e.lat, e.lon]))[0];
    if (un) { un.n = e.name; delete un.un; un.op = e.op; if (e.url) un.w = e.url; renamed++; continue; }
    index.push({ id: 'ext-' + core(e.name).slice(0, 24) + '-' + Math.round(e.lat * 1e3), n: e.name, a: Math.round(e.lat * 1e5) / 1e5, o: Math.round(e.lon * 1e5) / 1e5, p: prefOf([e.lat, e.lon]), op: e.op, w: e.url, ap: e.precise ? undefined : 1, src: e.chain ? 'official' : 'wikipedia' });
    added++;
  }
  // unify operator spellings
  for (const c of index) if (c.op) { if (/accordia|アコーディア/i.test(c.op)) c.op = 'アコーディア・ゴルフ'; else if (/pacific golf|^pgm/i.test(c.op)) c.op = 'PGM'; else if (/東急/.test(c.op)) c.op = '東急リゾーツ&ステイ'; else if (/東建/.test(c.op)) c.op = '東建コーポレーション'; }
  // operator from the name itself
  for (const c of index) if (!c.op) { if (/アコーディア/.test(c.n)) c.op = 'アコーディア・ゴルフ'; else if (/^PGM|ＰＧＭ/.test(c.n)) c.op = 'PGM'; else if (/東急/.test(c.n)) c.op = '東急リゾーツ&ステイ'; else if (/東建/.test(c.n)) c.op = '東建コーポレーション'; }
  log(`official/wiki: linked ${linked}, renamed ${renamed}, added ${added}`);
}

// ---------------- town names (国土地理院 reverse geocoder, cached) ----------------
{
  const cacheF = new URL('./muni-cache.json', import.meta.url);
  const cache = fs.existsSync(cacheF) ? JSON.parse(fs.readFileSync(cacheF, 'utf8')) : {};
  let muniTable = {};
  try {
    const js = await (await fetch('https://maps.gsi.go.jp/js/muni.js')).text();
    for (const m of js.matchAll(/GSI\.MUNI_ARRAY\["(\d+)"\]\s*=\s*'([^']+)'/g)) { const p = m[2].split(','); muniTable[String(Number(m[1]))] = p[1] + p[3]; }
  } catch {}
  let calls = 0;
  for (const c of index) {
    const k = `${c.a.toFixed(4)},${c.o.toFixed(4)}`;
    if (!(k in cache) && Object.keys(muniTable).length) {
      try {
        const j = await (await fetch(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${c.a}&lon=${c.o}`)).json();
        const r = j.results; cache[k] = r ? (muniTable[String(Number(r.muniCd))] || '') + (r.lv01Nm && r.lv01Nm !== '－' ? r.lv01Nm : '') : '';
      } catch { cache[k] = ''; }
      if (++calls % 50 === 0) { fs.writeFileSync(cacheF, JSON.stringify(cache)); log('reverse geocoded', calls); }
      await new Promise((res) => setTimeout(res, 60));
    }
    if (cache[k]) { c.ad = cache[k]; if (c.un) c.n = `${UNNAMED}（${cache[k].replace(/^(北海道|東京都|大阪府|京都府|.{2,3}県)/, '')}）`; }
  }
  fs.writeFileSync(cacheF, JSON.stringify(cache));
  log('town names', index.filter((c) => c.ad).length);
}

// hiragana readings from Wikipedia's 日本のゴルフ場一覧 (wiki-list.txt), so 「かすみがせき」 finds 霞ヶ関
{
  const f = new URL('./wiki-list.txt', import.meta.url);
  if (fs.existsSync(f)) {
    const t = fs.readFileSync(f, 'utf8');
    const nz = (s) => s.normalize('NFKC').replace(/[\s・･]/g, '');
    const map = new Map();
    for (const m of t.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*（([ぁ-んァ-ヶー・a-zA-Zａ-ｚＡ-Ｚ0-9０-９\s]+)）/g)) map.set(nz(m[1].trim()), m[2].trim());
    let n = 0;
    for (const c of index) if (!c.k && map.has(nz(c.n))) { c.k = map.get(nz(c.n)); n++; }
    log('readings', n);
  }
}

// supplement: Wikidata golf courses (wd.json from tools/README) that OpenStreetMap does not have yet
const WD = new URL('./wd.json', import.meta.url);
if (fs.existsSync(WD)) {
  let added = 0;
  for (const b of JSON.parse(fs.readFileSync(WD, 'utf8')).results.bindings) {
    const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(b.coord?.value || ''); const name = b.label?.value;
    if (!m || !name || NOT_GOLF.test(name)) continue;
    const p = [Number(m[2]), Number(m[1])];
    if (index.some((c) => Math.abs(c.a - p[0]) < 0.03 && Math.abs(c.o - p[1]) < 0.03 && dist([c.a, c.o], p) < 1500)) continue;
    index.push({ id: 'wd-' + b.item.value.split('/').pop(), n: name, a: Math.round(p[0] * 1e5) / 1e5, o: Math.round(p[1] * 1e5) / 1e5, p: prefOf(p), src: 'wikidata' });
    added++;
  }
  log('wikidata added', added);
}
index.sort((a, b) => (a.p || '').localeCompare(b.p || '', 'ja') || a.n.localeCompare(b.n, 'ja'));
const stamp = new Date().toISOString().slice(0, 10);
// hand-fixed display names (tools/name-fix.json)
{ const fix = JSON.parse(fs.readFileSync(new URL('./name-fix.json', import.meta.url), 'utf8')); for (const c of index) if (fix[c.id]) { Object.assign(c, fix[c.id]); delete c.un; } }
fs.writeFileSync(`${OUT_DIR}/courses-jp.json`, JSON.stringify({ source: '© OpenStreetMap contributors (ODbL)', generatedAt: stamp, count: index.length, withHoles, courses: index }));
log(`DONE courses=${index.length} withHoleData=${withHoles} withDetail=${index.filter((x) => x.d).length} detailMB=${(detailBytes / 1e6).toFixed(1)}`);
const byPref = {}; for (const c of index) byPref[c.p] = (byPref[c.p] || 0) + 1;
log(JSON.stringify(byPref));
