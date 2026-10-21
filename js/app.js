import { $, $$, esc, toast, copyText, shareOrDownload } from './util.js';
import { state, save, exportBundle, importBundle, DEFAULT_CLUBS } from './store.js';
import { initNavi, onNaviShown, loadCourse, refreshNavi, fillShotClubs, applyImagery } from './navi.js';
import { openBook } from './coursebook.js';
import { initSwing } from './swing.js';
import { initCourses } from './courses.js';
import { initScore, syncCourse } from './score.js';
import { initTracer } from './tracer.js';
import { initBooking } from './booking.js';
import { initAnalysis, renderAnalysis, restoreCoach } from './analysis.js';
import { initWeather, loadForecast } from './weather.js';
import { initGroup, onGroupShown, shareCourseIntel } from './group.js';

const TABS = ['navi', 'score', 'video', 'weather', 'group', 'menu', 'course', 'booking', 'analysis', 'settings', 'book'];
const PARENT = { course: 'menu', booking: 'menu', analysis: 'menu', settings: 'menu', book: 'navi' };

function goto(tab) {
  if (!TABS.includes(tab)) tab = 'navi';
  $$('.tab').forEach((s) => s.classList.toggle('active', s.dataset.tab === tab));
  $$('#tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.goto === (PARENT[tab] || tab)));
  state.ui.tab = tab; save('ui');
  window.scrollTo({ top: 0 });
  if (tab === 'navi') { onNaviShown(); wake(true); } else wake(false);
  if (tab === 'analysis') renderAnalysis();
  if (tab === 'weather') loadForecast(false);
  if (tab === 'group') onGroupShown();
  if (tab === 'book') openBook();
}

function courseChip() {
  $('#courseChip').textContent = state.course ? state.course.name : 'コースを選ぶ';
}

// ---------------- settings ----------------
function initSettings() {
  const s = state.settings;
  const bind = (id, key, num) => {
    const el = $('#' + id);
    el.value = s[key] ?? '';
    el.addEventListener('change', () => { s[key] = num ? Number(el.value) : el.value.trim(); save('settings'); refreshNavi(); });
  };
  bind('setUnit', 'unit'); bind('setName', 'name'); bind('setClaudeKey', 'claudeKey'); bind('setModel', 'model');
  bind('setImagery', 'imagery');
  $('#setImagery').value = s.imagery || 'gsi';
  $('#setImagery').addEventListener('change', applyImagery);
  bind('setRakutenId', 'rakutenId'); bind('setRakutenKey', 'rakutenKey'); bind('setRakutenAff', 'rakutenAff');
  $('#setSun').checked = !!s.sun;
  $('#setSun').onchange = () => setSun($('#setSun').checked);
  $('#setWake').checked = s.wake !== false;
  $('#setWake').onchange = () => { s.wake = $('#setWake').checked; save('settings'); wake(state.ui.tab === 'navi'); };
  $('#btnSun').onclick = () => setSun(!state.settings.sun);
  renderClubs();
  $('#btnAddClub').onclick = () => { state.clubs.push({ name: '新しいクラブ', carry: 100 }); save('clubs'); renderClubs(); };
  $('#clubEdit').addEventListener('change', (e) => {
    const i = Number(e.target.dataset.i), f = e.target.dataset.f;
    if (Number.isNaN(i)) return;
    state.clubs[i][f] = f === 'carry' ? Number(e.target.value) : e.target.value.trim();
    save('clubs'); fillShotClubs(); refreshNavi();
  });
  $('#clubEdit').addEventListener('click', (e) => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    state.clubs.splice(Number(b.dataset.del), 1); save('clubs'); renderClubs(); fillShotClubs();
  });
  $('#btnExportNotes').onclick = () => {
    const b = exportBundle({ includeRounds: false });
    shareOrDownload({ title: 'KUNIKUNIゴルフ 攻略メモ', text: '攻略メモとグリーン位置です。KUNIKUNIゴルフの設定 →「読み込み」で取り込めます', filename: `golfnavi-notes-${new Date().toISOString().slice(0, 10)}.json`, blob: new Blob([JSON.stringify(b)], { type: 'application/json' }) });
  };
  $('#btnExportAll').onclick = () => {
    const b = exportBundle({ includeRounds: true });
    shareOrDownload({ title: 'KUNIKUNIゴルフ バックアップ', text: 'KUNIKUNIゴルフのバックアップ', filename: `golfnavi-backup-${new Date().toISOString().slice(0, 10)}.json`, blob: new Blob([JSON.stringify(b)], { type: 'application/json' }) });
  };
  $('#importFile').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const r = importBundle(JSON.parse(await f.text()));
      toast(`取り込みました（メモ${r.notes}件・グリーン位置${r.pins}件・ラウンド${r.rounds}件）`, 3500);
      refreshNavi(); renderAnalysis();
    } catch (er) { toast(er.message); }
    e.target.value = '';
  };
  const url = location.origin + location.pathname;
  $('#appUrl').textContent = url;
  $('#btnCopyUrl').onclick = () => copyText(url);
  $('#btnShareApp').onclick = () => shareOrDownload({ title: 'KUNIKUNIゴルフ', text: `ゴルフアプリ「KUNIKUNIゴルフ」。開いて「ホーム画面に追加」でインストールできるよ\n${url}` });
}

