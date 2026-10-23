// Rotated hole view: satellite tiles drawn on a canvas with the tee at the bottom and the green at the top,
// distance arcs, hazard carries, a draggable target and a green close-up for setting today's pin.
import { dist, bearing, m2y, y2m } from './util.js';

// aerial imagery: 国土地理院 seamless photo (free incl. commercial use with credit) or Esri World Imagery
export const IMAGERY = {
  gsi: { url: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`, max: 18, credit: '国土地理院' },
  esri: { url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`, max: 19, credit: 'Esri World Imagery' },
};
let imagery = IMAGERY.gsi;
export function setImagery(name) { imagery = IMAGERY[name] || IMAGERY.gsi; tileCache.clear(); }
const TILE = (z, x, y) => imagery.url(z, x, y);
const tileCache = new Map();
const rad = Math.PI / 180;
const wx = (lon) => ((lon + 180) / 360) * 256;
const wy = (lat) => { const s = Math.sin(lat * rad); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256; };
const lonOf = (x) => (x / 256) * 360 - 180;
const latOf = (y) => { const n = Math.PI - (2 * Math.PI * y) / 256; return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };

export class HoleView {
  constructor(canvas, { onTap, onPin, tiles = true, interactive = true } = {}) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.useTiles = tiles; this.interactive = interactive;
    this.onTap = onTap; this.onPin = onPin;
    this.mode = 'hole'; this.zoomMul = 1; this.pan = { x: 0, y: 0 };
    this.d = null; this.pending = false;
    if (interactive) this._gestures();
    new ResizeObserver(() => this.render()).observe(canvas);
  }
  set(data) { this.d = { ...this.d, ...data }; this.render(); }
  setMode(m) { this.mode = m; this.zoomMul = 1; this.pan = { x: 0, y: 0 }; this.render(); }
  resetView() { this.zoomMul = 1; this.pan = { x: 0, y: 0 }; this.render(); }

  // ---------- geometry ----------
  _frame() {
    const d = this.d; const h = d?.hole;
    const green0 = h && (d.pin || h.center);
    if (!green0) {
      // unmapped hole: plain aerial view around the player (or the course) so the user can tap tee → green
      const c = d?.area; if (!c) return null;
      const W = this.cv.clientWidth, H = this.cv.clientHeight;
      const mpu = 156543.03 * Math.cos(c.lat * rad);
      const s = (Math.min(W, H) / ((d.areaSpan || 450) / mpu)) * this.zoomMul;
      const c0 = { x: wx(c.lon), y: wy(c.lat) };
      return { a: 0, c0, s, cx: 0, cy: 0, W, H, green: c, brg: 0, origin: null, empty: true };
    }
    if (!h) return null;
    const green = green0;
    const origin = this._origin();
    const from = h.tee || origin || green;
    const brg = from === green ? 0 : bearing(from, green);
    const a = -brg * rad;
    let pois;
    if (this.mode === 'green') {
      const gp = h.green?.pts?.length ? h.green.pts : [green];
      pois = gp.concat([green]);
    } else {
      pois = [...(h.line?.length ? h.line : []), green, h.tee, origin && dist(origin, green) < 650 ? origin : null, d.target].filter(Boolean);
    }
    const c0 = { x: wx(green.lon), y: wy(green.lat) };
    const rot = (p) => { const x = wx(p.lon) - c0.x, y = wy(p.lat) - c0.y; return { x: Math.cos(a) * x - Math.sin(a) * y, y: Math.sin(a) * x + Math.cos(a) * y }; };
    const rs = pois.map(rot);
    let minX = Math.min(...rs.map((p) => p.x)), maxX = Math.max(...rs.map((p) => p.x)), minY = Math.min(...rs.map((p) => p.y)), maxY = Math.max(...rs.map((p) => p.y));
    const W = this.cv.clientWidth, H = this.cv.clientHeight;
    const pad = this.mode === 'green' ? 0.35 : 0.12;
    const bw = Math.max(maxX - minX, 1e-6), bh = Math.max(maxY - minY, 1e-6);
    // meters → minimum span so tiny greens / short holes don't over-zoom
    const mpu = 156543.03 * Math.cos(green.lat * rad) / 1; // meters per world unit at z0 (per 256px)
    const minSpan = (this.mode === 'green' ? 45 : 140) / mpu;
    let s = Math.min(W / Math.max(bw, minSpan * (W / H)) , H / Math.max(bh, minSpan)) * (1 - pad * 2);
    s *= this.zoomMul;
    s = Math.min(s, 2 ** 20.5);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    return { a, c0, s, cx, cy, W, H, green, brg, origin };
  }
  _toScreen(f, p) {
    const x = wx(p.lon) - f.c0.x, y = wy(p.lat) - f.c0.y;
    const rx = Math.cos(f.a) * x - Math.sin(f.a) * y, ry = Math.sin(f.a) * x + Math.cos(f.a) * y;
    return { x: (rx - f.cx) * f.s + f.W / 2 + this.pan.x, y: (ry - f.cy) * f.s + f.H / 2 + this.pan.y };
  }
  _toLatLon(f, sx, sy) {
    const rx = (sx - f.W / 2 - this.pan.x) / f.s + f.cx, ry = (sy - f.H / 2 - this.pan.y) / f.s + f.cy;
    const x = Math.cos(-f.a) * rx - Math.sin(-f.a) * ry, y = Math.sin(-f.a) * rx + Math.cos(-f.a) * ry;
    return { lat: latOf(y + f.c0.y), lon: lonOf(x + f.c0.x) };
  }
  _origin() {
    const d = this.d, h = d.hole;
    const g = d.pin || h.center;
    if (d.me && g && dist(d.me, g) < 700) return d.me;
    return h.tee || null;
  }

  // ---------- drawing ----------
  render() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this._draw(); });
  }
  _draw() {
    const cv = this.cv, ctx = this.ctx, dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#1b2b20'; ctx.fillRect(0, 0, W, H);
    const f = this._frame();
    this.f = f;
    if (!f) { ctx.fillStyle = '#cfe3d4'; ctx.font = '14px system-ui'; ctx.textAlign = 'center'; ctx.fillText(this.d?.emptyText || 'グリーン位置が未登録です', W / 2, H / 2); return; }
    if (this.useTiles) this._tiles(f, dpr); else this._tilesLoaded = false;
    if (f.empty) {
      const S0 = (p) => this._toScreen(f, p);
      for (const [k, col] of [['tee', '#ffffff'], ['green', '#9cff9c']]) {
        const p = this.d.draft?.[k]; if (!p) continue;
        const q = S0(p); ctx.fillStyle = col; ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(q.x, q.y, 8, 0, 7); ctx.fill(); ctx.stroke();
      }
      if (this.d.me) { const m = S0(this.d.me); ctx.fillStyle = '#2f8bff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(m.x, m.y, 8, 0, 7); ctx.fill(); ctx.stroke(); }
      ctx.font = '600 13px system-ui';
      tag(ctx, W / 2, 62, this.d.emptyText || '', 'rgba(0,0,0,.72)', '#fff');
      return;
    }
    const d = this.d, h = d.hole, unit = d.unit || 'yd';
    const S = (p) => this._toScreen(f, p);
    const fmt = (m) => Math.round(unit === 'm' ? m : m2y(m));
    const satOk = this._tilesLoaded;

    // vector layers
    const polyPath = (pts) => { ctx.beginPath(); pts.forEach((p, i) => { const q = S(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.closePath(); };
    const near = (arr) => (arr || []).filter((x) => x.c && dist(x.c, f.green) < 700);
    for (const fw of near(d.features?.fairways)) { polyPath(fw.pts); ctx.fillStyle = satOk ? 'rgba(120,200,110,.10)' : 'rgba(70,140,70,.8)'; ctx.fill(); }
    for (const w of near(d.features?.water)) { polyPath(w.pts); ctx.fillStyle = satOk ? 'rgba(60,150,255,.25)' : 'rgba(40,110,200,.9)'; ctx.fill(); ctx.strokeStyle = 'rgba(120,190,255,.9)'; ctx.lineWidth = 1.5; ctx.stroke(); }
    for (const b of near(d.features?.bunkers)) { polyPath(b.pts); ctx.fillStyle = satOk ? 'rgba(240,220,160,.22)' : 'rgba(230,210,150,.95)'; ctx.fill(); ctx.strokeStyle = 'rgba(255,236,180,.9)'; ctx.lineWidth = 1.2; ctx.stroke(); }
    for (const t of near(d.features?.tees)) { polyPath(t.pts); ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = 1; ctx.stroke(); }
    for (const g of near(d.features?.greens)) { polyPath(g.pts); ctx.fillStyle = satOk ? (g === h.green ? 'rgba(150,255,150,.18)' : 'rgba(150,255,150,.06)') : 'rgba(110,200,110,.95)'; ctx.fill(); ctx.strokeStyle = g === h.green ? 'rgba(220,255,220,.95)' : 'rgba(200,255,200,.4)'; ctx.lineWidth = g === h.green ? 2 : 1; ctx.stroke(); }

    // hole center line
    if (h.line?.length >= 2 && this.mode === 'hole') {
      ctx.setLineDash([6, 6]); ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); h.line.forEach((p, i) => { const q = S(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.stroke(); ctx.setLineDash([]);
    }

    const O = f.origin;
    // distance arcs from origin toward the green
    if (O && this.mode === 'hole') {
      const toG = dist(O, f.green);
      const stepU = unit === 'm' ? 50 : 50;
      const o = S(O), g = S(f.green);
      const ang = Math.atan2(g.y - o.y, g.x - o.x);
      const pxPerM = Math.hypot(g.x - o.x, g.y - o.y) / Math.max(toG, 1);
      ctx.font = '600 12px "Barlow Condensed", system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (d.arcs?.length && this.interactive) {
        // club arcs: where each club in the bag lands from here
        const clubs = d.arcs.filter((c) => c.carry > 0).map((c) => ({ ...c, m: y2m(c.carry) })).filter((c) => c.m < toG + 25).sort((a, b) => b.m - a.m).slice(0, 5);
        // labels alternate sides so neighbouring clubs don't overlap
        let lastL = -1e9, lastR = -1e9;
        clubs.forEach((c, i) => {
          const r = c.m * pxPerM;
          ctx.strokeStyle = i === 0 ? '#ffd60a' : 'rgba(255,214,10,.6)'; ctx.lineWidth = i === 0 ? 2.2 : 1.4;
          ctx.beginPath(); ctx.arc(o.x, o.y, r, ang - 0.3, ang + 0.3); ctx.stroke();
          const left = Math.abs(r - lastL) >= 20 || Math.abs(r - lastR) < 20;
          if (Math.abs(r - (left ? lastL : lastR)) < 20) return; // both sides crowded: arc only
          const side = left ? -0.34 : 0.34;
          if (left) lastL = r; else lastR = r;
          const lx = o.x + Math.cos(ang + side) * r, ly = o.y + Math.sin(ang + side) * r;
          tag(ctx, lx, ly, `${c.name} ${Math.round(unit === 'm' ? c.m : c.carry)}`, 'rgba(26,20,0,.75)', '#ffd60a');
        });
      }
      for (let u = stepU * 2; !(d.arcs?.length && this.interactive); u += stepU) {
        const m = unit === 'm' ? u : y2m(u);
        if (m > toG - 15) break;
        const r = m * pxPerM;
        ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(o.x, o.y, r, ang - 0.32, ang + 0.32); ctx.stroke();
        const lx = o.x + Math.cos(ang + 0.36) * r, ly = o.y + Math.sin(ang + 0.36) * r;
        if (this.interactive) tag(ctx, lx, ly, String(u), 'rgba(0,0,0,.55)', '#fff');
      }
    }

    // hazard carries (from origin)
    if (O && this.mode === 'hole' && this.interactive) {
      for (const hz of d.hazards || []) {
        if (!hz.hz?.pts?.length) continue;
        const ds = hz.hz.pts.map((p) => dist(O, p));
        const front = Math.min(...ds), back = Math.max(...ds);
        if (dist(O, hz.hz.c) > dist(O, f.green) + 30 || back < 10) continue;
        const q = S(hz.hz.c);
        tag(ctx, q.x, q.y, `${fmt(front)}/${fmt(back)}`, hz.type === 'water' ? 'rgba(20,90,190,.85)' : 'rgba(120,95,40,.85)', '#fff');
      }
    }

    // today's recorded shots on this hole
    if (this.mode === 'hole' && d.shots?.length) {
      ctx.save();
      for (const sh of d.shots) {
        const a = S(sh.from), b = S(sh.to);
        ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 2; ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo((a.x + b.x) / 2 + (b.y - a.y) * 0.08, (a.y + b.y) / 2 - Math.abs(b.x - a.x) * 0.08, b.x, b.y); ctx.stroke();
        ctx.setLineDash([]); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(b.x, b.y, 4, 0, 7); ctx.fill();
        if (this.interactive) { ctx.font = '600 11px "Barlow Condensed", system-ui'; tag(ctx, b.x + 22, b.y, `${sh.club} ${unit === 'm' ? Math.round(sh.yards * 0.9144) : sh.yards}`, 'rgba(0,0,0,.6)', '#fff'); }
      }
      ctx.restore();
    }

    // wind arrow (relative to the rotated view)
    if (d.wind && Number.isFinite(d.wind.speed) && this.interactive && this.mode === 'hole') {
      const toward = ((d.wind.dir + 180) * Math.PI) / 180 + f.a; // meteorological "from" → blowing toward
      const cx = 30, cy = 70;
      ctx.save(); ctx.translate(cx, cy);
      ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.beginPath(); ctx.arc(0, 0, 20, 0, 7); ctx.fill();
      ctx.rotate(toward);
      ctx.strokeStyle = '#7fdcff'; ctx.fillStyle = '#7fdcff'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(0, 12); ctx.lineTo(0, -8); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(6, -5); ctx.lineTo(-6, -5); ctx.fill();
      ctx.restore();
      ctx.font = '700 12px "Barlow Condensed", system-ui';
      tag(ctx, cx, cy + 30, `${d.wind.speed.toFixed(1)}m`, 'rgba(0,0,0,.6)', '#7fdcff');
    }

    // target
    if (d.target && O) {
      const o = S(O), t = S(d.target), g = S(f.green);
      ctx.strokeStyle = '#ffd60a'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(t.x, t.y); ctx.lineTo(g.x, g.y); ctx.stroke();
      ctx.fillStyle = 'rgba(255,214,10,.25)'; ctx.beginPath(); ctx.arc(t.x, t.y, 13, 0, 7); ctx.fill();
      ctx.strokeStyle = '#ffd60a'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(t.x, t.y, 9, 0, 7); ctx.stroke();
      ctx.font = '700 15px "Barlow Condensed", system-ui';
      tag(ctx, (o.x + t.x) / 2, (o.y + t.y) / 2, String(fmt(dist(O, d.target))), '#ffd60a', '#1a1400');
      tag(ctx, (t.x + g.x) / 2, (t.y + g.y) / 2, String(fmt(dist(d.target, f.green))), 'rgba(0,0,0,.75)', '#ffd60a');
    }

    // flag
    const g = S(f.green);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(g.x, g.y); ctx.lineTo(g.x, g.y - 24); ctx.stroke();
    ctx.fillStyle = d.pin ? '#ff3b30' : '#ffd60a'; ctx.beginPath(); ctx.moveTo(g.x, g.y - 24); ctx.lineTo(g.x + 14, g.y - 19); ctx.lineTo(g.x, g.y - 14); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(g.x, g.y, 2.5, 0, 7); ctx.fill();

    // green slope arrows (downhill), from the elevation analysis
    if (this.mode === 'green' && d.slope && d.slope.conf && d.slope.conf.level !== 'none') {
      const gp = h.green?.pts?.length ? h.green.pts : null;
      const ctr = S(f.green);
      const span = gp ? Math.max(...gp.map((p) => Math.hypot(S(p).x - ctr.x, S(p).y - ctr.y))) : 60;
      const ang = (d.slope.downBearing * Math.PI) / 180 + f.a; // screen rotation of the downhill direction
      const len = Math.min(26, 10 + d.slope.pct * 5);
      ctx.save();
      for (let gy = -2; gy <= 2; gy++) for (let gx = -2; gx <= 2; gx++) {
        const px = ctr.x + gx * span * 0.38, py = ctr.y + gy * span * 0.38;
        if (gp) { const ll = this._toLatLon(f, px, py); let ins = false; for (let i = 0, j = gp.length - 1; i < gp.length; j = i++) { const a = gp[i], b = gp[j]; if ((a.lat > ll.lat) !== (b.lat > ll.lat) && ll.lon < ((b.lon - a.lon) * (ll.lat - a.lat)) / (b.lat - a.lat) + a.lon) ins = !ins; } if (!ins) continue; }
        ctx.save(); ctx.translate(px, py); ctx.rotate(ang);
        ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, len / 2); ctx.lineTo(0, -len / 2 + 5); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, -len / 2); ctx.lineTo(4, -len / 2 + 6); ctx.lineTo(-4, -len / 2 + 6); ctx.fill();
        ctx.restore();
      }
      ctx.restore();
      ctx.font = '700 12px system-ui';
      tag(ctx, W / 2, 62, `傾斜 ${d.slope.pct.toFixed(1)}%±${d.slope.pctSE.toFixed(1)} 信頼度${d.slope.conf.label}（矢印＝下り）`, 'rgba(0,0,0,.7)', '#fff');
    }

    // green distances / pin hint
    if (this.mode === 'green') {
      ctx.font = '600 13px system-ui'; ctx.textAlign = 'center';
      tag(ctx, W / 2, H - 46, d.pin ? '今日のピン位置を設定済み（タップで変更）' : 'グリーン上をタップして今日のピン位置を設定', 'rgba(0,0,0,.7)', '#fff');
      if (d.me) {
        ctx.font = '700 15px "Barlow Condensed", system-ui';
        tag(ctx, g.x, g.y + 18, String(fmt(dist(d.me, f.green))), 'rgba(0,0,0,.75)', '#ffd60a');
      }
    }

    // player
    if (d.me) {
      const m = S(d.me);
      if (m.x > -20 && m.x < W + 20 && m.y > -20 && m.y < H + 20) {
        const accPx = (d.acc || 5) * (Math.hypot(g.x - m.x, g.y - m.y) / Math.max(dist(d.me, f.green), 1));
        ctx.fillStyle = 'rgba(47,139,255,.18)'; ctx.beginPath(); ctx.arc(m.x, m.y, Math.min(accPx, 60), 0, 7); ctx.fill();
        // facing direction (compass): a soft cone
        if (Number.isFinite(d.heading)) {
          const hd = (d.heading * Math.PI) / 180 + f.a - Math.PI / 2;
          const gr = ctx.createRadialGradient(m.x, m.y, 4, m.x, m.y, 46); gr.addColorStop(0, 'rgba(47,139,255,.55)'); gr.addColorStop(1, 'rgba(47,139,255,0)');
          ctx.fillStyle = gr; ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.arc(m.x, m.y, 46, hd - 0.38, hd + 0.38); ctx.closePath(); ctx.fill();
        }
        ctx.fillStyle = '#2f8bff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(m.x, m.y, 8, 0, 7); ctx.fill(); ctx.stroke();
      }
    }
    // tee marker when player is elsewhere
    if (h.tee && this.mode === 'hole' && (!d.me || dist(d.me, h.tee) > 30)) {
      const t = S(h.tee); ctx.fillStyle = '#fff'; ctx.fillRect(t.x - 4, t.y - 4, 8, 8);
    }
    // compass hint: north arrow
    ctx.save(); ctx.translate(W - 22, H - 22); ctx.rotate(f.a); ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.beginPath(); ctx.arc(0, 0, 13, 0, 7); ctx.fill();
    ctx.fillStyle = '#ff6b5e'; ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(4, 0); ctx.lineTo(-4, 0); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(0, 10); ctx.lineTo(4, 0); ctx.lineTo(-4, 0); ctx.fill(); ctx.restore();
  }

  _tiles(f, dpr) {
    const ctx = this.ctx;
    let z = Math.round(Math.log2((f.s * dpr) / 1.4));
    z = Math.max(3, Math.min(imagery.max, z));
    const n = 2 ** z, T = 256 / n;
    const corners = [[0, 0], [f.W, 0], [0, f.H], [f.W, f.H]].map(([x, y]) => this._toLatLon(f, x, y));
    const xs = corners.map((c) => wx(c.lon)), ys = corners.map((c) => wy(c.lat));
    const x0 = Math.floor(Math.min(...xs) / T), x1 = Math.floor(Math.max(...xs) / T), y0 = Math.floor(Math.min(...ys) / T), y1 = Math.floor(Math.max(...ys) / T);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 80) return;
    ctx.save();
    ctx.translate(f.W / 2 + this.pan.x, f.H / 2 + this.pan.y); ctx.scale(f.s, f.s); ctx.translate(-f.cx, -f.cy); ctx.rotate(f.a); ctx.translate(-f.c0.x, -f.c0.y);
    let loaded = 0, total = 0;
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      total++;
      const img = this._tile(z, tx, ty);
      if (img?.complete && img.naturalWidth) { ctx.drawImage(img, tx * T, ty * T, T + 0.6 / f.s, T + 0.6 / f.s); loaded++; }
      else {
        // fall back to the parent tile while the sharp one loads
        const p = this._tile(z - 1, tx >> 1, ty >> 1, true);
        if (p?.complete && p.naturalWidth) ctx.drawImage(p, (tx & 1) * 128, (ty & 1) * 128, 128, 128, tx * T, ty * T, T, T);
      }
    }
    ctx.restore();
    this._tilesLoaded = loaded > total * 0.5;
  }
  _tile(z, x, y, noLoad) {
    const k = `${z}/${x}/${y}`;
    let img = tileCache.get(k);
    if (!img && !noLoad) {
      img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async';
      img.onload = () => this.render(); img.onerror = () => {};
      img.src = TILE(z, x, y);
      tileCache.set(k, img);
      if (tileCache.size > 600) tileCache.delete(tileCache.keys().next().value);
    }
    return img;
  }

  /** JPEG of the current view (for AI analysis); null if tiles taint the canvas */
  snapshot(maxW = 900) {
    try {
      const c = document.createElement('canvas'); const r = Math.min(1, maxW / this.cv.width);
      c.width = this.cv.width * r; c.height = this.cv.height * r;
      c.getContext('2d').drawImage(this.cv, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.82).split(',')[1];
    } catch { return null; }
  }
  metersPerPixel() { const f = this.f; if (!f) return null; return (156543.03 * Math.cos(f.green.lat * rad)) / f.s; }

  // ---------- gestures: tap = target / pin, drag = pan, pinch = zoom ----------
  _gestures() {
    const cv = this.cv; const pts = new Map(); let start = null, moved = false, pinch0 = null;
    cv.style.touchAction = 'none';
    cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 1) { start = { x: e.clientX, y: e.clientY, pan: { ...this.pan } }; moved = false; } if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), z: this.zoomMul }; } });
    cv.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && pinch0) { const [a, b] = [...pts.values()]; this.zoomMul = Math.max(0.5, Math.min(8, pinch0.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch0.d)); moved = true; this.render(); return; }
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) { moved = true; this.pan = { x: start.pan.x + e.clientX - start.x, y: start.pan.y + e.clientY - start.y }; this.render(); }
    });
    const up = (e) => {
      const wasTap = pts.size === 1 && !moved && start;
      pts.delete(e.pointerId); if (pts.size < 2) pinch0 = null;
      if (wasTap && this.f) {
        const r = cv.getBoundingClientRect();
        const ll = this._toLatLon(this.f, e.clientX - r.left, e.clientY - r.top);
        if (this.mode === 'green') this.onPin?.(ll); else this.onTap?.(ll);
      }
      if (!pts.size) start = null;
    };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => { e.preventDefault(); this.zoomMul = Math.max(0.5, Math.min(8, this.zoomMul * (e.deltaY < 0 ? 1.15 : 0.87))); this.render(); }, { passive: false });
    cv.addEventListener('dblclick', () => this.resetView());
  }
}

function tag(ctx, x, y, text, bg, fg) {
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 10, h = 18;
  ctx.fillStyle = bg; ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x - w / 2, y - h / 2, w, h, 5); else ctx.rect(x - w / 2, y - h / 2, w, h);
  ctx.fill(); ctx.fillStyle = fg; ctx.fillText(text, x, y + 1);
  ctx.restore();
}
