// Round memories: photos (IndexedDB, compressed), today's members and their final scores, a note,
// the weather of the day, an album view per round, and a shareable memory card image.
import { $, esc, toast, shareOrDownload, uid } from './util.js';
import { state, save } from './store.js';

// ---------------- IndexedDB photo store ----------------
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open('kunikuni-golf', 1);
    r.onupgradeneeded = () => { const s = r.result.createObjectStore('photos', { keyPath: 'id' }); s.createIndex('roundId', 'roundId'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction('photos', mode); const s = t.objectStore('photos'); const out = fn(s); t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error); });
}
export async function photosOf(roundId) {
  const d = await db();
  return new Promise((res, rej) => { const r = d.transaction('photos').objectStore('photos').index('roundId').getAll(roundId); r.onsuccess = () => res(r.result.sort((a, b) => a.at - b.at)); r.onerror = () => rej(r.error); });
}
const putPhoto = (p) => tx('readwrite', (s) => s.put(p));
const delPhoto = (id) => tx('readwrite', (s) => s.delete(id));

async function compress(file, max, q) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', q));
}

export async function addPhotos(files, roundId) {
  for (const f of files) {
    try {
      const [full, thumb] = await Promise.all([compress(f, 1600, 0.82), compress(f, 360, 0.7)]);
      await putPhoto({ id: uid(), roundId, at: f.lastModified || Date.now(), full, thumb, caption: '' });
    } catch { toast('保存できない画像がありました'); }
  }
}

// ---------------- UI on the scorecard screen ----------------
let urls = [];
export function initMemory() {
  try { navigator.storage?.persist?.(); } catch {}
  $('#memPhotos').onchange = async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    if (!files.length) return;
    toast(`${files.length}枚を保存しています…`);
    await addPhotos(files, state.current.id);
    renderGrid();
  };
  $('#memText').oninput = () => { state.current.memo = $('#memText').value; save('round'); };
  $('#memGrid').onclick = async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.textContent = '削除?'; return; } await delPhoto(del.dataset.del); renderGrid(); return; }
    const img = e.target.closest('[data-view]'); if (img) viewPhoto(img.dataset.view, state.current.id);
  };
  $('#btnMemCard').onclick = () => shareCard(state.current);
  $('#memClose').onclick = () => ($('#photoViewer').hidden = true);
  window.addEventListener('round-changed', renderAll);
  renderAll();
}

export function renderAll() {
  $('#memText').value = state.current?.memo || '';
  renderGrid();
}

async function renderGrid() {
  const r = state.current; if (!r) return;
  urls.forEach((u) => URL.revokeObjectURL(u)); urls = [];
  let list = [];
  try { list = await photosOf(r.id); } catch {}
  $('#memGrid').innerHTML = list.length ? list.map((p) => { const u = URL.createObjectURL(p.thumb); urls.push(u); return `<div class="mem-ph"><img src="${u}" alt="" data-view="${p.id}"><button class="mem-del" data-del="${p.id}" aria-label="削除">×</button></div>`; }).join('') : '<p class="muted">写真を追加すると、この日の思い出としてラウンドと一緒に残ります。</p>';
}

async function viewPhoto(id, roundId) {
  const list = await photosOf(roundId);
  const p = list.find((x) => x.id === id); if (!p) return;
  const u = URL.createObjectURL(p.full); urls.push(u);
  $('#photoViewerImg').src = u; $('#photoViewer').hidden = false;
}

