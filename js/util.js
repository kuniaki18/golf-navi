export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const M_PER_YD = 0.9144;
export const m2y = (m) => m / M_PER_YD;
export const y2m = (y) => y * M_PER_YD;

let toastTimer;
export function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const R = 6371008.8;
const rad = Math.PI / 180;
/** great-circle distance in meters */
export function dist(a, b) {
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
/** initial bearing a→b in degrees (0 = north, clockwise) */
export function bearing(a, b) {
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}
/** local flat projection in meters around origin o (x = east, y = north) */
export function xy(o, p) {
  return { x: (p.lon - o.lon) * rad * R * Math.cos(o.lat * rad), y: (p.lat - o.lat) * rad * R };
}
export function unxy(o, v) {
  return { lat: o.lat + v.y / (rad * R), lon: o.lon + v.x / (rad * R * Math.cos(o.lat * rad)) };
}
export function centroid(pts) {
  const n = pts.length || 1;
  return { lat: pts.reduce((s, p) => s + p.lat, 0) / n, lon: pts.reduce((s, p) => s + p.lon, 0) / n };
}
/** distance from point p to polyline (meters) and how far along it the closest point is */
export function nearestOnLine(p, line) {
  if (!line.length) return { d: Infinity, along: 0, lateral: 0 };
  const o = line[0];
  const P = xy(o, p);
  let best = { d: Infinity, along: 0, lateral: 0 }, acc = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const A = xy(o, line[i]), B = xy(o, line[i + 1]);
    const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy || 1, L = Math.sqrt(L2);
    const t = clamp(((P.x - A.x) * dx + (P.y - A.y) * dy) / L2, 0, 1);
    const cx = A.x + t * dx, cy = A.y + t * dy;
    const d = Math.hypot(P.x - cx, P.y - cy);
    // cross > 0 → point is left of travel direction
    const cross = dx * (P.y - A.y) - dy * (P.x - A.x);
    if (d < best.d) best = { d, along: acc + t * L, lateral: Math.sign(cross) * d };
    acc += L;
  }
  return best;
}
export function lineLength(line) {
  let s = 0;
  for (let i = 0; i < line.length - 1; i++) s += dist(line[i], line[i + 1]);
  return s;
}

export function fmtDate(d) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** tiny, safe markdown → HTML for AI answers */
export function md(text) {
  const lines = esc(text).split(/\r?\n/);
  let html = '', inList = false;
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
  for (const raw of lines) {
    const l = raw.trimEnd();
    const li = l.match(/^\s*(?:[-*・]|\d+[.)])\s+(.*)$/);
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    const h = l.match(/^#{1,4}\s+(.*)$/);
    if (h) html += `<h3>${inline(h[1])}</h3>`;
    else if (l.trim()) html += `<p>${inline(l)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

export async function fetchJSON(url, opts = {}, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!r.ok) { const e = new Error(data?.error_description || data?.error?.message || data?.error || `HTTP ${r.status}`); e.status = r.status; e.data = data; throw e; }
    return data;
  } finally { clearTimeout(t); }
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('コピーしました'); }
  catch { toast('長押ししてコピーしてください'); }
}

export async function shareOrDownload({ title, text, filename, blob }) {
  if (blob && navigator.canShare) {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare({ files: [file] })) {
      try { await navigator.share({ title, text, files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
  }
  if (!blob && navigator.share) {
    try { await navigator.share({ title, text }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  if (blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } else {
    copyText(text);
  }
}

export const PREFS = ['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'];
