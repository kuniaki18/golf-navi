// GPS rangefinder: map, distances to the green, club advice, hazards, hole strategy and shot tracking.
import { $, esc, toast, dist, bearing, m2y, y2m, xy, md, uid } from './util.js';
import { state, save, getCourseCache, putCourseCache, getNote, setNote, getPin, setPin } from './store.js';
import { courseFeatures, buildHoles, nearestHole, matchCourse } from './osm.js';
import { playsLike, recommendClub, weather, headComponent, crossComponent, elevations, compass } from './advice.js';
import { holeStrategy, hazardDistancesFrom } from './strategy.js';
import { askClaude, COACH_SYSTEM, hasAI } from './ai.js';

let map, layers, meMarker, accCircle, targetMarker, targetLine, greenLine;
let features = null, holes = [], holeIdx = 0;
let me = null, meAcc = null, manualMe = false;
let mapMode = 'target'; // target | me | green
let target = null;
let wx = null, elevDiff = null, elevKey = '';
let watchId = null;

const unit = () => state.settings.unit;
const fmt = (yards) => (yards == null || !isFinite(yards) ? '---' : String(Math.round(unit() === 'm' ? y2m(yards) : yards)));
const ul = () => (unit() === 'm' ? 'm' : 'y');

export function initNavi() {
  map = L.map('map', { zoomControl: false, attributionControl: true, maxZoom: 20 }).setView([35.68, 139.76], 14);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 20, maxNativeZoom: 19, attribution: 'Esri World Imagery | © OpenStreetMap',
  }).addTo(map);
  layers = L.layerGroup().addTo(map);
  map.on('click', onMapClick);

  $('#holePrev').onclick = () => gotoHole(holeIdx - 1, true);
  $('#holeNext').onclick = () => gotoHole(holeIdx + 1, true);
  $('#btnLocate').onclick = () => { manualMe = false; startGPS(); if (me) map.setView([me.lat, me.lon], 17); };
  $('#btnMapMode').onclick = cycleMapMode;
  $('#btnSetGreen').onclick = () => setMapMode('green');
  $('#btnReloadCourse').onclick = () => loadCourse(true);
  ['lie', 'windMode', 'elevManual'].forEach((id) => $('#' + id).addEventListener('input', renderAdvice));
  $('#btnShot').onclick = recordShot;
  $('#btnShotEnd').onclick = () => endShot(true);
  $('#btnAiHole').onclick = aiHole;
  let noteTimer;
  $('#holeNote').addEventListener('input', () => {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      if (!state.course) return;
      setNote(state.course.id, curHole().key, $('#holeNote').value);
      $('#noteSaved').textContent = '保存しました';
    }, 500);
  });
  fillShotClubs();
  renderShotLog();
  startGPS();
  loadCourse(false);
}

export function onNaviShown() { setTimeout(() => map?.invalidateSize(), 60); }
export function fillShotClubs() {
  const sel = $('#shotClub');
  const keep = sel.value;
  sel.innerHTML = state.clubs.map((c) => `<option>${esc(c.name)}</option>`).join('') + '<option>パター</option>';
  if (keep) sel.value = keep;
}

// ---------------- GPS ----------------
function startGPS() {
  if (!('geolocation' in navigator)) { $('#gpsStatus').textContent = 'この端末はGPSに対応していません'; return; }
  if (watchId != null) return;
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (manualMe) return;
      me = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      meAcc = pos.coords.accuracy;
      $('#gpsStatus').textContent = `GPS 精度 ±${fmt(m2y(meAcc))}${ul()}`;
      onPosition();
    },
    (err) => {
      watchId = null;
      $('#gpsStatus').textContent = err.code === 1 ? '位置情報が許可されていません（右上ボタンを「現在地」にして地図をタップで指定）' : 'GPS信号を探しています…';
      if (err.code !== 1) setTimeout(startGPS, 5000);
    },
    { enableHighAccuracy: true, maximumAge: 1500, timeout: 20000 },
  );
}

