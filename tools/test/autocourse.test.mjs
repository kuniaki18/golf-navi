import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, coursesAt } from '../../js/autocourse.js';
import { at } from './helpers.mjs';

// a course 1 km square around the origin, a second one (same club) 2 km east, one far away
const box = (cx, cy, half) => { const a = at(cx - half, cy - half), b = at(cx + half, cy + half); return [a.lat, a.lon, b.lat, b.lon]; };
const A = { id: 'a', name: 'Aコース', ...at(0, 0), bounds: box(0, 0, 500) };
const B = { id: 'b', name: 'Bコース', ...at(2100, 0), bounds: box(2100, 0, 500) };
const all = [A, B, { id: 'far', name: '遠い', ...at(30000, 0), bounds: box(30000, 0, 500) }];
const ctx = (o = {}) => ({ all, current: null, auto: true, round: false, rejected: {}, hold: null, now: 0, ...o });
// drive along the x axis (north = 0) at v m/s for `secs`, one fix per second, starting at x0
function drive(mem, c, x0, v, secs, t0 = 0) {
  let r; for (let s = 0; s <= secs; s++) r = decide({ ...at(x0 + v * s, 0), speed: v, t: t0 + s * 1000 }, mem, c);
  return r;
}

test('the courses at a point: inside the outline (with a margin), nearest first', () => {
  assert.deepEqual(coursesAt(all, at(100, 0)).map((c) => c.id), ['a']);
  assert.deepEqual(coursesAt(all, at(620, 0)).map((c) => c.id), ['a']); // car park just outside the outline
  assert.deepEqual(coursesAt(all, at(1050, 0)).map((c) => c.id), []);
});

test('driving past a course on the road does not select it', () => {
  const mem = {};
  assert.equal(drive(mem, ctx(), -700, 25, 56).action, null); // 90 km/h straight through
});

test('slowing down inside the course (arriving at the car park) selects it', () => {
  const mem = {};
  drive(mem, ctx(), -2000, 20, 60);             // on the way, fast
  const r = drive(mem, ctx(), -300, 3, 20, 61000); // into the car park
  assert.equal(r.action, 'select'); assert.equal(r.course.id, 'a');
});

test('staying inside for a while selects it even without a speed', () => {
  const mem = {}; let r;
  for (let s = 0; s <= 95; s++) r = decide({ ...at(0, 0), t: s * 1000 }, mem, ctx());
  assert.equal(r.action, 'select');
});

test('during a round, with automatic choice off, or for a rejected course: only asked or nothing', () => {
  assert.equal(drive({}, ctx({ round: true }), 0, 1, 20).action, 'ask');
  assert.equal(drive({}, ctx({ auto: false }), 0, 1, 20).action, 'ask');
  assert.equal(drive({}, ctx({ rejected: { a: true } }), 0, 1, 20).action, null);
});

test('already on this course, or picked another one by hand while at the club: left alone', () => {
  assert.equal(drive({}, ctx({ current: A }), 0, 1, 20).action, null);
  assert.equal(drive({}, ctx({ current: { id: 'gora-1', osmId: 'a' } }), 0, 1, 20).action, null);
  const hold = { at: 0, ...at(50, 0) };
  assert.equal(drive({}, ctx({ current: B, hold, now: 3600e3 }), 0, 1, 20).action, null);
  // picked at home the day before: the course is selected on arrival
  assert.equal(drive({}, ctx({ current: all[2], hold: { at: 0, ...at(30000, 0) }, now: 3600e3 }), 0, 1, 20).action, 'select');
});
