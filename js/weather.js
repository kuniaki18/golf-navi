// Course weather forecast (Open-Meteo), playability notes, outfit advice, and wear shopping.
import { $, esc, toast, fmtDate, fetchJSON, md } from './util.js';
import { state, save } from './store.js';
import { rakuten, hasGora } from './gora.js';
import { askClaude, COACH_SYSTEM, hasAI } from './ai.js';

let fc = null; // forecast payload
let fcKey = '';

const WMO = {
  0: '快晴', 1: '晴れ', 2: '晴れ時々くもり', 3: 'くもり', 45: '霧', 48: '霧',
  51: '霧雨', 53: '霧雨', 55: '霧雨', 56: '着氷性の霧雨', 57: '着氷性の霧雨',
  61: '小雨', 63: '雨', 65: '強い雨', 66: '冷たい雨', 67: '冷たい雨', 71: '小雪', 73: '雪', 75: '大雪', 77: '雪',
  80: 'にわか雨', 81: 'にわか雨', 82: '激しいにわか雨', 85: 'にわか雪', 86: 'にわか雪', 95: '雷雨', 96: '雷雨(ひょう)', 99: '雷雨(ひょう)',
};
const wmo = (c) => WMO[c] ?? '—';
const wmoTone = (c) => (c <= 1 ? 'sun' : c <= 3 || c === 45 || c === 48 ? 'cloud' : c >= 95 ? 'storm' : c >= 71 && c <= 86 && ![80, 81, 82].includes(c) ? 'snow' : 'rain');

export function initWeather() {
  const sel = $('#wxDate');
  const today = new Date();
  sel.innerHTML = Array.from({ length: 16 }, (_, i) => {
    const d = new Date(today); d.setDate(today.getDate() + i);
    return `<option value="${fmtDate(d)}">${d.getMonth() + 1}/${d.getDate()}（${'日月火水木金土'[d.getDay()]}）${i === 0 ? '今日' : i === 1 ? '明日' : ''}</option>`;
  }).join('');
  sel.value = state.ui.wxDate && state.ui.wxDate >= fmtDate(today) ? state.ui.wxDate : fmtDate(today);
  sel.onchange = () => { state.ui.wxDate = sel.value; save('ui'); renderDay(); };
  $('#wxGender').value = state.ui.gender || 'men';
  $('#wxGender').onchange = () => { state.ui.gender = $('#wxGender').value; save('ui'); renderDay(); loadItems(); };
  $('#btnWxReload').onclick = () => loadForecast(true);
  $('#btnAiWear').onclick = aiWear;
  $('#btnItems').onclick = loadItems;
  loadFeed();
}

