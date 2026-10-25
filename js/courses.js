// Nationwide course search over the bundled dataset (instant, offline), plus Rakuten GORA.
import { $, esc, toast, dist, PREFS } from './util.js';
import { state, save } from './store.js';
import { bundledCourses, bundleInfo, searchCourses, coursesNear } from './osm.js';
import { searchCourses as goraSearch, hasGora, goraFor } from './gora.js';
import { driveEstimate, fmtMinutes, geocode } from './travel.js';
import { aerialTiles, wikiInfo } from './coursephotos.js';

const origins = () => (state.settings.origins ??= []);
/** "自宅 52km・車で約1時間" for each saved starting point */
function travelText(c) {
  return origins().map((o) => { const km = dist(o, c) / 1000; const e = driveEstimate(km); return `${o.name}から${Math.round(e.roadKm)}km・車で${fmtMinutes(e.min)}`; });
}

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
  for (const id of ['prefSel', 'courseSort', 'fltHoles', 'fltFav', 'fltRecent', 'fltOp']) $('#' + id).addEventListener('change', () => {
    state.ui.prefName = $('#prefSel').value; state.ui.courseSort = $('#courseSort').value;
    const pi = PREFS.indexOf($('#prefSel').value); if (pi >= 0) { state.ui.pref = pi + 1; $('#bkPref').value = pi + 1; }
    save('ui'); run();
  });
  $('#btnSearchNear').onclick = () => locate(true);
  $('#btnSearchGora').onclick = gora;
  $('#btnMoreCourses').onclick = () => { shown += 60; render(); };
  $('#courseList').addEventListener('click', onClick);
  initOrigins();
  fetch('data/community/_index.json').then((r) => (r.ok ? r.json() : {})).then((j) => { commIdx = j || {}; render(); }).catch(() => {});
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
  if ($('#fltHoles').checked) list = list.filter((c) => c.holesMapped > 0 || c.greensMapped > 0 || commIdx[c.id]);
  if ($('#fltFav').checked) list = list.filter((c) => state.favorites?.[c.id]);
  const op = $('#fltOp').value; if (op) list = list.filter((c) => (c.operator || '').includes(op));
  if ($('#fltRecent').checked) { const rec = recentIds(); list = list.filter((c) => rec.has(c.id)); }
  const sort = $('#courseSort').value;
  for (const c of list) c._d = myPos ? dist(myPos, c) / 1000 : null;
  const home = origins()[0];
  for (const c of list) c._h = home ? dist(home, c) / 1000 : null;
  list = list.slice().sort((a, b) =>
    sort === 'home' && home ? a._h - b._h
      : sort === 'name' ? a.name.localeCompare(b.name, 'ja')
      : sort === 'data' ? (b.holesMapped || 0) - (a.holesMapped || 0) || (a._d ?? 0) - (b._d ?? 0)
        : (a._d ?? 0) - (b._d ?? 0) || a.name.localeCompare(b.name, 'ja'));
  // keep the selected course on top when nothing is typed
  if (!kw && state.course && !pref) { const i = list.findIndex((c) => c.id === state.course.id); if (i > 0) list.unshift(list.splice(i, 1)[0]); }
  lastList = list; shown = 60;
  $('#courseMeta').textContent = list.length ? `${list.length.toLocaleString()} 件${!kw && !pref && myPos ? '（現在地から60km以内）' : ''}` : '見つかりませんでした。別の書き方（ひらがな・略称）でもお試しください';
  render();
}
function recentIds() { return new Set((state.rounds || []).map((r) => r.courseId).filter(Boolean)); }

