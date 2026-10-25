// Pre-round briefing (事前ブリーフィング): what to practise before the play date and how to play the course,
// read aloud. Built from the course data and the player's own stats; nothing is invented. Pure; unit-tested.
import { clubSpeech } from './voice.js';

/**
 * @param d {
 *   courseName, nines: ['西コース', '東コース'] | null,
 *   holes: [{ label: '西コース3番', par, lengthY, water: bool, waterCarry: y|null, greenBunkers: n, dogleg: bool,
 *             shallowGreen: bool, narrowGreen: bool, est: bool }],
 *   clubs: [{ name, carry }], stats: computeStats() result | null, playDate: 'YYYY-MM-DD' | null, today: 'YYYY-MM-DD'
 * }
 * @returns {{ sentences: string[], practice: string[], keyHoles: string[] }}
 */
export function briefingScript(d) {
  const s = [], practice = [], keyHoles = [];
  const hs = d.holes || [];
  s.push(`${d.courseName}の事前ブリーフィングです。`);
  if (d.playDate && d.today) {
    const days = Math.round((Date.parse(d.playDate) - Date.parse(d.today)) / 864e5);
    if (days > 0) s.push(`プレー日まであと${days}日です。`);
  }
  if (!hs.length) { s.push('このコースはホールのデータがまだ少ないため、コースの特徴は説明できません。一般的な準備として、100ヤード以内の距離感と、1.5メートルのパットを練習しておきましょう。'); return { sentences: s, practice, keyHoles }; }

  // overview
  const par = hs.reduce((a, h) => a + (h.par || 0), 0), len = hs.reduce((a, h) => a + (h.lengthY || 0), 0);
  const water = hs.filter((h) => h.water).length, dog = hs.filter((h) => h.dogleg).length, est = hs.filter((h) => h.est).length;
  s.push(`${d.nines?.length ? d.nines.join('から') + 'の、' : ''}${hs.length}ホール、パー${par}${len ? `、全長およそ${Math.round(len / 100) * 100}ヤード` : ''}です。`);
  const feats = [water && `池がからむホールが${water}つ`, dog && `ドッグレッグが${dog}つ`].filter(Boolean);
  if (feats.length) s.push(`${feats.join('、')}あります。`);
  if (est > hs.length / 3) s.push(`なお、${est}ホールは位置が地図からの推定なので、距離は目安です。`);

  // key holes: water carries, long par 3s / 4s, narrow or shallow greens
  const scoreOf = (h) => (h.water ? 3 : 0) + (h.par === 3 && h.lengthY >= 180 ? 2 : 0) + (h.par === 4 && h.lengthY >= 420 ? 2 : 0) + (h.greenBunkers >= 2 ? 1 : 0) + (h.shallowGreen || h.narrowGreen ? 1 : 0);
  const hard = hs.map((h) => ({ h, v: scoreOf(h) })).filter((x) => x.v >= 3).sort((a, b) => b.v - a.v).slice(0, 3);
  for (const { h } of hard) {
    const why = [h.water && (h.waterCarry ? `池越えにキャリー約${h.waterCarry}ヤード` : '池がからむ'), h.par === 3 && h.lengthY >= 180 && '長いパー3', h.par === 4 && h.lengthY >= 420 && '長いパー4', h.greenBunkers >= 2 && 'グリーン周りにバンカーが多い', h.shallowGreen && 'グリーンが縦に浅い', h.narrowGreen && 'グリーンの横幅が狭い'].filter(Boolean);
    keyHoles.push(`${h.label}（パー${h.par}・${h.lengthY}ヤード）：${why.join('、')}`);
  }
  if (keyHoles.length) s.push(`注意するホールは、${keyHoles.join('。')}。`);

  // par 3 distances → clubs to practise
  const p3 = hs.filter((h) => h.par === 3 && h.lengthY);
  const clubs = (d.clubs || []).filter((c) => c.carry > 0).sort((a, b) => a.carry - b.carry);
  // the closest club (a few yards short is fine; ties go to the longer club); no driver on a par 3
  const irons = clubs.filter((c) => !/^1W$|ドライバー/i.test(c.name));
  const clubFor = (y) => irons.reduce((best, c) => (!best || Math.abs(c.carry - y) < Math.abs(best.carry - y) || (Math.abs(c.carry - y) === Math.abs(best.carry - y) && c.carry > best.carry) ? c : best), null);
  if (p3.length && clubs.length) {
    const lo = Math.min(...p3.map((h) => h.lengthY)), hi = Math.max(...p3.map((h) => h.lengthY));
    const a = clubFor(lo), b = clubFor(hi);
    const range = a && b && a.name !== b.name ? `${clubSpeech(a.name)}から${clubSpeech(b.name)}` : a ? clubSpeech(a.name) : '';
    s.push(`パー3は${lo}から${hi}ヤードです。${range ? `あなたの番手では${range}を使います。` : ''}`);
    if (range) practice.push(`${range}で、グリーンの真ん中を狙うショット（パー3対策）`);
  }

  // practice from the course
  const bunkerHoles = hs.filter((h) => h.greenBunkers >= 1).length;
  if (bunkerHoles >= hs.length / 2) practice.push(`バンカーショット（${bunkerHoles}ホールでグリーン周りにバンカー）`);
  if (water >= 3) practice.push('ティーショットの方向性。池のホールでは3Wやユーティリティで刻む練習も');
  if (hs.filter((h) => h.shallowGreen).length >= 3) practice.push('縦の距離感（グリーンが浅いホールが多い）。番手ごとのキャリーを確認');
  if (len >= hs.length * 375) practice.push('ユーティリティとフェアウェイウッド（長めのコース）');
  // practice from the player's stats
  const st = d.stats;
  if (st) {
    if (st.putts > 34) practice.push(`パット（平均${st.putts.toFixed(1)}回）：1.5メートルを続けて入れる練習と、10メートルの距離感`);
    else if (st.three > 1.5) practice.push(`3パットを減らす（1ラウンド約${st.three.toFixed(1)}回）：ロングパットの距離感`);
    if (st.fw != null && st.fw < 45) practice.push(`ドライバーの方向性（FWキープ率${Math.round(st.fw)}%${st.fwR > st.fwL * 1.5 ? '・右へのミスが多い' : st.fwL > st.fwR * 1.5 ? '・左へのミスが多い' : ''}）`);
    if (st.pen > 1.5) practice.push(`OB・池を避けるクラブ選び（1ラウンド約${st.pen.toFixed(1)}打のペナルティ）`);
    if (st.gir < 20) practice.push(`100ヤード以内の距離感（パーオン率${Math.round(st.gir)}%）`);
  } else practice.push('100ヤード以内の距離感と、1.5メートルのパット（成績が貯まると、あなたの苦手に合わせて提案します）');
  const top = practice.slice(0, 5);
  s.push(`プレー日までにおすすめの練習は、${top.length}つです。`);
  top.forEach((p, i) => s.push(`${i + 1}つめ、${p}。`));

  // overall plan
  const plan = [];
  if (water) plan.push('池のあるホールは、迷ったら大きめの番手で安全な側へ');
  if (dog) plan.push('ドッグレッグでは、曲がり角の手前で止まる番手を選ぶ');
  plan.push('グリーンはピンよりセンターを狙い、外すならハザードのない側へ');
  s.push(`当日の作戦です。${plan.join('。')}。`);
  s.push('当日はプレー開始ボタンを押すと、ホールごとに音声で案内します。よろしくお願いいたします。');
  return { sentences: s, practice: top, keyHoles };
}
