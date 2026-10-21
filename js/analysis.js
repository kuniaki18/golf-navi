// Stats, issue ranking against the target score, club distances from GPS shots, and the AI coach.
import { $, esc, toast, md } from './util.js';
import { state, save } from './store.js';
import { total, isGIR } from './score.js';
import { askClaude, COACH_SYSTEM, hasAI } from './ai.js';

// rough amateur benchmarks per 18 holes by score level (approximate guide values)
const BENCH = {
  110: { putts: 40, fw: 30, gir: 5, pen: 4, dbl: 10, three: 4, par3: 4.6, par4: 6.0, par5: 7.0 },
  100: { putts: 37, fw: 36, gir: 11, pen: 3, dbl: 7, three: 3, par3: 4.2, par4: 5.6, par5: 6.6 },
  90: { putts: 35, fw: 44, gir: 22, pen: 2, dbl: 4, three: 2, par3: 3.8, par4: 5.0, par5: 6.0 },
  80: { putts: 32, fw: 54, gir: 42, pen: 1, dbl: 1.5, three: 1, par3: 3.4, par4: 4.5, par5: 5.4 },
  72: { putts: 30, fw: 62, gir: 62, pen: 0.4, dbl: 0.5, three: 0.4, par3: 3.05, par4: 4.05, par5: 4.8 },
};
function bench(target) {
  const ks = Object.keys(BENCH).map(Number).sort((a, b) => a - b);
  const t = Math.min(Math.max(target, ks[0]), ks[ks.length - 1]);
  let lo = ks[0], hi = ks[ks.length - 1];
  for (let i = 0; i < ks.length - 1; i++) if (t >= ks[i] && t <= ks[i + 1]) { lo = ks[i]; hi = ks[i + 1]; }
  const f = hi === lo ? 0 : (t - lo) / (hi - lo);
  const out = {};
  for (const k of Object.keys(BENCH[lo])) out[k] = BENCH[lo][k] + (BENCH[hi][k] - BENCH[lo][k]) * f;
  return out;
}

export function computeStats(rounds = state.rounds) {
  const rs = rounds.filter((r) => total(r).played >= 9);
  if (!rs.length) return null;
  let holes = 0, putts = 0, fwOpp = 0, fwHit = 0, fwL = 0, fwR = 0, gir = 0, pen = 0, dbl = 0, three = 0, sandIn = 0, sandSave = 0;
  const parT = { 3: [0, 0], 4: [0, 0], 5: [0, 0] };
  const scores = [];
  for (const r of rs) {
    const t = total(r);
    scores.push({ date: r.date, score: Math.round((t.strokes / t.played) * 18), raw: t.strokes, played: t.played, course: r.course });
    for (const h of r.holes) {
      if (!h.strokes) continue;
      holes++;
      putts += h.putts || 0;
      if (h.par >= 4 && h.fw && h.fw !== 'na') { fwOpp++; if (h.fw === 'hit') fwHit++; if (h.fw === 'left') fwL++; if (h.fw === 'right') fwR++; }
      if (isGIR(h)) gir++;
      pen += h.penalties || 0;
      if (h.strokes - h.par >= 2) dbl++;
      if (h.putts >= 3) three++;
      if (h.sand) { sandIn++; if (h.sand === 2) sandSave++; }
      if (parT[h.par]) { parT[h.par][0] += h.strokes; parT[h.par][1]++; }
    }
  }
  const per18 = (v) => (v / holes) * 18;
  return {
    rounds: rs.length, holes, scores: scores.reverse(),
    avg: scores.reduce((s, x) => s + x.score, 0) / scores.length,
    best: Math.min(...scores.map((s) => s.score)),
    putts: per18(putts), fw: fwOpp ? (fwHit / fwOpp) * 100 : null, fwL, fwR, fwOpp,
    gir: (gir / holes) * 100, pen: per18(pen), dbl: per18(dbl), three: per18(three),
    sandSave: sandIn ? (sandSave / sandIn) * 100 : null,
    par3: parT[3][1] ? parT[3][0] / parT[3][1] : null, par4: parT[4][1] ? parT[4][0] / parT[4][1] : null, par5: parT[5][1] ? parT[5][0] / parT[5][1] : null,
  };
}

