// The month's rounds for the monthly score sheet, and its text. Pure; unit-tested (tools/test/cardrecord.test.mjs).
const played = (r) => (r.holes || []).filter((h) => h.strokes);
export function roundLine(r) {
  const hs = played(r);
  const strokes = hs.reduce((a, h) => a + h.strokes, 0), par = hs.reduce((a, h) => a + (h.par || 4), 0);
  const putts = hs.reduce((a, h) => a + (h.putts || 0), 0);
  return { id: r.id, date: r.date, course: r.course || 'コース名なし', strokes, toPar: strokes - par, putts: putts || null, holes: hs.length, members: (r.players || []).length };
}

/** rounds of the month 'YYYY-MM' (oldest first); best / average count 18-hole rounds only */
export function monthSummary(rounds, ym) {
  const list = rounds.filter((r) => String(r.date || '').startsWith(ym)).map(roundLine).filter((x) => x.holes).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const full = list.filter((x) => x.holes === 18);
  const best = full.length ? full.reduce((a, b) => (b.strokes < a.strokes ? b : a)) : null;
  const avg = full.length ? Math.round((full.reduce((a, b) => a + b.strokes, 0) / full.length) * 10) / 10 : null;
  return { ym, rounds: list, count: list.length, best, avg };
}

export const toParTxt = (v) => (v === 0 ? 'E' : v > 0 ? `+${v}` : String(v));
export const ymLabel = (ym) => `${Number(ym.slice(0, 4))}年${Number(ym.slice(5, 7))}月`;
export function monthText(s, name = '') {
  const lines = s.rounds.map((x) => `${x.date.slice(5).replace('-', '/')} ${x.course} ${x.strokes}${x.holes === 18 ? `（${toParTxt(x.toPar)}）` : `（${x.holes}H）`}`);
  return `⛳ ${ymLabel(s.ym)}のスコア${name ? ` ${name}` : ''}\n${lines.join('\n')}\n${s.count}ラウンド${s.best ? ` · ベスト ${s.best.strokes}（${s.best.course}）` : ''}${s.avg ? ` · 平均 ${s.avg}` : ''}\n#KUNIKUNIゴルフ`;
}

