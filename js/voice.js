// Voice caddie: one tap reads out the distance, wind, club and how to attack the green (Web Speech API, on the device).
// caddieScript() is pure (unit-tested); speak() is the browser part.

const y2m = (y) => y * 0.9144;

/** club names as they should be read aloud */
export function clubSpeech(name) {
  const n = String(name || '').trim();
  const NUM = ['', 'ワン', 'ツー', 'スリー', 'フォー', 'ファイブ', 'シックス', 'セブン', 'エイト', 'ナイン'];
  let m;
  if ((m = n.match(/^(\d)W$/i))) return m[1] === '1' ? 'ドライバー' : `${NUM[+m[1]]}ウッド`;
  if ((m = n.match(/^(\d)U$/i))) return `${m[1]}番ユーティリティ`;
  if ((m = n.match(/^(\d)I$/i))) return `${m[1]}番アイアン`;
  if ((m = n.match(/^(\d{2})°?$/))) return `${m[1]}度のウェッジ`;
  const W = { PW: 'ピッチングウェッジ', AW: 'アプローチウェッジ', GW: 'ギャップウェッジ', SW: 'サンドウェッジ', LW: 'ロブウェッジ' };
  return W[n.toUpperCase()] || n.replace(/パター\/寄せ/, 'パターか寄せ');
}

/**
 * @param d {
 *   unit: 'yd'|'m', holeNo, par, preview (distance from the tee, not the player), estimated (hole layout estimated),
 *   gpsPoor, center, front, back, pin            (yards; front/back/pin may be null)
 *   playsLike, club: {name, carry}, alt, layup, leave,
 *   head (m/s, + = into the wind), cross (m/s, + = from the left), gust, elevM, windKnown,
 *   greenHazards: [{ type: 'water'|'bunker', where: '手前'|'奥'|'左'|'右', front, carry }],
 *   slope: { pct, dir, level } | null           (only when the slope confidence is high/mid)
 * }
 * @returns {string[]} sentences
 */