export function clubStats() {
  const by = {};
  for (const s of state.shots || []) {
    if (!s.yards || /パター|PT/i.test(s.club)) continue;
    (by[s.club] ??= []).push(s.yards);
  }
  return Object.entries(by).map(([club, arr]) => {
    arr.sort((a, b) => a - b);
    // drop the shortest 20% (mishits / layups) for a "typical good shot" number
    const keep = arr.slice(Math.floor(arr.length * 0.2));
    const avg = keep.reduce((s, x) => s + x, 0) / keep.length;
    return { club, n: arr.length, avg: Math.round(avg), max: arr[arr.length - 1], min: arr[0] };
  }).sort((a, b) => b.avg - a.avg);
}

function issues(st, b) {
  const list = [];
  const add = (name, val, goal, higherBetter, unit, strokes, tip) => {
    if (val == null) return;
    const gap = higherBetter ? goal - val : val - goal;
    list.push({ name, val, goal, gap, unit, strokesLost: Math.max(0, gap * strokes), tip, ok: gap <= 0 });
  };
  add('パット数', st.putts, b.putts, false, '', 1, '1.5m以内の練習と、ロングパットの距離感（3パット撲滅）');
  add('3パット', st.three, b.three, false, '回', 1, '最初のパットを「半径1mの円」に入れる距離感練習');
  add('OB・ペナルティ', st.pen, b.pen, false, '打', 1, 'ティーショットは「打てる番手」を選ぶ。危ない側を消す狙い方');
  add('ダボ以上', st.dbl, b.dbl, false, 'ホール', 0.8, '大叩きの手前で守る。トラブル時はまず確実に出す');
  add('パーオン率', st.gir, b.gir, true, '%', 0.06, '100y以内の縦距離を合わせる。番手は大きめでセンター狙い');
  add('FWキープ率', st.fw, b.fw, true, '%', 0.04, '飛距離より方向。3Wやユーティリティで置きにいく選択も');
  add('パー3平均', st.par3, b.par3, false, '', 4, 'ショートアイアンの精度とグリーンを外した後の寄せ');
  add('パー5平均', st.par5, b.par5, false, '', 4, '3打目に得意距離を残すマネジメント');
  return list.sort((a, b2) => b2.strokesLost - a.strokesLost);
}

export function initAnalysis() {
  $('#targetScore').value = state.settings.targetScore || 90;
  $('#targetScore').onchange = () => { state.settings.targetScore = Number($('#targetScore').value) || 90; save('settings'); renderAnalysis(); };
  $('#btnAiCoach').onclick = aiCoach;
  $('#btnApplyClub').onclick = () => {
    const cs = clubStats().filter((c) => c.n >= 3);
    if (!cs.length) { toast('各番手3球以上のショット記録が必要です'); return; }
    let n = 0;
    for (const c of cs) { const cl = state.clubs.find((x) => x.name === c.club); if (cl) { cl.carry = c.avg; n++; } }
    save('clubs'); toast(`${n}本のクラブ距離を実測値に更新しました`);
  };
  renderAnalysis();
}

