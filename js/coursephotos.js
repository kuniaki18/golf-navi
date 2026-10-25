// Course photos and introduction (like ALBA's photo-rich course pages), from sources that are really about the course:
//  - 国土地理院 aerial photo of the whole course (always available)
//  - the course's Japanese Wikipedia article: its lead image and opening paragraph (only when an article exists)
// Location-based photo search was not used: it returns unrelated pictures (shops, stations) near the course.

const cache = new Map();

/** 3×3 aerial tiles around the course (zoom chosen from the course size) */
export function aerialTiles(c) {
  const b = c.bounds; // [south, west, north, east]
  const spanKm = b ? Math.max((b[2] - b[0]) * 111, (b[3] - b[1]) * 111 * Math.cos((c.lat * Math.PI) / 180)) : 1.5;
  const z = spanKm > 3 ? 14 : spanKm > 1.4 ? 15 : 16;
  const n = 2 ** z;
  const x = Math.floor(((c.lon + 180) / 360) * n);
  const lr = (c.lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2) * n);
  const tiles = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) tiles.push(`https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x + dx}/${y + dy}.jpg`);
  return { z, tiles };
}

const core = (s) => String(s || '').replace(/[（(【].*$/, '').replace(/\s+/g, '').replace(/[・･]/g, '');

/** the Wikipedia article about this course, or null. Accepts only titles that match the course name. */
export async function wikiInfo(name) {
  if (cache.has(name)) return cache.get(name);
  const api = (q) => fetch(`https://ja.wikipedia.org/w/api.php?${q}&format=json&origin=*`).then((r) => r.json());
  const props = 'prop=pageimages%7Cextracts%7Cinfo&piprop=thumbnail%7Cname&pithumbsize=640&exintro=1&explaintext=1&exsentences=3&inprop=url&redirects=1';
  let page = null;
  try {
    const j = await api(`action=query&titles=${encodeURIComponent(name)}&${props}`);
    page = Object.values(j.query?.pages || {}).find((p) => !('missing' in p)) || null;
    if (!page) {
      const s = await api(`action=query&list=search&srsearch=${encodeURIComponent(name + ' ゴルフ')}&srlimit=3`);
      const hit = (s.query?.search || []).find((x) => core(x.title).includes(core(name)) || core(name).includes(core(x.title)));
      if (hit) { const k = await api(`action=query&titles=${encodeURIComponent(hit.title)}&${props}`); page = Object.values(k.query?.pages || {})[0] || null; }
    }
  } catch { page = null; }
  const v = page ? {
    title: page.title, url: page.fullurl || `https://ja.wikipedia.org/wiki/${encodeURIComponent(page.title)}`,
    extract: page.extract || '', thumb: page.thumbnail?.source || null,
    file: page.pageimage ? `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(page.pageimage)}` : null,
  } : null;
  cache.set(name, v);
  return v;
}