// ---------------- memory album (one round) ----------------
export async function openMemory(roundId) {
  const r = state.rounds.find((x) => x.id === roundId) || (state.current?.id === roundId ? state.current : null);
  const box = $('#memoryBody');
  if (!r) { box.innerHTML = '<p class="muted">ラウンドが見つかりません</p>'; return; }
  let photos = [];
  try { photos = await photosOf(r.id); } catch {}
  urls.forEach((u) => URL.revokeObjectURL(u)); urls = [];
  const players = rankPlayers(r);
  const mine = myTotal(r);
  const wx = r.weather;
  $('#memTitle').textContent = r.course || 'ラウンド';
  box.innerHTML = `
    <p class="muted">${esc(r.date)}${wx ? ` · ${esc(wx.text || '')} ${wx.temp != null ? Math.round(wx.temp) + '℃' : ''} ${wx.wind != null ? '風' + wx.wind.toFixed(1) + 'm/s' : ''}` : ''}</p>
    ${photos.length ? `<div class="mem-hero"><img src="${(urls[urls.push(URL.createObjectURL(photos[0].full)) - 1])}" alt=""></div>` : ''}
    <div class="card">
      <div class="card-head"><h2>今日の結果</h2><span class="pill">${players.length}人</span></div>
      ${players.length ? `<ol class="mem-rank">${players.map((p, i) => `<li class="${p.me ? 'me' : ''}"><span class="rk">${i + 1}</span><b>${esc(p.name)}</b><span class="sc">${p.total || '-'}</span><span class="muted">OUT ${p.out || '-'} / IN ${p.in || '-'}</span></li>`).join('')}</ol>` : `<p>自分のスコア <b>${mine || '-'}</b></p>`}
    </div>
    ${r.memo ? `<div class="card"><h2>ひとこと</h2><p class="mem-note">${esc(r.memo)}</p></div>` : ''}
    ${photos.length > 1 ? `<div class="mem-gallery">${photos.slice(1).map((p) => { const u = URL.createObjectURL(p.thumb); urls.push(u); return `<img src="${u}" alt="" data-view="${p.id}">`; }).join('')}</div>` : ''}
    <div class="btn-row"><button class="btn primary" id="btnMemShare">思い出カードを共有</button></div>`;
  box.querySelector('.mem-gallery')?.addEventListener('click', (e) => { const i = e.target.closest('[data-view]'); if (i) viewPhoto(i.dataset.view, r.id); });
  $('#btnMemShare').onclick = () => shareCard(r);
}

function myTotal(r) { return r.holes.reduce((a, h) => a + (h.strokes || 0), 0); }
export function rankPlayers(r) {
  const list = (r.players || []).map((p) => ({ ...p, ...sums(p.holes, p.total) }));
  const myName = state.settings.name || '自分';
  if (!list.some((p) => p.me) && myTotal(r)) list.unshift({ name: myName, me: true, holes: r.holes.map((h) => h.strokes || null), ...sums(r.holes.map((h) => h.strokes || null)) });
  return list.filter((p) => p.total).sort((a, b) => a.total - b.total);
}
export function sums(holes = [], total) {
  const n = (a) => a.reduce((s, x) => s + (Number(x) || 0), 0);
  const out = n(holes.slice(0, 9)), inn = n(holes.slice(9, 18));
  return { out: out || null, in: inn || null, total: Number(total) || out + inn || null };
}

// ---------------- shareable memory card ----------------
export async function shareCard(r) {
  if (!r) return;
  const blob = await buildCard(r);
  await shareOrDownload({ title: `${r.course} ${r.date}`, text: `${r.date} ${r.course} #KUNIKUNIゴルフ`, filename: `golf-${r.date}.jpg`, blob });
}