export function renderAnalysis() {
  const st = computeStats();
  const target = state.settings.targetScore || 90;
  const b = bench(target);
  const tile = (k, v, t, cls = '') => `<div class="stat ${cls}"><span class="k">${k}</span><span class="v">${v}</span><span class="t">${t}</span></div>`;
  if (!st) {
    $('#statGrid').innerHTML = tile('平均スコア', '--', '9H以上のラウンドを保存すると表示') + tile('平均パット', '--', `目安 ${b.putts.toFixed(0)}`) + tile('パーオン率', '--', `目安 ${b.gir.toFixed(0)}%`);
    $('#issueList').innerHTML = '<p class="muted">スコアカードでラウンドを保存すると、目標スコアとの差から課題を自動で並べます。</p>';
    drawTrend([]);
  } else {
    const c = (v, g, hb) => ((hb ? v >= g : v <= g) ? 'ok' : 'warn');
    $('#statGrid').innerHTML = [
      tile('平均スコア', st.avg.toFixed(1), `ベスト ${st.best} · ${st.rounds}R`, c(st.avg, target, false)),
      tile('平均パット', st.putts.toFixed(1), `目安 ${b.putts.toFixed(0)}`, c(st.putts, b.putts, false)),
      tile('パーオン率', st.gir.toFixed(0) + '%', `目安 ${b.gir.toFixed(0)}%`, c(st.gir, b.gir, true)),
      tile('FWキープ', st.fw == null ? '--' : st.fw.toFixed(0) + '%', st.fwOpp ? `左${st.fwL}・右${st.fwR}回ミス` : '入力するとミス傾向が出ます', st.fw == null ? '' : c(st.fw, b.fw, true)),
      tile('OB/ペナ', st.pen.toFixed(1), `目安 ${b.pen.toFixed(1)}/R`, c(st.pen, b.pen, false)),
      tile('3パット', st.three.toFixed(1), `目安 ${b.three.toFixed(1)}/R`, c(st.three, b.three, false)),
    ].join('');
    const is = issues(st, b);
    const maxLost = Math.max(1, ...is.map((x) => x.strokesLost));
    $('#issueList').innerHTML = is.map((x, i) => `<div class="issue">
      <span class="nm">${x.ok ? '' : `課題${i + 1}. `}${x.name}　${fmtV(x.val, x.unit)} <span class="muted">→ 目安 ${fmtV(x.goal, x.unit)}</span></span>
      <span class="gap ${x.ok ? 'ok' : ''}">${x.ok ? 'クリア' : `約${x.strokesLost.toFixed(1)}打`}</span>
      <div class="bar"><i class="${x.ok ? 'ok' : ''}" style="width:${x.ok ? 100 : Math.max(6, (x.strokesLost / maxLost) * 100)}%"></i></div>
      ${x.ok ? '' : `<span class="tip">${esc(x.tip)}</span>`}</div>`).join('');
    drawTrend(st.scores, target);
  }
  const cs = clubStats();
  $('#clubStats').innerHTML = cs.length ? `<tr><th>番手</th><th>平均</th><th>最大</th><th>回数</th><th>設定値</th></tr>` + cs.map((c) => `<tr><td>${esc(c.club)}</td><td><b>${c.avg}</b></td><td>${c.max}</td><td>${c.n}</td><td>${state.clubs.find((x) => x.name === c.club)?.carry ?? '-'}</td></tr>`).join('') : '<tr><td class="muted" style="white-space:normal">ナビ画面の「ショット記録」で計測した飛距離がここに貯まります（ヤード）。</td></tr>';
}
const fmtV = (v, u) => (u === '%' ? v.toFixed(0) + '%' : v.toFixed(1) + u);

