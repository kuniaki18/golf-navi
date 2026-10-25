// GPS rangefinder: rotated hole view, satellite map, distances (front/center/back/pin), plays-like club advice,
// hazard carries, hole strategy, shot tracking, hole mapping for unmapped courses, and auto-learning.
import { $, $$, esc, toast, dist, bearing, m2y, y2m, md, uid, fmtDate } from './util.js';
import { state, save, getCourseCache, putCourseCache, getNote, setNote } from './store.js';
import { courseFeatures, buildHoles, nearestHole, matchCourse, greensNear, setLabel } from './osm.js';
import { playsLike, recommendClub, weather, headComponent, crossComponent, elevations, elevationSource, compass } from './advice.js';
import { holeStrategy, hazardDistancesFrom } from './strategy.js';
import { askClaude, COACH_SYSTEM, hasAI, needAI } from './ai.js';
import { HoleView, IMAGERY, setImagery } from './holeview.js';
import { analyzeGreen, readPutt, greenCondition } from './greenslope.js';
import { GpsFilter } from './gpsfilter.js';
import { greenDistances as greenDist, greenKey } from './geo.js';
import { submitHole, communityHoles, communityDoc, submitScorecard } from './community.js';
import { dataQuality, checkScorecard } from './coursedata.js';
import { learnHoles } from './learn.js';
import { briefingScript } from './briefing.js';
import { dwellOnGreen, shouldAdvance } from './easymap.js';
import { computeStats } from './analysis.js';
import { ninesOf, defaultPlan, planHoles, planPars, scRow } from './round.js';
import { beginRound } from './score.js';
import { caddieScript, speak, canSpeak, speaking, stopSpeaking, browserKind, externalBrowserUrl, speechHelp } from './voice.js';

let map, layers, meMarker, accCircle, overlay, mapTiles;
let hv = null;
let features = null, holes = [], holeIdx = 0;
let me = null, meAcc = null, manualMe = false;
const gps = new GpsFilter();
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
        submitHole(state.course, h.key, u[h.key]);
        toast(`${h.no}番を登録しました`); rebuild(); return;
      }
      target = ll; render();
    },
    onPin: (ll) => { const h = curHole(); if (!h) return; todayPins()[h.key] = { lat: ll.lat, lon: ll.lon }; save('pin'); toast('今日のピン位置をセットしました'); render(); },
  });
  $('#viewTabs').onclick = (e) => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); };
  $('#holePrev').onclick = () => gotoHole(holeIdx - 1, true);
  $('#holeNext').onclick = () => gotoHole(holeIdx + 1, true);
  $('#btnLocate').onclick = () => { manualMe = false; gps.reset(); startGPS(); hv.resetView(); if (me && map) map.setView([me.lat, me.lon], 17); };
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
  $('#btnPrecise').onclick = startPrecise;
  $('#btnGreenRead').onclick = () => { const h = curHole(); if (h) { try { const c = JSON.parse(localStorage.getItem('golfnavi:greens:v2') || '{}'); delete c[`v2:${greenKey(h.green, holeCenter(h))}`]; localStorage.setItem('golfnavi:greens:v2', JSON.stringify(c)); } catch {} } readGreen(false); };
  startCompass();
  initQuickScore();
  $('#btnGreenAlt').onclick = () => {
    const h = curHole(); if (!h?.greenOptions) return;
    const next = ((h.greenIdx ?? 0) + 1) % h.greenOptions.length;
    state.ui.greenAlt ??= {}; (state.ui.greenAlt[cid()] ??= {})[h.key] = next; save('ui');
    rebuild(); toast(`${greenSideLabel(curHole(), next)}にしました`);
  };
  $('#btnVoice').onclick = voiceCaddie;
  $('#stGo').onclick = startRound;
  $('#btnScEdit').onclick = openScorecardEditor;
  $('#emTee').onclick = () => { if (!me) { toast('現在地を取得中です。少し待ってから押してください'); return; } if ((meAcc ?? 99) > 25) toast('GPSの精度が低いので、位置が少しずれるかもしれません'); setHolePoint('tee', me, 'tap'); };
  $('#emGreen').onclick = () => { if (!me) { toast('現在地を取得中です。少し待ってから押してください'); return; } setHolePoint('green', me, 'tap'); };
  $('#emSkip').onclick = () => { if (holeIdx + 1 < holes.length) gotoHole(holeIdx + 1, true); };
  $('#briefPlay').onclick = () => speakBriefing(briefingScript(briefingInfo()).sentences);
  $('#briefClose').onclick = () => { stopSpeaking(); $('#briefCard').hidden = true; };
  $('#briefDate').onchange = () => { (state.ui.playDate ??= {})[cid()] = $('#briefDate').value || undefined; save('ui'); openBriefing(false); };
  $('#learnOk').onclick = applyLearned;
  $('#learnNo').onclick = () => { pendingLearn = null; $('#learnDlg').close(); };
  $('#scEditSave').onclick = saveScorecardEditor;
  $('#scEditCancel').onclick = () => $('#scEditDlg').close();
  $('#scEditClear').onclick = clearMyScorecard;
  $('#stCancel').onclick = () => $('#startDlg').close();
  $('#stTee').onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) { $$('#stTee button').forEach((x) => x.classList.toggle('on', x === b)); startTeeNote(); } };
  window.addEventListener('round-changed', renderRoundBar);
  $('#btnVoiceMap').onclick = voiceCaddie;
  // flyover (like a 3D hole preview): glide from the tee to the green over the aerial photo
  const flyBtn = $('#btnFly');
  hv.onFlyEnd = () => flyBtn.classList.remove('on');
  flyBtn.onclick = () => {
    if (hv.flying) { hv.resetView(); flyBtn.classList.remove('on'); return; }
    if (view !== 'hole') setView('hole');
    if (hv.flyover({ ms: 7000, onEnd: () => flyBtn.classList.remove('on') })) flyBtn.classList.add('on');
    else toast('このホールはティーとグリーンの位置が未登録のため、フライオーバーできません');
  };
  $('#btnRenumber').onclick = openRenumber;
  $('#rnClose').onclick = () => ($('#renumberPanel').hidden = true);
  $('#rnSave').onclick = applyRenumber;
  $('#rnHide').onclick = hideHole;
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