export async function buildCard(r) {
  const W = 1080, H = 1350;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#123524'; g.fillRect(0, 0, W, H);
  let photos = []; try { photos = await photosOf(r.id); } catch {}
  if (photos.length) {
    const bmp = await createImageBitmap(photos[0].full);
    const s = Math.max(W / bmp.width, (H * 0.54) / bmp.height);
    g.save(); g.beginPath(); g.rect(0, 0, W, H * 0.56); g.clip();
    g.drawImage(bmp, (W - bmp.width * s) / 2, (H * 0.54 - bmp.height * s) / 2, bmp.width * s, bmp.height * s);
    g.restore();
    const grad = g.createLinearGradient(0, H * 0.28, 0, H * 0.56); grad.addColorStop(0, 'rgba(18,53,36,0)'); grad.addColorStop(1, 'rgba(18,53,36,1)');
    g.fillStyle = grad; g.fillRect(0, 0, W, H * 0.56);
    // small collage of the next photos
    const rest = photos.slice(1, 4);
    for (let i = 0; i < rest.length; i++) {
      const b = await createImageBitmap(rest[i].thumb); const sz = 200, x = W - 60 - (i + 1) * (sz + 16) + 16, y = 60;
      const ss = Math.max(sz / b.width, sz / b.height);
      g.save(); g.beginPath(); g.roundRect ? g.roundRect(x, y, sz, sz, 20) : g.rect(x, y, sz, sz); g.clip();
      g.drawImage(b, x + (sz - b.width * ss) / 2, y + (sz - b.height * ss) / 2, b.width * ss, b.height * ss); g.restore();
      g.strokeStyle = '#fff'; g.lineWidth = 6; g.beginPath(); g.roundRect ? g.roundRect(x, y, sz, sz, 20) : g.rect(x, y, sz, sz); g.stroke();
    }
  }
  const F = '"Zen Kaku Gothic New", "Hiragino Sans", sans-serif', D = '"Barlow Condensed", sans-serif';
  g.fillStyle = '#f2c94c'; g.font = `700 40px ${D}`; g.fillText(r.date.replace(/-/g, '.'), 70, H * 0.5);
  g.fillStyle = '#fff'; g.font = `700 60px ${F}`;
  const tl = wrap(g, r.course || 'ゴルフ', 70, H * 0.5 + 76, W - 140, 68);
  const players = rankPlayers(r).slice(0, tl > 1 ? 5 : 6);
  let y = H * 0.5 + 70 + tl * 68 + 50;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    g.fillStyle = p.me ? 'rgba(242,201,76,.22)' : 'rgba(255,255,255,.07)';
    g.fillRect(60, y - 52, W - 120, 72);
    g.fillStyle = i === 0 ? '#f2c94c' : '#cfe3d4'; g.font = `700 44px ${D}`; g.fillText(String(i + 1), 84, y);
    g.fillStyle = '#fff'; g.font = `700 40px ${F}`; g.fillText(trim(g, p.name, 520), 150, y);
    g.font = `700 56px ${D}`; g.textAlign = 'right'; g.fillStyle = p.me ? '#f2c94c' : '#fff'; g.fillText(String(p.total), W - 90, y + 4);
    g.font = `500 28px ${D}`; g.fillStyle = '#a8c2b1'; g.fillText(`${p.out || '-'} / ${p.in || '-'}`, W - 220, y); g.textAlign = 'left';
    y += 86;
  }
  if (r.memo && y < H - 110) { g.fillStyle = '#e8f1eb'; g.font = `500 32px ${F}`; wrap(g, '“' + r.memo + '”', 70, y + 10, W - 140, 44, 2); }
  g.fillStyle = '#f2c94c'; g.font = `700 30px ${D}`; g.fillText('KUNIKUNI GOLF', 70, H - 50);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
}
function trim(g, s, w) { if (g.measureText(s).width <= w) return s; while (s && g.measureText(s + '…').width > w) s = s.slice(0, -1); return s + '…'; }
function wrap(g, text, x, y, w, lh, maxLines = 2) {
  let lines = [], line = '';
  for (const ch of [...text]) { if (g.measureText(line + ch).width > w) { lines.push(line); line = ch; } else line += ch; }
  if (line) lines.push(line);
  if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] = trim(g, lines[maxLines - 1] + '…', w); }
  lines.forEach((l, i) => g.fillText(l, x, y + i * lh));
  return lines.length;
}

// ---------------- weather snapshot when a round is saved ----------------
export async function snapshotWeather(r) {
  if (r.weather || !state.course) return;
  try {
    const { weather } = await import('./advice.js');
    const w = await weather(state.course.lat, state.course.lon);
    r.weather = { temp: w.temp, wind: w.speed, text: w.rain > 0 ? '雨' : '' };
  } catch {}
}
