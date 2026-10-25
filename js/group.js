// Group features: encrypted chat, tee-time sharing, date polls, competitions (新ペリア leaderboard).
// Transport: ntfy.sh pub/sub (free, no account). Every message is AES-GCM encrypted with a key
// derived from the invite code, so the relay only sees ciphertext. Each phone keeps its own history.
import { $, $$, esc, toast, uid, fmtDate, shareOrDownload, copyText } from './util.js';
import { state, save } from './store.js';
import { total } from './score.js';

const RELAY = 'https://ntfy.sh';
const enc = new TextEncoder(), dec = new TextDecoder();
const conns = {}; // code -> { es, key, topic }
let active = null; // room code
let gtab = 'chat';
let joinMode = false;

const me = () => { state.deviceId ??= uid(); return { id: state.deviceId, name: state.settings.name || 'ゲスト' }; };
const rooms = () => (state.rooms ??= {});
const room = (code = active) => rooms()[code];

// ---------------- crypto ----------------
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function sha(s) { return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function keyFor(code) { return crypto.subtle.importKey('raw', await sha('golfnavi-key:' + code), 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function topicFor(code) { return 'gn_' + [...(await sha('golfnavi-topic:' + code))].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join(''); }
async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  const out = new Uint8Array(12 + ct.byteLength); out.set(iv); out.set(new Uint8Array(ct), 12);
  return b64(out);
}
async function open(key, s) {
  const raw = unb64(s);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
  return JSON.parse(dec.decode(pt));
}
function newCode() {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  const r = crypto.getRandomValues(new Uint8Array(16));
  return [...r].map((x) => a[x % a.length]).join('').replace(/(.{4})(?=.)/g, '$1-');
}

// ---------------- transport ----------------
async function connect(code) {
  if (conns[code]) return conns[code];
  const c = { key: await keyFor(code), topic: await topicFor(code) };
  conns[code] = c;
  const r = room(code);
  const since = r.lastRelayId || 'all';
  const es = new EventSource(`${RELAY}/${c.topic}/sse?since=${since}`);
  es.onmessage = async (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.event !== 'message' || !m.message) return;
      r.lastRelayId = m.id;
      const p = await open(c.key, m.message);
      receive(code, p);
    } catch { /* not ours / tampered */ }
  };
  es.onerror = () => { setStatus(code, '再接続中…'); };
  es.onopen = () => setStatus(code, '');
  c.es = es;
  return c;
}
function setStatus(code, s) { if (code === active) $('#roomStatus') && ($('#roomStatus').textContent = s); }

async function send(code, payload) {
  const c = await connect(code);
  const p = { v: 1, mid: uid(), from: me(), at: Date.now(), ...payload };
  const body = await seal(c.key, p);
  if (body.length > 4000) throw new Error('メッセージが長すぎます');
  receive(code, p); // show immediately
  const r = await fetch(`${RELAY}/${c.topic}`, { method: 'POST', body });
  if (!r.ok) throw new Error(r.status === 429 ? '送信が多すぎます。少し待ってください' : '送信できませんでした');
  return p;
}

