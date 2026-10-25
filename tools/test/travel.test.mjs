import test from 'node:test';
import assert from 'node:assert/strict';
import { driveEstimate, fmtMinutes } from '../../js/travel.js';
import { aerialTiles } from '../../js/coursephotos.js';

test('drive estimate: road ≈ 1.3 × straight line, minutes rounded to 5, labelled as a guide by the caller', () => {
  const near = driveEstimate(5);
  assert.equal(Math.round(near.roadKm * 10) / 10, 6.5);
  assert.equal(near.min, 15); // 6.5 km at 30 km/h
  const far = driveEstimate(60); // 78 km: 15 km local + 63 km expressway
  assert.equal(far.min, 85);
  assert.equal(fmtMinutes(85), '約1時間25分');
  assert.equal(fmtMinutes(60), '約1時間');
  assert.equal(fmtMinutes(40), '約40分');
});

test('aerial tiles: 3×3 around the course, zoom from its size', () => {
  const a = aerialTiles({ lat: 35.8936, lon: 139.4227, bounds: [35.885, 139.41, 35.902, 139.435] });
  assert.equal(a.tiles.length, 9);
  assert.equal(a.z, 15);
  assert.match(a.tiles[4], /seamlessphoto\/15\/\d+\/\d+\.jpg$/);
});
