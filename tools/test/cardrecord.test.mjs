import test from 'node:test';
import assert from 'node:assert/strict';
import { matchCourseName, pickMe, cardDate, roundFromCard } from '../../js/cardparse.js';
import { monthSummary, monthText } from '../../js/monthsum.js';
import { lineUrl, mailUrl } from '../../js/share.js';

const list = [{ id: 'v', name: 'ピートダイゴルフクラブVIPコース【PGM】' }, { id: 'r', name: 'ピートダイゴルフクラブロイヤルコース【PGM】' },
  { id: 't', name: '筑波東急ゴルフクラブ' }, { id: 'k', name: '川越カントリークラブ' }];

test('the course read from the card is matched to the course list', () => {
  assert.equal(matchCourseName('筑波東急ゴルフクラブ', list).id, 't');
  assert.equal(matchCourseName('筑波東急GC', list).id, 't');
  assert.equal(matchCourseName('ピートダイ ロイヤル', list).id, 'r');
  assert.equal(matchCourseName('川越CC', list).id, 'k');
  assert.equal(matchCourseName('どこかのゴルフ場', list), null);
});

test('my row: the name from the settings, else the only row', () => {
  const ps = [{ name: '田中' }, { name: 'くにあき' }, { name: '佐藤' }];
  assert.equal(pickMe(ps, 'くにあき'), 1);
  assert.equal(pickMe(ps, ''), -1);
  assert.equal(pickMe([{ name: 'A' }], ''), 0);
});

test('the date: read from the card, else the photo time, never the future', () => {
  const now = new Date('2026-11-22T12:00:00').getTime();
  assert.equal(cardDate('2026-11-20', 0, now), '2026-11-20');
  assert.equal(cardDate(null, new Date('2026-11-15T09:00:00').getTime(), now), '2026-11-15');
  assert.equal(cardDate('1999-01-01', now + 864e5, now), '2026-11-22');
});

test('a round from the card: my row is the score, the others are members, pars from the card or the course', () => {
  const h = (v) => Array(18).fill(v);
  const res = { par: null, players: [{ name: '田中', holes: h(5), total: 90 }, { name: 'くにあき', holes: h(4), putts: h(2) }] };
  const r = roundFromCard(res, { date: '2026-11-20', course: '筑波東急ゴルフクラブ', courseId: 't', me: 1, pars: [4, 5, 4, 3, ...Array(14).fill(4)] });
  assert.equal(r.holes.reduce((a, x) => a + x.strokes, 0), 72);
  assert.equal(r.holes[1].par, 5); assert.equal(r.holes[0].putts, 2);
  assert.deepEqual(r.players.map((p) => p.name), ['田中']);
  assert.ok(r.saved && r.fromCard && r.date === '2026-11-20' && r.courseId === 't');
});

test('monthly sheet: the month\'s rounds, best and average of 18-hole rounds, as text', () => {
  const rd = (id, date, course, s, n = 18) => ({ id, date, course, holes: Array.from({ length: n }, () => ({ par: 4, strokes: s, putts: 2 })) });
  const rounds = [rd('a', '2026-11-03', 'A', 5), rd('b', '2026-11-20', 'B', 4), rd('c', '2026-11-10', 'C', 5, 9), rd('d', '2026-10-30', 'D', 4)];
  const s = monthSummary(rounds, '2026-11');
  assert.deepEqual(s.rounds.map((x) => x.id), ['a', 'c', 'b']);
  assert.equal(s.best.id, 'b'); assert.equal(s.best.strokes, 72); assert.equal(s.avg, 81);
  const t = monthText(s, 'くにあき');
  assert.match(t, /2026年11月のスコア くにあき/);
  assert.match(t, /11\/20 B 72（E）/); assert.match(t, /11\/10 C 45（9H）/);
  assert.match(t, /3ラウンド · ベスト 72（B） · 平均 81/);
});

test('LINE and mail links carry the text', () => {
  assert.equal(lineUrl('⛳ 72'), 'https://line.me/R/share?text=%E2%9B%B3%2072');
  assert.equal(mailUrl('件名', 'a\nb'), 'mailto:?subject=%E4%BB%B6%E5%90%8D&body=a%0Ab');
});