function renderClubs() {
  $('#clubEdit').innerHTML = '<span class="hd">クラブ</span><span class="hd">キャリー(y)</span><span></span>' + state.clubs.map((c, i) => `
    <input data-i="${i}" data-f="name" value="${esc(c.name)}" aria-label="クラブ名">
    <input data-i="${i}" data-f="carry" type="number" inputmode="numeric" value="${c.carry}" aria-label="${esc(c.name)}のキャリー">
    <button data-del="${i}" aria-label="${esc(c.name)}を削除">×</button>`).join('');
}

function setSun(on) {
  state.settings.sun = on; save('settings');
  document.documentElement.classList.toggle('sun', on);
  $('#btnSun').setAttribute('aria-pressed', String(on));
  $('#setSun').checked = on;
  toast(on ? '屋外モード: 直射日光でも見やすい表示にしました' : '屋外モードを切りました');
}

// keep the screen on during play
let lock = null;
async function wake(on) {
  try {
    if (on && state.settings.wake !== false && 'wakeLock' in navigator && !lock) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => (lock = null)); }
    if (!on && lock) { await lock.release(); lock = null; }
  } catch { lock = null; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.ui.tab === 'navi') wake(true); });

// ---------------- install (PWA) ----------------
let deferred = null;
function initInstall() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const dismissed = Number(localStorage.getItem('golfnavi:installDismissed') || 0);
  if (Date.now() - dismissed < 3 * 864e5) return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferred = e;
    $('#installBanner').hidden = false;
  });
  if (ios) {
    $('#installText').textContent = 'iPhone: 共有ボタン（□↑）→「ホーム画面に追加」でアプリとして使えます';
    $('#btnInstall').hidden = true;
    $('#installBanner').hidden = false;
  }
  $('#btnInstall').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#installBanner').hidden = true; };
  $('#btnInstallClose').onclick = () => { $('#installBanner').hidden = true; try { localStorage.setItem('golfnavi:installDismissed', String(Date.now())); } catch {} };
}

// ---------------- boot ----------------
function boot() {
  if (state.settings.sun) document.documentElement.classList.add('sun');
  document.body.addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]');
    if (g) { e.preventDefault(); goto(g.dataset.goto); }
  });
  $('#openSettings').onclick = () => goto('settings');
  initSettings();
  initCourses(async (c, mode) => { courseChip(); syncCourse(); goto(mode === 'book' ? 'book' : 'navi'); if (mode !== 'book') toast(`${state.course.name} を読み込みます`); await loadCourse(false); if (mode === 'book') openBook(); });
  window.addEventListener('open-book', () => goto('book'));
  $('#btnShareIntel').onclick = () => shareCourseIntel();
  window.addEventListener('course-intel', (e) => { if (e.detail.courseId === state.course?.id) loadCourse(false); toast('仲間から攻略情報が届きました'); });
  $('#videoTabs').onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; $$('#videoTabs button').forEach((x) => x.classList.toggle('on', x === b)); $$('.vpane').forEach((p) => (p.hidden = p.dataset.vp !== b.dataset.v)); };
  window.addEventListener('course-picked', async () => { courseChip(); syncCourse(); goto('navi'); await loadCourse(false); });
  window.addEventListener('goto-tab', (e) => goto(e.detail));
  initScore(() => renderAnalysis());
  initTracer();
  initSwing();
  initBooking();
  initAnalysis(); restoreCoach();
  initWeather();
  initGroup();
  courseChip();
  initNavi();
  goto(new URLSearchParams(location.search).get('room') ? 'group' : state.ui.tab || 'navi');
  initInstall();
  if (!state.clubs?.length) { state.clubs = DEFAULT_CLUBS.map((c) => ({ ...c })); save('clubs'); }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('新しいバージョンがあります。アプリを再起動すると更新されます', 4500); });
      });
    }).catch(() => {});
  }
}

if (typeof L === 'undefined') {
  document.body.insertAdjacentHTML('afterbegin', '<p style="padding:16px">地図ライブラリを読み込めませんでした。通信状態を確認して再読み込みしてください。</p>');
}
boot();