// ---------------- GPS quality, precise lock, compass ----------------
let gpsHeading = null, compassHeading = null;
const MODE_TXT = { wait: '測位待ち', settling: '測位中', stable: '静止・安定', moving: '移動中', poor: '精度が低い', measuring: '精密計測中', lock: '精密ロック' };
function gpsBadge() {
  const el = $('#gpsStatus');
  if (manualMe) { el.className = 'gps-status q-lock'; el.textContent = '手動の現在地'; return; }
  const st = gps.state, now = Date.now();
  if (!st.pos) { el.className = 'gps-status q-wait'; el.textContent = watchId == null ? (gpsError || 'GPS停止中') : '測位待ち…'; return; }
  if (st.mode === 'measuring') { el.className = 'gps-status q-lock'; el.textContent = `精密計測中… あと${st.left ?? ''}秒（動かないで）`; return; }
  const age = gps.age(now);
  const accY = m2y(st.sigma);
  const q = age > 30 ? 'stale' : age > 10 ? 'old' : st.mode === 'lock' ? 'lock' : st.mode === 'moving' ? 'fair' : accY <= 8 ? 'good' : accY <= 16 ? 'fair' : 'poor';
  el.className = 'gps-status q-' + q;
  document.querySelector('.yardage')?.classList.toggle('stale', q === 'old' || q === 'stale');
  const ageTxt = age < 3 ? '' : ` · ${Math.round(age)}秒前${age > 10 ? '（更新待ち）' : ''}`;
  el.textContent = `${MODE_TXT[st.mode] || 'GPS'} 誤差の目安 ±${fmt(accY)}${ul()}${ageTxt}${q === 'poor' ? ' · 空の見える所で' : ''}`;
}
function startPrecise() {
  if (!gps.state.pos) { toast('GPSを取得中です'); return; }
  gps.startMeasure(Date.now());
  $('#btnPrecise').classList.add('on');
  toast('6秒間その場で動かずに待ってください');
  gpsBadge();
  setTimeout(() => { if (gps.measure) { applyGps(gps.finishMeasure(Date.now())); afterPrecise(); render(); } }, 6800);
}
function afterPrecise() {
  $('#btnPrecise').classList.remove('on');
  const st = gps.state;
  toast(st.measureFailed ? 'GPSの更新が少なく精密計測できませんでした（そのまま使えます）' : `精密計測 誤差の目安 ±${fmt(m2y(st.sigma))}${ul()}（${st.n}回の平均）`);
}
function applyGps(st) {
  if (manualMe || !st.pos) { gpsBadge(); return; }
  me = st.pos; meAcc = st.sigma;
  gpsBadge();
}
function startCompass() {
  const on = (e) => {
    const h = e.webkitCompassHeading ?? (e.absolute && Number.isFinite(e.alpha) ? (360 - e.alpha) % 360 : null);
    if (Number.isFinite(h)) { compassHeading = h; if (view !== 'map') hvHeadingThrottle(); }
  };
  const attach = () => { window.addEventListener('deviceorientationabsolute', on); window.addEventListener('deviceorientation', on); };
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    // iOS: must be requested from a tap
    document.addEventListener('click', function ask() { DeviceOrientationEvent.requestPermission().then((r) => { if (r === 'granted') attach(); }).catch(() => {}); document.removeEventListener('click', ask); }, { once: true });
  } else attach();
}
let hdT = 0;
function hvHeadingThrottle() { const now = Date.now(); if (now - hdT < 250) return; hdT = now; hv?.set({ heading: compassHeading ?? gpsHeading }); }

// ---------------- green read ----------------
let greenBusy = false;
async function readGreen(auto) {
  const h = curHole(); const c = holeCenter(h);
  if (!h || !c) { $('#greenRead').innerHTML = '<p class="muted">このホールのグリーン位置が未登録です。</p>'; return; }
  if (greenBusy) return; greenBusy = true;
  $('#greenRead').innerHTML = '<p class="muted">国土地理院の高さデータからグリーンの傾斜を計算しています…</p>';
  try {
    const key = `v2:${greenKey(h.green, h.center || c)}`;
    const [slope, cond] = await Promise.all([analyzeGreen(h.green, h.center || c, key), state.course ? greenCondition(state.course.lat, state.course.lon) : null]);
    curSlope = slope;
    const from = me && dist(me, c) < 400 ? me : (h.line?.length >= 2 ? h.line[h.line.length - 2] : h.tee) || me;
    const pin = (cid() && todayPins()[h.key]) || c;
    const rd = slope && from ? readPutt(slope, from, pin, state.ui.swHand || 'right') : null; // null when not determinable
    const conf = slope?.conf;
    const confCls = { high: 'good', mid: 'fair', low: 'poor', none: 'none' }[conf?.level] || 'none';
    const where = me && dist(me, c) < 400 ? 'いまの位置から' : 'フェアウェイ側から（推定）';
    $('#greenRead').innerHTML = !slope ? '<p class="muted">この場所の高さデータが取得できませんでした。</p>' : `
      <div class="gr-main">${conf.level === 'none' ? '<b>判定不可</b>' : `<b>${slope.pct.toFixed(1)}%</b><span>±${slope.pctSE.toFixed(1)}% · ${esc(compass(slope.downBearing))}方向へ下る（方向の誤差 ±${Math.round(slope.dirSE)}°）</span>`}</div>
      <p class="gr-conf"><span class="pill conf-${confCls}">信頼度：${esc(conf.label)}</span> ${esc(conf.reason)}</p>
      ${rd ? `<ul class="tips"><li>${where}ピンへ：<b>${esc(rd.upDown)}</b>・<b>${esc(rd.sideTxt)}</b></li><li>${esc(rd.aim)}。</li></ul>` : ''}
      ${cond ? `<p class="gr-cond"><span class="pill">速さ（天気からの推測）：${esc(cond.speed)}</span> ${esc(cond.note)}</p>` : ''}
      <p class="muted">計算の根拠：国土地理院 ${esc(slope.src)}、グリーン内の${slope.n}点に平面を当てはめ（当てはめのずれ ${Math.round(slope.rms * 100)}cm）。${slope.shapeKnown ? '' : 'グリーンの形が地図にないため、中心の周り半径8mで計算。'}標高は0.1m単位のため、緩い傾斜ほど誤差が大きくなります。段差・細かいアンジュレーション・芝目は分かりません。</p>`;
    render();
  } catch { if (!auto) $('#greenRead').innerHTML = '<p class="muted">解析できませんでした。電波の良い所でもう一度お試しください。</p>'; }
  finally { greenBusy = false; }
}
let curSlope = null;

function setView(v) {
  view = v;
  $('#greenCard').hidden = v !== 'green';
  if (v === 'green') readGreen(true);
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
let gpsError = '';
function startGPS() {
  if (!('geolocation' in navigator)) { $('#gpsStatus').textContent = 'この端末はGPSに対応していません'; return; }
  if (watchId != null) return;
  watchId = navigator.geolocation.watchPosition(onFix, (err) => {
    // errors do not stop a watch: clear it before restarting, otherwise watches pile up and fixes are counted twice
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    gpsError = err.code === 1 ? '位置情報がオフです（地図→「現在地を指定」で手動指定）' : 'GPS信号を探しています…';
    gpsBadge();
    if (err.code !== 1) setTimeout(startGPS, 5000);
  }, { enableHighAccuracy: true, maximumAge: roundActive() ? 0 : 1000, timeout: 20000 });
}
/** start the position watch again from scratch (after the phone slept, or when fixes stopped) */
function restartGPS() { if (watchId != null) navigator.geolocation.clearWatch(watchId); watchId = null; startGPS(); }
let lastFixAt = 0;
// during a round the position is measured all the time: if fixes stop (screen was off, the browser paused the watch),
// the watch is restarted; returning to the app restarts it at once
setInterval(() => { if (roundActive() && document.visibilityState === 'visible' && Date.now() - lastFixAt > 20000) restartGPS(); }, 10000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && roundActive() && Date.now() - lastFixAt > 5000) restartGPS(); });

