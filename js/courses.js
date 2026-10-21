// Nationwide course search over the bundled dataset (instant, offline), plus Rakuten GORA.
import { $, esc, toast, dist, PREFS } from './util.js';
import { state, save } from './store.js';
import { bundledCourses, bundleInfo, searchCourses, coursesNear } from './osm.js';
import { searchCourses as goraSearch, hasGora } from './gora.js';

let lastList = [];
let shown = 60;
let myPos = null;
let onPick = null;

export function initCourses(onSelect) {
  onPick = onSelect;
  $('#prefSel').innerHTML = '<option value="">全国</option>' + PREFS.map((p) => `<option>${p}</option>`).join('');
  $('#bkPref').innerHTML = PREFS.map((p, i) => `<option value="${i + 1}">${p}</option>`).join('');
  $('#prefSel').value = state.ui.prefName ?? '';
  $('#bkPref').value = state.ui.pref || 13;
  $('#courseSort').value = state.ui.courseSort || 'near';
  let timer;
  const rerun = () => { clearTimeout(timer); timer = setTimeout(run, 120); };
  $('#courseKw').addEventListener('input', rerun);
  for (const id of ['prefSel', 'courseSort', 'fltHoles', 'fltFav', 'fltRecent']) $('#' + id).addEventListener('change', () => {
    state.ui.prefName = $('#prefSel').value; state.ui.courseSort = $('#courseSort').value;
    const pi = PREFS.indexOf($('#prefSel').value); if (pi >= 0) { state.ui.pref = pi + 1; $('#bkPref').value = pi + 1; }
    save('ui'); run();
  });
  $('#btnSearchNear').onclick = () => locate(true);
  $('#btnSearchGora').onclick = gora;
  $('#btnMoreCourses').onclick = () => { shown += 60; render(); };
  $('#courseList').addEventListener('click', onClick);
  bundledCourses().then((all) => {
    const info = bundleInfo();
    $('#courseCount').textContent = all.length
      ? `全国 ${all.length.toLocaleString()} コース収録（うちホール配置データあり ${info?.withHoles ?? '-'}）· データ ${info?.generatedAt || ''}`
      : '全国データを読み込めませんでした（通信を確認してください）';
    run();
  });
  locate(false);
}