export async function loadForecast(force) {
  const c = state.course;
  $('#wxCourse').textContent = c ? c.name : 'コース未選択（現在地付近の天気）';
  let lat = c?.lat, lon = c?.lon;
  if (!c) {
    try { const p = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000 })); lat = p.coords.latitude; lon = p.coords.longitude; }
    catch { lat = 35.68; lon = 139.76; $('#wxCourse').textContent = 'コース未選択（東京の天気）'; }
  }
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (!force && fc && fcKey === key && Date.now() - fc._t < 30 * 60e3) { renderDay(); return; }
  $('#wxHours').innerHTML = '<p class="muted">天気を取得中…</p>';
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=Asia%2FTokyo&wind_speed_unit=ms&forecast_days=16`
      + '&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,sunrise,sunset,uv_index_max';
    fc = await fetchJSON(url); fc._t = Date.now(); fcKey = key;
    renderDay();
  } catch (e) { $('#wxHours').innerHTML = `<p class="muted">天気を取得できませんでした（${esc(e.message)}）</p>`; }
}

function dayData(date) {
  if (!fc) return null;
  const di = fc.daily.time.indexOf(date);
  if (di < 0) return null;
  const hours = [];
  fc.hourly.time.forEach((t, i) => {
    if (!t.startsWith(date)) return;
    const h = Number(t.slice(11, 13));
    if (h < 6 || h > 17) return;
    hours.push({ h, temp: fc.hourly.temperature_2m[i], feel: fc.hourly.apparent_temperature[i], pop: fc.hourly.precipitation_probability[i], rain: fc.hourly.precipitation[i], code: fc.hourly.weather_code[i], wind: fc.hourly.wind_speed_10m[i], dir: fc.hourly.wind_direction_10m[i], gust: fc.hourly.wind_gusts_10m[i], uv: fc.hourly.uv_index[i] });
  });
  const d = fc.daily;
  return {
    date, hours, code: d.weather_code[di], max: d.temperature_2m_max[di], min: d.temperature_2m_min[di], rain: d.precipitation_sum[di],
    pop: d.precipitation_probability_max[di], wind: d.wind_speed_10m_max[di], gust: d.wind_gusts_10m_max[di],
    sunrise: d.sunrise[di]?.slice(11), sunset: d.sunset[di]?.slice(11), uv: d.uv_index_max[di],
  };
}

const arrow = (deg) => `<svg viewBox="0 0 24 24" style="width:14px;height:14px;transform:rotate(${deg + 180}deg)"><path d="M12 3v18M6 9l6-6 6 6"/></svg>`;

function renderDay() {
  const dd = dayData($('#wxDate').value);
  if (!dd) { $('#wxHours').innerHTML = '<p class="muted">この日の予報はまだありません</p>'; return; }
  const play = dd.hours.filter((h) => h.h >= 7 && h.h <= 16);
  const am = play.filter((h) => h.h <= 11), pm = play.filter((h) => h.h >= 12);
  const avg = (a, k) => (a.length ? a.reduce((s, x) => s + x[k], 0) / a.length : NaN);
  const feelMin = Math.min(...play.map((h) => h.feel)), feelMax = Math.max(...play.map((h) => h.feel));
  const windMax = Math.max(...play.map((h) => h.wind)), popMax = Math.max(...play.map((h) => h.pop ?? 0));
  const score = playScore({ feelMin, feelMax, windMax, popMax, rain: dd.rain });
  $('#wxSummary').innerHTML = `
    <div class="wx-now ${wmoTone(dd.code)}"><span class="wx-cond">${wmo(dd.code)}</span><span class="wx-temp">${Math.round(dd.max)}°<small>/ ${Math.round(dd.min)}°</small></span></div>
    <div class="wx-facts">
      <span>降水 <b>${dd.pop ?? '-'}%</b>（${dd.rain.toFixed(1)}mm）</span>
      <span>最大風速 <b>${dd.wind.toFixed(1)}m/s</b>（瞬間 ${dd.gust.toFixed(0)}）</span>
      <span>UV <b>${dd.uv?.toFixed(0) ?? '-'}</b></span>
      <span>日の出 ${dd.sunrise} / 日の入 ${dd.sunset}</span>
    </div>
    <div class="play-score s${score.level}"><span class="k">ゴルフ日和度</span><span class="v">${score.label}</span><span class="t">${esc(score.note)}</span></div>`;
  $('#wxHours').innerHTML = `<div class="hours">${dd.hours.map((h) => `
    <div class="hr ${wmoTone(h.code)} ${h.h >= 7 && h.h <= 16 ? '' : 'off'}">
      <span class="t">${h.h}時</span><span class="c">${wmo(h.code)}</span><b>${Math.round(h.temp)}°</b>
      <span class="f">体感${Math.round(h.feel)}°</span><span class="p">${h.pop ?? 0}%</span>
      <span class="w">${arrow(h.dir)}${h.wind.toFixed(0)}m</span></div>`).join('')}</div>`;
  const tips = golfTips({ dd, am, pm, feelMin, feelMax, windMax, popMax, avg });
  $('#wxTips').innerHTML = tips.map((t) => `<li>${esc(t)}</li>`).join('');
  renderWear({ feelMin, feelMax, windMax, popMax, rain: dd.rain, uv: dd.uv, amFeel: avg(am, 'feel'), pmFeel: avg(pm, 'feel') });
}

function playScore({ feelMin, feelMax, windMax, popMax, rain }) {
  let s = 5; const why = [];
  if (popMax >= 70 || rain >= 5) { s -= 2; why.push('雨'); } else if (popMax >= 40) { s -= 1; why.push('にわか雨の可能性'); }
  if (windMax >= 9) { s -= 2; why.push('強風'); } else if (windMax >= 6) { s -= 1; why.push('風やや強め'); }
  if (feelMax >= 33) { s -= 2; why.push('猛暑'); } else if (feelMax >= 30) { s -= 1; why.push('暑い'); }
  if (feelMin <= 2) { s -= 2; why.push('厳しい寒さ'); } else if (feelMin <= 7) { s -= 1; why.push('寒い'); }
  s = Math.max(1, s);
  return { level: s, label: ['', '厳しい', 'いまいち', 'まずまず', '良好', '絶好'][s], note: why.length ? why.join('・') + 'に注意' : '快適にプレーできそうです' };
}

function golfTips({ dd, feelMin, feelMax, windMax, popMax }) {
  const t = [];
  if (windMax >= 6) t.push(`風が強い日（最大${windMax.toFixed(0)}m/s）。向かい風は1〜2番手上げてハーフショットで低い球。ナビの番手は風を自動補正します。`);
  if (popMax >= 50) t.push('雨の可能性大。グリーンは重く、ラフは抵抗大。パットはしっかり打ち、ランが出ない前提でキャリーで攻める。');
  if (feelMax >= 30) t.push('暑い日はボールがよく飛び、体力が落ちる後半にミスが増えます。1ホールごとに水分、後半は番手を正直に。');
  if (feelMin <= 8) t.push('寒い日はボールが飛ばない（気温10℃で約3〜5%減）。朝イチは番手を1つ上げ、体が温まるまで振り幅を抑える。');
  if (dd.uv >= 6) t.push('紫外線が強い日。日焼け止めは2時間ごとに塗り直し。サングラスで目の疲れを軽減。');
  if (!t.length) t.push('穏やかなコンディション。普段通りの番手でOK。グリーンも素直に転がりそうです。');
  return t;
}

// ---------------- outfit advice ----------------
function wearPlan({ feelMin, feelMax, windMax, popMax, rain, uv, amFeel, pmFeel }) {
  const men = (state.ui.gender || 'men') === 'men';
  const base = Math.round((amFeel + pmFeel) / 2);
  const items = []; const style = []; let band;
  if (base >= 28) { band = '真夏'; items.push('吸汗速乾の半袖ポロ（白・淡色で熱を吸わない）', men ? '薄手ストレッチのパンツ／ハーフパンツ＋ハイソックス' : 'キュロット／スカート＋インナーパンツ', '冷感アームカバー・UVインナー', '通気性の良いキャップ or サンバイザー', '替えのポロとグローブ2枚');
    style.push('白ポロ×ネイビーパンツで清潔感。小物（ベルト・キャップ）で差し色を1色だけ'); }
  else if (base >= 22) { band = '初夏・初秋'; items.push('半袖ポロ（UVカット）', '朝夕用の薄手ウィンドブレーカー or カーディガン', men ? 'ストレッチロングパンツ' : 'スカート／ストレッチパンツ', 'キャップ');
    style.push('ポロとパンツをワントーンにして、羽織りでアクセント'); }
  else if (base >= 16) { band = '春・秋'; items.push('長袖ポロ or 半袖ポロ＋ベスト', '脱ぎ着しやすいニットベスト／薄手ブルゾン', men ? 'ロングパンツ' : 'パンツ or スカート＋タイツ', '長袖インナー（朝が寒ければ）');
    style.push('ベージュ・グリーン系のアースカラーが季節感◎。ベストの色をキャップと合わせると締まる'); }
  else if (base >= 10) { band = '晩秋・早春'; items.push('ハイネックの保温インナー', '長袖ポロ＋ニット or スニード（中綿ベスト）', '防風ブルゾン', men ? '裏起毛パンツ' : '裏起毛パンツ／厚手タイツ＋スカート', 'ニット帽 or イヤーウォーマー');
    style.push('ニットは白・グレー、パンツは濃色で重く見せない。ハイネックは首元に色を入れると写真映え'); }
  else if (base >= 4) { band = '冬'; items.push('発熱インナー上下', 'ハイネック＋ニット＋中綿 or ダウンブルゾン', '防寒パンツ（裏起毛・防風）', 'ネックウォーマー・ニット帽', '冬用グローブ（両手）・ハンドウォーマー', 'カイロ（ポケット用と貼るタイプ）');
    style.push('ダウンはスイングを妨げない薄手を。全身ダーク系になりがちなので白ニットやキャップで明るさを'); }
  else { band = '厳冬'; items.push('発熱インナー2枚重ね', '中綿ブルゾン＋ダウンベスト', '防風・防寒パンツ', 'ネックウォーマー・耳当て付き帽子', 'ミトン・カイロ多め', 'ボールは柔らかめ（低圧縮）が飛びやすい');
    style.push('防寒優先。上着は待ち時間用のロングダウンを1枚持って行くと楽'); }
  if (feelMax - feelMin >= 8) items.push(`朝と昼の体感差が${Math.round(feelMax - feelMin)}℃。脱ぎ着しやすい重ね着に`);
  if (popMax >= 40 || rain >= 1) items.push('レインウェア上下（透湿タイプ）', '防水シューズ', 'レイン用グローブ・タオル多め・傘');
  if (windMax >= 6) items.push('防風ジャケット（シャカシャカ音の少ないもの）');
  if (uv >= 6) items.push('日焼け止め（SPF50）・サングラス');
  return { band, base, items, style, men };
}

function renderWear(cond) {
  const w = wearPlan(cond);
  $('#wearBand').textContent = `${w.band}コーデ（プレー中の体感 約${w.base}℃）`;
  $('#wearItems').innerHTML = w.items.map((i) => `<li>${esc(i)}</li>`).join('');
  $('#wearStyle').innerHTML = w.style.map((s) => `<p>${esc(s)}</p>`).join('') +
    '<p class="muted">マナー: 襟付きシャツが基本。ハーフパンツはハイソックス、クラブハウスはジャケット推奨のコースも。ジーンズ・Tシャツは避けるのが無難。</p>';
  $('#btnItems').dataset.kw = `ゴルフウェア ${w.men ? 'メンズ' : 'レディース'} ${shopKeyword(w.base)}`;
}
const shopKeyword = (t) => (t >= 28 ? '半袖 ポロ 冷感' : t >= 22 ? '半袖 ポロ' : t >= 16 ? '長袖 ポロ ベスト' : t >= 10 ? 'ニット ハイネック' : 'ブルゾン 防寒');

async function aiWear() {
  if (!hasAI()) { toast('設定でClaudeのAPIキーを入れるとAIコーデ提案が使えます', 3500); return; }
  const dd = dayData($('#wxDate').value);
  if (!dd) return;
  const out = $('#aiWearOut'); out.hidden = false; out.innerHTML = '<p class="muted">コーデを考えています…</p>';
  const prompt = `${dd.date} に「${state.course?.name || 'ゴルフ場'}」でプレーします。${(state.ui.gender || 'men') === 'men' ? 'メンズ' : 'レディース'}のゴルフウェアのコーディネートを3パターン（定番・おしゃれ・機能重視）提案してください。