function onPosition() {
  drawMe();
  if ($('#autoHole').checked && holes.length) autoHole();
  render();
}

function autoHole() {
  const cur = holes[holeIdx];
  const next = holes[holeIdx + 1];
  // move on when standing near the next tee, or when clearly away from the current hole
  if (next && dist(me, next.tee) < 35 && dist(me, cur.center) > 25) return gotoHole(holeIdx + 1, false);
  const near = nearestHole(holes, me);
  if (near && near !== cur) {
    const dCur = Math.min(dist(me, cur.center), dist(me, cur.tee));
    if (dCur > 250 || dist(me, near.tee) < 30) gotoHole(holes.indexOf(near), false);
  }
}

function drawMe() {
  if (!me) return;
  const ll = [me.lat, me.lon];
  if (!meMarker) {
    meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 }).addTo(map);
    accCircle = L.circle(ll, { radius: meAcc || 5, color: '#2f8bff', weight: 1, fillOpacity: 0.08 }).addTo(map);
  } else { meMarker.setLatLng(ll); accCircle.setLatLng(ll).setRadius(meAcc || 5); }
}

// ---------------- map interaction ----------------
function cycleMapMode() { setMapMode(mapMode === 'target' ? 'me' : 'target'); }
function setMapMode(m) {
  mapMode = m;
  const b = $('#btnMapMode');
  b.textContent = { target: '目標', me: '現在地', green: 'ピン' }[m];
  b.classList.toggle('on', m !== 'target');
  if (m === 'me') toast('地図をタップした場所を現在地にします（練習・テスト用）');
  if (m === 'green') toast(`地図をタップして ${curHole()?.no ?? ''}番ホールのグリーン（ピン）位置を設定`);
}
function onMapClick(e) {
  const p = { lat: e.latlng.lat, lon: e.latlng.lng };
  if (mapMode === 'me') { manualMe = true; me = p; meAcc = 3; $('#gpsStatus').textContent = '手動の現在地'; onPosition(); setMapMode('target'); return; }
  if (mapMode === 'green') {
    if (!state.course) { toast('先にコースを選んでください'); return; }
    setPin(state.course.id, curHole().key, p);
    toast('グリーン位置を保存しました');
    setMapMode('target'); renderCourse(); render(); return;
  }
  target = p; render();
}

// ---------------- course ----------------
export async function loadCourse(force) {
  layers?.clearLayers();
  features = null; holes = []; target = null;
  const c = state.course;
  if (!c) { renderEmpty(); return; }
  if (c.source === 'gora' && !c.osmLinked) {
    try {
      const o = await matchCourse(c.lat, c.lon);
      if (o) { Object.assign(c, { bounds: o.bounds, osmId: o.id, osmLinked: true }); save('course'); }
    } catch {}
  }
  const cacheId = c.osmId || c.id;
  const cached = !force && getCourseCache(cacheId);
  if (cached && Date.now() - cached.savedAt < 14 * 864e5) features = cached.features;
  else {
    $('#holeTips').innerHTML = '<li class="muted">コースデータを読み込み中…</li>';
    try {
      features = await courseFeatures(c);
      putCourseCache(cacheId, { features });
      if (force) toast('最新のコースデータに更新しました');
    } catch (e) {
      features = cached?.features || { holes: [], greens: [], tees: [], bunkers: [], water: [], fairways: [], pins: [], trees: [] };
      toast(e.message, 4000);
    }
  }
  holes = buildHoles(features);
  if (!holes.length) holes = virtualHoles();
  const savedKey = state.ui.holeKey;
  holeIdx = Math.max(0, holes.findIndex((h) => h.key === savedKey));
  renderCourse();
  gotoHole(holeIdx, true);
  try { wx = await weather(c.lat, c.lon); render(); } catch {}
}

