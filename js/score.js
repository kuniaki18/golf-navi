// Scorecard: current round entry, totals, history.
import { $, $$, esc, toast, fmtDate, uid, shareOrDownload } from './util.js';
import { state, save } from './store.js';
import { renderAll as renderMemory, snapshotWeather, sums, rankPlayers } from './memory.js';
import { readScorecard } from './ocr.js';
import { submitPlayersToComp } from './group.js';

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
    state.current = newRound(); cur = 0; save('round'); render(); window.dispatchEvent(new Event('round-changed'));
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
  $('#btnSaveRound').onclick = async () => {
    const r = state.current;
    if (!r.holes.some((h) => h.strokes)) { toast('スコアを入力してください'); return; }
    r.saved = true;
    await snapshotWeather(r);
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
    if (b.dataset.act === 'open') { const r = state.rounds.find((x) => x.id === id); state.current = JSON.parse(JSON.stringify(r)); cur = 0; save('round'); render(); window.dispatchEvent(new Event('round-changed')); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    if (b.dataset.act === 'mem') window.dispatchEvent(new CustomEvent('open-memory', { detail: id }));
    if (b.dataset.act === 'del') {
      if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = '本当に削除'; return; }
      state.rounds = state.rounds.filter((x) => x.id !== id); save('rounds'); render(); onSaved?.();
    }
  };
  initPlayers();
  window.addEventListener('round-changed', () => render());
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
    const mates = (r.players || []).length;
    return `<div class="h-item"><div class="h-score">${t.strokes}</div><div><div><b>${esc(r.course || 'コース名なし')}</b></div><div class="meta">${esc(r.date)} · ${t.played}H · パット ${t.putts} · ${fmtPar(t.strokes - t.par)}${mates ? ` · ${mates + 1}人` : ''}${r.memo ? ' · メモあり' : ''}</div></div>
      <div class="acts"><button class="btn small primary" data-act="mem" data-id="${r.id}">思い出</button><button class="btn small" data-act="open" data-id="${r.id}">開く</button><button class="btn small" data-act="del" data-id="${r.id}">削除</button></div></div>`;
  }).join('') : '<p class="muted">保存したラウンドがここに並びます。</p>';
}

// ---------------- today's members (manual or scorecard OCR) ----------------
function initPlayers() {
  $('#ocrFile').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const st = $('#ocrStatus');
    try {
      const res = await readScorecard(f, { pars: state.current.holes.map((h) => h.par), onStatus: (m) => (st.textContent = m) });
      const r = state.current;
      r.players ??= [];
      for (const p of res.players) {
        const i = r.players.findIndex((x) => x.name === p.name);
        if (i >= 0) r.players[i] = { ...r.players[i], ...p }; else r.players.push({ id: uid(), ...p });
      }
      if (res.par?.filter(Boolean).length >= 9) res.par.forEach((p, i) => { if (p && p >= 3 && p <= 6 && !r.holes[i].strokes) r.holes[i].par = p; });
      if (!r.course && res.course) r.course = res.course;
      save('round'); render(); renderPlayers();
      const warn = res.players.filter((p) => p.check).length;
      st.textContent = `${res.players.length}人分を読み取りました（${res.source === 'ai' ? 'AI' : '端末内OCR'}）。数字を確認して、違うマスはタップで直してください。${warn ? `合計が合わない行が${warn}つあります。` : ''}自分の行は「自分」を押すとスコアカードに反映されます。`;
    } catch (er) { st.textContent = er.message; }
  };
  $('#btnAddPlayer').onclick = () => { (state.current.players ??= []).push({ id: uid(), name: '', holes: Array(18).fill(null), total: null }); save('round'); renderPlayers(); };
  $('#btnPlayersToComp').onclick = () => {
    const r = state.current;
    const me = { name: state.settings.name || '自分', holes: r.holes.map((h) => h.strokes || 0), me: true };
    submitPlayersToComp([me, ...(r.players || []).filter((p) => p.name)]);
  };
  $('#playersTable').addEventListener('change', (e) => {
    const el = e.target; const p = state.current.players?.find((x) => x.id === el.dataset.p); if (!p) return;
    if (el.dataset.f === 'name') p.name = el.value.trim();
    else if (el.dataset.h != null) { const v = parseInt(el.value, 10); p.holes[Number(el.dataset.h)] = Number.isFinite(v) && v > 0 ? v : null; p.total = null; p.check = ''; }
    save('round'); renderPlayers(); renderHistory();
  });
  $('#playersTable').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const r = state.current; const p = r.players?.find((x) => x.id === b.dataset.p); if (!p) return;
    if (b.dataset.act === 'me') {
      p.holes.forEach((v, i) => { if (v) { r.holes[i].strokes = v; if (p.putts?.[i]) r.holes[i].putts = p.putts[i]; } });
      if (!state.settings.name && p.name) state.settings.name = p.name;
      r.players = r.players.filter((x) => x !== p);
      save('round'); render(); renderPlayers(); toast('自分のスコアカードに反映しました');
    }
    if (b.dataset.act === 'rm') {
      if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = '削除?'; return; }
      r.players = r.players.filter((x) => x !== p); save('round'); renderPlayers();
    }
  });
  window.addEventListener('round-changed', renderPlayers);
  renderPlayers();
}

