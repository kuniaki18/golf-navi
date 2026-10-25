import test from 'node:test';
import assert from 'node:assert/strict';
import { dataQuality, checkScorecard } from '../../js/coursedata.js';

const hole = (no, source, shape = true) => ({ no, source, center: { lat: 35, lon: 139 }, green: shape ? { pts: [1, 2, 3] } : null });

test('quality: fully mapped + official scorecard = 高; estimated = 低; nothing = データ不足', () => {
  const all = Array.from({ length: 18 }, (_, i) => hole(i + 1, 'osm'));
  assert.equal(dataQuality(all, { source: 'official', courses: [{}] }).level, 'high');
  assert.equal(dataQuality(all, null).level, 'mid'); // no scorecard: par / yardage not confirmed
  const est = Array.from({ length: 18 }, (_, i) => hole(i + 1, 'est'));
  const q = dataQuality(est, null);
  assert.equal(q.level, 'low');
  assert.ok(q.tips.some((t) => /推定/.test(t)));
  assert.equal(dataQuality([], null).level, 'none');
});

test('scorecard check: accepts a normal card, rejects typos', () => {
  const nine = (p) => Array.from({ length: 9 }, (_, i) => ({ par: p[i], yd: { 3: 160, 4: 370, 5: 510 }[p[i]] }));
  const good = checkScorecard({ courses: [{ name: '中', holes: nine([4, 4, 3, 5, 4, 4, 3, 5, 4]) }, { name: '西', holes: nine([5, 4, 4, 3, 4, 4, 5, 3, 4]) }] });
  assert.ok(good.ok, good.errors.join());
  const bad = checkScorecard({ courses: [{ name: '中', holes: [{ par: 3, yd: 420 }, { par: 7, yd: 300 }, ...nine([4, 4, 4, 4, 4, 4, 4])] }] });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /パー3で420ヤード/.test(e)));
  assert.ok(bad.errors.some((e) => /パーは3〜6/.test(e)));
  assert.equal(checkScorecard({ courses: [{ name: 'x', holes: nine([4, 4, 4, 4, 4, 4, 4, 4, 4]).slice(0, 8) }] }).ok, false);
});

test('scorecard check: ladies tee yardage is kept and must not exceed the regular tee', () => {
  const nine = Array.from({ length: 9 }, () => ({ par: 4, yd: 360, ladies: 300 }));
  const ok = checkScorecard({ courses: [{ name: 'OUT', holes: nine }] });
  assert.ok(ok.ok, ok.errors.join());
  assert.equal(ok.card.courses[0].holes[0].ladies, 300);
  const bad = checkScorecard({ courses: [{ name: 'OUT', holes: nine.map((h, i) => (i ? h : { ...h, ladies: 400 })) }] });
  assert.ok(bad.errors.some((e) => /レディースティーはレギュラー以下/.test(e)));
});