function virtualHoles() {
  // the course has no hole lines in OSM: 18 holes that work with manual green pins
  return Array.from({ length: 18 }, (_, i) => ({ no: i + 1, key: String(i + 1), par: null, line: [], tee: null, green: null, center: null, lengthM: 0, virtual: true }));
}

function renderEmpty() {
  $('#holeNo').textContent = '-';
  $('#holeMeta').textContent = 'コースを選んでください';
  $('#holeTips').innerHTML = '<li class="muted">「コース」タブでゴルフ場を選ぶと、ホールごとの距離と攻略が出ます。</li>';
  render();
}

function renderCourse() {
  layers.clearLayers();
  if (!features) return;
  const poly = (arr, style) => arr.forEach((f) => f.pts.length > 2 && L.polygon(f.pts.map((p) => [p.lat, p.lon]), { ...style, interactive: false }).addTo(layers));
  poly(features.water, { color: '#5aa9ff', weight: 1, fillOpacity: 0.25 });
  poly(features.bunkers, { color: '#f1dca7', weight: 1, fillOpacity: 0.35 });
  poly(features.greens, { color: '#9cff9c', weight: 1.5, fillOpacity: 0.15 });
  for (const h of holes) {
    if (!h.line.length) continue;
    L.polyline(h.line.map((p) => [p.lat, p.lon]), { color: '#ffffff', weight: 1.5, opacity: 0.45, dashArray: '4 6', interactive: false }).addTo(layers);
    L.marker([h.tee.lat, h.tee.lon], { icon: L.divIcon({ className: '', html: `<div class="yd-tag" style="font-size:12px;padding:2px 5px">${esc(h.no)}</div>`, iconSize: [20, 18], iconAnchor: [10, 9] }), interactive: false }).addTo(layers);
  }
}

function curHole() { return holes[holeIdx] || null; }
function holeCenter(h) {
  if (!h) return null;
  const pin = state.course && getPin(state.course.id, h.key);
  return pin || h.center;
}

export function gotoHole(i, fit) {
  if (!holes.length) return;
  holeIdx = (i + holes.length) % holes.length;
  const h = curHole();
  state.ui.holeKey = h.key; save('hole');
  target = null;
  $('#holeNo').textContent = h.no > 100 ? '?' : h.no;
  const lenY = h.lengthM ? m2y(h.lengthM) : null;
  $('#holeMeta').textContent = `PAR ${h.par ?? '-'} · ${lenY ? fmt(lenY) + ul() : '距離データなし'}${h.hcp ? ' · HDCP ' + h.hcp : ''}`;
  $('#holeNote').value = state.course ? getNote(state.course.id, h.key) : '';
  $('#noteSaved').textContent = '';
  const ai = state.course && state.aiTips[state.course.id]?.[h.key];
  $('#aiHoleOut').hidden = !ai;
  $('#aiHoleOut').innerHTML = ai ? md(ai.text) + `<p class="muted">AI作成: ${new Date(ai.updatedAt).toLocaleDateString('ja-JP')}</p>` : '';
  renderStrategy();
  if (fit) fitHole();
  render();
  window.dispatchEvent(new CustomEvent('navi-hole', { detail: { no: h.no, par: h.par } }));
}

function fitHole() {
  const h = curHole();
  const c = holeCenter(h);
  const pts = [...(h.line || []), c, me && dist(me, c || me) < 700 ? me : null].filter(Boolean);
  if (pts.length >= 2) map.fitBounds(pts.map((p) => [p.lat, p.lon]), { padding: [30, 30], maxZoom: 18 });
  else if (pts.length === 1) map.setView([pts[0].lat, pts[0].lon], 17);
  else if (state.course) map.setView([state.course.lat, state.course.lon], 15);
}