// ---------------- state merge ----------------
function receive(code, p) {
  const r = room(code);
  if (!r) return;
  r.seen ??= {};
  if (r.seen[p.mid]) return;
  r.seen[p.mid] = 1;
  r.members ??= {};
  if (p.from?.id) r.members[p.from.id] = { name: p.from.name, at: p.at };
  switch (p.type) {
    case 'chat': case 'plan': (r.msgs ??= []).push(p); r.msgs = r.msgs.slice(-300); if (p.from.id !== me().id) r.unread = (r.unread || 0) + 1; break;
    case 'comp': { r.comps ??= {}; const cur = r.comps[p.comp.id]; if (!cur || p.comp.updatedAt >= cur.updatedAt) r.comps[p.comp.id] = p.comp; if (!cur) sysMsg(r, p, `コンペ「${p.comp.title}」が企画されました`); break; }
    case 'entry': { r.entries ??= {}; (r.entries[p.compId] ??= {})[p.from.id] = p.on ? { name: p.from.name, at: p.at, hdcp: p.hdcp ?? null } : undefined; if (!p.on) delete r.entries[p.compId][p.from.id]; break; }
    case 'score': { r.scores ??= {}; const s = (r.scores[p.compId] ??= {}); const cur = s[p.member.id]; if (!cur || p.at >= cur.at) s[p.member.id] = { name: p.member.name, holes: p.holes, at: p.at }; break; }
    case 'poll': (r.polls ??= {})[p.poll.id] = p.poll; sysMsg(r, p, `投票「${p.poll.q}」が作られました`); break;
    case 'vote': { r.votes ??= {}; const v = (r.votes[p.pollId] ??= {}); const cur = v[p.from.id]; if (!cur || p.at >= cur.at) v[p.from.id] = { name: p.from.name, picks: p.picks, at: p.at }; break; }
    case 'sync-req': if (p.from.id !== me().id) scheduleSync(code, p.at); break;
    case 'sync': mergeSync(r, p.data); break;
    case 'hello': sysMsg(r, p, `${p.from.name}さんが参加しました`); break;
    case 'course-intel': {
      // hole registrations + strategy notes for one course; newer entries win
      const { courseId, courseName, holes = {}, notes = {} } = p;
      let n = 0;
      state.userHoles ??= {}; const uh = (state.userHoles[courseId] ??= {});
      for (const [k, v] of Object.entries(holes)) if (!uh[k] || (v.updatedAt || 0) > (uh[k].updatedAt || 0)) { uh[k] = v; n++; }
      state.notes[courseId] ??= {};
      for (const [k, v] of Object.entries(notes)) if (!state.notes[courseId][k] || (v.updatedAt || 0) > (state.notes[courseId][k].updatedAt || 0)) { state.notes[courseId][k] = v; n++; }
      // today's pin positions (only if they are for today)
      const today = new Date().toISOString().slice(0, 10);
      if (p.pins && p.pinDate === today) {
        if (state.todayPins?.date !== today) state.todayPins = { date: today, c: {} };
        const tp = (state.todayPins.c[courseId] ??= {});
        for (const [k, v] of Object.entries(p.pins)) { tp[k] = v; n++; }
      }
      sysMsg(r, p, `${p.from.name}さんが「${courseName}」の攻略情報を共有しました${p.from.id !== me().id ? `（${n}件更新）` : ''}`);
      if (n && p.from.id !== me().id) window.dispatchEvent(new CustomEvent('course-intel', { detail: { courseId } }));
      break;
    }
  }
  save('group');
  if (code === active) renderRoom(); else renderRooms();
  updateBadge();
}
function sysMsg(r, p, text) { (r.msgs ??= []).push({ type: 'sys', mid: p.mid + 's', at: p.at, text }); }

let syncTimer = null;
function scheduleSync(code, reqAt) {
  clearTimeout(syncTimer);
  // one random member answers; others see the answer and stand down
  syncTimer = setTimeout(async () => {
    const r = room(code);
    if ((r.lastSyncAt || 0) > reqAt) return;
    const chunks = [];
    const data = { comps: r.comps || {}, entries: r.entries || {}, polls: r.polls || {}, votes: r.votes || {} };
    chunks.push(data);
    const scores = r.scores || {};
    for (const [cid, ms] of Object.entries(scores)) chunks.push({ scores: { [cid]: ms } });
    const msgs = (r.msgs || []).filter((m) => m.type !== 'sys').slice(-20);
    for (let i = 0; i < msgs.length; i += 5) chunks.push({ msgs: msgs.slice(i, i + 5) });
    for (const d of chunks) { try { await send(code, { type: 'sync', data: d }); } catch {} }
  }, 600 + Math.random() * 2500);
}
function mergeSync(r, d) {
  r.lastSyncAt = Date.now();
  for (const [id, c] of Object.entries(d.comps || {})) { const cur = (r.comps ??= {})[id]; if (!cur || c.updatedAt > cur.updatedAt) r.comps[id] = c; }
  for (const [cid, es] of Object.entries(d.entries || {})) Object.assign((r.entries ??= {})[cid] ??= {}, es);
  Object.assign((r.polls ??= {}), d.polls || {});
  for (const [pid, vs] of Object.entries(d.votes || {})) { const t = ((r.votes ??= {})[pid] ??= {}); for (const [m, v] of Object.entries(vs)) if (!t[m] || v.at > t[m].at) t[m] = v; }
  for (const [cid, ms] of Object.entries(d.scores || {})) { const t = ((r.scores ??= {})[cid] ??= {}); for (const [m, v] of Object.entries(ms)) if (!t[m] || v.at > t[m].at) t[m] = v; }
  if (d.msgs) { r.msgs ??= []; const have = new Set(r.msgs.map((m) => m.mid)); for (const m of d.msgs) if (!have.has(m.mid)) { r.msgs.push(m); r.seen[m.mid] = 1; } r.msgs.sort((a, b) => a.at - b.at); }
}

