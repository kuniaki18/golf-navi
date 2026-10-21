// Scorecard: current round entry, totals, history.
import { $, $$, esc, toast, fmtDate, uid, shareOrDownload } from './util.js';
import { state, save } from './store.js';

let cur = 0;

const blankHole = (par = 4) => ({ par, strokes: null, putts: null, penalties: 0, fw: null, sand: 0 });
function newRound() {
  return { id: uid(), date: fmtDate(new Date()), course: state.course?.name || '', courseId: state.course?.id || null, holes: Array.from({ length: 18 }, () => blankHole()), saved: false };
}

export function initScore(onSaved) {
  if (!state.current) { state.current = newRound(); save('round'); }
  $('#btnNewRound').onclick = () => {
    if (state.current && state.current.holes.some((h) => h.strokes) && !state.current.saved) {
      if ($('#btnNewRound').dataset.confirm !== '1') { $('#btnNewRound').dataset.confirm = '1'; $('#btnNewRound').textContent = '未保存を破棄して新規？'; setTimeout(() => { $('#btnNewRound').dataset.confirm = ''; $('#btnNewRound').textContent = '新しいラウンド'; }, 3500); return; }
    }
    $('#btnNewRound').dataset.confirm = ''; $('#btnNewRound').textContent = '新しいラウンド';
    state.current = newRound(); cur = 0; save('round'); render();
  };
  $('#roundCourse').oninput = () => { state.current.course = $('#roundCourse').value; save('round'); };
  $('#roundDate').oninput = () => { state.current.date = $('#roundDate').value; save('round'); };
  $('#scPrev').onclick = () => { cur = (cur + 17) % 18; render(); };
  $('#scNext').onclick = () => { cur = (cur + 1) % 18; render(); };
  $('#scPar').onclick = (e) => { const v = e.target.dataset.v; if (!v) return; hole().par = Number(v); save('round'); render(); };
  $('#scFw').onclick = (e) => { const v = e.target.dataset.v; if (!v) return; hole().fw = hole().fw === v ? null : v; save('round'); render(); };
  $('#scSand').onclick = (e) => { const v = e.target.dataset.v; if (v == null) return; hole().sand = Number(v); save('round'); render(); };
  $$('.stepper button').forEach((b) => (b.onclick = () => {
    const f = b.dataset.f, d = Number(b.dataset.d), h = hole();
    if (h[f] == null) h[f] = f === 'strokes' ? h.par : f === 'putts' ? 2 : 0;
    else h[f] = Math.max(0, h[f] + d);
    if (f === 'putts' && h.strokes != null && h.putts > h.strokes) h.strokes = h.putts;
    save('round'); render();
  }));
  $('#scTable').onclick = (e) => { const td = e.target.closest('[data-h]'); if (td) { cur = Number(td.dataset.h); render(); } };
  $('#btnSaveRound').onclick = () => {
    const r = state.current;
    if (!r.holes.some((h) => h.strokes)) { toast('スコアを入力してください'); return; }
    r.saved = true;
    const i = state.rounds.findIndex((x) => x.id === r.id);
    const copy = JSON.parse(JSON.stringify(r));
    if (i >= 0) state.rounds[i] = copy; else state.rounds.unshift(copy);
    state.rounds.sort((a, b) => (a.date < b.date ? 1 : -1));
    save('rounds'); toast(`保存しました（${total(r).strokes}）`); render(); onSaved?.();
  };
  $('#btnShareRound').onclick = () => shareOrDownload({ title: 'スコア', text: scoreText(state.current) });
  $('#roundHistory').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const id = b.dataset.id;
    if (b.dataset.act === 'open') { const r = state.rounds.find((x) => x.id === id); state.current = JSON.parse(JSON.stringify(r)); cur = 0; save('round'); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    if (b.dataset.act === 'del') {
      if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = '本当に削除'; return; }
      state.rounds = state.rounds.filter((x) => x.id !== id); save('rounds'); render(); onSaved?.();
    }
  };
  window.addEventListener('navi-hole', (e) => {
    const no = e.detail.no;
    if (no >= 1 && no <= 18) {
      cur = no - 1;
      if (e.detail.par && hole().strokes == null) { hole().par = e.detail.par; save('round'); }
      render();
    }
  });
  render();
}

export function syncCourse() {
  if (state.current && !state.current.holes.some((h) => h.strokes)) {
    state.current.course = state.course?.name || ''; state.current.courseId = state.course?.id || null; save('round'); render();
  }
}