/** where the player walked during the round (compact: [lat, lon, seconds since start]) */
function recordTrack(p, acc) {
  const r = state.current; if (!roundActive() || !(acc <= 30)) return;
  const tr = (r.track ??= []);
  const t = Math.round((Date.now() - (r.started || Date.now())) / 1000);
  const last = tr[tr.length - 1];
  if (last && dist({ lat: last[0], lon: last[1] }, p) < 8 && t - last[2] < 60) return;
  if (tr.length >= 5000) tr.splice(0, 1);
  tr.push([Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6, t]);
  save('round');
}
export function walkedKm(tr = state.current?.track || []) {
  let m = 0;
  for (let i = 1; i < tr.length; i++) { const d = dist({ lat: tr[i - 1][0], lon: tr[i - 1][1] }, { lat: tr[i][0], lon: tr[i][1] }); if (d < 300) m += d; }
  return m / 1000;
}
function onFix(pos) {
  gpsError = ''; lastFixAt = Date.now();
  recordTrack({ lat: pos.coords.latitude, lon: pos.coords.longitude }, pos.coords.accuracy);
  if (Number.isFinite(pos.coords.heading) && (pos.coords.speed || 0) > 0.8) gpsHeading = pos.coords.heading;
  const wasMeasuring = !!gps.measure;
  const st = gps.push({ lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, t: Date.now(), speed: pos.coords.speed });
  if (manualMe) return;
  applyGps(st);
  if (wasMeasuring && !gps.measure) afterPrecise();
  if (st.mode === 'measuring') return;
  if ($('#autoHole').checked && holes.length) autoHole();
  easyOnFix(pos.coords.accuracy);
  detectCourse();
  render();
}
// refresh the status line every second so the age of the fix is always visible
setInterval(() => { if (document.visibilityState === 'visible' && $('#gpsStatus')) gpsBadge(); }, 1000);
setInterval(() => { const el = document.querySelector('#roundBar .rb-gps'); if (!el || !roundActive()) return; const ok = Date.now() - lastFixAt < 15000; el.className = 'rb-gps ' + (ok ? 'ok' : 'wait'); el.textContent = (ok ? 'GPS計測中' : 'GPSを探しています…') + ' · 歩いた距離 ' + walkedKm().toFixed(1) + 'km'; }, 5000);

function autoHole() {
  const cur = holes[holeIdx], next = holes[holeIdx + 1];
  if (next?.tee && dist(me, next.tee) < 35 && (!cur.center || dist(me, cur.center) > 25)) return gotoHole(holeIdx + 1, true);
  // walking onto another course of a 27/36-hole club: switch course when standing on its tee
  const nearAll = nearestHole(allHoles, me);
  if (!roundActive() && nearAll && (nearAll.set || 0) !== activeSet() && nearAll.tee && dist(me, nearAll.tee) < 30) {
    setSet(nearAll.set || 0); state.ui.holeKey = nearAll.key; rebuild(); toast(`${setLabel(activeSet())}に切り替えました`); return;
  }
  const near = nearestHole(holes, me);
  if (near && near !== cur) {
    const dCur = Math.min(cur.center ? dist(me, cur.center) : Infinity, cur.tee ? dist(me, cur.tee) : Infinity);
    // far from the current hole → switch; but when the current hole is not registered yet (distance unknown), switch
    // only when standing on another hole's tee — otherwise it would jump back to the last registered hole
    if ((Number.isFinite(dCur) && dCur > 250) || (near.tee && dist(me, near.tee) < 30)) gotoHole(holes.indexOf(near), true);
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
  // a course was chosen: the 'are you at …?' question from before is no longer needed
  $('#detectBanner').hidden = true; detected = 'done';
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
  communityData = await communityHoles(c.id).catch(() => ({}));
  scorecard = null;
  try { const { bundledCourses } = await import('./osm.js'); const b = (await bundledCourses()).find((x) => x.id === (c.osmId || c.id)); if (b?.scorecard) scorecard = await (await fetch(`data/sc/${b.id}.json`)).json(); } catch {}
  officialCard = scorecard ? { ...scorecard, source: 'official' } : null;
  communityCard = null; try { const d = await communityDoc(c.id); if (d?.scorecard?.courses?.length) communityCard = { ...d.scorecard, source: 'community' }; } catch {}
  pickScorecard();
  rebuild(true);
  await refreshWind();
}

let allHoles = [];
export const LADIES_RATIO = 0.85;
const playingTee = () => (roundActive() ? state.current.plan.tee || 'regular' : 'regular');
let officialCard = null, communityCard = null;
/** which par / yardage table to use: your own entry, then the official card shipped with the app, then the community's */
function pickScorecard() {
  const mine = cid() && state.scorecards?.[cid()];
  scorecard = mine ? { ...mine, source: 'mine' } : officialCard || communityCard || null;
}
let scorecard = null;
const courseName = (i) => (scorecard?.courses?.[i]?.name ? `${scorecard.courses[i].name}コース` : setLabel(i));
let communityData = {};
const activeSet = () => (cid() && state.ui.holeSet?.[cid()]) || 0;
function rebuild(first) {
  const keep = curHole()?.key ?? state.ui.holeKey;
  // estimated holes are not used: measured on mapped courses their hole number was right only 2% of the time
  // (tools/validate-est.mjs). Mapped greens are offered as 'nearby greens' instead, and rounds teach the real holes.
  allHoles = buildHoles(features, { ...communityData, ...userHoles() });
  // 2-green systems: use the green the player picked for this hole (default: the first option)
  for (const h of allHoles) {
    if (!h.greenOptions) continue;
    const i = state.ui.greenAlt?.[cid()]?.[h.key] || 0;
    const g = h.greenOptions[i] || h.greenOptions[0];
    if (g !== h.greenOptions[0] || h.source !== 'osm' || !h.green) { h.green = g; h.center = g.c; }
    h.greenIdx = h.greenOptions.indexOf(h.green);
  }
  // official scorecard: par and yardage by course / hole number
  // only for holes whose number is known (mapped, registered or confirmed with 番号修正) — never for an estimated number
  // yardage of the tee being played (falls back to the regular tee when the scorecard has no number for it)
  const tee = roundActive() ? state.current.plan.tee || 'regular' : 'regular';
  const ydOf = (sc) => (tee === 'back' ? sc.back : tee === 'ladies' ? sc.ladies : tee === 'front' ? sc.front : null) || sc.yd;
  // ladies tee without numbers on the scorecard: about 85% of the regular yardage (草津温泉 5,420 / 6,354; typical courses
  // are close to this) — always labelled 推定
  const ladiesEst = (sc) => tee === 'ladies' && !sc.ladies;
  for (const h of allHoles) { if (h.source === 'est') continue; const sc = scorecard?.courses?.[h.set || 0]?.holes?.[h.no - 1]; if (sc) { h.par = sc.par; h.parEst = false; h.officialY = ladiesEst(sc) ? Math.round(sc.yd * LADIES_RATIO) : ydOf(sc); h.teeEst = ladiesEst(sc); } }
  const sets = [...new Set(allHoles.map((h) => h.set || 0))].sort((a, b) => a - b);
  if (!sets.includes(activeSet())) setSet(0, false);
  // during a started round the holes follow the plan (front nine → back nine); otherwise one course at a time
  holes = roundActive() ? planHoles(allHoles, state.current.plan) : allHoles.filter((h) => (h.set || 0) === activeSet());
  // official course of a 27-hole club played on map holes: par / yardage from that course's scorecard row
  for (const h of holes) { if (h.scIdx == null) continue; const sc = scRow(h, scorecard); if (sc) { h.par = sc.par; h.parEst = false; h.officialY = ladiesEst(sc) ? Math.round(sc.yd * LADIES_RATIO) : ydOf(sc); h.teeEst = ladiesEst(sc); } }
  holeIdx = Math.max(0, holes.findIndex((h) => h.key === keep));
  const btn = $('#setBtn');
  btn.hidden = sets.length < 2 || roundActive();
  btn.textContent = courseName(activeSet());
  btn.onclick = () => { setSet((activeSet() + 1) % sets.length); state.ui.holeKey = null; rebuild(); toast(`${courseName(activeSet())}に切り替えました`); };
  renderCourseLayer();
  renderRoundBar();
  renderDataCard();
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
  $('#holeNo').textContent = h.no > 100 ? '?' : h.dispNo ?? h.no;
  const lenY = h.lengthM ? m2y(h.lengthM) : null;
  $('#holeMeta').textContent = `${h.nineName ? h.nineName + ' · ' : ''}PAR ${h.par ?? '-'}${h.parEst ? '（推定）' : ''} · ${h.officialY ? (h.teeEst ? `レディース 約${fmt(h.officialY)}${ul()}（推定）` : `公式 ${fmt(h.officialY)}${ul()}`) : lenY ? (playingTee() === 'ladies' ? `レディース 約${fmt(lenY * LADIES_RATIO)}${ul()}（推定）` : fmt(lenY) + ul()) : '距離データなし'}${h.hcp ? ' · HDCP ' + h.hcp : ''}`;
  $('#btnRenumber').hidden = !['est', 'user', 'community', 'learned'].includes(h.source);
  const gb = $('#btnGreenAlt');
  gb.hidden = !h.greenOptions;
  if (h.greenOptions) gb.textContent = greenSideLabel(h, h.greenIdx ?? 0);
  $('#holeSrc').textContent = { osm: '', user: '登録済み', learned: '自動学習', community: 'みんなの地図', est: '自動推定', none: '未登録' }[h.source] || '';
  $('#holeSrc').className = 'src-badge ' + h.source;
  $('#holeNote').value = cid() ? getNote(cid(), h.key) : '';
  $('#noteSaved').textContent = '';
  const ai = cid() && state.aiTips[cid()]?.[h.key];
  $('#aiHoleOut').hidden = !ai;
  $('#aiHoleOut').innerHTML = ai ? md(ai.text) + `<p class="muted">AI作成: ${new Date(ai.updatedAt).toLocaleDateString('ja-JP')}</p>` : '';
  renderStrategy();
  renderQuickScore();
  curSlope = null; if (view === 'green') readGreen(true);
  if (fit) { hv.resetView(); fitMap(); }
  render();
  window.dispatchEvent(new CustomEvent('navi-hole', { detail: { no: h.no, idx: h.roundIdx, par: h.parEst ? null : h.par } }));
  // when each hole started (to learn tee / green positions from the walked track after the round)
  if (roundActive() && h.roundIdx != null) {
    const r = state.current, log = (r.holeLog ??= []);
    if (log[log.length - 1]?.[0] !== h.roundIdx) { log.push([h.roundIdx, Math.round((Date.now() - (r.started || Date.now())) / 1000)]); save('round'); }
  }
  renderRoundBar();
}

function renderStrategy() {
  const h = curHole();
  if (!h || !h.center || !features) {
    strat = null;
    $('#holeTips').innerHTML = `<li class="muted">${state.course ? 'このホールはまだ登録されていません。下の「ホールを登録」でティーとグリーンをタップするか、プレー中に「近くのグリーン」から選ぶと距離と攻略が出ます。' : 'コースを選んでください。'}</li>`;
    return;
  }
  strat = holeStrategy({ ...h, center: holeCenter(h) }, features, state.clubs);
  const estNote = h.source === 'est' ? ['このホールのティー位置と長さ・パーは地図からの推定です。ティーショットの距離やハザードまでの距離は目安として見てください。'] : [];
  $('#holeTips').innerHTML = [...estNote, ...strat.tips].map((t, i) => `<li${estNote.length && i === 0 ? ' class="muted"' : ''}>${esc(t)}</li>`).join('');
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
    slope: view === 'green' ? curSlope : null, heading: compassHeading ?? gpsHeading,
    emptyText: !state.course ? 'コースを選ぶとホールが表示されます' : draft?.tee ? `${h.no}番のグリーンをタップ` : `${h?.no ?? ''}番は未登録：ティーをタップ（拡大・移動できます）`,
  });
  if (view === 'map') renderMapOverlay(c);
  renderMappingCard(h);
  const o = originFor(h, c);
  $('#ydMainLabel').textContent = o && o !== me ? (h?.source === 'est' ? '推定ティーから（目安）' : 'ティーから（プレビュー）') : 'グリーンセンター';
  if (!o || !c) {
    $('#ydCenter').textContent = '---'; $('#ydFront').textContent = '---'; $('#ydBack').textContent = '---'; $('#ydPin').hidden = true;
    $('#ydUnit').textContent = unit() === 'm' ? 'm' : 'yd';
    $('#clubName').textContent = '--';
    $('#clubDetail').textContent = !state.course ? 'コースを選ぶと距離と番手が出ます' : !c ? 'このホールのグリーン位置が未登録です' : '現在地を取得中…（地図タブ→「現在地を指定」で手動指定も可）';
    $('#hazardList').innerHTML = '';
    $('#targetLine').hidden = true;
    $('#adjBreak').textContent = ''; // no stale corrections from the previous hole
    return;
  }
  const g = greenDist(o, h.green, h.center || c);
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
  return h?.tee || (me && c && dist(me, c) < 3000 ? me : null); // never measure from kilometres away
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
  if (wx && Number.isFinite(wx.speed)) $('#windPill').textContent = `予報：${compass(wx.dir)}の風 ${wx.speed.toFixed(1)}m/s${Number.isFinite(wx.gust) ? `（最大${wx.gust.toFixed(0)}）` : ''} · ${Math.round(wx.temp)}℃`;
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

