import test from 'node:test';
import assert from 'node:assert/strict';
import { briefingScript } from '../../js/briefing.js';

const clubs = [{ name: '1W', carry: 220 }, { name: '5U', carry: 180 }, { name: '6I', carry: 155 }, { name: '7I', carry: 145 }, { name: '8I', carry: 135 }, { name: 'PW', carry: 110 }];
const H = (i, par, y, x = {}) => ({ label: `${i}番`, par, lengthY: y, water: false, greenBunkers: 1, dogleg: false, ...x });
const holes = [H(1, 4, 380), H(2, 3, 150), H(3, 5, 520, { water: true, waterCarry: 160 }), H(4, 4, 430, { water: true }), H(5, 3, 185, { water: true, greenBunkers: 3 }),
  H(6, 4, 360, { dogleg: true }), H(7, 4, 400), H(8, 3, 140), H(9, 5, 500)];

test('briefing: overview, key holes, par-3 clubs, practice and plan', () => {
  const r = briefingScript({ courseName: 'テストCC', nines: ['西コース'], holes, clubs, stats: null, playDate: '2026-11-01', today: '2026-10-25' });
  const t = r.sentences.join('');
  assert.match(t, /テストCCの事前ブリーフィング/);
  assert.match(t, /あと7日/);
  assert.match(t, /9ホール、パー35/);
  assert.match(t, /池がからむホールが3つ/);
  assert.match(t, /5番（パー3・185ヤード）/);
  assert.match(t, /パー3は140から185ヤード/);
  assert.match(t, /7番アイアンから5番ユーティリティ/);
  assert.match(t, /バンカーショット/);
  assert.match(t, /よろしくお願いいたします/);
  assert.ok(r.practice.length >= 2 && r.practice.length <= 5);
});

test('briefing uses the player\'s weaknesses', () => {
  const r = briefingScript({ courseName: 'X', holes, clubs, stats: { putts: 37.2, three: 2.5, fw: 38, fwL: 2, fwR: 9, pen: 2.2, gir: 12 } });
  const t = r.practice.join('|');
  assert.match(t, /パット（平均37.2回）/);
  assert.match(t, /FWキープ率38%・右へのミスが多い/);
});

test('briefing with no hole data stays general and says so', () => {
  const t = briefingScript({ courseName: 'X', holes: [], clubs }).sentences.join('');
  assert.match(t, /データがまだ少ない/);
});