let strat = null;
function renderStrategy() {
  const h = curHole();
  if (!h || h.virtual || !features) {
    strat = null;
    $('#holeTips').innerHTML = `<li class="muted">${state.course ? 'このコースはホールデータが未登録です。「グリーン位置を手動設定」で各ホールのグリーンをタップすると距離が出ます。設定したグリーン位置は保存され、友だちとも共有できます。' : 'コースを選んでください。'}</li>`;
    return;
  }
  strat = holeStrategy({ ...h, center: holeCenter(h) }, features, state.clubs);
  $('#holeTips').innerHTML = strat.tips.map((t) => `<li>${esc(t)}</li>`).join('');
}

// ---------------- main render ----------------
function render() {
  const h = curHole();
  const c = holeCenter(h);
  greenLine?.remove(); greenLine = null;
  targetMarker?.remove(); targetMarker = null;
  targetLine?.remove(); targetLine = null;
  if (c) {
    greenLine = L.layerGroup().addTo(map);
    L.marker([c.lat, c.lon], { icon: L.divIcon({ className: '', html: '<div class="flag-icon">⛳</div>', iconSize: [24, 24], iconAnchor: [6, 22] }), interactive: false }).addTo(greenLine);
    if (h.line?.length) L.polyline(h.line.map((p) => [p.lat, p.lon]), { color: '#ffd60a', weight: 2.5, opacity: 0.9, dashArray: '6 6', interactive: false }).addTo(greenLine);
  }
  if (!me || !c) {
    $('#ydCenter').textContent = '---'; $('#ydFront').textContent = '---'; $('#ydBack').textContent = '---';
    $('#ydUnit').textContent = unit() === 'm' ? 'm' : 'yd';
    $('#clubName').textContent = '--';
    $('#clubDetail').textContent = !state.course ? 'コースを選ぶと距離と番手が出ます' : !c ? 'グリーン位置が未設定です' : '現在地を取得中…（地図右上「目標」→「現在地」で手動指定も可）';
    $('#hazardList').innerHTML = '';
    renderTarget(null);
    return;
  }
  const g = greenDistances(me, h, c);
  $('#ydCenter').textContent = fmt(g.center);
  $('#ydFront').textContent = fmt(g.front);
  $('#ydBack').textContent = fmt(g.back);
  $('#ydUnit').textContent = unit() === 'm' ? 'm' : 'yd';
  L.polyline([[me.lat, me.lon], [c.lat, c.lon]], { color: '#ffffff', weight: 2, opacity: 0.9, interactive: false }).addTo(greenLine);
  const mid = { lat: (me.lat + c.lat) / 2, lon: (me.lon + c.lon) / 2 };
  L.marker([mid.lat, mid.lon], { icon: L.divIcon({ className: '', html: `<div class="yd-tag">${fmt(g.center)}${ul()}</div>`, iconSize: [50, 22], iconAnchor: [25, 11] }), interactive: false }).addTo(greenLine);

  // hazards ahead
  if (strat?.hazards?.length) {
    const hz = hazardDistancesFrom(me, strat.hazards, c).slice(0, 6);
    $('#hazardList').innerHTML = hz.map((x) => `<span class="hz ${x.type}">${x.type === 'water' ? '池' : 'バンカー'}(${x.latY > 5 ? '左' : x.latY < -5 ? '右' : '中央'}) 手前${fmt(x.front)} / 越え${fmt(x.carry)}</span>`).join('');
  } else $('#hazardList').innerHTML = '';

  renderTarget(c);
  renderAdvice();
  updateElevation(c);
}

function greenDistances(p, h, c) {
  const center = m2y(dist(p, c));
  const pin = state.course && getPin(state.course.id, h.key);
  if (!h.green?.pts?.length) return { center, front: pin ? null : center - 12, back: pin ? null : center + 12 };
  const b = (bearing(p, c) * Math.PI) / 180, ux = Math.sin(b), uy = Math.cos(b);
  let lo = Infinity, hi = -Infinity;
  for (const q of h.green.pts) { const v = xy(p, q); const a = v.x * ux + v.y * uy; lo = Math.min(lo, a); hi = Math.max(hi, a); }
  return { center, front: m2y(lo), back: m2y(hi) };
}