// wind is a forecast (10 m height, course centre): refresh every 15 minutes during the round
let wxAt = 0;
async function refreshWind() {
  if (!state.course) return;
  try { wx = await weather(state.course.lat, state.course.lon); wxAt = Date.now(); render(); } catch {}
}
setInterval(() => { if (state.course && Date.now() - wxAt > 15 * 60e3 && document.visibilityState === 'visible') refreshWind(); }, 60e3);

// ---------------- course data accuracy & scorecard entry ----------------
const SC_SRC = { official: '公式スコアカード（アプリに収録）', mine: 'あなたが入力したスコアカード', community: 'みんなが入力したスコアカード' };
function renderDataCard() {
  const box = $('#dataCard'); if (!box) return;
  box.hidden = !state.course; if (box.hidden) return;
  const q = dataQuality(holes, scorecard);
  $('#dataLevel').className = `pill conf-${{ high: 'good', mid: 'fair', low: 'poor', none: 'none' }[q.level]}`;
  $('#dataLevel').textContent = `精度：${q.label}`;
  $('#dataBody').innerHTML = `<ul class="data-list">
    <li><b>ホールの位置</b>：地図・登録 ${q.measured} / 自動学習 ${q.learned} / 推定 ${q.est} / 未登録 ${q.none}（全${q.n}ホール）</li>
    <li><b>グリーンの形</b>：${q.shapes}ホール分（形が分かるホールだけ手前・奥の距離を出します）</li>
    <li><b>パー・ヤード</b>：${q.scSource ? esc(SC_SRC[q.scSource]) + (scorecard.votes ? `（${scorecard.votes}人が同じ内容）` : '') : 'スコアカードなし（地図からの推定）'}</li></ul>
    ${q.tips.length ? `<ul class="tips">${q.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '<p class="muted">このコースのデータは揃っています。</p>'}`;
}
/** the table shape: an existing scorecard's courses, or one block per course of the map (9 or 18 holes) */
function scorecardDraft() {
  if (scorecard?.courses?.length) return JSON.parse(JSON.stringify({ courses: scorecard.courses }));
  const sets = [...new Set(allHoles.map((h) => h.set || 0))].sort((a, b) => a - b);
  if (!sets.length) sets.push(0);
  return { courses: sets.map((s0) => {
    const hs = allHoles.filter((h) => (h.set || 0) === s0 && h.no <= 18);
    const len = hs.some((h) => h.no > 9) || !hs.length ? 18 : 9;
    return { name: sets.length > 1 ? courseName(s0).replace(/コース$/, '') : '', holes: Array.from({ length: len }, (_, i) => { const h = hs.find((x) => x.no === i + 1); return { par: h && !h.parEst ? h.par : '', yd: h?.officialY || '' }; }) };
  }) };
}
function openScorecardEditor() {
  if (!state.course) return;
  const d = scorecardDraft();
  const parSel = (v, c, i) => `<select data-c="${c}" data-i="${i}" data-f="par" aria-label="パー"><option value=""></option>${[3, 4, 5, 6].map((p) => `<option ${Number(v) === p ? 'selected' : ''}>${p}</option>`).join('')}</select>`;
  const num = (v, c, i, fld, ph) => `<input data-c="${c}" data-i="${i}" data-f="${fld}" type="number" inputmode="numeric" min="50" max="750" value="${v ?? ''}" placeholder="${ph}" aria-label="${ph}">`;
  $('#scEditBody').innerHTML = d.courses.map((c, k) => `<fieldset class="sc-block"><legend><input class="sc-name" data-c="${k}" data-f="name" value="${esc(c.name || '')}" placeholder="コース名（例: 東）" aria-label="コース名"></legend>
    <div class="sc-grid"><span class="hd">番</span><span class="hd">パー</span><span class="hd">ヤード</span><span class="hd">バック</span><span class="hd">レディース</span>
    ${c.holes.map((h, i) => `<span class="no">${i + 1}</span>${parSel(h.par, k, i)}${num(h.yd, k, i, 'yd', 'ヤード')}${num(h.back, k, i, 'back', '任意')}${num(h.ladies, k, i, 'ladies', '任意')}`).join('')}</div></fieldset>`).join('');
  $('#scEditErr').textContent = '';
  $('#scEditDlg').showModal();
  $('#scEditDlg').dataset.shape = JSON.stringify(d.courses.map((c) => c.holes.length));
}
function saveScorecardEditor() {
  const shape = JSON.parse($('#scEditDlg').dataset.shape || '[]');
  const card = { courses: shape.map((n, k) => ({ name: $(`.sc-name[data-c="${k}"]`).value, holes: Array.from({ length: n }, (_, i) => {
    const v = (fld) => $(`#scEditBody [data-c="${k}"][data-i="${i}"][data-f="${fld}"]`).value;
    return { par: v('par'), yd: v('yd'), back: v('back'), ladies: v('ladies') };
  }) })) };
  const r = checkScorecard(card);
  if (!r.ok) { $('#scEditErr').innerHTML = r.errors.slice(0, 6).map((e) => `<li>${esc(e)}</li>`).join('') + (r.errors.length > 6 ? `<li>ほか${r.errors.length - 6}件</li>` : ''); return; }
  (state.scorecards ??= {})[cid()] = r.card; save('scorecard');
  submitScorecard(state.course, r.card);
  $('#scEditDlg').close();
  pickScorecard(); rebuild();
  toast(state.settings.shareMaps === false ? 'スコアカードを保存しました' : 'スコアカードを保存しました。「みんなの地図」にも送りました（反映は数時間後）', 4000);
}
function clearMyScorecard() {
  if (!state.scorecards?.[cid()]) { $('#scEditDlg').close(); return; }
  delete state.scorecards[cid()]; save('scorecard'); $('#scEditDlg').close(); pickScorecard(); rebuild(); toast('あなたの入力を消して、元のデータに戻しました');
}

