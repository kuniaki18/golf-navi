// Course strategy book: every hole on one page with a mini map, numbers and tips, plus a course overview.
import { $, esc, toast, m2y, md } from './util.js';
import { state, save, getNote } from './store.js';
import { courseFeatures, buildHoles, setLabel } from './osm.js';
import { holeStrategy } from './strategy.js';
import { HoleView } from './holeview.js';
import { askClaude, COACH_SYSTEM, hasAI, needAI } from './ai.js';
import { currentCourseData } from './navi.js';

let views = [];

export async function openBook() {
  const c = state.course;
  const list = $('#bookList');
  views = [];
  if (!c) { list.innerHTML = '<p class="muted">コースを選ぶと攻略ブックを作ります。</p>'; return; }
  $('#bookTitle').textContent = `${c.name}`;
  $('#bookMeta').textContent = '攻略ブックを作成中…';
  list.innerHTML = '';
  let { features, holes } = currentCourseData();
  if (!features || state.ui.bookCourse !== c.id) {
    try { features = await courseFeatures(c, { liveFallback: false }); } catch { features = null; }
  }
  if (!features) features = { holes: [], greens: [], tees: [], bunkers: [], water: [], fairways: [], pins: [] };
  holes = buildHoles(features, state.userHoles?.[c.id] || {}).filter((h) => h.center).sort((a, b) => (a.set || 0) - (b.set || 0) || a.no - b.no);
  const multi = new Set(holes.map((h) => h.set || 0)).size > 1;
  bookMulti = multi;
  const isFirstOfSet = (h, i, arr) => multi && (i === 0 || (arr[i - 1].h || arr[i - 1]).set !== h.set);
  state.ui.bookCourse = c.id;
  if (!holes.length) {
    $('#bookMeta').textContent = '';
    list.innerHTML = `<div class="card"><h2>このコースはまだホールが登録されていません</h2><p class="muted">ナビ画面の「ホールを登録」で、航空写真の上でティーとグリーンをタップすると攻略ブックが作れます。ショット記録を使って1ラウンド回るだけでも、ティーとグリーンの位置を自動で覚えます。</p><button class="btn primary" data-goto="navi">ナビで登録する</button></div>`;
    return;
  }
  const rows = holes.map((h) => ({ h, s: holeStrategy(h, features, state.clubs) }));
  // my history on this course: average / best per hole
  const mine = (state.rounds || []).filter((r) => r.courseId === c.id || r.course === c.name);
  const hist = (no, set = 0) => { const v = mine.filter((r) => (r.set || 0) === set).map((r) => r.holes[no - 1]?.strokes).filter(Boolean); return v.length ? { avg: v.reduce((a, b) => a + b, 0) / v.length, best: Math.min(...v), n: v.length } : null; };
  const sum = summarize(rows);
  $('#bookMeta').textContent = `${mine.length ? `あなたのラウンド ${mine.length}回 · ` : ''}${holes.length}ホール · PAR ${sum.par || '-'} · ${Math.round(sum.yards).toLocaleString()}${state.settings.unit === 'm' ? 'm' : 'y'}（センターライン計測）`;
  const ai = state.aiTips?.[c.id]?._course;
  list.innerHTML = `
    <div class="card book-summary">
      <div class="card-head"><h2>コース全体の攻略ポイント</h2><button class="btn small" id="btnAiCourse">AIで作戦を立てる</button></div>
      <ul class="tips">${sum.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      <div class="ai-out" id="aiCourseOut" ${ai ? '' : 'hidden'}>${ai ? md(ai.text) : ''}</div>
      <div class="table-wrap"><table class="book-table"><tr><th>H</th><th>PAR</th><th>距離</th><th>池</th><th>バンカー</th><th>難度</th></tr>
        ${rows.map(({ h, s }, i, arr) => `${isFirstOfSet(h, i, arr) ? `<tr class="set-row"><td colspan="6">${setLabel(h.set || 0)}</td></tr>` : ''}<tr><td><a href="#book-${esc(h.key)}">${esc(hn(h))}</a></td><td>${h.par ?? '-'}</td><td>${Math.round(unitize(m2y(h.lengthM))) || '-'}</td><td>${s.hazards.filter((x) => x.type === 'water').length || ''}</td><td>${s.hazards.filter((x) => x.type === 'bunker').length || ''}</td><td>${'●'.repeat(difficulty(h, s))}</td></tr>`).join('')}
      </table></div>
    </div>
    ${rows.map(({ h, s }, i, arr) => {
      const head = isFirstOfSet(h, i, arr) ? `<h2 class="sec-title">${setLabel(h.set || 0)}</h2>` : '';
      const tip = state.aiTips?.[c.id]?.[h.key];
      const note = getNote(c.id, h.key);
      return `${head}<article class="card book-hole" id="book-${esc(h.key)}">
        <div class="book-head"><b class="bh-no">${esc(hn(h))}</b><span>PAR ${h.par ?? '-'}</span><span>${Math.round(unitize(m2y(h.lengthM))) || '-'}${state.settings.unit === 'm' ? 'm' : 'y'}</span>${h.hcp ? `<span>HDCP ${h.hcp}</span>` : ''}${(() => { const x = h.no <= 18 && hist(h.no, h.set || 0); return x ? `<span class="my-hist">平均 ${x.avg.toFixed(1)} · ベスト ${x.best}</span>` : ''; })()}<span class="diff">${'●'.repeat(difficulty(h, s))}</span></div>
        <div class="book-body">
          <canvas class="book-map" data-k="${esc(h.key)}"></canvas>
          <div class="book-text">
            <ul class="tips">${s.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
            ${note ? `<p class="book-note"><b>マイメモ</b> ${esc(note)}</p>` : ''}
            ${tip ? `<details><summary>AI攻略</summary><div class="ai-out">${md(tip.text)}</div></details>` : ''}
          </div>
        </div>
      </article>`;
    }).join('')}`;
  for (const cv of list.querySelectorAll('canvas.book-map')) {
    const h = holes.find((x) => x.key === cv.dataset.k);
    const hv = new HoleView(cv, { tiles: state.settings.bookPhotos !== false, interactive: false });
    hv.set({ hole: h, features, unit: state.settings.unit === 'm' ? 'm' : 'yd', hazards: rows.find((r) => r.h === h).s.hazards });
    views.push(hv);
  }
  $('#btnAiCourse').onclick = () => aiCourse(rows, sum);
}

let bookMulti = false;
const hn = (h) => (h.no > 100 ? 'その他' : (bookMulti ? 'ABCDEFGH'[h.set || 0] : '') + h.no);
const unitize = (y) => (state.settings.unit === 'm' ? y * 0.9144 : y);

function difficulty(h, s) {
  let d = 1;
  const L = m2y(h.lengthM), par = h.par || (L < 250 ? 3 : L < 470 ? 4 : 5);
  const norm = par === 3 ? 170 : par === 4 ? 370 : 500;
  if (L > norm + 25) d++;
  if (s.hazards.some((x) => x.type === 'water')) d++;
  if (s.hazards.filter((x) => x.nearGreen).length >= 3) d++;
  if (s.doglegs?.length) d++;
  return Math.min(5, d);
}

function summarize(rows) {
  const points = [];
  const par = rows.reduce((a, r) => a + (r.h.par || 0), 0);
  const yards = rows.reduce((a, r) => a + m2y(r.h.lengthM || 0), 0);
  const water = rows.filter((r) => r.s.hazards.some((x) => x.type === 'water'));
  const dl = rows.filter((r) => r.s.doglegs?.length);
  const p5 = rows.filter((r) => (r.h.par || 0) === 5);
  const p3 = rows.filter((r) => (r.h.par || 0) === 3);
  const hardest = rows.slice().sort((a, b) => difficulty(b.h, b.s) - difficulty(a.h, a.s)).slice(0, 3);
  const driver = Math.max(...state.clubs.map((c) => c.carry || 0), 200);
  if (water.length) points.push(`池が絡むホールが${water.length}つ（${water.map((r) => hn(r.h) + '番').join('・')}）。池のホールは「迷ったら安全側・大きめ」を徹底。`);
  if (dl.length >= 4) points.push(`ドッグレッグが${dl.length}ホール。飛距離より「曲がり角に届かない番手で置く」ほうがスコアがまとまるコース。`);
  else if (dl.length) points.push(`ドッグレッグは${dl.map((r) => hn(r.h) + '番').join('・')}。ティーショットは曲がり角までの距離を確認してから。`);
  const reach = p5.filter((r) => m2y(r.h.lengthM) - driver <= 230);
  if (p5.length) points.push(reach.length ? `パー5のうち${reach.map((r) => hn(r.h) + '番').join('・')}はナイスショットなら2オン圏。ほかは3打目に得意距離を残す作戦で。` : 'パー5はどれも長め。3打目に得意距離を残す3オン作戦でボギーを防ぐ。');
  if (p3.length) points.push(`パー3は${p3.map((r) => `${hn(r.h)}番 ${Math.round(unitize(m2y(r.h.lengthM)))}${state.settings.unit === 'm' ? 'm' : 'y'}`).join('、')}。グリーンセンター狙いで確実に乗せる。`);
  if (hardest.length) points.push(`特に難しいのは${hardest.map((r) => hn(r.h) + '番').join('・')}。ここはボギーで十分と割り切ると大叩きを防げます。`);
  if (!points.length) points.push('素直なレイアウト。ティーショットをフェアウェイに置けばスコアメイクしやすいコースです。');
  return { par, yards, points };
}

async function aiCourse(rows, sum) {
  if (needAI('AIの作戦立て')) return;
  const c = state.course;
  const out = $('#aiCourseOut'); out.hidden = false; out.innerHTML = '<p class="muted">コース全体の作戦を立てています…</p>';
  const data = rows.map(({ h, s }) => ({ hole: h.no, par: h.par, yards: Math.round(m2y(h.lengthM)), doglegs: s.doglegs, hazards: s.hazards.map((x) => ({ t: x.type, fromTee: Math.round(x.alongY), side: x.latY > 5 ? 'L' : x.latY < -5 ? 'R' : 'C', nearGreen: x.nearGreen })), green: s.shape && { depth: Math.round(s.shape.depth), width: Math.round(s.shape.width) } }));
  const prompt = `ゴルフ場「${c.name}」のコース全体の攻略作戦を立ててください。
### 1. コースの特徴（3行）
### 2. スコアメイクの作戦（攻めるホール・守るホール・目標スコアの配分）
### 3. ホールごとの一言攻略（1ホール1行、番手の目安つき）
### 4. 持ち物・練習しておくと良いショット
私のクラブ（キャリーy）: ${JSON.stringify(state.clubs)}
目標スコア: ${state.settings.targetScore || 90}
ホールデータ(ヤード): ${JSON.stringify(data)}
自動解析のポイント: ${JSON.stringify(sum.points)}`;
  try {
    const text = await askClaude({ system: COACH_SYSTEM, prompt, maxTokens: 2500, onText: (t) => (out.innerHTML = md(t)) });
    state.aiTips[c.id] ??= {}; state.aiTips[c.id]._course = { text, updatedAt: Date.now() }; save('ai');
    out.innerHTML = md(text);
  } catch (e) { out.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}
