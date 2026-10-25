import test from 'node:test';
import assert from 'node:assert/strict';
import { caddieScript, clubSpeech } from '../../js/voice.js';

const base = { unit: 'yd', holeNo: 5, par: 4, center: 152, front: 140, back: 166, playsLike: 160, club: { name: '7I', carry: 160 }, alt: { name: '6I', carry: 170 }, windKnown: true, head: 3, cross: 0, elevM: 0, greenHazards: [] };
const say = (d) => caddieScript({ ...base, ...d }).join('');

test('club names are read naturally', () => {
  assert.equal(clubSpeech('1W'), 'ドライバー');
  assert.equal(clubSpeech('3W'), 'スリーウッド');
  assert.equal(clubSpeech('5U'), '5番ユーティリティ');
  assert.equal(clubSpeech('7I'), '7番アイアン');
  assert.equal(clubSpeech('PW'), 'ピッチングウェッジ');
  assert.equal(clubSpeech('56°'), '56度のウェッジ');
});

test('distance, wind, club, and front/back are all spoken', () => {
  const t = say({});
  assert.match(t, /5番、パー4/);
  assert.match(t, /グリーンセンターまで152ヤード/);
  assert.match(t, /手前まで140、奥まで166/);
  assert.match(t, /向かい風3メートル/);
  assert.match(t, /打つ距離は160ヤード/);
  assert.match(t, /おすすめは7番アイアン。迷ったら6番アイアン/);
});

test('no invented front/back when the green outline is unknown', () => {
  const t = say({ front: null, back: null });
  assert.doesNotMatch(t, /手前まで/);
});

test('green attack: front water → carry needed and aim past the centre', () => {
  const t = say({ greenHazards: [{ type: 'water', where: '手前', front: 130, carry: 145 }, { type: 'bunker', where: '右', front: 150, carry: 160 }] });
  assert.match(t, /グリーンの手前に池、右にバンカーがあります/);
  assert.match(t, /キャリー145ヤード必要/);
  assert.match(t, /奥目を狙いましょう/);
});

test('green attack: bunker one side → miss on the safe side', () => {
  assert.match(say({ greenHazards: [{ type: 'bunker', where: '右', front: 150, carry: 160 }] }), /外すなら左サイドが安全/);
});

test('cross wind → aim into the wind', () => {
  assert.match(say({ cross: 3 }), /左からの横風3メートル.*左目から風に乗せましょう/);
});

test('poor GPS / tee preview are said first; metres are honoured', () => {
  assert.match(say({ gpsPoor: true }), /GPSの精度が低いので、距離は目安です/);
  assert.match(say({ preview: true, estimated: true }), /推定したティーからの距離です/);
  assert.match(say({ unit: 'm' }), /グリーンセンターまで139メートル/);
});

test('out of reach → lay-up advice; no green position → says so', () => {
  assert.match(say({ center: 300, playsLike: 300, club: { name: '1W', carry: 230 }, alt: null, layup: true, leave: 70 }), /届かない距離です。ドライバーで、残り約70ヤード/);
  assert.match(say({ center: NaN }), /グリーンの位置が分からない/);
});

test('slope only when given, stated as an estimate', () => {
  assert.doesNotMatch(say({}), /傾斜/);
  assert.match(say({ slope: { pct: 2.4, dir: '北西', level: 'high' } }), /北西方向へ下る傾斜、約2パーセント。標高データからの目安/);
});

test('hazards of the same kind are grouped; lay-up frames the green plan for later', () => {
  const t = say({ center: 400, playsLike: 400, club: { name: '1W', carry: 230 }, alt: null, layup: true, leave: 170, greenHazards: [{ type: 'bunker', where: '手前', front: 380, carry: 390 }, { type: 'bunker', where: '右', front: 395, carry: 405 }] });
  assert.match(t, /グリーンの手前と右にバンカーがあります/);
  assert.match(t, /グリーンを狙うときは、ショートは禁物/);
  assert.doesNotMatch(t, /キャリー\d+ヤード必要/);
});

test('in-app browsers are detected and get a way out', async () => {
  const { browserKind, externalBrowserUrl, speechHelp } = await import('../../js/voice.js');
  const lineIOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.3.0';
  const igAndroid = 'Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Instagram 300.0';
  const safari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const chrome = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
  assert.equal(browserKind(lineIOS), 'line');
  assert.equal(browserKind(igAndroid), 'instagram');
  assert.equal(browserKind(safari), null);
  assert.equal(browserKind(chrome), null);
  assert.match(externalBrowserUrl('line', 'https://x.example/app/?room=A', lineIOS), /room=A&openExternalBrowser=1$/);
  assert.match(externalBrowserUrl('instagram', 'https://x.example/app/', igAndroid), /^intent:\/\/x\.example\/app\/#Intent;scheme=https;package=com\.android\.chrome/);
  assert.match(speechHelp('line', lineIOS), /LINEの中のブラウザでは音声が出ません/);
  assert.match(speechHelp(null, safari), /マナーモード/);
  assert.match(speechHelp(null, chrome), /Google 音声サービス/);
});