// ---------------- 事前ブリーフィング (before the play date) ----------------
/** the holes of the usual round (first two nines) described for the briefing, from the same data the navi uses */
function briefingInfo() {
  const nines = ninesOf(allHoles, courseName, scorecard);
  const plan = defaultPlan(nines);
  const ph = plan.front ? planHoles(allHoles, plan) : [];
  for (const h of ph) { if (h.scIdx == null) continue; const sc = scRow(h, scorecard); if (sc) { h.par = sc.par; h.officialY = sc.yd; } }
  const holesOut = ph.filter((h) => h.center || h.officialY).map((h) => {
    const st = h.center && features ? holeStrategy({ ...h, center: holeCenter(h) }, features, state.clubs) : null;
    const hz = st?.hazards || [];
    const lenY = h.officialY || (h.lengthM ? m2y(h.lengthM) : 0);
    const water = hz.filter((x) => x.type === 'water' && Math.abs(x.latY) < 25);
    // a carry only counts for water across the line in front of the green that a shot from the tee has to fly over
    const carries = water.filter((x) => Math.abs(x.latY) < 15).map((x) => x.alongY + m2y(x.size || 0)).filter((c) => c > 30 && c < lenY - 10 && (h.par === 3 || c <= 250));
    const front = carries.length ? Math.max(...carries) : null;
    return {
      label: `${h.nineName && nines.length > 2 ? h.nineName + ' ' : ''}${h.dispNo ?? h.no}番`, par: h.par || st?.par, lengthY: Math.round(h.officialY || (h.lengthM ? m2y(h.lengthM) : 0)),
      water: water.length > 0, waterCarry: front ? Math.round(front) : null,
      greenBunkers: hz.filter((x) => x.nearGreen && x.type === 'bunker').length, dogleg: !!st?.doglegs?.length,
      shallowGreen: st?.shape ? st.shape.depth < 25 : false, narrowGreen: st?.shape ? st.shape.width < 22 : false, est: h.source === 'est',
    };
  });
  return { courseName: state.course.name, nines: plan.front ? [plan.front.short, plan.back?.short].filter(Boolean) : null, holes: holesOut, clubs: state.clubs, stats: computeStats(), playDate: (state.ui.playDate || {})[cid()] || null, today: new Date().toISOString().slice(0, 10) };
}
function openBriefing(play) {
  if (!state.course) return;
  const card = $('#briefCard'); card.hidden = false;
  $('#briefDate').value = (state.ui.playDate || {})[cid()] || '';
  const r = briefingScript(briefingInfo());
  $('#briefBody').innerHTML = `${r.keyHoles.length ? `<h3>注意するホール</h3><ul class="tips">${r.keyHoles.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}
    <h3>プレー日までの練習</h3><ol class="brief-practice">${r.practice.map((p) => `<li>${esc(p)}</li>`).join('')}</ol>
    <details><summary>読み上げる全文</summary><p>${esc(r.sentences.join(''))}</p></details>`;
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (play) speakBriefing(r.sentences);
}
function speakBriefing(lines) {
  const b = $('#briefPlay');
  if (speaking()) { stopSpeaking(); b.textContent = '▶ 音声で聞く'; return; }
  b.textContent = '■ 止める';
  speak(lines, { rate: Number(state.settings.voiceRate) || 1.05, onEnd: () => (b.textContent = '▶ 音声で聞く'), onFail: () => { b.textContent = '▶ 音声で聞く'; showVoiceHelp(browserKind()); } });
}

// ---------------- round: プレー開始 ----------------
function roundActive() { const r = state.current; return !!(r?.plan && !r.ended && cid() && r.courseId === cid()); }
let startMode = 'new';
let startTeeNote = () => {};
export function openStartRound(mode = 'new') {
  if (!state.course) { toast('先にコースを選んでください'); return; }
  startMode = mode;
  const nines = ninesOf(allHoles, courseName, scorecard);
  const plan = mode === 'edit' && roundActive() ? state.current.plan : defaultPlan(nines);
  const opt = (n, sel) => `<option value="${n.id}" ${sel?.id === n.id ? 'selected' : ''}>${esc(n.name)}${n.mapped < 9 ? `（地図データ ${n.mapped}/9ホール）` : ''}</option>`;
  $('#stCourse').textContent = state.course.name;
  $('#stFront').innerHTML = nines.map((n) => opt(n, plan.front)).join('');
  $('#stBack').innerHTML = nines.map((n) => opt(n, plan.back)).join('') + `<option value="" ${plan.back ? '' : 'selected'}>なし（9ホールのみ）</option>`;
  // every tee can be chosen; tees the scorecard has no numbers for use the regular yardage (said in the note)
  const has = (k) => !!scorecard?.courses?.some((c) => c.holes?.some((h) => h[k]));
  $('#stTeeWrap').hidden = false;
  $$('#stTee button').forEach((b) => { const k = b.dataset.v; b.dataset.missing = k !== 'regular' && !has(k) ? '1' : ''; });
  if (mode !== 'edit' && state.ui.gender === 'women' && !plan.tee) plan.tee = 'ladies';
  const teeNote = () => {
    const b = $('#stTee button.on'), k = b?.dataset.v;
    $('#stTeeNote').textContent = k === 'ladies' && (!scorecard || b.dataset.missing) ? 'このコースはレディースティーのヤードが分からないため、ホールの長さはレギュラーの約85%で推定して表示します。グリーンまでの距離はGPSで測るので、ティーに関係なく正確です。'
      : !scorecard ? 'このコースはスコアカードがないため、ホールの長さは地図から出します。グリーンまでの距離はGPSで測ります。'
      : b?.dataset.missing ? `このコースのスコアカードには${b.textContent}ティーのヤードがないため、レギュラーティーのヤードを表示します。` : '';
  };
  $('#stTee').dataset.note = '1'; setTimeout(teeNote, 0); $('#stTee').onchange = teeNote; startTeeNote = teeNote;
  $$('#stTee button').forEach((b) => b.classList.toggle('on', b.dataset.v === (plan.tee || 'regular')));
  $('#stPlayers').value = '';
  $('#stPlayersWrap').hidden = mode === 'edit';
  $('#stGo').textContent = mode === 'edit' ? 'この内容に変更' : '▶ スタート';
  $('#stNote').textContent = mode === 'edit' ? '入力済みのスコアはそのまま残ります。' : '入力途中で保存していないラウンドは、自動で履歴に保存されます。';
  $('#startDlg').showModal();
}
function startRound() {
  const nines = ninesOf(allHoles, courseName, scorecard);
  const front = nines.find((n) => n.id === $('#stFront').value);
  const back = nines.find((n) => n.id === $('#stBack').value) || null;
  if (!front) return;
  if (back && back.id === front.id) { toast('前半と後半に同じコースが選ばれています'); return; }
  const tee = $('#stTee button.on')?.dataset.v || 'regular';
  const plan = { front, back, tee };
  const ph = planHoles(allHoles, plan);
  const pars = planPars(plan, ph, scorecard);
  $('#startDlg').close();
  if (startMode === 'edit' && roundActive()) {
    const r = state.current; r.plan = plan;
    r.holes.forEach((h, i) => { if (h.strokes == null) h.par = pars[i] || h.par; });
    save('round'); window.dispatchEvent(new Event('round-changed'));
    toast('ラウンドの内容を変更しました');
  } else {
    const players = $('#stPlayers').value.split(/[\s、,]+/).map((x) => x.trim()).filter(Boolean).slice(0, 7);
    const kept = beginRound({ plan, pars, players });
    // greeting at the first tee (spoken from the tap, so phones allow the sound)
    const hello = [`${state.course.name}、${front.short}からのスタートです。`, 'よろしくお願いいたします。'];
    speak(hello, { rate: Number(state.settings.voiceRate) || 1.05, onFail: () => { const k = browserKind(); if (k) showVoiceHelp(k); } });
    restartGPS();
    window.dispatchEvent(new Event('round-started'));
    toast(`プレー開始！ ${front.short}${back ? ' → ' + back.short : ''}${kept ? '（前のラウンドは履歴に保存しました）' : ''}`, 3500);
  }
  state.ui.holeKey = ph[0]?.key; save('ui');
  rebuild(); hv.resetView();
}
let endArmed = 0;
function endRound() {
  if (Date.now() - endArmed > 3500) {
    endArmed = Date.now(); $('#btnRoundEnd').textContent = 'もう一度押して終了';
    setTimeout(() => { const b = $('#btnRoundEnd'); if (b) b.textContent = '終了'; }, 3500);
    return;
  }
  const r = state.current;
  const learned = learnHoles(r.track, r.holeLog, holes);
  if (r.holes.some((h) => h.strokes) && !r.saved) $('#btnSaveRound').click();
  r.ended = true; save('round');
  rebuild();
  window.dispatchEvent(new CustomEvent('goto-tab', { detail: 'score' }));
  if (learned.length) offerLearned(learned);
}
let pendingLearn = null;
/** after the round: show what the walked track says about tee / green positions, and save only what the player ticks */
function offerLearned(list) {
  pendingLearn = { courseId: cid(), list };
  const name = (s0) => { const h = allHoles.find((x) => x.key === s0.key); const p = state.current?.plan; const nine = p?.[s0.roundIdx < 9 ? 'front' : 'back']; return `${nine ? nine.short + ' ' : ''}${(nine?.sc != null ? s0.roundIdx % 9 + 1 : h?.no) ?? s0.key}番`; };
  $('#learnList').innerHTML = list.map((s0, i) => `<label class="check"><input type="checkbox" data-l="${i}" checked> <span><b>${esc(name(s0))}</b>：ティー→グリーン 約${Math.round(m2y(s0.lengthM))}y${s0.moveGreen != null ? `（今のグリーン位置から${s0.moveGreen}m）` : '（未登録だったホール）'}</span></label>`).join('');
  $('#learnDlg').showModal();
}
function applyLearned() {
  const p = pendingLearn; $('#learnDlg').close(); pendingLearn = null;
  if (!p || p.courseId !== cid()) return;
  const u = userHoles(); let n = 0;
  p.list.forEach((s0, i) => {
    if (!$(`#learnList [data-l="${i}"]`)?.checked) return;
    u[s0.key] = { ...(u[s0.key] || {}), tee: s0.tee, green: s0.green, learned: true, updatedAt: Date.now() };
    submitHole(state.course, s0.key, u[s0.key]); n++;
  });
  if (n) { save('holes'); rebuild(); toast(`${n}ホールの位置を、歩いた記録から登録しました`); }
}
function renderRoundBar() {
  const bar = $('#roundBar'); if (!bar) return;
  if (!state.course) { bar.hidden = true; return; }
  bar.hidden = false;
  if (!roundActive()) {
    bar.className = 'round-bar idle';
    bar.innerHTML = `<button class="btn primary play-btn" id="btnPlay"><svg viewBox="0 0 24 24"><path d="M7 4v16l13-8Z"/></svg>プレー開始</button><button class="btn brief-btn" id="btnBrief"><svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>事前ブリーフィング</button><span class="muted">プレー前に練習と攻め方を音声で確認・当日は回るコースを選んでスタート</span>`;
    $('#btnPlay').onclick = () => openStartRound('new');
    $('#btnBrief').onclick = () => openBriefing(true);
    return;
  }
  const r = state.current, p = r.plan;
  const played = r.holes.filter((h) => h.strokes);
  const tot = played.reduce((a, h) => a + h.strokes, 0), toPar = tot - played.reduce((a, h) => a + h.par, 0);
  const n = p.back ? 18 : 9, at = (curHole()?.roundIdx ?? 0) + 1;
  bar.className = 'round-bar live';
  bar.innerHTML = `<span class="rb-dot" aria-hidden="true"></span><div class="rb-info"><b>プレー中</b> ${esc(p.front.short)}${p.back ? ' → ' + esc(p.back.short) : ''}${{ back: ' · バックティー', ladies: ' · レディースティー', front: ' · フロントティー' }[p.tee] || ''}<br><span>${at}/${n}ホール目${played.length ? ` · ${tot}（${toPar === 0 ? 'E' : toPar > 0 ? '+' + toPar : toPar}）` : ''}</span><br><span class="rb-gps ${Date.now() - lastFixAt < 15000 ? 'ok' : 'wait'}">${Date.now() - lastFixAt < 15000 ? 'GPS計測中' : 'GPSを探しています…'} · 歩いた距離 ${walkedKm().toFixed(1)}km</span></div><button class="btn small" id="btnRoundEdit">変更</button><button class="btn small" id="btnRoundEnd">終了</button>`;
  $('#btnRoundEdit').onclick = () => openStartRound('edit');
  $('#btnRoundEnd').onclick = endRound;
}