function renderPlayers() {
  const r = state.current; if (!r) return;
  const mine = r.holes.map((h) => h.strokes || null);
  const ms = sums(mine);
  const head = `<tr><th class="nm">名前</th>${Array.from({ length: 18 }, (_, i) => `<th>${i + 1}</th>`).join('')}<th>OUT</th><th>IN</th><th>計</th><th></th></tr>`;
  const meRow = `<tr class="me-row"><td class="nm"><b>${esc(state.settings.name || '自分')}</b></td>${mine.map((v) => `<td>${v ?? ''}</td>`).join('')}<td>${ms.out ?? ''}</td><td>${ms.in ?? ''}</td><td><b>${ms.total ?? ''}</b></td><td></td></tr>`;
  const rows = (r.players || []).map((p) => {
    const s = sums(p.holes, p.total);
    return `<tr class="${p.check ? 'warn-row' : ''}" title="${esc(p.check || '')}"><td class="nm"><input data-p="${p.id}" data-f="name" value="${esc(p.name)}" placeholder="名前" aria-label="名前"></td>
      ${p.holes.map((v, i) => `<td><input data-p="${p.id}" data-h="${i}" value="${v ?? ''}" inputmode="numeric" aria-label="${esc(p.name)} ${i + 1}番"></td>`).join('')}
      <td>${s.out ?? ''}</td><td>${s.in ?? ''}</td><td><b>${s.total ?? ''}</b></td>
      <td class="acts"><button class="btn small" data-act="me" data-p="${p.id}">自分</button><button class="btn small" data-act="rm" data-p="${p.id}">×</button></td></tr>`;
  }).join('');
  $('#playersTable').innerHTML = head + meRow + rows;
  $('#playersEmpty').hidden = !!(r.players || []).length;
  document.querySelector('.players-wrap').hidden = !(r.players || []).length;
  renderMemory();
}

function scoreText(r) {
  const t = total(r), o = total(r, 0, 9), i = total(r, 9, 18);
  const line = (a, b) => r.holes.slice(a, b).map((h) => h.strokes ?? '-').join(' ');
  return `⛳ ${r.course || ''} ${r.date}\n${state.settings.name ? state.settings.name + ' ' : ''}スコア ${t.strokes}（${fmtPar(t.strokes - t.par)}）OUT ${o.strokes} / IN ${i.strokes} / パット ${t.putts}\nOUT: ${line(0, 9)}\nIN : ${line(9, 18)}${(r.players || []).length ? '\n\n今日の結果\n' + rankPlayers(r).map((p, k) => `${k + 1}. ${p.name} ${p.total}`).join('\n') : ''}\n#KUNIKUNIゴルフ`;
}
