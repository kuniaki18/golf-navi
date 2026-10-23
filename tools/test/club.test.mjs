import test from 'node:test';
import assert from 'node:assert/strict';
import { clubStats, carryRatio } from '../../js/clubmath.js';
import { playsLike, recommendClub } from '../../js/advice.js';

test('GPS shot totals are not used as carry; carry is an explicit estimate', () => {
  const shots = Array.from({ length: 5 }, (_, i) => ({ club: '1W', yards: 240 + i, acc: 4, accTo: 5 }));
  const [d] = clubStats(shots);
  assert.equal(d.total, 243); // shortest 20% dropped: mean(241..244)
  assert.equal(d.carryEst, Math.round(242.5 * carryRatio('1W')));
  assert.ok(d.carryEst < d.total);
});

test('shots with poor GPS on either end are ignored', () => {
  const shots = [{ club: '7I', yards: 150, acc: 4, accTo: 4 }, { club: '7I', yards: 190, acc: 4, accTo: 25 }];
  assert.equal(clubStats(shots)[0].n, 1);
});

test('plays-like: headwind longer, tailwind shorter, uphill longer, no change in calm flat conditions', () => {
  assert.equal(Math.round(playsLike(150, {}).yards), 150);
  assert.ok(playsLike(150, { head: 5 }).yards > 150);
  assert.ok(playsLike(150, { head: -5 }).yards < 150);
  assert.ok(playsLike(150, { elevM: 5 }).yards > 150);
  assert.ok(playsLike(150, { elevM: -5 }).yards < 150);
});

test('recommendClub picks the shortest club that carries the distance', () => {
  const clubs = [{ name: '7I', carry: 150 }, { name: '8I', carry: 140 }, { name: '6I', carry: 160 }];
  assert.equal(recommendClub(clubs, 145).club.name, '7I');
  assert.equal(recommendClub(clubs, 152).club.name, '7I'); // 3y tolerance by design
  assert.equal(recommendClub(clubs, 155).club.name, '6I');
});