// ---------------- voice caddie ----------------
/** everything the caddie says, from the same numbers the screen shows */
function voiceInfo() {
  const h = curHole(); const c = holeCenter(h); const o = originFor(h, c);
  const base = { unit: unit(), holeNo: h && h.no <= 100 ? h.no : null, holeName: h?.nineName ? `${h.nineName}の${h.dispNo ?? h.no}番` : null, par: h && !h.parEst ? h.par : null };
  if (!h || !c || !o) return { ...base, center: NaN };
  const g = greenDist(o, h.green, h.center || c);
  const pin = cid() ? todayPins()[h.key] : null;
  const br = bearing(o, c), cond = conditions(br);
  const pl = playsLike(m2y(dist(o, c)), cond);
  const rc = recommendClub(state.clubs, pl.yards);
  const auto = $('#windMode').value === 'auto';
  // hazards around the green, seen from the player: in front / behind / left / right of the line to the green
  const toC = dist(o, c);
  const near = (strat?.hazards || []).filter((x) => x.nearGreen);
  const greenHazards = hazardDistancesFrom(o, near, c).map((x) => {
    const d = dist(o, x.hz.c), rel = ((bearing(o, x.hz.c) - br + 540) % 360 - 180) * Math.PI / 180;
    const lat = d * Math.sin(rel), along = d * Math.cos(rel) - toC;
    // direction from the green centre, by whichever offset is larger (as the player sees it)
    const where = Math.abs(along) >= Math.abs(lat) ? (along < 0 ? '手前' : '奥') : lat < 0 ? '左' : '右';
    return { type: x.type, where, front: x.front, carry: x.carry };
  });
  const st = gps.state || {};
  const slope = curSlope && ['high', 'mid'].includes(curSlope.conf?.level) ? { pct: curSlope.pct, dir: compass(curSlope.downBearing), level: curSlope.conf.level } : null;
  return {
    ...base, preview: o !== me, estimated: h.source === 'est',
    gpsPoor: o === me && (gps.isStale(Date.now()) || ['poor', 'wait'].includes(st.mode) || (meAcc ?? 0) > 15),
    center: g.center, front: g.front, back: g.back, pin: pin ? m2y(dist(o, pin)) : null,
    playsLike: pl.yards, club: rc?.club, alt: rc?.alt, layup: !!rc?.layup, leave: rc ? pl.yards - rc.club.carry : 0,
    windKnown: auto ? !!(wx && Number.isFinite(wx.speed)) : true, head: cond.head || 0, cross: auto ? crossComponent(wx, br) : 0, gust: auto ? wx?.gust : null,
    elevM: cond.elevM, greenHazards, slope,
  };
}
function voiceCaddie() {
  const btns = [$('#btnVoice'), $('#btnVoiceMap')];
  const setOn = (on) => btns.forEach((b) => b.classList.toggle('on', on));
  if (speaking()) { stopSpeaking(); setOn(false); return; }
  const lines = caddieScript(voiceInfo());
  const box = $('#voiceText'); box.hidden = false; box.textContent = lines.join('');
  const kind = browserKind();
  const fail = () => { setOn(false); showVoiceHelp(kind); };
  if (kind && !canSpeak()) { fail(); return; }
  setOn(true);
  speak(lines, { rate: Number(state.settings.voiceRate) || 1.05, onEnd: () => setOn(false), onFail: fail });
}
function showVoiceHelp(kind) {
  const help = $('#voiceHelp'); help.hidden = false;
  const url = externalBrowserUrl(kind, location.href);
  help.innerHTML = `<p>${esc(speechHelp(kind))}</p>${url ? `<a class="btn primary small" href="${esc(url)}">ブラウザで開く</a>` : ''}<button class="btn small" id="voiceHelpClose">閉じる</button>`;
  $('#voiceHelpClose').onclick = () => (help.hidden = true);
}