// ---------------- UI ----------------
export function initGroup() {
  $('#btnRoomNew').onclick = $('#btnRoomNew2').onclick = () => showSetup(false);
  $('#btnRoomJoin2').onclick = () => showSetup(true);
  $('#btnRoomJoinMode').onclick = () => showSetup(!joinMode);
  $('#btnRoomCancel').onclick = () => ($('#roomSetup').hidden = true);
  $('#btnRoomCreate').onclick = createOrJoin;
  $('#groupTabs').onclick = (e) => { const b = e.target.closest('[data-g]'); if (b) { gtab = b.dataset.g; renderRoom(); } };
  $('#chatForm').onsubmit = async (e) => {
    e.preventDefault();
    const t = $('#chatText').value.trim(); if (!t || !active) return;
    $('#chatText').value = '';
    try { await send(active, { type: 'chat', text: t.slice(0, 600) }); } catch (er) { toast(er.message); }
  };
  $('#btnCompNew').onclick = () => { $('#compForm').hidden = false; $('#cpDate').value ||= fmtDate(new Date(Date.now() + 14 * 864e5)); $('#cpCourse').value ||= state.course?.name || ''; };
  $('#btnCompCancel').onclick = () => ($('#compForm').hidden = true);
  $('#btnCompSave').onclick = createComp;
  $('#btnPollSave').onclick = createPoll;
  $('#btnPollDates').onclick = () => {
    const c = window.__bookingCheapest?.() || [];
    if (!c.length) { toast('先に予約タブで最安カレンダーを作ってください'); return; }
    $('#pollOpts').value = c.slice(0, 6).map((p) => `${p.date.slice(5).replace('-', '/')} ${p.course} ¥${p.price.toLocaleString('ja-JP')}`).join('\n');
    $('#pollQ').value ||= '次のラウンド、どの日にする？';
  };
  $('#roomBar').onclick = (e) => {
    const b = e.target.closest('[data-room]'); if (b) { active = b.dataset.room; state.ui.room = active; room().unread = 0; save('ui'); renderRoom(); updateBadge(); }
    if (e.target.closest('#btnInvite')) invite();
  };
  $('#chatList').onclick = (e) => { const b = e.target.closest('[data-url]'); if (b) window.open(b.dataset.url, '_blank', 'noopener'); };
  $('#compList').onclick = onCompClick;
  $('#pollList').onclick = onPollClick;

  // invite link: ?room=CODE&g=Name
  const q = new URLSearchParams(location.search);
  if (q.get('room')) {
    showSetup(true);
    $('#roomCode').value = q.get('room');
    $('#roomName').value = q.get('g') || '';
    history.replaceState(null, '', location.pathname);
    setTimeout(() => window.dispatchEvent(new CustomEvent('goto-tab', { detail: 'group' })), 50);
  }
  for (const code of Object.keys(rooms())) connect(code);
  active = state.ui.room && room(state.ui.room) ? state.ui.room : Object.keys(rooms())[0] || null;
  renderRoom(); updateBadge();
}

function showSetup(join) {
  joinMode = join;
  $('#roomSetup').hidden = false;
  $('#roomSetupTitle').textContent = join ? '招待コードで参加' : 'グループを作る';
  $('#roomCodeWrap').hidden = !join;
  $('#btnRoomCreate').textContent = join ? '参加' : '作成';
  $('#btnRoomJoinMode').textContent = join ? '新しく作る' : '招待コードで参加';
  $('#roomMyName').value ||= state.settings.name || '';
}