function drawTrend(scores, target) {
  const cv = $('#trendChart');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 320, H = 160;
  cv.width = W * dpr; cv.height = H * dpr;
  const c = cv.getContext('2d'); c.scale(dpr, dpr); c.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement);
  const fg = css.getPropertyValue('--muted').trim(), line = css.getPropertyValue('--line').trim(), green = css.getPropertyValue('--green').trim(), flag = css.getPropertyValue('--flag').trim();
  c.font = '11px system-ui'; c.fillStyle = fg;
  if (!scores.length) { c.fillText('ラウンドを保存するとスコアの推移が出ます', 10, H / 2); $('#trendNote').textContent = ''; return; }
  const pts = scores.slice(-20);
  const vals = pts.map((p) => p.score).concat(target ? [target] : []);
  const lo = Math.floor((Math.min(...vals) - 3) / 5) * 5, hi = Math.ceil((Math.max(...vals) + 3) / 5) * 5;
  const L = 30, R = 10, T = 10, B = 22;
  const x = (i) => L + (pts.length === 1 ? (W - L - R) / 2 : (i / (pts.length - 1)) * (W - L - R));
  const y = (v) => T + ((v - lo) / (hi - lo)) * (H - T - B); // lower score = higher on chart? keep: lower = top
  c.strokeStyle = line; c.lineWidth = 1;
  for (let v = lo; v <= hi; v += 5) { c.beginPath(); c.moveTo(L, y(v)); c.lineTo(W - R, y(v)); c.stroke(); c.fillText(v, 4, y(v) + 4); }
  if (target) { c.strokeStyle = flag; c.setLineDash([4, 4]); c.beginPath(); c.moveTo(L, y(target)); c.lineTo(W - R, y(target)); c.stroke(); c.setLineDash([]); c.fillStyle = flag; c.fillText('目標', W - R - 26, y(target) - 4); }
  c.strokeStyle = green; c.lineWidth = 2.5; c.beginPath();
  pts.forEach((p, i) => (i ? c.lineTo(x(i), y(p.score)) : c.moveTo(x(i), y(p.score)))); c.stroke();
  c.fillStyle = green;
  pts.forEach((p, i) => { c.beginPath(); c.arc(x(i), y(p.score), i === pts.length - 1 ? 5 : 3, 0, 7); c.fill(); });
  c.fillStyle = fg;
  c.fillText(pts[0].date.slice(5), L, H - 6);
  if (pts.length > 1) c.fillText(pts[pts.length - 1].date.slice(5), W - R - 30, H - 6);
  $('#trendNote').textContent = `直近${pts.length}ラウンド（18H換算・上ほど良い）`;
}

async function aiCoach() {
  if (!hasAI()) { toast('設定でClaudeのAPIキーを入れるとAIコーチが使えます', 3500); return; }
  const st = computeStats();
  if (!st) { toast('まずラウンドを1つ以上保存してください'); return; }
  const out = $('#aiCoachOut');
  out.innerHTML = '<p class="muted">分析しています…</p>';
  const target = state.settings.targetScore || 90;
  const recent = state.rounds.slice(0, 8).map((r) => ({ date: r.date, course: r.course, holes: r.holes.filter((h) => h.strokes).map((h) => [h.par, h.strokes, h.putts, h.fw, h.penalties, h.sand]) }));
  const prompt = `私のゴルフの記録を分析して、次を作ってください。
### 1. いちばんスコアを落としている原因トップ3（数字の根拠つき）
### 2. 目標スコア${target}を切るための具体的な目標（次のラウンドで狙う数値）
### 3. 1週間の練習メニュー（練習場・パター練習・自宅、各15〜60分）
### 4. ラウンド中のマネジメントのコツ（クラブの飛距離を踏まえて）
### 5. 1か月後に達成したい課題目標（チェックリスト形式）

集計値(18H換算): ${JSON.stringify({ ...st, scores: undefined })}
スコア推移: ${JSON.stringify(st.scores.slice(-12))}
課題ランキング(目安との差): ${JSON.stringify(issues(st, bench(target)).map((x) => ({ name: x.name, val: +x.val.toFixed(1), goal: +x.goal.toFixed(1), strokesLost: +x.strokesLost.toFixed(1) })))}
クラブのキャリー設定(y): ${JSON.stringify(state.clubs)}
GPS実測距離: ${JSON.stringify(clubStats())}
直近ラウンド詳細 [par, 打数, パット, ティーショット(hit/left/right), ペナ, バンカー(1=入った,2=寄せワン)]: ${JSON.stringify(recent)}`;
  try {
    const text = await askClaude({ system: COACH_SYSTEM, prompt, maxTokens: 2500, onText: (t) => (out.innerHTML = md(t)) });
    state.lastCoach = { text, at: Date.now() }; save('coach');
    out.innerHTML = md(text);
  } catch (e) { out.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

export function restoreCoach() {
  if (state.lastCoach?.text) $('#aiCoachOut').innerHTML = md(state.lastCoach.text) + `<p class="muted">前回の分析: ${new Date(state.lastCoach.at).toLocaleDateString('ja-JP')}</p>`;
}