// ---------------- unmapped holes: nearby greens + mapping ----------------
let mapping = false;
function renderMappingCard(h) {
  const card = $('#mapCard');
  // the guide shows while the hole's green is unknown, and (during a round) until its tee is known too
  const need = state.course && h && h.no <= 100 && (!h.center || (roundActive() && !h.tee && h.source !== 'osm'));
  card.hidden = !need && !mapping;
  if (card.hidden) return;
  const known = holes.filter((x) => x.center).length;
  $('#emHole').textContent = `${h.nineName ? h.nineName + ' ' : ''}${h.dispNo ?? h.no}番`;
  $('#emProgress').textContent = `登録済み ${known}/${holes.length}`;
  $('#emTeeStep').className = h.tee ? 'done' : 'todo';
  $('#emGreenStep').className = h.center ? 'done' : 'todo';
  $('#emTee').textContent = h.tee ? '✓ ティー登録済み（押すと今の場所に直す）' : '📍 ここがティー';
  $('#emGreen').textContent = h.center ? '✓ グリーン登録済み（押すと今の場所に直す）' : '📍 ここがグリーン';
  const chips = !h.center && me && features ? greensNear(features, me, 4).filter((x) => x.d < 600) : [];
  $('#greenChips').innerHTML = chips.length
    ? '<span class="muted">地図にあるグリーン:</span>' + chips.map((x) => `<button class="btn small" data-g="${x.g.id}">${fmt(m2y(x.d))}${ul()} 先</button>`).join('')
    : '';
}
/** save a tee / green position for the current hole (from GPS), share it when the hole is complete */
function setHolePoint(kind, p, how) {
  const h = curHole(); if (!h || !cid() || !p) return;
  const u = userHoles(); const prev = u[h.key] ? { ...u[h.key] } : null;
  // a green tapped near a mapped green snaps to that green's centre
  let pt = { lat: p.lat, lon: p.lon };
  if (kind === 'green' && features?.greens) { const g = greensNear(features, pt, 1)[0]; if (g && g.d < 25) pt = { ...g.g.c }; }
  u[h.key] = { ...(u[h.key] || {}), [kind]: pt, learned: how === 'auto', updatedAt: Date.now() };
  save('holes');
  if (u[h.key].tee && u[h.key].green) submitHole(state.course, h.key, u[h.key]);
  lastEasy = { key: h.key, prev, kind, how };
  rebuild();
  const name = `${h.nineName ? h.nineName + ' ' : ''}${h.dispNo ?? h.no}番`;
  const box = $('#emAuto');
  box.hidden = false;
  box.innerHTML = `<span>${how === 'auto' ? '自動で' : ''}${esc(name)}の${kind === 'tee' ? 'ティー' : 'グリーン'}を登録しました</span> <button class="btn small" id="emUndo">取り消す</button>`;
  $('#emUndo').onclick = undoEasy;
  if (how === 'auto' && state.settings.voiceRate !== 'off') speak([`${name}のグリーンを登録しました。`], { rate: Number(state.settings.voiceRate) || 1.05 });
  toast(`${name}の${kind === 'tee' ? 'ティー' : 'グリーン'}を登録しました`);
}
let lastEasy = null;
function undoEasy() {
  const e = lastEasy; if (!e) return;
  const u = userHoles();
  if (e.prev) u[e.key] = e.prev; else delete u[e.key];
  save('holes'); lastEasy = null; $('#emAuto').hidden = true; rebuild(); toast('登録を取り消しました');
}
// during a round: the green registers itself when the player stands on a mapped green; the round moves on after the
// score is in and the player walks off the green
let greenDwell = null, advancedFrom = null;
function easyOnFix(acc) {
  if (!roundActive() || !me) return;
  const h = curHole(); if (!h) return;
  if (!h.center && features?.greens?.length) {
    const r = dwellOnGreen(greenDwell, me, Date.now(), features.greens, { acc });
    greenDwell = r.st;
    if (r.green) { greenDwell = null; setHolePoint('green', r.green.c, 'auto'); return; }
  }
  const sh = scoreHole();
  if ($('#autoHole').checked && advancedFrom !== h.key && shouldAdvance({ strokes: sh?.sh?.strokes, green: h.center, me, hasNext: holeIdx + 1 < holes.length })) {
    advancedFrom = h.key;
    gotoHole(holeIdx + 1, true);
    toast(`次のホール（${curHole().dispNo ?? curHole().no}番）に進みました`);
  }
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
  if (u[h.key].tee && u[h.key].green) submitHole(state.course, h.key, u[h.key]);
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
  if (!h || !cid() || h.source === 'osm' || h.source === 'community' || h.source === 'est') return;
  const u = userHoles(); const cur = u[h.key] || {};
  if (cur.learned === false) return; // user-mapped: don't overwrite
  const shotsHere = (state.shots || []).filter((s) => s.courseId === cid() && s.hole === h.no && s.date?.slice(0, 10) === new Date().toISOString().slice(0, 10));
  let changed = false;
  if (club !== 'パター' && !cur.tee && !shotsHere.length) { cur.tee = { ...me }; changed = true; }
  if (club === 'パター' && !cur.green) { cur.green = { ...me }; changed = true; }
  if (changed) { u[h.key] = { ...cur, learned: true, updatedAt: Date.now() }; save('holes'); if (u[h.key].tee && u[h.key].green) submitHole(state.course, h.key, u[h.key]); rebuild(); toast(`${h.no}番の${club === 'パター' ? 'グリーン' : 'ティー'}位置を覚えました`); }
}
function endShot(manual) {
  const ps = state.pendingShot;
  if (!ps) { if (manual) toast('先に「ここから打つ」を押してください'); return; }
  if (!me) return;
  const yards = m2y(dist(ps.from, me));
  state.pendingShot = null;
  if (yards < 3) { save('shot'); return; }
  state.shots ??= [];
  state.shots.push({ ...ps, to: { ...me }, yards: Math.round(yards), accTo: meAcc, kind: 'total' }); // GPS measures carry + roll
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
  if (needAI('AI攻略')) return;
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
  const i = h.roundIdx ?? n - 1; // planned round: the scorecard column in playing order
  return { n, sh: state.current.holes[i], par: h.parEst ? null : h.par };
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

/** "左グリーン" / "右グリーン" as seen from the fairway, for 2-green holes */
function greenSideLabel(h, i) {
  const opts = h?.greenOptions; if (!opts || opts.length < 2) return 'グリーン';
  const from = h.tee || (h.line?.length ? h.line[0] : null);
  const a = opts[0].c, b = opts[1].c;
  if (!from) return i === 0 ? 'グリーン1' : 'グリーン2';
  // cross product of (from→mid) × (mid→green_i): + means left
  const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
  const vx = mid.lon - from.lon, vy = mid.lat - from.lat;
  const g = opts[i].c, wx = g.lon - mid.lon, wy = g.lat - mid.lat;
  return vx * wy - vy * wx > 0 ? '左グリーン' : '右グリーン';
}

// ---------------- renumber estimated / registered holes ----------------
function openRenumber() {
  const h = curHole(); if (!h) return;
  const nCourses = Math.max(scorecard?.courses?.length || 0, ...allHoles.map((x) => (x.set || 0) + 1), 1);
  const setCount = Math.max(nCourses, scorecard ? scorecard.courses.length : 3);
  $('#rnSet').innerHTML = Array.from({ length: setCount }, (_, i) => `<option value="${i}">${esc(courseName(i))}</option>`).join('');
  $('#rnSet').value = String(h.set || 0);
  const fillNo = () => {
    const n = scorecard?.courses?.[Number($('#rnSet').value)]?.holes?.length || 18;
    $('#rnNo').innerHTML = Array.from({ length: n }, (_, i) => { const sc = scorecard?.courses?.[Number($('#rnSet').value)]?.holes?.[i]; return `<option value="${i + 1}">${i + 1}番${sc ? `（PAR${sc.par} ${sc.yd}y）` : ''}</option>`; }).join('');
    $('#rnNo').value = String(Math.min(h.no, n));
  };
  $('#rnSet').onchange = fillNo; fillNo();
  $('#renumberPanel').hidden = false;
  $('#renumberPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function applyRenumber() {
  const h = curHole(); if (!h) return;
  const set = Number($('#rnSet').value), n = Number($('#rnNo').value);
  const newKey = set ? `${n}-${set + 1}` : String(n);
  const u = userHoles();
  const mine = { tee: h.tee, green: h.center, mid: h.line?.length > 2 ? h.line[1] : null, par: scorecard?.courses?.[set]?.holes?.[n - 1]?.par || h.par || null, learned: false, updatedAt: Date.now() };
  if (newKey !== h.key) {
    // swap: whatever was at the new number moves to this hole's old number
    const displaced = allHoles.find((x) => x.key === newKey && x.center);
    u[h.key] = displaced ? { tee: displaced.tee, green: displaced.center, mid: displaced.line?.length > 2 ? displaced.line[1] : null, par: null, learned: false, updatedAt: Date.now() } : { hidden: true, updatedAt: Date.now() };
  }
  u[newKey] = mine;
  save('holes');
  if (mine.tee && mine.green) submitHole(state.course, newKey, mine);
  $('#renumberPanel').hidden = true;
  setSet(set); state.ui.holeKey = newKey;
  rebuild();
  toast(`${courseName(set)} ${n}番にしました`);
}
function hideHole() {
  const h = curHole(); if (!h) return;
  userHoles()[h.key] = { hidden: true, updatedAt: Date.now() }; save('holes');
  $('#renumberPanel').hidden = true; rebuild(); toast('このホールを隠しました');
}