const hole = () => state.current.holes[cur];
export function total(r, from = 0, to = 18) {
  const hs = r.holes.slice(from, to);
  const played = hs.filter((h) => h.strokes);
  return {
    strokes: played.reduce((s, h) => s + h.strokes, 0),
    par: played.reduce((s, h) => s + h.par, 0),
    parAll: hs.reduce((s, h) => s + h.par, 0),
    putts: played.reduce((s, h) => s + (h.putts || 0), 0),
    played: played.length,
  };
}
export const isGIR = (h) => h.strokes != null && h.putts != null && h.strokes - h.putts <= h.par - 2;

function cls(h) {
  if (!h.strokes) return '';
  const d = h.strokes - h.par;
  return d <= -2 ? 's-eagle' : d === -1 ? 's-birdie' : d === 0 ? '' : d === 1 ? 's-bogey' : 's-double';
}

function render() {
  const r = state.current, h = hole();
  $('#roundCourse').value = r.course; $('#roundDate').value = r.date;
  $('#scHole').textContent = cur + 1;
  const t = total(r);
  $('#scToPar').textContent = t.played ? `${t.strokes}（${fmtPar(t.strokes - t.par)}）· ${t.played}H` : '未入力';
  $$('#scPar button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === h.par));
  $$('#scFw button').forEach((b) => b.classList.toggle('on', b.dataset.v === h.fw));
  $$('#scSand button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === h.sand));
  $('#scStrokes').textContent = h.strokes ?? '-';
  $('#scPutts').textContent = h.putts ?? '-';
  $('#scPen').textContent = h.penalties ?? 0;
  const flags = [];
  if (h.strokes) {
    const d = h.strokes - h.par;
    flags.push(`<span class="flag-chip ${d < 0 ? 'good' : d >= 2 ? 'bad' : ''}">${['アルバトロス', 'イーグル', 'バーディー', 'パー', 'ボギー', 'ダブルボギー', 'トリプルボギー'][d + 3] || `+${d}`}</span>`);
    if (isGIR(h)) flags.push('<span class="flag-chip good">パーオン</span>');
    if (h.putts >= 3) flags.push('<span class="flag-chip bad">3パット</span>');
    if (h.putts === 1) flags.push('<span class="flag-chip good">1パット</span>');
    if (h.penalties) flags.push(`<span class="flag-chip bad">OB/池 ${h.penalties}</span>`);
  }
  $('#scFlags').innerHTML = flags.join('');
  renderTable(r);
  renderHistory();
}
const fmtPar = (d) => (d === 0 ? 'E' : d > 0 ? '+' + d : String(d));

function renderTable(r) {
  const half = (a, b, label) => {
    const hs = r.holes.slice(a, b);
    const t = total(r, a, b);
    return `<tr><th>${label}</th>${hs.map((_, i) => `<th>${a + i + 1}</th>`).join('')}<th>計</th></tr>
      <tr><th>PAR</th>${hs.map((h) => `<td>${h.par}</td>`).join('')}<td>${t.parAll}</td></tr>
      <tr><th>打数</th>${hs.map((h, i) => `<td data-h="${a + i}" class="${cls(h)} ${a + i === cur ? 'cur' : ''}">${h.strokes ?? ''}</td>`).join('')}<td><b>${t.strokes || ''}</b></td></tr>
      <tr><th>パット</th>${hs.map((h, i) => `<td data-h="${a + i}">${h.putts ?? ''}</td>`).join('')}<td>${t.putts || ''}</td></tr>`;
  };
  $('#scTable').innerHTML = half(0, 9, 'OUT') + half(9, 18, 'IN');
}

function renderHistory() {
  const list = state.rounds;
  $('#roundHistory').innerHTML = list.length ? list.map((r) => {
    const t = total(r);
    return `<div class="h-item"><div class="h-score">${t.strokes}</div><div><div><b>${esc(r.course || 'コース名なし')}</b></div><div class="meta">${esc(r.date)} · ${t.played}H · パット ${t.putts} · ${fmtPar(t.strokes - t.par)}</div></div>
      <div class="acts"><button class="btn small" data-act="open" data-id="${r.id}">開く</button><button class="btn small" data-act="del" data-id="${r.id}">削除</button></div></div>`;
  }).join('') : '<p class="muted">保存したラウンドがここに並びます。</p>';
}

function scoreText(r) {
  const t = total(r), o = total(r, 0, 9), i = total(r, 9, 18);
  const line = (a, b) => r.holes.slice(a, b).map((h) => h.strokes ?? '-').join(' ');
  return `⛳ ${r.course || ''} ${r.date}\n${state.settings.name ? state.settings.name + ' ' : ''}スコア ${t.strokes}（${fmtPar(t.strokes - t.par)}）OUT ${o.strokes} / IN ${i.strokes} / パット ${t.putts}\nOUT: ${line(0, 9)}\nIN : ${line(9, 18)}\n#GolfNavi`;
}