export function caddieScript(d) {
  const u = d.unit === 'm' ? 'メートル' : 'ヤード';
  const n = (yards) => Math.round(d.unit === 'm' ? y2m(yards) : yards);
  const s = [];
  if (d.holeNo) s.push(`${d.holeNo}番${d.par ? `、パー${d.par}` : ''}。`);
  if (d.preview) s.push(d.estimated ? '推定したティーからの距離です。' : 'ティーからの距離です。');
  else if (d.gpsPoor) s.push('GPSの精度が低いので、距離は目安です。');
  if (!Number.isFinite(d.center)) { s.push('グリーンの位置が分からないため、距離を出せません。'); return s; }

  // distances
  let dist = `グリーンセンターまで${n(d.center)}${u}`;
  if (Number.isFinite(d.front) && Number.isFinite(d.back)) dist += `。手前まで${n(d.front)}、奥まで${n(d.back)}`;
  s.push(dist + '。');
  if (Number.isFinite(d.pin)) s.push(`ピンまで${n(d.pin)}${u}。`);
  if (d.center <= 20) { s.push('グリーン周りです。転がして寄せましょう。'); return s; }

  // wind (forecast) and elevation
  if (d.windKnown) {
    const w = [];
    if (Math.abs(d.head) >= 1) w.push(`${d.head > 0 ? '向かい風' : '追い風'}${Math.abs(d.head).toFixed(0)}メートル`);
    if (Math.abs(d.cross) >= 1) w.push(`${d.cross > 0 ? '左' : '右'}からの横風${Math.abs(d.cross).toFixed(0)}メートル`);
    s.push(w.length ? `風は予報で、${w.join('、')}。` : '風は予報ではほとんどありません。');
    if (Number.isFinite(d.gust) && d.gust >= 8) s.push(`突風は最大${Math.round(d.gust)}メートルの予報です。`);
  }
  if (Number.isFinite(d.elevM) && Math.abs(d.elevM) >= 2) s.push(`${d.elevM > 0 ? '打ち上げ' : '打ち下ろし'}、約${Math.abs(d.elevM).toFixed(0)}メートル。`);

  // club
  if (d.club) {
    if (d.layup) s.push(`届かない距離です。${clubSpeech(d.club.name)}で、残り約${n(d.leave)}${u}を残しましょう。`);
    else {
      const pl = Math.round(d.playsLike) !== Math.round(d.center) ? `打つ距離は${n(d.playsLike)}${u}。` : '';
      s.push(`${pl}おすすめは${clubSpeech(d.club.name)}。${d.alt ? `迷ったら${clubSpeech(d.alt.name)}。` : ''}`);
    }
  }
  if (d.windKnown && Math.abs(d.cross) >= 2) s.push(`横風なので、${d.cross > 0 ? '左' : '右'}目から風に乗せましょう。`);

  // attacking the green
  const hz = d.greenHazards || [];
  const when = d.layup ? 'グリーンを狙うときは、' : '';
  if (hz.length) {
    const by = {}, byType = {};
    const ORDER = ['手前', '左', '右', '奥'];
    for (const h of hz) { const t = h.type === 'water' ? '池' : 'バンカー'; (by[h.where] ??= new Set()).add(t); (byType[t] ??= new Set()).add(h.where); }
    const desc = ['池', 'バンカー'].filter((t) => byType[t]).map((t) => `${ORDER.filter((k) => byType[t].has(k)).join('と')}に${t}`);
    s.push(`グリーンの${desc.join('、')}があります。`);
    const front = hz.filter((h) => h.where === '手前').sort((x, y) => y.carry - x.carry)[0];
    if (front && Number.isFinite(front.carry) && !d.layup) s.push(`手前の${front.type === 'water' ? '池' : 'バンカー'}を越えるには、キャリー${n(front.carry)}${u}必要です。`);
    const safe = ['左', '右'].find((k) => !by[k]);
    if (by['手前'] && !by['奥']) s.push(`${when}ショートは禁物。センターから奥目を狙いましょう。`);
    else if (by['奥'] && !by['手前']) s.push(`${when}奥はトラブル。手前から攻めましょう。`);
    else if (safe && (by['左'] || by['右'])) s.push(`${when}外すなら${safe}サイドが安全です。グリーンの${safe}寄りを狙いましょう。`);
    else s.push(`${when}グリーンセンターを狙いましょう。`);
  } else s.push(d.layup ? 'グリーン周りに大きなハザードはありません。' : 'グリーン周りに大きなハザードはありません。グリーンセンターを狙いましょう。');

  if (d.slope) s.push(`グリーンは${d.slope.dir}方向へ下る傾斜、約${d.slope.pct.toFixed(0)}パーセント。標高データからの目安です。`);
  return s;
}

// ---------------- speech ----------------
const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
export const canSpeak = () => !!synth && typeof SpeechSynthesisUtterance !== 'undefined';
export const speaking = () => !!synth && (synth.speaking || synth.pending);
export function stopSpeaking() { synth?.cancel(); }

function jaVoice() {
  const vs = synth.getVoices().filter((v) => /^ja/i.test(v.lang));
  return vs.find((v) => /Kyoko|Otoya|Nanami|Google/i.test(v.name)) || vs[0] || null;
}
/** read sentences one after another (short utterances avoid browsers cutting long speech off) */
export function speak(sentences, { rate = 1.05, onEnd } = {}) {
  if (!canSpeak()) return false;
  synth.cancel();
  const v = jaVoice();
  sentences.forEach((t, i) => {
    const u = new SpeechSynthesisUtterance(t);
    u.lang = 'ja-JP'; u.rate = rate; if (v) u.voice = v;
    if (i === sentences.length - 1 && onEnd) { u.onend = onEnd; u.onerror = onEnd; }
    synth.speak(u);
  });
  return true;
}
if (synth) { synth.getVoices(); synth.addEventListener?.('voiceschanged', () => synth.getVoices()); }
