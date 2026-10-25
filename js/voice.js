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
/** a strategy tip as it should be spoken: "230y" → "230ヤード", marks read aloud */
export function spokenTip(t) {
  return String(t || '').replace(/(\d+)y/g, '$1ヤード').replace(/◎/g, 'おすすめ').replace(/（/g, '、').replace(/）/g, '、').replace(/、([。、])/g, '$1');
}

export function caddieScript(d) {
  const u = d.unit === 'm' ? 'メートル' : 'ヤード';
  const n = (yards) => Math.round(d.unit === 'm' ? y2m(yards) : yards);
  const s = [];
  if (d.holeNo) s.push(`${d.holeName || `${d.holeNo}番`}${d.par ? `、パー${d.par}` : ''}。`);
  // the course guide's note for the hole, on the tee (or when previewing from it)
  if (d.note && (d.atTee || d.preview)) s.push(`コースガイドより。${d.note}${/[。！？]$/.test(d.note) ? '' : '。'}`);
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

  // on the tee of a par 4 / 5: the tee-shot plan (landing-zone hazards, which side to aim, doglegs, the par-5 plan)
  const plan = (d.teePlan || []).map(spokenTip).filter(Boolean);
  if (plan.length) s.push(`ティーショットの作戦。${plan.join('')}`);
  // laying up from the fairway: hazards around where this shot comes down
  else if (d.layup && d.layupHazards?.length) {
    for (const x of d.layupHazards.slice(0, 2)) {
      const t = x.type === 'water' ? '池' : 'バンカー';
      s.push(`落とし所の${x.side === '正面' ? '正面' : x.side + '側'}に${t}。手前まで${n(x.front)}、越えるまで${n(x.carry)}${u}。`);
    }
    const sides = new Set(d.layupHazards.map((x) => x.side));
    const safe = ['左', '右'].find((k) => !sides.has(k));
    if (safe && sides.size === 1 && !sides.has('正面')) s.push(`${safe}サイドへ運びましょう。`);
  }
  // the green is read on the approach; on the tee of a long hole it would only make the message long
  if (plan.length && d.layup) return s;

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

// ---------------- which browser are we in ----------------
/** in-app browsers (LINE, Instagram, …) usually have no speech synthesis; the phone's own browser does */
export function browserKind(ua = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
  if (/\bLine\//i.test(ua)) return 'line';
  if (/Instagram/i.test(ua)) return 'instagram';
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return 'facebook';
  if (/Twitter/i.test(ua)) return 'x';
  if (/Android/i.test(ua) && /; wv\)/.test(ua)) return 'webview';
  if (/iPhone|iPad|iPod/i.test(ua) && /AppleWebKit/i.test(ua) && !/Safari\//i.test(ua) && !/CriOS|FxiOS|EdgiOS/i.test(ua)) return 'webview';
  return null;
}
export const isIOS = (ua = typeof navigator !== 'undefined' ? navigator.userAgent : '') => /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document);
export const isAndroid = (ua = typeof navigator !== 'undefined' ? navigator.userAgent : '') => /Android/i.test(ua);
const APP_NAME = { line: 'LINE', instagram: 'Instagram', facebook: 'Facebook', x: 'X', webview: 'アプリ' };
export const inAppName = (k) => APP_NAME[k] || 'アプリ';

/** a link that leaves the in-app browser, or null when the user has to use the app's menu */
export function externalBrowserUrl(kind, href, ua = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
  if (!kind) return null;
  if (kind === 'line') { const u = new URL(href); u.searchParams.set('openExternalBrowser', '1'); return u.toString(); }
  if (isAndroid(ua)) { const u = new URL(href); return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(href)};end`; }
  return null;
}

/** what to do when no sound comes out */
export function speechHelp(kind, ua = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
  if (kind) return `${inAppName(kind)}の中のブラウザでは音声が出ません。「ブラウザで開く」を押すか、右上（または下）のメニューから「${isIOS(ua) ? 'Safari' : 'ブラウザ'}で開く」を選んでください。`;
  if (isIOS(ua)) return '音が出ないときは、iPhoneの横のスイッチ（マナーモード）をオフにして、音量を上げてください。それでも出ない場合は「設定」→「アクセシビリティ」→「読み上げコンテンツ」→「声」で日本語の声をダウンロードしてください。';
  if (isAndroid(ua)) return '音が出ないときは、メディアの音量を上げてください。それでも出ない場合は「設定」→「システム」→「言語と入力」→「テキスト読み上げの出力」で「Google 音声サービス」を選び、日本語の音声データをダウンロードしてください（機種によってメニューの名前が少し違います）。';
  return '音が出ないときは、音量とパソコンの音声出力を確認してください。Chrome・Edge・Safariの最新版で使えます。';
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
/**
 * read sentences one after another (short utterances avoid browsers cutting long speech off).
 * onFail(reason) fires when nothing starts within a few seconds (no voice engine, muted WebView, …).
 */
export function speak(sentences, { rate = 1.05, onEnd, onFail } = {}) {
  if (!canSpeak()) { onFail?.('unsupported'); return false; }
  // cancel only when something is queued: Safari drops an utterance spoken right after an idle cancel()
  if (synth.speaking || synth.pending) synth.cancel();
  try { synth.resume(); } catch {} // Chrome can be left paused after the page was in the background
  const v = jaVoice();
  let started = false, done = false;
  const finish = () => { if (done) return; done = true; clearTimeout(watch); onEnd?.(); };
  const watch = setTimeout(() => { if (!started && !done) { done = true; synth.cancel(); onFail?.('silent'); } }, 4000);
  sentences.forEach((t, i) => {
    const u = new SpeechSynthesisUtterance(t);
    u.lang = 'ja-JP'; u.rate = rate; u.volume = 1; if (v) u.voice = v;
    if (i === 0) u.onstart = () => { started = true; };
    u.onerror = (e) => { if (e.error === 'interrupted' || e.error === 'canceled') return finish(); if (!started) { done = true; clearTimeout(watch); onFail?.(e.error || 'error'); } else finish(); };
    if (i === sentences.length - 1) u.onend = finish;
    synth.speak(u);
  });
  return true;
}
if (synth) { synth.getVoices(); synth.addEventListener?.('voiceschanged', () => synth.getVoices()); }
