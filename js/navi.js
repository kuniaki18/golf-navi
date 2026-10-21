// GPS rangefinder: rotated hole view, satellite map, distances (front/center/back/pin), plays-like club advice,
// hazard carries, hole strategy, shot tracking, hole mapping for unmapped courses, and auto-learning.
import { $, $$, esc, toast, dist, bearing, m2y, y2m, md, uid, fmtDate } from './util.js';
import { state, save, getCourseCache, putCourseCache, getNote, setNote } from './store.js';
import { courseFeatures, buildHoles, nearestHole, matchCourse, greensNear, setLabel } from './osm.js';
import { playsLike, recommendClub, weather, headComponent, crossComponent, elevations, elevationSource, compass } from './advice.js';
import { holeStrategy, hazardDistancesFrom } from './strategy.js';
import { askClaude, COACH_SYSTEM, hasAI } from './ai.js';
import { HoleView, IMAGERY, setImagery } from './holeview.js';

let map, layers, meMarker, accCircle, overlay, mapTiles;
let hv = null;
let features = null, holes = [], holeIdx = 0;
let me = null, meAcc = null, manualMe = false;
const fixes = [];
let view = 'hole'; // hole | green | map
let mapClick = 'target'; // target | me | tee | mid | green
let target = null;
let wx = null, elevDiff = null, elevKey = '';
let watchId = null;
let strat = null;

const unit = () => state.settings.unit;
const fmt = (yards) => (yards == null || !isFinite(yards) ? '---' : String(Math.round(unit() === 'm' ? y2m(yards) : yards)));
const ul = () => (unit() === 'm' ? 'm' : 'y');
const cid = () => state.course?.id;
const userHoles = () => (cid() ? (state.userHoles ??= {})[cid()] ??= {} : {});

// ---------------- today's pin positions (reset every day) ----------------
function todayPins() {
  const t = fmtDate(new Date());
  if (state.todayPins?.date !== t) state.todayPins = { date: t, c: {} };
  return (state.todayPins.c[cid()] ??= {});
}

export function initNavi() {
  setImagery(state.settings.imagery || 'gsi');
  hv = new HoleView($('#holeCanvas'), {
    onTap: (ll) => {
      const h = curHole();
      if (h && !h.center && state.course) {
        // register an unmapped hole straight from the aerial view: tee first, then green
        const u = userHoles(); const cur = u[h.key] || {};
        if (!cur.tee) { u[h.key] = { ...cur, tee: ll, learned: false, updatedAt: Date.now() }; save('holes'); toast('ティーを登録。次にグリーンをタップ'); render(); return; }
        u[h.key] = { ...cur, green: ll, learned: false, updatedAt: Date.now() }; save('holes');
        toast(`${h.no}番を登録しました`); rebuild(); return;
      }
      target = ll; render();
    },
    onPin: (ll) => { const h = curHole(); if (!h) return; todayPins()[h.key] = { lat: ll.lat, lon: ll.lon }; save('pin'); toast('今日のピン位置をセットしました'); render(); },
  });
  $('#viewTabs').onclick = (e) => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); };
  $('#holePrev').onclick = () => gotoHole(holeIdx - 1, true);
  $('#holeNext').onclick = () => gotoHole(holeIdx + 1, true);
  $('#btnLocate').onclick = () => { manualMe = false; fixes.length = 0; startGPS(); hv.resetView(); if (me && map) map.setView([me.lat, me.lon], 17); };
  $('#btnPinClear').onclick = () => { const h = curHole(); if (h) { delete todayPins()[h.key]; save('pin'); render(); } };
  ['lie', 'windMode', 'elevManual'].forEach((id) => $('#' + id).addEventListener('input', renderAdvice));
  $('#btnShot').onclick = recordShot;
  $('#btnShotEnd').onclick = () => endShot(true);
  $('#btnAiHole').onclick = aiHole;
  $('#btnMapHole').onclick = () => startMapping();
  $('#mapBar').onclick = onMapBar;
  $('#greenChips').onclick = (e) => {
    const b = e.target.closest('[data-g]'); if (!b) return;
    const g = features.greens.find((x) => x.id === b.dataset.g);
    const h = curHole(); if (!g || !h) return;
    const u = userHoles(); u[h.key] = { ...u[h.key], green: g.c, ...(me && !u[h.key]?.tee && dist(me, g.c) > 60 ? { tee: { ...me }, learned: true } : {}), updatedAt: Date.now() };
    save('holes'); rebuild(); toast(`${h.no}番のグリーンを登録しました`);
  };
  let noteTimer;
  $('#holeNote').addEventListener('input', () => {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { if (!cid()) return; setNote(cid(), curHole().key, $('#holeNote').value); $('#noteSaved').textContent = '保存しました'; }, 500);
  });
  $('#btnReloadCourse').onclick = () => loadCourse(true);
  $('#btnCourseBook').onclick = () => window.dispatchEvent(new CustomEvent('open-book'));
  $('#btnArcs').onclick = () => { state.ui.arcs = state.ui.arcs === 'clubs' ? 'dist' : 'clubs'; save('ui'); $('#btnArcs').classList.toggle('on', state.ui.arcs === 'clubs'); render(); };
  $('#btnArcs').classList.toggle('on', state.ui.arcs === 'clubs');
  $('#btnOffline').onclick = saveOffline;
  initQuickScore();
  fillShotClubs();
  renderShotLog();
  startGPS();
  loadCourse(false);
}

