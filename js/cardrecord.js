// Record a round from a photo of the paper scorecard: read it (OCR), confirm date / course / which row is me,
// save it as a round with the other players, and keep the card photo (and any others) as the day's memories.
import { $, esc, toast, fmtDate } from './util.js';
import { state, save } from './store.js';
import { matchCourseName, pickMe, cardDate, roundFromCard } from './cardparse.js';

// ---------------- UI ----------------
let pending = null; // { res, file, extra: File[] }

export function initCardRecord({ onSaved }) {
  $('#cardShot').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const st = $('#cardShotStatus'); st.textContent = '読み取っています…';
    try {
      const { readScorecard } = await import('./ocr.js');
      const res = await readScorecard(f, { onStatus: (m) => (st.textContent = m) });
      st.textContent = '';
      pending = { res, file: f, extra: [] };
      await review();
    } catch (er) { st.textContent = er.message; }
  };
  $('#cardRecPanel').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-c]'); if (!b) return;
    if (b.dataset.c === 'close') { $('#cardRecPanel').hidden = true; pending = null; }
    if (b.dataset.c === 'save') await saveCard(onSaved);
  });
  $('#cardRecPanel').addEventListener('change', (e) => {
    if (e.target.id === 'crExtra') { pending.extra = [...e.target.files]; $('#crExtraN').textContent = pending.extra.length ? `${pending.extra.length}枚を一緒に保存します` : ''; }
    const cell = e.target.closest('[data-p]');
    if (cell && pending) { const p = pending.res.players[+cell.dataset.p]; if (cell.dataset.f === 'name') p.name = cell.value.trim(); else { const v = parseInt(cell.value, 10); p.holes[+cell.dataset.h] = v > 0 && v < 20 ? v : null; p.total = null; } renderTotals(); }
  });
}

async function review() {
  const { res, file } = pending;
  const { bundledCourses } = await import('./osm.js');
  let list = []; try { list = await bundledCourses(); } catch {}
  const hit = res.course ? matchCourseName(res.course, list) : null;
  // the course read from the card, else the course selected in the app (picked on arrival, or by hand)
  const c = hit || (state.course ? { id: state.course.id, name: state.course.name } : null);
  pending.courseId = c?.id || null;
  const me = pickMe(res.players, state.settings.name);
  const date = cardDate(res.date, file.lastModified);
  $('#cardRecPanel').innerHTML = `<div class="sheet-body" role="dialog" aria-label="スコアカードの記録">
    <div class="card-head"><h2>スコアカードを記録</h2><button class="btn small" data-c="close">閉じる</button></div>
    <p class="muted">${res.source === 'ai' ? 'AI' : '端末内OCR'}で読み取りました。数字・日付・ゴルフ場を確認して「記録する」を押してください。</p>
    <div class="cr-fields">
      <label>日付<input type="date" id="crDate" value="${esc(date)}"></label>
      <label>ゴルフ場<input id="crCourse" value="${esc(c?.name || res.course || '')}" placeholder="ゴルフ場名" list="crCourseList"></label>
      <datalist id="crCourseList">${hit ? `<option value="${esc(hit.name)}">` : ''}${state.course ? `<option value="${esc(state.course.name)}">` : ''}</datalist>
    </div>
    <div class="table-wrap"><table class="players cr-table">${tableHtml(res, me)}</table></div>
    <p class="muted">○ の行が自分のスコアになります。ほかの人は「今日のメンバー」として一緒に保存されます。</p>
    <label class="check"><input type="checkbox" id="crKeepPhoto" checked> スコアカードの写真を思い出に保存する</label>
    <label class="btn small file-btn">ほかの写真も追加<input type="file" id="crExtra" accept="image/*" multiple></label> <span class="muted" id="crExtraN"></span>
    <div class="btn-row"><button class="btn primary" data-c="save">記録する</button></div>
  </div>`;
  $('#cardRecPanel').hidden = false;
  renderTotals();
}

function tableHtml(res, me) {
  const head = `<tr><th>自分</th><th class="nm">名前</th>${Array.from({ length: 18 }, (_, i) => `<th>${i + 1}</th>`).join('')}<th>計</th></tr>`;
  return head + res.players.map((p, k) => `<tr class="${p.check ? 'warn-row' : ''}" title="${esc(p.check || '')}"><td><input type="radio" name="crMe" value="${k}" ${k === me ? 'checked' : ''} aria-label="${esc(p.name)}が自分"></td>
    <td class="nm"><input data-p="${k}" data-f="name" value="${esc(p.name)}" aria-label="名前"></td>
    ${p.holes.map((v, i) => `<td><input data-p="${k}" data-h="${i}" value="${v ?? ''}" inputmode="numeric" aria-label="${esc(p.name)} ${i + 1}番"></td>`).join('')}<td class="cr-tot" data-t="${k}"></td></tr>`).join('');
}
function renderTotals() {
  pending?.res.players.forEach((p, k) => { const el = document.querySelector(`[data-t="${k}"]`); if (el) el.textContent = p.holes.reduce((a, x) => a + (x || 0), 0) || ''; });
}

async function saveCard(onSaved) {
  const { res, file, extra } = pending;
  const meEl = document.querySelector('input[name="crMe"]:checked');
  if (!meEl) { toast('自分の行を ○ で選んでください'); return; }
  const course = $('#crCourse').value.trim(), date = $('#crDate').value || fmtDate(new Date());
  // the course id only when the name was not changed to something else
  const { bundledCourses } = await import('./osm.js');
  let list = []; try { list = await bundledCourses(); } catch {}
  const c = list.find((x) => x.name === course) || (course ? matchCourseName(course, list) : null);
  let pars = null;
  if (c) { try { const sc = await (await fetch(`data/sc/${c.id}.json`)).json(); if (sc.courses?.[0]?.holes?.length === 18) pars = sc.courses[0].holes.map((h) => h.par); } catch {} }
  const r = roundFromCard(res, { date, course, courseId: c?.id || null, me: Number(meEl.value), pars });
  if (!state.settings.name && res.players[Number(meEl.value)]?.name) state.settings.name = res.players[Number(meEl.value)].name;
  const { snapshotWeather, addPhotos } = await import('./memory.js');
  state.rounds.unshift(r); state.rounds.sort((a, b) => (a.date < b.date ? 1 : -1));
  save('rounds');
  const photos = [...($('#crKeepPhoto').checked ? [file] : []), ...extra];
  if (photos.length) { try { await addPhotos(photos, r.id); } catch { toast('写真を保存できませんでした'); } }
  if (date === fmtDate(new Date())) { await snapshotWeather(r); save('rounds'); }
  $('#cardRecPanel').hidden = true; pending = null;
  toast(`${date} ${course || ''} のラウンドを記録しました`, 3500);
  onSaved?.(r);
}
