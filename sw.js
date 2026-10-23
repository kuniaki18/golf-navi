// Offline support: app shell cached, map tiles cached as you browse (so the course map works with weak signal).
const VERSION = 'v2.8.0';
const SHELL = `shell-${VERSION}`;
const TILES = 'tiles-v1';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/style.css', 'css/features.css',
  'js/app.js', 'js/util.js', 'js/store.js', 'js/osm.js', 'js/advice.js', 'js/strategy.js', 'js/ai.js', 'js/navi.js',
  'js/courses.js', 'js/gora.js', 'js/score.js', 'js/tracer.js', 'js/booking.js', 'js/analysis.js', 'js/weather.js', 'js/group.js',
  'js/holeview.js', 'js/coursebook.js', 'js/swing.js', 'js/memory.js', 'js/ocr.js', 'js/onboard.js', 'js/greenslope.js', 'js/community.js', 'js/feedback.js', 'js/gpsfilter.js', 'js/geo.js', 'js/swingeval.js', 'js/clubmath.js', 'css/v2.css', 'css/v3.css', 'css/v4.css', '404.html',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('shell-') && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // satellite tiles: cache-first, keep up to ~3000 tiles
  if (url.hostname === 'server.arcgisonline.com' || (url.hostname === 'cyberjapandata.gsi.go.jp' && url.pathname.startsWith('/xyz/'))) {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') { c.put(req, res.clone()); trim(c, 3000); }
      return res;
    }).catch(() => caches.match(req)));
    return;
  }
  // live data (APIs, relay, feed): network only / network-first
  if (url.origin !== location.origin && !url.hostname.endsWith('unpkg.com') && !url.hostname.includes('fonts.g')) return;
  if (url.pathname.endsWith('/data/feed.json')) return;
  // app shell: stale-while-revalidate
  e.respondWith(caches.open(SHELL).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: url.origin === location.origin });
    const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});

let trimming = false;
async function trim(cache, max) {
  if (trimming) return; trimming = true;
  try { const keys = await cache.keys(); for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]); } finally { trimming = false; }
}
