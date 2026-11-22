// Monthly score sheet: every round of a month in one table (date, course, score, putts, members), the month's
// best / average, as a shareable image and text (the numbers come from monthsum.js).
import { $, esc } from './util.js';
import { state } from './store.js';
import { openShare } from './share.js';
import { monthSummary, monthText, toParTxt, ymLabel } from './monthsum.js';

export async function buildMonthCard(s, name = '') {
  const rows = Math.max(1, s.rounds.length), W = 1080, H = Math.max(900, 430 + rows * 96 + 140);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const F = '"Zen Kaku Gothic New", "Hiragino Sans", sans-serif', D = '"Barlow Condensed", sans-serif';
  g.fillStyle = '#123524'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#f2c94c'; g.font = `700 44px ${D}`; g.fillText('MONTHLY SCORES', 70, 110);
  g.fillStyle = '#fff'; g.font = `700 72px ${F}`; g.fillText(`${ymLabel(s.ym)}のスコア`, 70, 200);
  if (name) { g.font = `500 36px ${F}`; g.fillStyle = '#cfe3d4'; g.fillText(name, 70, 252); }
  // stats
  const stat = (x, label, v) => { g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(x, 290, 300, 110); g.fillStyle = '#a8c2b1'; g.font = `500 28px ${F}`; g.fillText(label, x + 24, 330); g.fillStyle = '#f2c94c'; g.font = `700 56px ${D}`; g.fillText(v, x + 24, 388); };
  stat(70, 'ラウンド', String(s.count)); stat(390, 'ベスト', s.best ? String(s.best.strokes) : '-'); stat(710, '平均', s.avg != null ? String(s.avg) : '-');
  let y = 490;
  for (const x of s.rounds) {
    const isBest = s.best && x.id === s.best.id;
    g.fillStyle = isBest ? 'rgba(242,201,76,.2)' : 'rgba(255,255,255,.06)'; g.fillRect(60, y - 58, W - 120, 82);
    g.fillStyle = '#cfe3d4'; g.font = `700 40px ${D}`; g.fillText(x.date.slice(5).replace('-', '/'), 84, y);
    g.fillStyle = '#fff'; g.font = `700 36px ${F}`; g.fillText(trim(g, x.course, 560), 210, y);
    g.textAlign = 'right'; g.font = `700 54px ${D}`; g.fillStyle = isBest ? '#f2c94c' : '#fff'; g.fillText(String(x.strokes), W - 90, y + 2);
    g.font = `500 28px ${D}`; g.fillStyle = '#a8c2b1'; g.fillText(x.holes === 18 ? toParTxt(x.toPar) : `${x.holes}H`, W - 200, y); g.textAlign = 'left';
    y += 96;
  }
  if (!s.rounds.length) { g.fillStyle = '#cfe3d4'; g.font = `500 36px ${F}`; g.fillText('この月のラウンドはありません', 70, y); }
  g.fillStyle = '#f2c94c'; g.font = `700 30px ${D}`; g.fillText('KUNIKUNI GOLF', 70, H - 50);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
}
function trim(g, s, w) { if (g.measureText(s).width <= w) return s; while (s && g.measureText(s + '…').width > w) s = s.slice(0, -1); return s + '…'; }

// ---------------- UI (score tab) ----------------
let ym = null;
const shift = (v, d) => { const [y, m] = v.split('-').map(Number); const t = new Date(y, m - 1 + d, 1); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`; };
export function initMonthly() {
  ym = (state.rounds[0]?.date || new Date().toISOString()).slice(0, 7);
  $('#monthPrev').onclick = () => { ym = shift(ym, -1); renderMonthly(); };
  $('#monthNext').onclick = () => { ym = shift(ym, 1); renderMonthly(); };
  $('#monthShare').onclick = async () => {
    const s = monthSummary(state.rounds, ym), name = state.settings.name || '';
    openShare({ title: `${ymLabel(ym)}のスコア`, text: monthText(s, name), blob: await buildMonthCard(s, name), filename: `golf-${ym}.jpg` });
  };
  renderMonthly();
}
export function renderMonthly() {
  if (!ym) return;
  const s = monthSummary(state.rounds, ym);
  $('#monthLabel').textContent = ymLabel(ym);
  $('#monthBody').innerHTML = s.count ? `<table class="month-table"><tr><th>日付</th><th>ゴルフ場</th><th>スコア</th><th>パット</th></tr>${s.rounds.map((x) => `<tr class="${s.best && x.id === s.best.id ? 'best' : ''}"><td>${esc(x.date.slice(5).replace('-', '/'))}</td><td>${esc(x.course)}</td><td><b>${x.strokes}</b> <span class="muted">${x.holes === 18 ? toParTxt(x.toPar) : x.holes + 'H'}</span></td><td>${x.putts ?? '-'}</td></tr>`).join('')}</table>
    <p class="muted">${s.count}ラウンド${s.best ? ` · ベスト ${s.best.strokes}` : ''}${s.avg != null ? ` · 平均 ${s.avg}` : ''}</p>` : '<p class="muted">この月のラウンドはありません。</p>';
  $('#monthShare').disabled = !s.count;
}
