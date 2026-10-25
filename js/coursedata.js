// How accurate is the data for this course? (shown to the player, never hidden) and checks for scorecards that
// players type in. Pure; unit-tested.

const MEASURED = new Set(['osm', 'user', 'community']); // positions someone actually mapped / tapped on the photo

/**
 * @param holes holes being played (or one course), from buildHoles / planHoles
 * @param sc    { source: 'official'|'mine'|'community', courses } or null
 */
export function dataQuality(holes, sc) {
  const real = holes.filter((h) => h.no <= 18);
  const n = real.length || 18;
  const measured = real.filter((h) => MEASURED.has(h.source) && h.center).length;
  const learned = real.filter((h) => h.source === 'learned').length;
  const est = real.filter((h) => h.source === 'est').length;
  const none = n - measured - learned - est;
  const shapes = real.filter((h) => h.green?.pts?.length >= 3).length;
  const hasSc = !!sc?.courses?.length;
  let level, label;
  if (measured >= n * 0.9 && hasSc && shapes >= n * 0.8) { level = 'high'; label = '高'; }
  else if (measured + learned >= n * 0.7) { level = 'mid'; label = '中'; }
  else if (measured + learned + est >= n * 0.5) { level = 'low'; label = '低'; }
  else { level = 'none'; label = 'データ不足'; }
  const tips = [];
  if (!hasSc) tips.push('公式スコアカード（パー・ヤード）を入力すると、パーと距離の表示が正確になります。');
  if (est) tips.push(`${est}ホールは位置が地図からの推定です。ずれていたら「番号修正」かホールの登録で直せます。`);
  if (none > 0) tips.push(`${none}ホールは未登録です。ホールビューでティー→グリーンの順にタップすると登録できます。`);
  if (shapes < measured) tips.push('グリーンの形が分からないホールは、手前・奥の距離を出していません。');
  return { level, label, n, measured, learned, est, none, shapes, scSource: hasSc ? sc.source : null, tips };
}

/**
 * validate a typed-in scorecard. Returns { ok, errors, card } where card is normalised:
 * { courses: [{ name, holes: [{ par, yd, back? }] }] } — 1–4 courses of 9 or 18 holes.
 */
export function checkScorecard(card) {
  const errors = [];
  const courses = (card?.courses || []).slice(0, 4).map((c, k) => {
    const holes = (c.holes || []).map((h, i) => {
      const par = Number(h.par), yd = Number(h.yd), back = h.back === '' || h.back == null ? null : Number(h.back);
      if (![3, 4, 5, 6].includes(par)) errors.push(`${c.name || 'コース' + (k + 1)} ${i + 1}番：パーは3〜6で入れてください`);
      if (!(yd >= 50 && yd <= 700)) errors.push(`${c.name || 'コース' + (k + 1)} ${i + 1}番：ヤードは50〜700で入れてください`);
      if (back != null && !(back >= yd && back <= 750)) errors.push(`${c.name || 'コース' + (k + 1)} ${i + 1}番：バックティーはレギュラー以上のヤードで入れてください`);
      // par vs length sanity (typical ranges; generous so unusual holes still pass)
      if (par === 3 && yd > 290) errors.push(`${c.name || 'コース' + (k + 1)} ${i + 1}番：パー3で${yd}ヤードは長すぎます。入力を確認してください`);
      if (par === 5 && yd < 380) errors.push(`${c.name || 'コース' + (k + 1)} ${i + 1}番：パー5で${yd}ヤードは短すぎます。入力を確認してください`);
      return back != null ? { par, yd, back } : { par, yd };
    });
    if (![9, 18].includes(holes.length)) errors.push(`${c.name || 'コース' + (k + 1)}：ホール数は9か18です`);
    return { name: String(c.name || '').trim().slice(0, 12), holes };
  });
  if (!courses.length) errors.push('コースがありません');
  return { ok: !errors.length, errors, card: { courses } };
}