各パターン: トップス/ミドル/アウター/ボトムス/小物/色の組み合わせ、の順で短く。最後にこの天気での持ち物チェックリスト。
天気(7〜16時): ${JSON.stringify(dd.hours.map((h) => ({ 時: h.h, 気温: h.temp, 体感: h.feel, 降水確率: h.pop, 風: h.wind, 天気: wmo(h.code) })))} UV最大 ${dd.uv}`;
  try { const text = await askClaude({ system: COACH_SYSTEM + '\nゴルフファッションにも詳しいスタイリストとして答えます。ブランド名は一般的な例に留めます。', prompt, maxTokens: 1500, onText: (t) => (out.innerHTML = md(t)) }); out.innerHTML = md(text); }
  catch (e) { out.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

// ---------------- shopping: Rakuten items + curated shop feed ----------------
async function loadItems() {
  const box = $('#wearProducts');
  const kw = $('#btnItems').dataset.kw || 'ゴルフウェア';
  if (!hasGora()) { box.innerHTML = '<p class="muted">楽天のアプリID/アクセスキーを設定すると、この天気に合うウェアの人気商品をここに表示します。</p>'; return; }
  box.innerHTML = '<p class="muted">人気のウェアを探しています…</p>';
  try {
    const j = await rakuten('/ichibams/api/IchibaItem/Search/20260401', { keyword: kw, hits: 12, imageFlag: 1, sort: '-reviewCount' });
    const list = (j.Items || []).map((x) => x.Item || x);
    box.innerHTML = list.length ? `<div class="products">${list.map((i) => `
      <a class="product" href="${esc(i.affiliateUrl || i.itemUrl)}" target="_blank" rel="noopener">
        ${i.mediumImageUrls?.[0] ? `<img src="${esc((i.mediumImageUrls[0].imageUrl || i.mediumImageUrls[0]).replace('?_ex=128x128', '?_ex=300x300'))}" alt="" loading="lazy">` : ''}
        <span class="nm">${esc(i.itemName)}</span><span class="pr">¥${Number(i.itemPrice).toLocaleString('ja-JP')}</span>
        <span class="sh">${esc(i.shopName)}${i.reviewAverage ? ` · ★${Number(i.reviewAverage).toFixed(1)}` : ''}</span></a>`).join('')}</div>` : '<p class="muted">商品が見つかりませんでした</p>';
  } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

/** curated shop list + style news; data/feed.json is updated on the server, so new info shows up without reinstalling */
async function loadFeed() {
  const box = $('#shopFeed');
  let feed = null;
  try { feed = await fetchJSON('data/feed.json?t=' + Math.floor(Date.now() / 36e5), { cache: 'no-cache' }); localStorage.setItem('golfnavi:feed', JSON.stringify(feed)); }
  catch { try { feed = JSON.parse(localStorage.getItem('golfnavi:feed') || 'null'); } catch {} }
  if (!feed) { box.innerHTML = '<p class="muted">オンラインになるとショップ情報を読み込みます。</p>'; return; }
  const month = new Date().getMonth() + 1;
  const picks = (feed.picks || []).filter((p) => !p.months || p.months.includes(month));
  $('#feedUpdated').textContent = feed.updatedAt ? `更新 ${feed.updatedAt}` : '';
  box.innerHTML = (picks.length ? `<div class="picks">${picks.map((p) => `<div class="pick"><b>${esc(p.title)}</b><p>${esc(p.text)}</p>${p.url ? `<a class="link" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.linkText || '詳しく見る')}</a>` : ''}</div>`).join('')}</div>` : '')
    + `<div class="shops">${(feed.shops || []).map((s) => `<a class="shop" href="${esc(s.url)}" target="_blank" rel="noopener"><b>${esc(s.name)}</b><span>${esc(s.desc || '')}</span><span class="tags">${(s.tags || []).map((t) => `<i>${esc(t)}</i>`).join('')}</span></a>`).join('')}</div>`;
}