function locate(explicit) {
  if (!navigator.geolocation) { if (explicit) toast('GPSが使えません'); return; }
  if (explicit) $('#courseMeta').textContent = '現在地を取得中…';
  navigator.geolocation.getCurrentPosition((p) => {
    myPos = { lat: p.coords.latitude, lon: p.coords.longitude };
    if (explicit) { $('#prefSel').value = ''; $('#courseKw').value = ''; $('#courseSort').value = 'near'; }
    run();
  }, () => { if (explicit) $('#courseMeta').textContent = '位置情報を取得できませんでした'; }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
}

async function run() {
  const kw = $('#courseKw').value.trim();
  const pref = $('#prefSel').value;
  let list = await searchCourses(kw, { pref: pref || undefined });
  if (!kw && !pref && myPos) list = await coursesNear(myPos.lat, myPos.lon, 60);
  if ($('#fltHoles').checked) list = list.filter((c) => c.holesMapped > 0);
  if ($('#fltFav').checked) list = list.filter((c) => state.favorites?.[c.id]);
  if ($('#fltRecent').checked) { const rec = recentIds(); list = list.filter((c) => rec.has(c.id)); }
  const sort = $('#courseSort').value;
  for (const c of list) c._d = myPos ? dist(myPos, c) / 1000 : null;
  list = list.slice().sort((a, b) =>
    sort === 'name' ? a.name.localeCompare(b.name, 'ja')
      : sort === 'data' ? (b.holesMapped || 0) - (a.holesMapped || 0) || (a._d ?? 0) - (b._d ?? 0)
        : (a._d ?? 0) - (b._d ?? 0) || a.name.localeCompare(b.name, 'ja'));
  // keep the selected course on top when nothing is typed
  if (!kw && state.course && !pref) { const i = list.findIndex((c) => c.id === state.course.id); if (i > 0) list.unshift(list.splice(i, 1)[0]); }
  lastList = list; shown = 60;
  $('#courseMeta').textContent = list.length ? `${list.length.toLocaleString()} 件${!kw && !pref && myPos ? '（現在地から60km以内）' : ''}` : '見つかりませんでした。別の書き方（ひらがな・略称）でもお試しください';
  render();
}
function recentIds() { return new Set((state.rounds || []).map((r) => r.courseId).filter(Boolean)); }

function badge(c) {
  if (c.holesMapped >= 9) return `<span class="pill good">ホールデータ ${c.holesMapped}H</span>`;
  if (c.holesMapped) return `<span class="pill">一部ホール ${c.holesMapped}H</span>`;
  if (c.greensMapped) return `<span class="pill">グリーン ${c.greensMapped}</span>`;
  const mine = Object.keys(state.userHoles?.[c.id] || {}).length;
  if (mine) return `<span class="pill good">登録済み ${mine}H</span>`;
  return '<span class="pill muted-pill">位置のみ</span>';
}

function render() {
  const list = lastList.slice(0, shown);
  $('#courseList').innerHTML = list.map((c, i) => `
    <article class="course-item ${state.course?.id === c.id ? 'current' : ''}">
      <div class="ci-main">
        <h3>${esc(c.name)}</h3>
        <div class="meta">
          ${c.pref ? `<span>${esc(c.pref)}</span>` : c.address ? `<span>${esc(c.address)}</span>` : ''}
          ${c._d != null ? `<span>${c._d < 10 ? c._d.toFixed(1) : Math.round(c._d)}km</span>` : ''}
          ${c.holes ? `<span>${c.holes}H</span>` : ''}
          ${c.ic ? `<span>${esc(c.ic)} IC ${esc(c.icDistance ?? '')}km</span>` : ''}
          ${c.evaluation ? `<span>評価 ${esc(c.evaluation)}</span>` : ''}
        </div>
      </div>
      <button class="fav ${state.favorites?.[c.id] ? 'on' : ''}" data-fav="${i}" aria-label="お気に入り">★</button>
      <div class="ci-badges">${badge(c)}${c.private ? '<span class="pill">会員制</span>' : ''}</div>
      <div class="actions">
        <button class="btn small primary" data-pick="${i}">${state.course?.id === c.id ? 'プレー中' : 'このコースでプレー'}</button>
        <button class="btn small" data-book="${i}">攻略ブック</button>
        ${c.reserveUrl ? `<a class="btn small" href="${esc(c.reserveUrl)}" target="_blank" rel="noopener">予約</a>` : `<a class="btn small" href="https://www.google.com/search?q=${encodeURIComponent(c.name + " 予約 楽天GORA")}" target="_blank" rel="noopener">予約を探す</a>`}
        ${c.website ? `<a class="btn small" href="${esc(c.website)}" target="_blank" rel="noopener">公式</a>` : ''}
        <a class="btn small" href="https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lon}" target="_blank" rel="noopener">ルート</a>
      </div>
    </article>`).join('');
  $('#btnMoreCourses').hidden = lastList.length <= shown;
}

function choose(c) {
  state.course = { id: c.id, name: c.name, lat: c.lat, lon: c.lon, bounds: c.bounds || null, source: c.source, goraId: c.goraId || null, reserveUrl: c.reserveUrl || null, pref: c.pref || '' };
  state.ui.holeKey = '1';
  save('course');
}

function onClick(e) {
  const b = e.target.closest('button'); if (!b) return;
  const i = Number(b.dataset.pick ?? b.dataset.book ?? b.dataset.fav);
  const c = lastList[i]; if (!c) return;
  if (b.dataset.fav != null) {
    state.favorites ??= {};
    if (state.favorites[c.id]) delete state.favorites[c.id]; else state.favorites[c.id] = { name: c.name, at: Date.now() };
    save('fav'); b.classList.toggle('on'); return;
  }
  choose(c);
  onPick?.(state.course, b.dataset.book != null ? 'book' : 'navi');
}

async function gora() {
  if (!hasGora()) { toast('設定で楽天GORAのアプリIDとアクセスキーを入れてください', 3500); return; }
  const kw = $('#courseKw').value.trim();
  const pref = $('#prefSel').value;
  $('#courseMeta').textContent = '楽天GORAを検索中…';
  try {
    const { list } = await goraSearch(kw ? { keyword: kw } : { areaCode: PREFS.indexOf(pref) + 1 || state.ui.pref || 13 });
    for (const c of list) c._d = myPos ? dist(myPos, c) / 1000 : null;
    lastList = list; shown = 60;
    $('#courseMeta').textContent = `楽天GORA ${list.length} 件`;
    render();
  } catch (e) { $('#courseMeta').textContent = e.message; }
}