function ensureMap() {
  if (map) return;
  map = L.map('map', { zoomControl: false, attributionControl: true, maxZoom: 20 }).setView([state.course?.lat || 35.68, state.course?.lon || 139.76], 15);
  const src = state.settings.imagery || 'gsi';
  mapTiles = src === 'esri'
    ? L.tileLayer(IMAGERY.esri.url('{z}', '{x}', '{y}'), { maxZoom: 20, maxNativeZoom: 19, attribution: 'Esri World Imagery | © OpenStreetMap' })
    : L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', { maxZoom: 20, maxNativeZoom: 18, attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a> | © OpenStreetMap' });
  mapTiles.addTo(map);
  layers = L.layerGroup().addTo(map);
  overlay = L.layerGroup().addTo(map);
  map.on('click', onMapClick);
  renderCourseLayer();
}

function setView(v) {
  view = v;
  $$('#viewTabs [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  const isMap = v === 'map';
  $('#holeCanvas').hidden = isMap; $('#map').hidden = !isMap;
  $('#btnPinClear').hidden = v !== 'green';
  if (isMap) { ensureMap(); setTimeout(() => { map.invalidateSize(); fitMap(); }, 50); }
  else hv.setMode(v);
  render();
}

export function onNaviShown() { if (view === 'map') setTimeout(() => map?.invalidateSize(), 60); else hv?.render(); }
export function fillShotClubs() {
  const sel = $('#shotClub'); const keep = sel.value;
  sel.innerHTML = state.clubs.map((c) => `<option>${esc(c.name)}</option>`).join('') + '<option>パター</option>';
  if (keep) sel.value = keep;
}

// ---------------- GPS with smoothing ----------------
function startGPS() {
  if (!('geolocation' in navigator)) { $('#gpsStatus').textContent = 'この端末はGPSに対応していません'; return; }
  if (watchId != null) return;
  watchId = navigator.geolocation.watchPosition(onFix, (err) => {
    watchId = null;
    $('#gpsStatus').textContent = err.code === 1 ? '位置情報がオフです（地図→「現在地を指定」で手動指定）' : 'GPS信号を探しています…';
    if (err.code !== 1) setTimeout(startGPS, 5000);
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
}
function onFix(pos) {
  if (manualMe) return;
  const p = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy || 30, t: Date.now() };
  if (p.acc > 80 && me) return; // ignore very poor fixes once we have one
  // walking resets the average; standing still averages the last fixes weighted by accuracy
  if (fixes.length && dist(fixes[fixes.length - 1], p) > Math.max(8, p.acc)) fixes.length = 0;
  fixes.push(p); while (fixes.length > 6) fixes.shift();
  let w = 0, la = 0, lo = 0;
  for (const f of fixes) { const k = 1 / Math.max(3, f.acc) ** 2; w += k; la += f.lat * k; lo += f.lon * k; }
  me = { lat: la / w, lon: lo / w };
  meAcc = Math.max(2, Math.min(...fixes.map((f) => f.acc)) / Math.sqrt(fixes.length));
  $('#gpsStatus').textContent = `GPS ±${fmt(m2y(meAcc))}${ul()}${fixes.length > 2 ? ' · 安定' : ''}`;
  if ($('#autoHole').checked && holes.length) autoHole();
  detectCourse();
  render();
}

function autoHole() {
  const cur = holes[holeIdx], next = holes[holeIdx + 1];
  if (next?.tee && dist(me, next.tee) < 35 && (!cur.center || dist(me, cur.center) > 25)) return gotoHole(holeIdx + 1, true);
  // walking onto another course of a 27/36-hole club: switch course when standing on its tee
  const nearAll = nearestHole(allHoles, me);
  if (nearAll && (nearAll.set || 0) !== activeSet() && nearAll.tee && dist(me, nearAll.tee) < 30) {
    setSet(nearAll.set || 0); state.ui.holeKey = nearAll.key; rebuild(); toast(`${setLabel(activeSet())}に切り替えました`); return;
  }
  const near = nearestHole(holes, me);
  if (near && near !== cur) {
    const dCur = Math.min(cur.center ? dist(me, cur.center) : Infinity, cur.tee ? dist(me, cur.tee) : Infinity);
    if (dCur > 250 || (near.tee && dist(me, near.tee) < 30)) gotoHole(holes.indexOf(near), true);
  }
}

// ---------------- map (Leaflet) ----------------
function onMapClick(e) {
  const p = { lat: e.latlng.lat, lon: e.latlng.lng };
  if (mapClick === 'me') { manualMe = true; me = p; meAcc = 3; $('#gpsStatus').textContent = '手動の現在地'; setMapClick('target'); render(); return; }
  if (['tee', 'mid', 'green'].includes(mapClick)) { mappingTap(p); return; }
  target = p; render();
}
function setMapClick(m) { mapClick = m; renderMapBar(); }
function fitMap() {
  if (!map) return;
  const h = curHole(); const c = holeCenter(h);
  const pts = [...(h?.line || []), c, me && c && dist(me, c) < 700 ? me : null].filter(Boolean);
  if (pts.length >= 2) map.fitBounds(pts.map((p) => [p.lat, p.lon]), { padding: [30, 30], maxZoom: 18 });
  else if (pts.length === 1) map.setView([pts[0].lat, pts[0].lon], 17);
  else if (state.course?.bounds) map.fitBounds([[state.course.bounds[0], state.course.bounds[1]], [state.course.bounds[2], state.course.bounds[3]]]);
  else if (state.course) map.setView([state.course.lat, state.course.lon], 15);
}
function renderCourseLayer() {
  if (!map || !layers) return;
  layers.clearLayers();
  if (!features) return;
  const poly = (arr, style) => arr.forEach((f) => f.pts.length > 2 && L.polygon(f.pts.map((p) => [p.lat, p.lon]), { ...style, interactive: false }).addTo(layers));
  poly(features.water, { color: '#5aa9ff', weight: 1, fillOpacity: 0.25 });
  poly(features.bunkers, { color: '#f1dca7', weight: 1, fillOpacity: 0.35 });
  poly(features.greens, { color: '#9cff9c', weight: 1.5, fillOpacity: 0.15 });
  for (const h of holes) {
    if (h.line.length < 2) continue;
    L.polyline(h.line.map((p) => [p.lat, p.lon]), { color: h.source === 'osm' ? '#ffffff' : '#ffd60a', weight: 1.5, opacity: 0.55, dashArray: '4 6', interactive: false }).addTo(layers);
    if (h.tee) L.marker([h.tee.lat, h.tee.lon], { icon: L.divIcon({ className: '', html: `<div class="yd-tag small">${esc(h.no)}</div>`, iconSize: [22, 18], iconAnchor: [11, 9] }), interactive: false }).addTo(layers);
  }
}
function renderMapOverlay(c) {
  if (!map || !overlay) return;
  overlay.clearLayers();
  if (me) {
    L.marker([me.lat, me.lon], { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000, interactive: false }).addTo(overlay);
    L.circle([me.lat, me.lon], { radius: meAcc || 5, color: '#2f8bff', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(overlay);
  }
  const h = curHole();
  if (c) {
    L.marker([c.lat, c.lon], { icon: L.divIcon({ className: '', html: '<div class="flag-icon">⛳</div>', iconSize: [24, 24], iconAnchor: [6, 22] }), interactive: false }).addTo(overlay);
    if (h?.line?.length) L.polyline(h.line.map((p) => [p.lat, p.lon]), { color: '#ffd60a', weight: 2.5, dashArray: '6 6', interactive: false }).addTo(overlay);
    if (me) {
      L.polyline([[me.lat, me.lon], [c.lat, c.lon]], { color: '#fff', weight: 2, interactive: false }).addTo(overlay);
      L.marker([(me.lat + c.lat) / 2, (me.lon + c.lon) / 2], { icon: L.divIcon({ className: '', html: `<div class="yd-tag">${fmt(m2y(dist(me, c)))}${ul()}</div>`, iconSize: [50, 22], iconAnchor: [25, 11] }), interactive: false }).addTo(overlay);
    }
  }
  if (target && me) {
    L.circleMarker([target.lat, target.lon], { radius: 7, color: '#ffd60a', weight: 3, fillOpacity: 0.3, interactive: false }).addTo(overlay);
    L.polyline([[me.lat, me.lon], [target.lat, target.lon], ...(c ? [[c.lat, c.lon]] : [])], { color: '#ffd60a', weight: 2, dashArray: '2 5', interactive: false }).addTo(overlay);
  }
  const u = userHoles()[h?.key];
  if (mapping && u) for (const k of ['tee', 'mid', 'green']) if (u[k]) L.circleMarker([u[k].lat, u[k].lon], { radius: 6, color: k === 'green' ? '#9cff9c' : '#fff', weight: 3, fillOpacity: 0.6, interactive: false }).addTo(overlay);
}

// ---------------- course ----------------
export async function loadCourse(force) {
  features = null; holes = []; target = null; strat = null;
  const c = state.course;
  if (!c) { renderEmpty(); return; }
  if (c.source === 'gora' && !c.osmLinked) {
    try { const o = await matchCourse(c.lat, c.lon); if (o) { Object.assign(c, { bounds: o.bounds, osmId: o.id, osmLinked: true }); save('course'); } } catch {}
  }
  const cacheId = c.osmId || c.id;
  const cached = !force && getCourseCache(cacheId);
  if (cached && Date.now() - cached.savedAt < 7 * 864e5) features = cached.features;
  else {
    $('#holeTips').innerHTML = '<li class="muted">コースデータを読み込み中…</li>';
    try {
      features = await courseFeatures(c, { liveFallback: force || !c.osmId?.startsWith?.('osm-') && !c.id.startsWith('osm-'), onRetry: (n) => ($('#holeTips').innerHTML = `<li class="muted">地図サーバーが混雑中。再試行しています（${n}回目）…</li>`) });
      putCourseCache(cacheId, { features });
      if (force) toast(features.holes.length ? '最新のコースデータに更新しました' : 'このコースはまだホールが登録されていません。「ホールを登録」で作れます', 4000);
    } catch (e) {
      features = cached?.features || { holes: [], greens: [], tees: [], bunkers: [], water: [], fairways: [], pins: [] };
      toast(e.message, 4000);
    }
  }
  rebuild(true);
  try { wx = await weather(c.lat, c.lon); render(); } catch {}
}

let allHoles = [];
const activeSet = () => (cid() && state.ui.holeSet?.[cid()]) || 0;
function rebuild(first) {
  const keep = curHole()?.key ?? state.ui.holeKey;
  allHoles = buildHoles(features, userHoles());
  const sets = [...new Set(allHoles.map((h) => h.set || 0))].sort((a, b) => a - b);
  if (!sets.includes(activeSet())) setSet(0, false);
  holes = allHoles.filter((h) => (h.set || 0) === activeSet());
  holeIdx = Math.max(0, holes.findIndex((h) => h.key === keep));
  const btn = $('#setBtn');
  btn.hidden = sets.length < 2;
  btn.textContent = setLabel(activeSet());
  btn.onclick = () => { setSet((activeSet() + 1) % sets.length); state.ui.holeKey = null; rebuild(); toast(`${setLabel(activeSet())}に切り替えました`); };
  renderCourseLayer();
  gotoHole(holeIdx, first || true);
}
function setSet(i, persist = true) {
  if (!cid()) return;
  state.ui.holeSet ??= {}; state.ui.holeSet[cid()] = i;
  if (state.current) state.current.set = i;
  if (persist) save('ui');
}

function renderEmpty() {
  $('#holeNo').textContent = '-';
  $('#holeMeta').textContent = 'コースを選んでください';
  $('#holeSrc').textContent = '';
  $('#holeTips').innerHTML = '<li class="muted">「コース」からゴルフ場を選ぶと、ホールごとの距離と攻略が出ます。</li>';
  hv?.set({ hole: null, emptyText: 'コースを選ぶとホールが表示されます' });
  render();
}

function curHole() { return holes[holeIdx] || null; }
function holeCenter(h) {
  if (!h) return null;
  return (cid() && todayPins()[h.key]) || h.center;
}

export function gotoHole(i, fit) {
  if (!holes.length) return;
  holeIdx = (i + holes.length) % holes.length;
  const h = curHole();
  state.ui.holeKey = h.key; save('hole');
  target = null;
  $('#holeNo').textContent = h.no > 100 ? '?' : h.no;
  const lenY = h.lengthM ? m2y(h.lengthM) : null;
  $('#holeMeta').textContent = `PAR ${h.par ?? '-'}${h.parEst ? '（推定）' : ''} ·${lenY ? fmt(lenY) + ul() : '距離データなし'}${h.hcp ? ' · HDCP ' + h.hcp : ''}`;
  $('#holeSrc').textContent = { osm: '', user: '登録済み', learned: '自動学習', none: '未登録' }[h.source] || '';
  $('#holeSrc').className = 'src-badge ' + h.source;
  $('#holeNote').value = cid() ? getNote(cid(), h.key) : '';
  $('#noteSaved').textContent = '';
  const ai = cid() && state.aiTips[cid()]?.[h.key];
  $('#aiHoleOut').hidden = !ai;
  $('#aiHoleOut').innerHTML = ai ? md(ai.text) + `<p class="muted">AI作成: ${new Date(ai.updatedAt).toLocaleDateString('ja-JP')}</p>` : '';
  renderStrategy();
  renderQuickScore();
  if (fit) { hv.resetView(); fitMap(); }
  render();
  window.dispatchEvent(new CustomEvent('navi-hole', { detail: { no: h.no, par: h.parEst ? null : h.par } }));
}

function renderStrategy() {
  const h = curHole();
  if (!h || !h.center || !features) {
    strat = null;
    $('#holeTips').innerHTML = `<li class="muted">${state.course ? 'このホールはまだ登録されていません。下の「ホールを登録」でティーとグリーンをタップするか、プレー中に「近くのグリーン」から選ぶと距離と攻略が出ます。' : 'コースを選んでください。'}</li>`;
    return;
  }
  strat = holeStrategy({ ...h, center: holeCenter(h) }, features, state.clubs);
  $('#holeTips').innerHTML = strat.tips.map((t) => `<li>${esc(t)}</li>`).join('');
}

// ---------------- main render ----------------
function render() {
  const h = curHole();
  const c = holeCenter(h);
  const pin = h && cid() ? todayPins()[h.key] : null;
  const draft = h && !h.center ? userHoles()[h.key] : null;
  const prevGreen = holes[holeIdx - 1]?.center;
  const area = !state.course ? null : me && dist(me, state.course) < 2500 ? me : draft?.tee || prevGreen || { lat: state.course.lat, lon: state.course.lon };
  hv?.set({
    hole: h, features, me, acc: meAcc, target, pin, unit: unit() === 'm' ? 'm' : 'yd', hazards: strat?.hazards || [], area, draft,
    arcs: state.ui.arcs === 'clubs' ? state.clubs : null, wind: wx, shots: todaysShots(h),
    emptyText: !state.course ? 'コースを選ぶとホールが表示されます' : draft?.tee ? `${h.no}番のグリーンをタップ` : `${h?.no ?? ''}番は未登録：ティーをタップ（拡大・移動できます）`,
  });
  if (view === 'map') renderMapOverlay(c);
  renderMappingCard(h);
  const o = originFor(h, c);
  $('#ydMainLabel').textContent = o && o !== me ? 'ティーから（プレビュー）' : 'グリーンセンター';
  if (!o || !c) {
    $('#ydCenter').textContent = '---'; $('#ydFront').textContent = '---'; $('#ydBack').textContent = '---'; $('#ydPin').hidden = true;
    $('#ydUnit').textContent = unit() === 'm' ? 'm' : 'yd';
    $('#clubName').textContent = '--';
    $('#clubDetail').textContent = !state.course ? 'コースを選ぶと距離と番手が出ます' : !c ? 'このホールのグリーン位置が未登録です' : '現在地を取得中…（地図タブ→「現在地を指定」で手動指定も可）';
    $('#hazardList').innerHTML = '';
    $('#targetLine').hidden = true;
    return;
  }
  const g = greenDistances(o, h, h.center || c);
  $('#ydCenter').textContent = fmt(g.center);
  $('#ydFront').textContent = fmt(g.front);
  $('#ydBack').textContent = fmt(g.back);
  $('#ydUnit').textContent = unit() === 'm' ? 'm' : 'yd';
  $('#ydPin').hidden = !pin;
  if (pin) $('#ydPinNum').textContent = fmt(m2y(dist(o, pin)));

  if (strat?.hazards?.length) {
    const hz = hazardDistancesFrom(o, strat.hazards, c).slice(0, 6);
    $('#hazardList').innerHTML = hz.map((x) => `<span class="hz ${x.type}">${x.type === 'water' ? '池' : 'バンカー'}(${x.latY > 5 ? '左' : x.latY < -5 ? '右' : '中央'}) 手前${fmt(x.front)} / 越え${fmt(x.carry)}</span>`).join('');
  } else $('#hazardList').innerHTML = '';
  renderTarget(c);
  renderAdvice();
  updateElevation(c);
}

/** distances are measured from the player on the hole, otherwise from the tee (preview while browsing) */
function originFor(h, c) {
  if (me && c && dist(me, c) <= 800) return me;
  return h?.tee || (me && c ? me : null);
}

function greenDistances(p, h, gc) {
  const center = m2y(dist(p, gc));
  if (!h.green?.pts?.length) return { center, front: null, back: null };
  const b = (bearing(p, gc) * Math.PI) / 180, ux = Math.sin(b), uy = Math.cos(b);
  const k = Math.cos((p.lat * Math.PI) / 180) * 111320, kl = 110540;
  let lo = Infinity, hi = -Infinity;
  // project every edge point onto the line of play; front/back are the nearest/farthest edges
  for (const q of h.green.pts) {
    const x = (q.lon - p.lon) * k, y = (q.lat - p.lat) * kl;
    const along = x * ux + y * uy, off = Math.abs(x * uy - y * ux);
    if (off > 18) continue;
    lo = Math.min(lo, along); hi = Math.max(hi, along);
  }
  if (!isFinite(lo)) return { center, front: center - 12, back: center + 12 };
  return { center, front: m2y(lo), back: m2y(hi) };
}

function renderTarget(c) {
  const box = $('#targetLine');
  const o = originFor(curHole(), c);
  if (!target || !o) { box.hidden = true; return; }
  const d1 = m2y(dist(o, target)), d2 = c ? m2y(dist(target, c)) : null;
  const rc = recommendClub(state.clubs, playsLike(d1, conditions(bearing(o, target))).yards);
  box.hidden = false;
  box.innerHTML = `<span>目標まで <b>${fmt(d1)}${ul()}</b>${rc ? `（${esc(rc.club.name)}）` : ''}${d2 != null ? ` → 残り <b>${fmt(d2)}${ul()}</b>` : ''}</span><button class="btn small" id="clearTarget">消す</button>`;
  $('#clearTarget').onclick = () => { target = null; render(); };
}

function conditions(shotBearing) {
  const mode = $('#windMode').value;
  const head = mode === 'auto' ? headComponent(wx, shotBearing) : Number(mode);
  const manual = $('#elevManual').value;
  return { head, lie: $('#lie').value, elevM: manual !== '' ? Number(manual) : elevDiff ?? 0, tempC: wx?.temp };
}

function renderAdvice() {
  const h = curHole(); const c = holeCenter(h);
  if (wx && Number.isFinite(wx.speed)) $('#windPill').textContent = `${compass(wx.dir)}の風 ${wx.speed.toFixed(1)}m/s · ${Math.round(wx.temp)}℃`;
  const o = originFor(h, c);
  if (!o || !c) return;
  const br = bearing(o, c);
  const raw = m2y(dist(o, c));
  const cond = conditions(br);
  const pl = playsLike(raw, cond);
  const rc = recommendClub(state.clubs, pl.yards);
  if (!rc) return;
  $('#clubName').textContent = rc.club.name;
  const cross = $('#windMode').value === 'auto' ? crossComponent(wx, br) : 0;
  const aim = Math.abs(cross) >= 2 ? `横風 ${Math.abs(cross).toFixed(1)}m/s：${cross > 0 ? '左' : '右'}から吹くので${cross > 0 ? '左' : '右'}目を狙う。` : '';
  $('#clubDetail').innerHTML = `打つ距離 <b>${fmt(pl.yards)}${ul()}</b>（実距離 ${fmt(raw)}${ul()}）<br>${rc.alt ? `迷ったら ${esc(rc.alt.name)}（${fmt(rc.alt.carry)}${ul()}）。` : ''}${esc(rc.note)}${esc(aim)}`;
  const src = elevationSource(c);
  $('#adjBreak').textContent = (pl.parts.length ? '補正: ' + pl.parts.join(' / ') : '補正なし') + (elevDiff != null && $('#elevManual').value === '' ? ` · 高低差 ${elevDiff > 0 ? '+' : ''}${elevDiff.toFixed(1)}m${src ? `（${src}）` : ''}` : '');
}

async function updateElevation(c) {
  const o = originFor(curHole(), c);
  if (!o || !c) return;
  const key = `${o.lat.toFixed(4)},${o.lon.toFixed(4)}>${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
  if (key === elevKey) return;
  elevKey = key;
  try {
    const [a, b] = await elevations([o, c]);
    if (Number.isFinite(a) && Number.isFinite(b)) { elevDiff = b - a; renderAdvice(); }
  } catch { elevDiff = null; }
}

// ---------------- unmapped holes: nearby greens + mapping ----------------
let mapping = false;
function renderMappingCard(h) {
  const card = $('#mapCard');
  const need = state.course && h && !h.center;
  card.hidden = !need && !mapping;
  if (card.hidden) return;
  const chips = me && features ? greensNear(features, me, 4).filter((x) => x.d < 600) : [];
  $('#greenChips').innerHTML = chips.length
    ? '<span class="muted">近くのグリーン:</span>' + chips.map((x) => `<button class="btn small" data-g="${x.g.id}">${fmt(m2y(x.d))}${ul()} 先</button>`).join('')
    : '';
}
function startMapping() {
  if (!state.course) { toast('先にコースを選んでください'); return; }
  mapping = true;
  setView('map');
  setMapClick('tee');
  $('#mapBar').hidden = false;
}
function renderMapBar() {
  const h = curHole(); const bar = $('#mapBar');
  if (!mapping || !h) { bar.hidden = true; return; }
  const u = userHoles()[h.key] || {};
  const step = { tee: 'ティー', mid: '曲がり角（ドッグレッグ）', green: 'グリーンの中心' }[mapClick] || '';
  bar.hidden = false;
  bar.innerHTML = `<div class="mb-title"><b>${h.no}番ホールを登録</b> ${step ? `— 地図で<b>${step}</b>をタップ` : ''}</div>
    <div class="seg mb-par">${[3, 4, 5].map((p) => `<button data-par="${p}" class="${(u.par || h.par) === p ? 'on' : ''}">PAR${p}</button>`).join('')}</div>
    <div class="btn-row tight">
      <button class="btn small" data-mb="tee">ティー</button><button class="btn small" data-mb="mid">曲がり角</button><button class="btn small" data-mb="green">グリーン</button>
      <button class="btn small" data-mb="me">現在地を指定</button>
      <button class="btn small primary" data-mb="next">次のホール</button><button class="btn small" data-mb="done">終了</button>
    </div>`;
}
function onMapBar(e) {
  const b = e.target.closest('button'); if (!b) return;
  const h = curHole(); const u = userHoles();
  if (b.dataset.par) { u[h.key] = { ...u[h.key], par: Number(b.dataset.par), updatedAt: Date.now() }; save('holes'); rebuild(); renderMapBar(); return; }
  const a = b.dataset.mb;
  if (['tee', 'mid', 'green', 'me'].includes(a)) { setMapClick(a); if (a === 'me') toast('地図をタップした場所を現在地にします（テスト用）'); return; }
  if (a === 'next') { gotoHole(holeIdx + 1, true); setMapClick('tee'); return; }
  if (a === 'done') { mapping = false; setMapClick('target'); $('#mapBar').hidden = true; setView('hole'); toast('登録した内容は設定の「攻略メモを友だちに送る」で共有できます', 4000); }
}
function mappingTap(p) {
  const h = curHole(); const u = userHoles();
  u[h.key] = { ...u[h.key], [mapClick]: p, learned: false, updatedAt: Date.now() };
  save('holes');
  const nextStep = mapClick === 'tee' ? 'green' : mapClick === 'mid' ? 'green' : 'tee';
  const finishedHole = mapClick === 'green';
  rebuild();
  setMapClick(nextStep);
  if (finishedHole) { toast(`${h.no}番を登録しました`); gotoHole(holeIdx + 1, true); setMapClick('tee'); }
}

// ---------------- shots (+ auto-learning tees and greens) ----------------
function recordShot() {
  if (!me) { toast('現在地がまだ取れていません'); return; }
  endShot(false);
  const h = curHole();
  const club = $('#shotClub').value;
  learn(h, club);
  if (club === 'パター') { toast('パット地点を記録しました'); return; }
  state.pendingShot = { id: uid(), club, from: { ...me }, acc: meAcc, hole: h?.no ?? null, courseId: cid() || null, courseName: state.course?.name || '', date: new Date().toISOString() };
  save('shot');
  $('#shotHint').textContent = `${club} 計測中… ボール地点で押す`;
  toast(`${club} の打球位置を記録`);
}
/** first full shot on an unmapped hole = tee, putting position = green */
function learn(h, club) {
  if (!h || !cid() || h.source === 'osm') return;
  const u = userHoles(); const cur = u[h.key] || {};
  if (cur.learned === false) return; // user-mapped: don't overwrite
  const shotsHere = (state.shots || []).filter((s) => s.courseId === cid() && s.hole === h.no && s.date?.slice(0, 10) === new Date().toISOString().slice(0, 10));
  let changed = false;
  if (club !== 'パター' && !cur.tee && !shotsHere.length) { cur.tee = { ...me }; changed = true; }
  if (club === 'パター' && !cur.green) { cur.green = { ...me }; changed = true; }
  if (changed) { u[h.key] = { ...cur, learned: true, updatedAt: Date.now() }; save('holes'); rebuild(); toast(`${h.no}番の${club === 'パター' ? 'グリーン' : 'ティー'}位置を覚えました`); }
}
function endShot(manual) {
  const ps = state.pendingShot;
  if (!ps) { if (manual) toast('先に「ここから打つ」を押してください'); return; }
  if (!me) return;
  const yards = m2y(dist(ps.from, me));
  state.pendingShot = null;
  if (yards < 3) { save('shot'); return; }
  state.shots ??= [];
  state.shots.push({ ...ps, to: { ...me }, yards: Math.round(yards) });
  save('shot');
  $('#shotHint').textContent = '打つ地点で押す';
  toast(`${ps.club}: ${fmt(yards)}${ul()}`);
  renderShotLog();
}
export function renderShotLog() {
  const list = (state.shots || []).slice(-5).reverse();
  $('#shotLog').innerHTML = list.map((s) => `<div><span>${esc(s.courseName ? s.courseName.slice(0, 10) : '')} ${s.hole ? s.hole + 'H' : ''} ${esc(s.club)}</span><b>${fmt(s.yards)}${ul()}</b></div>`).join('') || '<span class="muted">「ここから打つ」→ボールの所で「ボール地点」を押すと飛距離を自動計測します。未登録のホールでは、ティーとグリーンの位置も自動で覚えます。</span>';
  if (state.pendingShot) $('#shotHint').textContent = `${state.pendingShot.club} 計測中…`;
}

// ---------------- AI hole strategy (with the aerial view) ----------------
async function aiHole() {
  const h = curHole();
  if (!state.course || !h) { toast('コースを選んでください'); return; }
  if (!hasAI()) { toast('設定でClaudeのAPIキーを入れるとAI攻略が使えます', 3500); return; }
  const out = $('#aiHoleOut');
  out.hidden = false; out.innerHTML = '<p class="muted">AIが航空写真とデータからホールを解析しています…</p>';
  const s = strat || { tips: [], hazards: [] };
  let image = null, scale = null;
  if (h.center && view !== 'map') { hv.setMode('hole'); await new Promise((r) => setTimeout(r, 900)); image = hv.snapshot(); scale = hv.metersPerPixel(); }
  const data = {
    course: state.course.name, hole: h.no, par: h.par, lengthYards: h.lengthM ? Math.round(m2y(h.lengthM)) : null,
    mapSource: h.source, doglegs: s.doglegs, green: s.shape ? { depthY: Math.round(s.shape.depth), widthY: Math.round(s.shape.width) } : null,
    hazards: (s.hazards || []).map((x) => ({ type: x.type, fromTeeY: Math.round(x.alongY), side: x.latY > 5 ? 'left' : x.latY < -5 ? 'right' : 'center', offsetY: Math.round(Math.abs(x.latY)), nearGreen: x.nearGreen })),
    weather: wx, myClubsCarryY: state.clubs, playerNow: me && h.center ? { toGreenY: Math.round(m2y(dist(me, holeCenter(h)))) } : null,
    myNote: getNote(cid(), h.key) || null, myTendency: summarizeTendency((state.rounds || []).slice(0, 5)),
  };
  const prompt = `${image ? `添付画像はこのホールの航空写真です。ティーが下、グリーン（旗）が上になるよう回転してあり、1ピクセル≈${scale ? (m2y(scale)).toFixed(2) : '?'}ヤードです。白い弧はプレーヤー（またはティー）からの距離（${unit() === 'm' ? 'm' : 'ヤード'}）です。写真から、バンカー・池・林・OBになりそうな場所・フェアウェイの幅・グリーン周りを読み取ってください。\n` : ''}次のホールの攻略法を作ってください。
1) ティーショット（狙い所と番手、避けるべきミス、写真から読める危険箇所）
2) セカンド以降（刻むか攻めるか、残したい距離）
3) グリーン周り（外していい側、パッティングの注意）
4) このプレーヤーの傾向を踏まえた一言
データ(JSON、距離はヤード、sideはティーから見た左右):
${JSON.stringify(data)}`;
  try {
    const text = await askClaude({ system: COACH_SYSTEM, prompt, images: image ? [image] : [], maxTokens: 1400, onText: (t) => { out.innerHTML = md(t); } });
    state.aiTips[cid()] ??= {};
    state.aiTips[cid()][h.key] = { text, updatedAt: Date.now() };
    save('ai');
    out.innerHTML = md(text) + `<p class="muted">AI作成: ${new Date().toLocaleDateString('ja-JP')}（保存済み・攻略ブックにも載ります）</p>`;
  } catch (e) { out.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

function summarizeTendency(rounds) {
  if (!rounds.length) return null;
  let fwL = 0, fwR = 0, fwH = 0, n = 0;
  for (const r of rounds) for (const x of r.holes) { if (x.fw === 'left') fwL++; else if (x.fw === 'right') fwR++; else if (x.fw === 'hit') fwH++; if (x.strokes) n++; }
  return { teeShots: { fairway: fwH, missLeft: fwL, missRight: fwR }, holesPlayed: n };
}

export function refreshNavi() { fillShotClubs(); renderShotLog(); renderStrategy(); render(); }
export function currentCourseData() { return { features, holes }; }
export function applyImagery() { setImagery(state.settings.imagery || 'gsi'); if (map && mapTiles) { map.removeLayer(mapTiles); mapTiles = null; map.remove(); map = null; } if (view === 'map') ensureMap(); hv?.render(); }

// ---------------- quick score entry on the navi screen ----------------
function scoreHole() {
  const h = curHole(); const n = h?.no;
  if (!state.current || !n || n > 18) return null;
  return { n, sh: state.current.holes[n - 1], par: h.parEst ? null : h.par };
}
function initQuickScore() {
  $('#quickScore').addEventListener('click', (e) => {
    const x = scoreHole(); if (!x) return;
    const b = e.target.closest('button'); if (!b) return;
    const sh = x.sh;
    if (x.par && !sh.strokes) sh.par = x.par;
    if (b.dataset.q) {
      const f = b.dataset.q, d = Number(b.dataset.d);
      if (sh[f] == null) sh[f] = f === 'strokes' ? sh.par : 2; else sh[f] = Math.max(0, sh[f] + d);
      if (f === 'putts' && sh.strokes != null && sh.putts > sh.strokes) sh.strokes = sh.putts;
    } else if (b.dataset.v) sh.fw = sh.fw === b.dataset.v ? null : b.dataset.v;
    if (state.course && !state.current.course) { state.current.course = state.course.name; state.current.courseId = state.course.id; }
    save('round'); renderQuickScore(); window.dispatchEvent(new Event('round-changed'));
  });
  window.addEventListener('round-changed', renderQuickScore);
}
function renderQuickScore() {
  const x = scoreHole(); const box = $('#quickScore');
  box.hidden = !x || !state.course; if (box.hidden) return;
  const sh = x.sh; const par = x.par || sh.par;
  $('#qsHole').textContent = `${x.n}番`; $('#qsPar').textContent = `PAR ${par}`;
  $('#qsStrokes').textContent = sh.strokes ?? '-'; $('#qsPutts').textContent = sh.putts ?? '-';
  $$('#qsFw button').forEach((b) => b.classList.toggle('on', b.dataset.v === sh.fw));
  $('#qsFw').hidden = par === 3;
  const played = state.current.holes.filter((h) => h.strokes);
  const tot = played.reduce((a, h) => a + h.strokes, 0), toPar = tot - played.reduce((a, h) => a + h.par, 0);
  $('#qsTotal').textContent = played.length ? `合計 ${tot}（${toPar === 0 ? 'E' : toPar > 0 ? '+' + toPar : toPar}）· ${played.length}H` : 'スコアはここでも入力できます';
  // round finished: offer to save and open the memories
  const fin = $('#qsFinish');
  fin.hidden = !(played.length >= 18 && !state.current.saved);
  if (!fin.hidden) fin.innerHTML = `<span>おつかれさまでした！ <b>${tot}</b></span><button class="btn small primary" id="qsSave">保存して思い出を残す</button>`;
  const sv = $('#qsSave');
  if (sv) sv.onclick = () => { window.dispatchEvent(new CustomEvent('goto-tab', { detail: 'score' })); setTimeout(() => $('#btnSaveRound')?.click(), 50); };
}

// ---------------- auto course detection ----------------
let detected = null;
async function detectCourse() {
  if (!me || detected === 'done' || detected === 'busy') return;
  if (state.course && dist(me, state.course) < 3000) { detected = 'done'; return; }
  detected = 'busy';
  try {
    const { bundledCourses } = await import('./osm.js');
    const all = await bundledCourses();
    let best = null, bd = Infinity;
    for (const c of all) {
      const b = c.bounds;
      const inside = b && me.lat >= b[0] - 0.002 && me.lat <= b[2] + 0.002 && me.lon >= b[1] - 0.002 && me.lon <= b[3] + 0.002;
      const d = dist(me, c);
      if ((inside || d < 900) && d < bd) { bd = d; best = c; }
    }
    if (!best) { detected = null; return; }
    detected = 'done';
    const bn = $('#detectBanner');
    bn.hidden = false;
    bn.innerHTML = `<span>いま <b>${esc(best.name)}</b> にいますか？</span><button class="btn small primary" id="dtYes">このコースでプレー</button><button class="btn small" id="dtNo">ちがう</button>`;
    $('#dtNo').onclick = () => (bn.hidden = true);
    $('#dtYes').onclick = () => {
      bn.hidden = true;
      state.course = { id: best.id, name: best.name, lat: best.lat, lon: best.lon, bounds: best.bounds, source: 'osm', pref: best.pref };
      state.ui.holeKey = '1'; save('course');
      window.dispatchEvent(new CustomEvent('course-picked'));
    };
  } catch { detected = null; }
}

// ---------------- today's shots on the hole view ----------------
function todaysShots(h) {
  if (!h || !cid()) return [];
  const day = new Date().toISOString().slice(0, 10);
  return (state.shots || []).filter((s) => s.courseId === cid() && s.hole === h.no && s.date?.slice(0, 10) === day && s.to);
}

// ---------------- offline pack: aerial tiles for every hole ----------------
async function saveOffline() {
  if (!state.course) { toast('コースを選んでください'); return; }
  const st = $('#offlineStatus');
  const esri = state.settings.imagery === 'esri';
  const url = (z, x, y) => (esri ? `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}` : `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`);
  const maxZ = esri ? 19 : 18;
  const boxes = holes.filter((h) => h.center).map((h) => {
    const pts = [...(h.line || []), h.center];
    return [Math.min(...pts.map((p) => p.lat)) - 0.0012, Math.min(...pts.map((p) => p.lon)) - 0.0015, Math.max(...pts.map((p) => p.lat)) + 0.0012, Math.max(...pts.map((p) => p.lon)) + 0.0015];
  });
  if (!boxes.length && state.course.bounds) boxes.push(state.course.bounds);
  if (!boxes.length) { toast('このコースは範囲が分からないため保存できません'); return; }
  const tx = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const ty = (lat, z) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };
  const set = new Set();
  for (const b of boxes) for (let z = 15; z <= maxZ; z++) for (let x = tx(b[1], z); x <= tx(b[3], z); x++) for (let y = ty(b[2], z); y <= ty(b[0], z); y++) set.add(`${z}/${x}/${y}`);
  const list = [...set].slice(0, 2500);
  let done = 0, fail = 0;
  st.textContent = `航空写真 ${list.length}枚を保存中…`;
  const queue = list.slice();
  const worker = async () => {
    while (queue.length) {
      const [z, x, y] = queue.shift().split('/').map(Number);
      try { const r = await fetch(url(z, x, y), { mode: 'cors' }); if (!r.ok) fail++; } catch { fail++; }
      done++;
      if (done % 20 === 0) st.textContent = `航空写真を保存中… ${Math.round((done / list.length) * 100)}%`;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  try { await fetch(`data/c/${state.course.osmId || state.course.id}.json`); } catch {}
  st.textContent = `保存しました（${done - fail}枚）。電波がなくても、このコースのホールビューが表示できます。`;
}