function renderTarget(c) {
  const box = $('#targetLine');
  if (!target || !me) { box.hidden = true; return; }
  targetMarker = L.circleMarker([target.lat, target.lon], { radius: 7, color: '#ffd60a', weight: 3, fillOpacity: 0.3 }).addTo(map);
  targetLine = L.polyline([[me.lat, me.lon], [target.lat, target.lon], ...(c ? [[c.lat, c.lon]] : [])], { color: '#ffd60a', weight: 2, dashArray: '2 5' }).addTo(map);
  const d1 = m2y(dist(me, target)), d2 = c ? m2y(dist(target, c)) : null;
  const rc = recommendClub(state.clubs, playsLike(d1, conditions(bearing(me, target))).yards);
  box.hidden = false;
  box.innerHTML = `目標まで <b>${fmt(d1)}${ul()}</b>${rc ? `（${esc(rc.club.name)}）` : ''}${d2 != null ? ` → そこからグリーンまで <b>${fmt(d2)}${ul()}</b>` : ''}　<button class="btn small" id="clearTarget">消す</button>`;
  $('#clearTarget').onclick = () => { target = null; render(); };
}

function conditions(shotBearing) {
  const mode = $('#windMode').value;
  const head = mode === 'auto' ? headComponent(wx, shotBearing) : Number(mode);
  const manual = $('#elevManual').value;
  return {
    head, lie: $('#lie').value,
    elevM: manual !== '' ? Number(manual) : elevDiff ?? 0,
    tempC: wx?.temp,
  };
}

function renderAdvice() {
  const h = curHole(); const c = holeCenter(h);
  if (wx && Number.isFinite(wx.speed)) $('#windPill').textContent = `${compass(wx.dir)}の風 ${wx.speed.toFixed(1)}m/s · ${Math.round(wx.temp)}℃`;
  if (!me || !c) return;
  const br = bearing(me, c);
  const raw = m2y(dist(me, c));
  const cond = conditions(br);
  const pl = playsLike(raw, cond);
  const rc = recommendClub(state.clubs, pl.yards);
  if (!rc) return;
  $('#clubName').textContent = rc.club.name;
  const cross = $('#windMode').value === 'auto' ? crossComponent(wx, br) : 0;
  const aim = Math.abs(cross) >= 2 ? `横風 ${Math.abs(cross).toFixed(1)}m/s：${cross > 0 ? '左' : '右'}から吹くので${cross > 0 ? '左' : '右'}目を狙う。` : '';
  $('#clubDetail').innerHTML = `打つ距離 <b>${fmt(pl.yards)}${ul()}</b>（実距離 ${fmt(raw)}${ul()}）<br>${rc.alt ? `迷ったら ${esc(rc.alt.name)}（${fmt(rc.alt.carry)}${ul()}）。` : ''}${esc(rc.note)}${esc(aim)}`;
  $('#adjBreak').textContent = pl.parts.length ? '補正: ' + pl.parts.join(' / ') : '補正なし';
}

async function updateElevation(c) {
  if (!me || !c) return;
  const key = `${me.lat.toFixed(4)},${me.lon.toFixed(4)}>${c.lat.toFixed(4)},${c.lon.toFixed(4)}`;
  if (key === elevKey) return;
  elevKey = key;
  try {
    const [a, b] = await elevations([me, c]);
    if (Number.isFinite(a) && Number.isFinite(b)) { elevDiff = b - a; renderAdvice(); }
  } catch { elevDiff = null; }
}

