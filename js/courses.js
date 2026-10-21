// Nationwide course search: OpenStreetMap (free) + Rakuten GORA (prices, ratings).
import { $, esc, toast, dist, PREFS } from './util.js';
import { state, save } from './store.js';
import { coursesInPref, coursesNear } from './osm.js';
import { searchCourses, hasGora } from './gora.js';

let lastList = [];
let myPos = null;

export function initCourses(onSelect) {
  const opts = PREFS.map((p, i) => `<option value="${i + 1}">${p}</option>`).join('');
  $('#prefSel').innerHTML = opts;
  $('#bkPref').innerHTML = opts;
  const savedPref = state.ui.pref || 13;
  $('#prefSel').value = savedPref; $('#bkPref').value = savedPref;
  $('#prefSel').onchange = () => { state.ui.pref = Number($('#prefSel').value); $('#bkPref').value = state.ui.pref; save('ui'); };

  $('#btnSearchPref').onclick = async () => {
    const pref = PREFS[$('#prefSel').value - 1];
    await run(`${pref}のゴルフ場を検索中…`, async () => {
      const list = await coursesInPref(pref);
      return filterKw(list);
    });
  };
  $('#btnSearchNear').onclick = () => {
    if (!navigator.geolocation) return toast('GPSが使えません');
    $('#courseMeta').textContent = '現在地を取得中…';
    navigator.geolocation.getCurrentPosition(async (pos) => {
      myPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      await run('近くのゴルフ場を検索中…', async () => filterKw(await coursesNear(myPos.lat, myPos.lon, 30)));
    }, () => { $('#courseMeta').textContent = '位置情報が取得できませんでした'; }, { enableHighAccuracy: false, timeout: 15000 });
  };
  $('#btnSearchGora').onclick = async () => {
    if (!hasGora()) { toast('設定で楽天GORAのアプリIDとアクセスキーを入れてください', 3500); return; }
    const kw = $('#courseKw').value.trim();
    await run('楽天GORAを検索中…', async () => (await searchCourses(kw ? { keyword: kw } : { areaCode: $('#prefSel').value })).list);
  };
  $('#courseKw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnSearchPref').click(); });

  $('#courseList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    const c = lastList[Number(b.dataset.pick)];
    state.course = { id: c.id, name: c.name, lat: c.lat, lon: c.lon, bounds: c.bounds || null, source: c.source, goraId: c.goraId || null, reserveUrl: c.reserveUrl || null };
    state.ui.holeKey = '1';
    save('course');
    onSelect(state.course);
  });

  // show the selected/favourite course on first open
  if (state.course) { lastList = [state.course]; renderList(); }
}

function filterKw(list) {
  const kw = $('#courseKw').value.trim();
  if (!kw) return list;
  const k = kw.toLowerCase();
  return list.filter((c) => (c.name + c.kana + c.address).toLowerCase().includes(k));
}

async function run(msg, fn) {
  $('#courseMeta').textContent = msg;
  $('#courseList').innerHTML = '';
  try {
    const list = await fn();
    if (myPos) list.forEach((c) => (c._d = dist(myPos, c) / 1000));
    list.sort((a, b) => (a._d ?? 0) - (b._d ?? 0) || a.name.localeCompare(b.name, 'ja'));
    lastList = list;
    $('#courseMeta').textContent = `${list.length}件見つかりました`;
    renderList();
  } catch (e) {
    $('#courseMeta').textContent = e.message;
  }
}

function renderList() {
  $('#courseList').innerHTML = lastList.map((c, i) => `
    <article class="course-item ${state.course?.id === c.id ? 'current' : ''}">
      <h3>${esc(c.name)}</h3>
      ${c.evaluation ? `<span class="pill">評価 ${esc(c.evaluation)}</span>` : '<span></span>'}
      <div class="meta">
        ${c.address ? `<span>${esc(c.address)}</span>` : ''}
        ${c._d != null ? `<span>${c._d.toFixed(1)}km</span>` : ''}
        ${c.holes ? `<span>${c.holes}H</span>` : ''}
        ${c.ic ? `<span>${esc(c.ic)} IC ${esc(c.icDistance ?? '')}km</span>` : ''}
        <span>${c.source === 'gora' ? '楽天GORA' : 'OSM'}</span>
      </div>
      <div class="actions">
        <button class="btn small primary" data-pick="${i}">${state.course?.id === c.id ? '選択中' : 'このコースでプレー'}</button>
        ${c.reserveUrl ? `<a class="btn small" href="${esc(c.reserveUrl)}" target="_blank" rel="noopener">予約</a>` : ''}
        ${c.website ? `<a class="btn small" href="${esc(c.website)}" target="_blank" rel="noopener">公式サイト</a>` : ''}
        <a class="btn small" href="https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lon}" target="_blank" rel="noopener">ルート</a>
      </div>
    </article>`).join('');
}
