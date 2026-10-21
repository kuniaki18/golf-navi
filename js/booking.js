// Cheapest-tee-time calendar: one Rakuten GORA plan search per day, cheapest plan per day on a calendar.
import { $, esc, toast, fmtDate, sleep } from './util.js';
import { state, save } from './store.js';
import { searchPlans, hasGora } from './gora.js';
import { sharePlanToGroup } from './group.js';

let results = {}; // date -> plans[]
let stop = false;
let selected = null;

// fixed + approximate national holidays (moving holidays computed below)
function holidays(year) {
  const set = new Set(['01-01', '02-11', '02-23', '04-29', '05-03', '05-04', '05-05', '08-11', '11-03', '11-23']);
  const nthMon = (m, n) => { const d = new Date(year, m - 1, 1); const off = (8 - d.getDay()) % 7; return `${String(m).padStart(2, '0')}-${String(1 + off + (n - 1) * 7).padStart(2, '0')}`; };
  [nthMon(1, 2), nthMon(7, 3), nthMon(9, 3), nthMon(10, 2)].forEach((x) => set.add(x));
  const ve = Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  const ae = Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  set.add(`03-${ve}`); set.add(`09-${ae}`);
  return set;
}
const isHoliday = (d) => holidays(d.getFullYear()).has(fmtDate(d).slice(5));

export function initBooking() {
  const tomorrow = new Date(Date.now() + 864e5);
  $('#bkStart').value = fmtDate(tomorrow);
  $('#bkStart').min = fmtDate(new Date());
  $('#bkPref').onchange = () => { state.ui.pref = Number($('#bkPref').value); save('ui'); };
  $('#btnBkSearch').onclick = run;
  $('#btnBkStop').onclick = () => { stop = true; };
  $('#bkCal').onclick = (e) => { const d = e.target.closest('[data-date]'); if (d && results[d.dataset.date]) { selected = d.dataset.date; renderCal(); renderPlans(); } };
  renderCal();
  window.__bookingCheapest = () => Object.values(results).filter((v) => v.length).map((v) => v[0]).sort((a, b) => a.price - b.price);
}

function dates() {
  const start = new Date($('#bkStart').value + 'T00:00:00');
  const n = Number($('#bkDays').value);
  const weekendOnly = $('#bkWeekend').checked;
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    if (weekendOnly && !(d.getDay() === 0 || d.getDay() === 6 || isHoliday(d))) continue;
    out.push(d);
  }
  return out;
}

async function run() {
  if (!hasGora()) { toast('設定で楽天GORAのアプリIDとアクセスキーを入れてください', 3500); $('#bkStatus').textContent = '楽天ウェブサービスのキーが未設定です。下の予約サイトのリンクからも探せます。'; return; }
  results = {}; selected = null; stop = false;
  const ds = dates();
  const maxPrice = Number($('#bkMax').value) || 0;
  $('#btnBkSearch').disabled = true; $('#btnBkStop').hidden = false;
  renderCal(ds);
  for (let i = 0; i < ds.length && !stop; i++) {
    const key = fmtDate(ds[i]);
    $('#bkStatus').textContent = `${key} を調べています（${i + 1}/${ds.length}）`;
    try { results[key] = await searchPlans({ areaCode: $('#bkPref').value, playDate: key, maxPrice }); }
    catch (e) { results[key] = []; $('#bkStatus').textContent = e.message; if (/アプリID|アクセスキー|接続できません/.test(e.message)) break; }
    renderCal(ds);
    await sleep(1100); // API limit: about 1 request / second
  }
  $('#btnBkSearch').disabled = false; $('#btnBkStop').hidden = true;
  const all = Object.entries(results).filter(([, v]) => v.length);
  if (all.length) {
    const [d] = all.reduce((m, x) => (x[1][0].price < m[1][0].price ? x : m));
    selected = d;
    $('#bkStatus').textContent = `最安は ${d}（${yen(results[d][0].price)}）`;
    renderCal(ds); renderPlans();
  } else if (!stop) $('#bkStatus').textContent ||= '条件に合うプランが見つかりませんでした';
}

const yen = (n) => '¥' + Number(n).toLocaleString('ja-JP');

function renderCal(ds = dates()) {
  if (!ds.length) { $('#bkCal').innerHTML = ''; return; }
  const mins = Object.values(results).filter((v) => v.length).map((v) => v[0].price);
  const cheapest = mins.length ? Math.min(...mins) : null;
  let html = ['日', '月', '火', '水', '木', '金', '土'].map((d) => `<div class="dow">${d}</div>`).join('');
  const lead = ds[0].getDay();
  for (let i = 0; i < lead; i++) html += '<div class="day empty"></div>';
  let prev = null;
  for (const d of ds) {
    if (prev) { const gap = Math.round((d - prev) / 864e5) - 1; for (let i = 0; i < gap; i++) html += '<div class="day empty"></div>'; }
    prev = d;
    const k = fmtDate(d), r = results[k];
    const cl = ['day', d.getDay() === 0 ? 'sun' : d.getDay() === 6 ? 'sat' : '', isHoliday(d) ? 'hol' : '', r?.length && r[0].price === cheapest ? 'cheapest' : '', selected === k ? 'sel' : '', r ? '' : 'loading'].join(' ');
    html += `<button class="${cl}" data-date="${k}"><span class="d">${d.getMonth() + 1}/${d.getDate()}</span><span class="p">${r ? (r.length ? (r[0].price / 1000).toFixed(1) + 'k' : '—') : '…'}</span>${r?.length ? `<span class="muted">${r.length}件</span>` : ''}</button>`;
  }
  $('#bkCal').innerHTML = html;
}

function renderPlans() {
  const list = results[selected] || [];
  $('#bkPlans').innerHTML = list.length ? `<h2 class="sec-title">${selected} の安い順</h2>` + list.slice(0, 20).map((p) => `
    <div class="plan">
      <div class="nm">${esc(p.course)}</div><div class="price">${yen(p.price)}</div>
      <div class="pn">${esc(p.plan)}${p.lunch ? ' · ' + esc(lunchLabel(p.lunch)) : ''}${p.round ? ' · ' + esc(p.round) + 'R' : ''}${p.evaluation ? ' · 評価 ' + esc(p.evaluation) : ''}</div>
      <div class="acts">${p.url ? `<a class="btn small primary" href="${esc(p.url)}" target="_blank" rel="noopener">予約ページへ</a>` : ''}
      <button class="btn small" data-share="${esc(JSON.stringify({ course: p.course, date: p.date, plan: p.plan, price: p.price, url: p.url }))}">仲間に共有</button>
      ${p.lat ? `<button class="btn small" data-play="${esc(JSON.stringify({ id: 'gora-' + p.courseId, name: p.course, lat: Number(p.lat), lon: Number(p.lon), source: 'gora', goraId: p.courseId, reserveUrl: p.url }))}">このコースを選ぶ</button>` : ''}</div>
    </div>`).join('') : '';
  $('#bkPlans').querySelectorAll('[data-share]').forEach((b) => (b.onclick = () => sharePlanToGroup(JSON.parse(b.dataset.share))));
  $('#bkPlans').querySelectorAll('[data-play]').forEach((b) => (b.onclick = () => { state.course = JSON.parse(b.dataset.play); save('course'); window.dispatchEvent(new CustomEvent('course-picked')); }));
}
const lunchLabel = (v) => ({ 0: '昼食なし', 1: '昼食付', '0': '昼食なし', '1': '昼食付' }[v] ?? String(v));