async function createOrJoin() {
  const name = $('#roomMyName').value.trim();
  if (!name) { toast('あなたの名前を入れてください'); return; }
  state.settings.name = name;
  const code = joinMode ? $('#roomCode').value.trim().toLowerCase() : newCode();
  if (joinMode && code.replace(/-/g, '').length < 12) { toast('招待コードが正しくありません'); return; }
  rooms()[code] ??= { name: $('#roomName').value.trim() || 'ゴルフ仲間', createdAt: Date.now(), msgs: [] };
  active = code; state.ui.room = code; save('room');
  $('#roomSetup').hidden = true;
  await connect(code);
  try {
    await send(code, { type: 'hello' });
    if (joinMode) await send(code, { type: 'sync-req' });
  } catch (e) { toast(e.message); }
  renderRoom();
  if (!joinMode) invite();
}

function inviteUrl() {
  const u = new URL(location.href.split('?')[0].split('#')[0]);
  u.searchParams.set('room', active); u.searchParams.set('g', room().name);
  u.searchParams.set('openExternalBrowser', '1'); // LINE opens it in Safari / Chrome
  return u.toString();
}
function invite() {
  const url = inviteUrl();
  shareOrDownload({ title: 'KUNIKUNIゴルフ 招待', text: `「${room().name}」に招待します。KUNIKUNIゴルフで開いてね（招待コード: ${active}）\n${url}` });
}

function renderRooms() {
  const rs = rooms();
  $('#roomBar').innerHTML = Object.entries(rs).map(([code, r]) => `<button class="room-chip ${code === active ? 'on' : ''}" data-room="${esc(code)}">${esc(r.name)}${r.unread && code !== active ? `<i>${r.unread}</i>` : ''}</button>`).join('')
    + (active ? '<button class="btn small" id="btnInvite">招待</button><span class="muted" id="roomStatus"></span>' : '');
}

export function renderRoom() {
  renderRooms();
  const has = !!active && !!room();
  $('#roomBody').hidden = !has; $('#roomEmpty').hidden = has;
  if (!has) return;
  $$('#groupTabs button').forEach((b) => b.classList.toggle('on', b.dataset.g === gtab));
  $$('.gpane').forEach((p) => (p.hidden = p.dataset.gp !== gtab));
  if (gtab === 'chat') renderChat();
  if (gtab === 'comp') renderComps();
  if (gtab === 'poll') renderPolls();
}