let commIdx = {};
function badge(c) {
  const comm = commIdx[c.id];
  if (comm && !(c.holesMapped >= 9)) return `<span class="pill good">みんなの地図 ${comm}H</span>`;
  if (!(c.holesMapped >= 9) && c.greensMapped >= 9) return `<span class="pill">グリーン位置あり（ホール番号は未登録）</span>`;
  if (c.holesMapped >= 9) return `<span class="pill good">ホールデータ ${c.holesMapped}H</span>`;
  if (c.approx) return '<span class="pill muted-pill">位置は市町村の目安</span>';
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
          ${c.address || c.pref ? `<span>${esc(c.address || c.pref)}</span>` : ''}${c.operator ? `<span>${esc(c.operator)}</span>` : ''}
          ${c._d != null ? `<span>${c._d < 10 ? c._d.toFixed(1) : Math.round(c._d)}km</span>` : ''}
          ${c.holes ? `<span>${c.holes}H</span>` : ''}
          ${travelText(c).map((t) => `<span class="travel">${esc(t)}（目安）</span>`).join('')}
          ${c.ic ? `<span>${esc(c.ic)} IC ${esc(c.icDistance ?? '')}km</span>` : ''}
          ${c.evaluation ? `<span>評価 ${esc(c.evaluation)}</span>` : ''}
        </div>
      </div>
      <button class="fav ${state.favorites?.[c.id] ? 'on' : ''}" data-fav="${i}" aria-label="お気に入り">★</button>
      <div class="ci-badges">${badge(c)}${c.private ? '<span class="pill">会員制</span>' : ''}</div>
      <div class="actions">
        <button class="btn small primary" data-pick="${i}">${state.course?.id === c.id ? 'プレー中' : 'このコースでプレー'}</button>
        <button class="btn small" data-book="${i}">攻略ブック</button>
        <button class="btn small" data-info="${i}">写真・紹介</button>
        ${c.reserveUrl ? `<a class="btn small" href="${esc(c.reserveUrl)}" target="_blank" rel="noopener">予約</a>` : `<a class="btn small" href="https://www.google.com/search?q=${encodeURIComponent(c.name + " 予約 楽天GORA")}" target="_blank" rel="noopener">予約を探す</a>`}
        ${c.website ? `<a class="btn small" href="${esc(c.website)}" target="_blank" rel="noopener">公式</a>` : ''}
        <a class="btn small" href="https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lon}" target="_blank" rel="noopener">ルート</a>
      </div>
      <div class="ci-info" id="ciInfo${i}" hidden></div>
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
  const i = Number(b.dataset.pick ?? b.dataset.book ?? b.dataset.fav ?? b.dataset.info);
  const c = lastList[i]; if (!c) return;
  if (b.dataset.info != null) { showInfo(c, i); return; }
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

// ---------------- photos & introduction ----------------
async function showInfo(c, i) {
  const box = $('#ciInfo' + i);
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  const a = aerialTiles(c);
  box.innerHTML = `<div class="ci-aerial" aria-label="コース全体の航空写真">${a.tiles.map((u) => `<img src="${u}" alt="" loading="lazy">`).join('')}</div>
    <p class="muted credit">航空写真：国土地理院（シームレス空中写真）</p><div class="ci-gora"></div><div class="ci-wiki muted">紹介を探しています…</div>`;
  showGora(c, box.querySelector('.ci-gora'));
  const w = await wikiInfo(c.name);
  const el = box.querySelector('.ci-wiki');
  if (!w) { el.textContent = 'このゴルフ場のWikipediaの記事は見つかりませんでした。'; return; }
  el.classList.remove('muted');
  el.innerHTML = `${w.thumb ? `<img class="ci-photo" src="${esc(w.thumb)}" alt="${esc(w.title)}" loading="lazy"><p class="muted credit">写真：${w.file ? `<a class="link" href="${esc(w.file)}" target="_blank" rel="noopener">Wikimedia Commons</a>` : 'Wikimedia Commons'}</p>` : ''}
    ${w.extract ? `<p>${esc(w.extract)}</p>` : ''}<p class="muted credit">出典：<a class="link" href="${esc(w.url)}" target="_blank" rel="noopener">Wikipedia「${esc(w.title)}」</a>（CC BY-SA）</p>`;
}

// ---------------- starting points ----------------
function initOrigins() {
  const st = $('#orgStatus');
  const renderList = () => {
    $('#originList').innerHTML = origins().length ? origins().map((o, k) => `<div class="origin"><b>${esc(o.name)}</b><span class="muted">${esc(o.label || '')}</span><button class="btn small" data-odel="${k}">削除</button></div>`).join('') : '<p class="muted">まだ登録されていません。</p>';
  };
  const add = (o) => {
    if (origins().length >= 3) { st.textContent = '登録できるのは3つまでです。どれかを削除してください。'; return; }
    origins().push(o); save('settings'); renderList(); run(); st.textContent = `「${o.name}」を登録しました。コース一覧に移動時間の目安が出ます。`;
    $('#orgName').value = ''; $('#orgAddr').value = '';
  };
  const name = () => $('#orgName').value.trim() || ['自宅', '出発地2', '出発地3'][origins().length] || '出発地';
  $('#btnOrgAdd').onclick = async () => {
    const q = $('#orgAddr').value.trim(); if (!q) { st.textContent = '住所を入れてください（市区町村まででもOK）'; return; }
    st.textContent = '住所を探しています…';
    try { const g = await geocode(q); add({ name: name(), lat: g.lat, lon: g.lon, label: g.label }); } catch (e) { st.textContent = e.message; }
  };
  $('#btnOrgHere').onclick = () => {
    if (!navigator.geolocation) { st.textContent = 'この端末では現在地を取得できません'; return; }
    st.textContent = '現在地を取得中…';
    navigator.geolocation.getCurrentPosition((p) => add({ name: name(), lat: p.coords.latitude, lon: p.coords.longitude, label: '現在地で登録' }), () => (st.textContent = '現在地を取得できませんでした'), { timeout: 15000 });
  };
  $('#originList').onclick = (e) => { const b = e.target.closest('[data-odel]'); if (!b) return; origins().splice(Number(b.dataset.odel), 1); save('settings'); renderList(); run(); };
  renderList();
}

/** 楽天GORA (official API, with the player's own app ID): photos and basic facts */
async function showGora(c, el) {
  if (!hasGora()) { el.innerHTML = '<p class="muted credit">設定で楽天のアプリIDを入れると、楽天GORAのコース写真と情報も表示します。</p>'; return; }
  el.innerHTML = '<p class="muted">楽天GORAで探しています…</p>';
  try {
    const g = await goraFor(c);
    if (!g) { el.innerHTML = '<p class="muted credit">楽天GORAに同じゴルフ場が見つかりませんでした。</p>'; return; }
    el.innerHTML = `${g.images.length ? `<div class="ci-gora-imgs">${g.images.map((u) => `<img src="${esc(u)}" alt="" loading="lazy">`).join('')}</div>` : ''}
      ${g.facts.length ? `<p><b>${esc(g.facts.join(' · '))}</b></p>` : ''}${g.caption ? `<p>${esc(g.caption)}</p>` : ''}
      <p class="muted credit">写真・情報：<a class="link" href="${esc(g.url)}" target="_blank" rel="noopener">楽天GORA「${esc(g.name)}」</a> · Supported by Rakuten Developers</p>`;
  } catch (e) { el.innerHTML = `<p class="muted credit">${esc(e.message)}</p>`; }
}
