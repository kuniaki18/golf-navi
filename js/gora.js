// Rakuten GORA (楽天ウェブサービス) — course search and plan (price / availability) search.
// 2026 migration: host openapi.rakuten.co.jp, applicationId + accessKey required.
import { state } from './store.js';

const HOST = 'https://openapi.rakuten.co.jp';
const BASE = HOST + '/engine/api/Gora';

export function hasGora() { return !!(state.settings.rakutenId && state.settings.rakutenKey); }

function buildUrl(full, params) {
  const s = state.settings;
  const q = new URLSearchParams({ format: 'json', applicationId: s.rakutenId, accessKey: s.rakutenKey, ...params });
  if (s.rakutenAff) q.set('affiliateId', s.rakutenAff);
  for (const [k, v] of [...q.entries()]) if (v === '' || v == null || v === 'undefined') q.delete(k);
  return `${full}?${q}`;
}

function jsonp(url) {
  return new Promise((resolve, reject) => {
    const cb = 'gora_cb_' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new Error('楽天APIがタイムアウトしました')); }, 20000);
    function cleanup() { clearTimeout(timer); delete window[cb]; s.remove(); }
    window[cb] = (data) => { cleanup(); resolve(data); };
    s.onerror = () => { cleanup(); reject(new Error('楽天APIに接続できません（アプリIDの許可サイト設定を確認）')); };
    s.src = url + '&callback=' + cb;
    document.head.appendChild(s);
  });
}

/** any Rakuten Web Service endpoint (path from host root) */
export function rakuten(path, params) { return request(HOST + path, params); }
function call(path, params) { return request(BASE + "/" + path, params); }

async function request(full, params) {
  if (!hasGora()) throw new Error('設定で楽天のアプリIDとアクセスキーを入力してください');
  const url = buildUrl(full, params);
  let data;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    data = await r.json().catch(() => ({}));
    if (!r.ok && !data.error) data.error = `HTTP ${r.status}`;
  } catch {
    data = await jsonp(url); // CORS blocked → JSONP
  }
  if (data.error) {
    if (data.error === 'not_found') return { Items: [] };
    const m = data.error_description || data.error;
    throw new Error(/wrong_parameter.*applicationId|accessKey|specify valid/i.test(m) ? '楽天のアプリID/アクセスキーが正しくありません' : `楽天API: ${m}`);
  }
  return data;
}

const items = (j) => (j.Items || []).map((x) => x.Item || x);

export async function searchCourses({ areaCode, keyword, latitude, longitude, page = 1 }) {
  const j = await call('GoraGolfCourseSearch/20170623', {
    areaCode: areaCode ?? '', keyword: keyword ?? '', latitude: latitude ?? '', longitude: longitude ?? '',
    searchRange: latitude ? 30 : '', hits: 30, page,
  });
  return { list: items(j).map(mapCourse), pageCount: j.pageCount || 1 };
}

export function mapCourse(r) {
  return {
    id: 'gora-' + r.golfCourseId, goraId: r.golfCourseId, name: r.golfCourseName, kana: r.golfCourseNameKana || '',
    lat: Number(r.latitude), lon: Number(r.longitude), address: r.address || '', caption: r.golfCourseCaption || '',
    evaluation: r.evaluation, highway: r.highway, ic: r.ic, icDistance: r.icDistance,
    image: r.golfCourseImageUrl, detailUrl: r.golfCourseDetailUrl, reserveUrl: r.reserveCalUrl, source: 'gora',
  };
}

/** plans on one date for a prefecture; returns flat list sorted by price */
export async function searchPlans({ areaCode, playDate, maxPrice, golfCourseId }) {
  const j = await call('GoraPlanSearch/20170623', {
    areaCode: areaCode ?? '', playDate, maxPrice: maxPrice || '', golfCourseId: golfCourseId ?? '', hits: 30,
  });
  const out = [];
  for (const it of items(j)) {
    for (const pi of it.planInfo || []) {
      const p = pi.plan || pi;
      const price = Number(p.price ?? p.planPrice ?? p.basePrice);
      if (!price) continue;
      if (maxPrice && price > maxPrice) continue;
      out.push({
        course: it.golfCourseName, courseId: it.golfCourseId, lat: it.latitude, lon: it.longitude,
        address: it.address, evaluation: it.evaluation,
        plan: p.planName, price, basePrice: Number(p.basePrice) || null, lunch: p.lunch, round: p.round,
        caddie: p.caddie, cart: p.cart, playerNum: p.playerNumMin ?? p.playerNum, date: playDate,
        url: p.reservePageUrlPC || p.reservePageUrlMobile || p.planUrl || it.reserveCalUrl || it.golfCourseDetailUrl,
      });
    }
  }
  return out.sort((a, b) => a.price - b.price);
}

/** the GORA entry for a course of the app's dataset (same place, similar name), with its detail page data */
export async function goraFor(c) {
  const core = String(c.name || '').replace(/[（(【].*$/, '').replace(/\s+/g, '');
  const j = await call('GoraGolfCourseSearch/20170623', { keyword: core.slice(0, 20), hits: 10 });
  const R = 6371, rad = Math.PI / 180;
  const km = (a) => { const dLa = (a.lat - c.lat) * rad, dLo = (a.lon - c.lon) * rad; return 2 * R * Math.asin(Math.sqrt(Math.sin(dLa / 2) ** 2 + Math.cos(c.lat * rad) * Math.cos(a.lat * rad) * Math.sin(dLo / 2) ** 2)); };
  const hit = items(j).map((x) => ({ x, d: km({ lat: Number(x.latitude), lon: Number(x.longitude) }) })).filter((o) => o.d < 4).sort((a, b) => a.d - b.d)[0];
  if (!hit) return null;
  const d = items(await call('GoraGolfCourseDetail/20170623', { golfCourseId: hit.x.golfCourseId }))[0] || hit.x;
  const imgs = [1, 2, 3, 4, 5].map((i) => d[`golfCourseImageUrl${i}`]).filter(Boolean);
  return {
    id: d.golfCourseId, name: d.golfCourseName, url: d.golfCourseDetailUrl || hit.x.golfCourseDetailUrl,
    lat: Number(d.latitude), lon: Number(d.longitude), km: hit.d,
    images: imgs.length ? imgs : [hit.x.golfCourseImageUrl].filter(Boolean),
    facts: [d.holeCount && `${d.holeCount}ホール`, d.parCount && `パー${d.parCount}`, d.courseDistance && `${Number(d.courseDistance).toLocaleString()}ヤード`, d.courseType, d.designer && `設計 ${d.designer}`, d.green && `グリーン ${d.green}`].filter(Boolean),
    caption: d.golfCourseCaption || '',
  };
}