function renderChat() {
  const r = room(); r.unread = 0;
  const myId = me().id;
  const list = $('#chatList');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  list.innerHTML = (r.msgs || []).map((m) => {
    if (m.type === 'sys') return `<div class="msg sys">${esc(m.text)}</div>`;
    const mine = m.from?.id === myId;
    const time = new Date(m.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const body = m.type === 'plan'
      ? `<div class="plan-card"><b>${esc(m.plan.course)}</b><span>${esc(m.plan.date)} · ${esc(m.plan.plan)}</span><span class="price">¥${Number(m.plan.price).toLocaleString('ja-JP')}</span>${m.plan.url ? `<button class="btn small" data-url="${esc(m.plan.url)}">予約ページ</button>` : ''}${m.text ? `<p>${esc(m.text)}</p>` : ''}</div>`
      : esc(m.text);
    return `<div class="msg ${mine ? 'me' : ''}">${mine ? '' : `<span class="who">${esc(m.from?.name)}</span>`}<div class="bubble">${body}</div><span class="time">${time}</span></div>`;
  }).join('') || '<p class="muted">まだメッセージはありません。予約の相談をはじめましょう。</p>';
  if (atBottom || !list.dataset.init) { list.scrollTop = list.scrollHeight; list.dataset.init = '1'; }
  save('group');
}

export async function sharePlanToGroup(plan) {
  if (!active) { toast('先に「仲間」タブでグループを作ってください'); return false; }
  try { await send(active, { type: 'plan', plan, text: '' }); toast(`「${room().name}」に共有しました`); return true; }
  catch (e) { toast(e.message); return false; }
}
export function hasGroup() { return !!active; }

/** submit everyone's scores (from the scorecard / OCR) to the group's nearest competition */
export async function submitPlayersToComp(players) {
  if (!active) { toast('先に「仲間」タブでグループを作ってください'); return; }
  const r = room();
  const today = new Date().toISOString().slice(0, 10);
  const comps = Object.values(r.comps || {}).sort((a, b) => Math.abs(new Date(a.date) - new Date(today)) - Math.abs(new Date(b.date) - new Date(today)));
  const comp = comps[0];
  if (!comp) { toast('このグループにコンペがありません。「仲間」→「コンペ」で作れます'); return; }
  let n = 0;
  try {
    for (const p of players) {
      if (!p.holes?.some((x) => x)) continue;
      const member = p.me ? me() : { id: 'n:' + p.name, name: p.name };
      await send(active, { type: 'score', compId: comp.id, member, holes: p.holes.map((x) => x || 0) });
      n++;
    }
    toast(`「${comp.title}」に${n}人分のスコアを提出しました`);
  } catch (e) { toast(e.message); }
}

/** send this course's registered holes and notes to the active group */
export async function shareCourseIntel() {
  const c = state.course;
  if (!c) { toast('コースを選んでください'); return; }
  if (!active) { toast('先に「仲間」タブでグループを作ってください'); return; }
  const holes = state.userHoles?.[c.id] || {}, notes = state.notes?.[c.id] || {};
  const today = new Date().toISOString().slice(0, 10);
  const pins = state.todayPins?.date === today ? state.todayPins.c?.[c.id] || {} : {};
  if (!Object.keys(holes).length && !Object.keys(notes).length && !Object.keys(pins).length) { toast('共有できる登録ホール・攻略メモ・ピン位置がまだありません'); return; }
  try {
    // keep each message under the relay limit by sending holes, notes and pins separately when large
    const pinPart = Object.keys(pins).length ? { pins, pinDate: today } : {};
    const parts = JSON.stringify({ holes, notes, pins }).length > 2400 ? [{ holes }, { notes }, pinPart].filter((x) => Object.keys(x).length) : [{ holes, notes, ...pinPart }];
    for (const part of parts) await send(active, { type: 'course-intel', courseId: c.id, courseName: c.name, ...part });
    toast(`「${room().name}」に共有しました`);
  } catch (e) { toast(e.message); }
}

function updateBadge() {
  const n = Object.entries(rooms()).reduce((s, [c, r]) => s + (c === active && document.querySelector('#tab-group.active') ? 0 : r.unread || 0), 0);
  const b = $('#groupBadge'); if (!b) return;
  b.hidden = !n; b.textContent = n > 9 ? '9+' : n;
}
export function onGroupShown() { if (room()) { room().unread = 0; save('group'); } renderRoom(); updateBadge(); }

// ---------------- competitions ----------------
function pickHidden(pars) {
  // 新ペリア: 12 hidden holes, 6 per nine with par 24 (1 par3, 1 par5, 4 par4) when possible
  const out = [];
  for (const [a, b] of [[0, 9], [9, 18]]) {
    const idx = Array.from({ length: b - a }, (_, i) => a + i).sort(() => Math.random() - 0.5);
    const p3 = idx.filter((i) => pars[i] === 3), p4 = idx.filter((i) => pars[i] === 4), p5 = idx.filter((i) => pars[i] === 5);
    let pick = [...p3.slice(0, 1), ...p5.slice(0, 1)];
    pick = pick.concat(p4.slice(0, 6 - pick.length));
    if (pick.length < 6) pick = pick.concat(idx.filter((i) => !pick.includes(i)).slice(0, 6 - pick.length));
    out.push(...pick);
  }
  return out.sort((x, y) => x - y);
}

async function createComp() {
  const title = $('#cpTitle').value.trim();
  if (!title) { toast('コンペ名を入れてください'); return; }
  const pars = state.current?.holes?.map((h) => h.par) || Array(18).fill(4);
  const comp = {
    id: uid(), title, date: $('#cpDate').value, course: $('#cpCourse').value.trim(), start: $('#cpStart').value,
    format: $('#cpFormat').value, fee: Number($('#cpFee').value) || 0, notes: $('#cpNotes').value.trim(),
    pars, hidden: null, groups: null, by: me(), updatedAt: Date.now(), status: 'open',
  };
  try {
    await send(active, { type: 'comp', comp });
    await send(active, { type: 'entry', compId: comp.id, on: true });
    $('#compForm').hidden = true; $('#cpTitle').value = ''; $('#cpNotes').value = '';
    toast('コンペを作成して仲間に送りました');
  } catch (e) { toast(e.message); }
}

function leaderboard(comp, scores) {
  const rows = Object.entries(scores || {}).map(([id, s]) => {
    const played = s.holes.filter((x) => x).length;
    const gross = s.holes.reduce((a, x) => a + (x || 0), 0);
    let hdcp = 0;
    if (comp.format === 'newperia' && comp.hidden && played === 18) {
      const hs = comp.hidden.reduce((a, i) => a + Math.min(s.holes[i], comp.pars[i] * 2), 0);
      const parAll = comp.pars.reduce((a, b) => a + b, 0);
      hdcp = Math.max(0, Math.min(36, (hs * 1.5 - parAll) * 0.8));
    }
    return { id, name: s.name, played, gross, hdcp: Math.round(hdcp * 10) / 10, net: Math.round((gross - hdcp) * 10) / 10 };
  });
  const key = comp.format === 'newperia' && comp.hidden ? 'net' : 'gross';
  rows.sort((a, b) => (b.played === 18) - (a.played === 18) || a[key] - b[key] || a.gross - b.gross);
  return { rows, key };
}

function renderComps() {
  const r = room();
  const comps = Object.values(r.comps || {}).sort((a, b) => (a.date < b.date ? 1 : -1));
  const myId = me().id;
  $('#compList').innerHTML = comps.length ? comps.map((c) => {
    const entries = r.entries?.[c.id] || {};
    const ids = Object.keys(entries);
    const joined = !!entries[myId];
    const isHost = c.by?.id === myId;
    const lb = leaderboard(c, r.scores?.[c.id]);
    const names = (id) => esc(entries[id]?.name || r.members?.[id]?.name || '?');
    return `<div class="card comp" data-comp="${c.id}">
      <div class="card-head"><h2>${esc(c.title)}</h2><span class="pill">${c.format === 'newperia' ? '新ペリア' : 'ストローク'}</span></div>
      <div class="comp-meta"><span><b>${esc(c.date)}</b> ${esc(c.start || '')}〜</span><span>${esc(c.course || 'コース未定')}</span>${c.fee ? `<span>参加費 ¥${c.fee.toLocaleString('ja-JP')}</span>` : ''}<span>幹事 ${esc(c.by?.name)}</span></div>
      ${c.notes ? `<p class="comp-notes">${esc(c.notes)}</p>` : ''}
      <div class="entries"><b>参加 ${ids.length}名</b> ${ids.map(names).join('、')}</div>
      <div class="btn-row">
        <button class="btn small ${joined ? '' : 'primary'}" data-act="entry">${joined ? '参加を取り消す' : '参加する'}</button>
        <button class="btn small" data-act="submit">今のスコアを提出</button>
        ${isHost ? '<button class="btn small" data-act="groups">組み合わせ作成</button>' : ''}
        ${isHost && c.format === 'newperia' ? `<button class="btn small" data-act="hidden">${c.hidden ? '隠しホール再抽選' : '隠しホール決定'}</button>` : ''}
        <button class="btn small" data-act="share">結果を共有</button>
      </div>
      ${c.groups ? `<div class="groups">${c.groups.map((g, i) => `<div><span class="muted">${i + 1}組 ${esc(g.time)}</span> ${g.ids.map(names).join('・')}</div>`).join('')}</div>` : ''}
      ${c.hidden ? `<p class="muted">隠しホール: ${c.hidden.map((i) => i + 1).join(', ')}</p>` : ''}
      ${lb.rows.length ? `<div class="table-wrap"><table><tr><th>順位</th><th>名前</th><th>グロス</th>${lb.key === 'net' ? '<th>HDCP</th><th>ネット</th>' : ''}<th>H</th></tr>${lb.rows.map((x, i) => `<tr><td><b>${x.played === 18 ? i + 1 : '-'}</b></td><td>${esc(x.name)}</td><td>${x.gross}</td>${lb.key === 'net' ? `<td>${x.hdcp}</td><td><b>${x.net}</b></td>` : ''}<td>${x.played}</td></tr>`).join('')}</table></div>` : '<p class="muted">スコアが提出されると順位表が出ます。</p>'}
    </div>`;
  }).join('') : '<p class="muted">コンペはまだありません。「コンペを企画」から作れます。</p>';
}

async function onCompClick(e) {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const card = b.closest('[data-comp]'); const r = room(); const c = r.comps[card.dataset.comp];
  const myId = me().id;
  try {
    if (b.dataset.act === 'entry') await send(active, { type: 'entry', compId: c.id, on: !r.entries?.[c.id]?.[myId] });
    if (b.dataset.act === 'submit') {
      const holes = state.current.holes.map((h) => h.strokes || 0);
      if (!holes.some((x) => x)) { toast('スコアカードに入力してから提出してください'); return; }
      await send(active, { type: 'score', compId: c.id, member: me(), holes });
      toast(`スコア ${holes.reduce((a, x) => a + x, 0)} を提出しました`);
    }
    if (b.dataset.act === 'groups') {
      const ids = Object.keys(r.entries?.[c.id] || {}).sort(() => Math.random() - 0.5);
      const groups = []; const [hh, mm] = (c.start || '08:30').split(':').map(Number);
      const n = Math.ceil(ids.length / 4) || 1; const size = Math.ceil(ids.length / n);
      for (let i = 0; i < n; i++) { const t = new Date(2000, 0, 1, hh, mm + i * 7); groups.push({ time: t.toTimeString().slice(0, 5), ids: ids.slice(i * size, (i + 1) * size) }); }
      await send(active, { type: 'comp', comp: { ...c, groups, updatedAt: Date.now() } });
    }
    if (b.dataset.act === 'hidden') await send(active, { type: 'comp', comp: { ...c, hidden: pickHidden(c.pars), updatedAt: Date.now() } });
    if (b.dataset.act === 'share') {
      const lb = leaderboard(c, r.scores?.[c.id]);
      const text = `🏆 ${c.title}（${c.date} ${c.course}）\n` + lb.rows.map((x, i) => `${i + 1}位 ${x.name} ${lb.key === 'net' ? `ネット${x.net}（グロス${x.gross} HC${x.hdcp}）` : `${x.gross}`}`).join('\n');
      shareOrDownload({ title: c.title, text });
    }
  } catch (er) { toast(er.message); }
}

// ---------------- polls ----------------
async function createPoll() {
  const q = $('#pollQ').value.trim();
  const opts = $('#pollOpts').value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 10);
  if (!q || opts.length < 2) { toast('質問と2つ以上の候補を入れてください'); return; }
  try { await send(active, { type: 'poll', poll: { id: uid(), q, opts, by: me(), at: Date.now() } }); $('#pollQ').value = ''; $('#pollOpts').value = ''; }
  catch (e) { toast(e.message); }
}
function renderPolls() {
  const r = room(); const myId = me().id;
  const polls = Object.values(r.polls || {}).sort((a, b) => b.at - a.at);
  $('#pollList').innerHTML = polls.map((p) => {
    const votes = r.votes?.[p.id] || {};
    const mine = votes[myId]?.picks || [];
    const counts = p.opts.map((_, i) => Object.values(votes).filter((v) => v.picks.includes(i)));
    const max = Math.max(1, ...counts.map((c) => c.length));
    return `<div class="card poll" data-poll="${p.id}"><h2>${esc(p.q)}</h2><span class="muted">${esc(p.by?.name)}さん · 複数選択OK</span>
      ${p.opts.map((o, i) => `<button class="poll-opt ${mine.includes(i) ? 'on' : ''}" data-i="${i}"><span class="bar" style="width:${(counts[i].length / max) * 100}%"></span><span class="lbl">${esc(o)}</span><b>${counts[i].length}</b><span class="who">${counts[i].map((v) => esc(v.name)).join('・')}</span></button>`).join('')}</div>`;
  }).join('') || '<p class="muted">投票はまだありません。</p>';
}
async function onPollClick(e) {
  const b = e.target.closest('.poll-opt'); if (!b) return;
  const pid = b.closest('[data-poll]').dataset.poll; const i = Number(b.dataset.i);
  const r = room(); const cur = r.votes?.[pid]?.[me().id]?.picks || [];
  const picks = cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i];
  try { await send(active, { type: 'vote', pollId: pid, picks }); } catch (er) { toast(er.message); }
}