// ---------------- shots ----------------
function recordShot() {
  if (!me) { toast('現在地がまだ取れていません'); return; }
  endShot(false);
  state.pendingShot = { id: uid(), club: $('#shotClub').value, from: { ...me }, acc: meAcc, hole: curHole()?.no ?? null, courseId: state.course?.id || null, courseName: state.course?.name || '', date: new Date().toISOString() };
  save('shot');
  $('#shotHint').textContent = `${state.pendingShot.club} 計測中… ボール地点で押す`;
  toast(`${state.pendingShot.club} の打球位置を記録`);
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
  $('#shotLog').innerHTML = list.map((s) => `<div><span>${esc(s.courseName ? s.courseName.slice(0, 10) : '')} ${s.hole ? s.hole + 'H' : ''} ${esc(s.club)}</span><b>${fmt(s.yards)}${ul()}</b></div>`).join('') || '<span class="muted">「ここから打つ」→ボールの所で「ボール地点」で飛距離を自動計測。番手別の平均が分析タブに貯まります。</span>';
  if (state.pendingShot) $('#shotHint').textContent = `${state.pendingShot.club} 計測中…`;
}

// ---------------- AI hole strategy ----------------
async function aiHole() {
  const h = curHole();
  if (!state.course || !h) { toast('コースを選んでください'); return; }
  if (!hasAI()) { toast('設定でClaudeのAPIキーを入れるとAI攻略が使えます', 3500); return; }
  const out = $('#aiHoleOut');
  out.hidden = false; out.innerHTML = '<p class="muted">AIが攻略を考えています…</p>';
  const s = strat || { tips: [], hazards: [] };
  const recent = (state.rounds || []).slice(0, 5);
  const data = {
    course: state.course.name, hole: h.no, par: h.par, lengthYards: h.lengthM ? Math.round(m2y(h.lengthM)) : null,
    doglegs: s.doglegs, green: s.shape ? { depthY: Math.round(s.shape.depth), widthY: Math.round(s.shape.width) } : null,
    hazards: (s.hazards || []).map((x) => ({ type: x.type, fromTeeY: Math.round(x.alongY), side: x.latY > 5 ? 'left' : x.latY < -5 ? 'right' : 'center', offsetY: Math.round(Math.abs(x.latY)), nearGreen: x.nearGreen })),
    weather: wx, myClubsCarryY: state.clubs, playerNow: me && holeCenter(h) ? { toGreenY: Math.round(m2y(dist(me, holeCenter(h)))) } : null,
    myNote: getNote(state.course.id, h.key) || null,
    myTendency: recent.length ? summarizeTendency(recent) : null,
  };
  const prompt = `次のホールの攻略法を作ってください。
1) ティーショット（狙い所と番手、避けるべきミス）
2) セカンド以降（刻むか攻めるか、残したい距離）
3) グリーン周り（外していい側、パッティングの注意）
4) このプレーヤーの傾向を踏まえた一言
データ(JSON、距離はヤード、lateralはティーから見た左右):
${JSON.stringify(data)}`;
  try {
    const text = await askClaude({ system: COACH_SYSTEM, prompt, maxTokens: 1200, onText: (t) => { out.innerHTML = md(t); } });
    state.aiTips[state.course.id] ??= {};
    state.aiTips[state.course.id][h.key] = { text, updatedAt: Date.now() };
    save('ai');
    out.innerHTML = md(text) + `<p class="muted">AI作成: ${new Date().toLocaleDateString('ja-JP')}（保存済み）</p>`;
  } catch (e) { out.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

function summarizeTendency(rounds) {
  let fwL = 0, fwR = 0, fwH = 0, n = 0;
  for (const r of rounds) for (const x of r.holes) { if (x.fw === 'left') fwL++; else if (x.fw === 'right') fwR++; else if (x.fw === 'hit') fwH++; if (x.strokes) n++; }
  return { teeShots: { fairway: fwH, missLeft: fwL, missRight: fwR }, holesPlayed: n };
}

export function refreshNavi() { fillShotClubs(); renderShotLog(); renderStrategy(); render(); }
