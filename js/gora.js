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
