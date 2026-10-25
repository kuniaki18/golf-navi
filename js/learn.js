// Learn tee and green positions from the walked track of a round. Pure; unit-tested.
// track: [[lat, lon, sec], ...]  (sec = seconds since the round started)
// holeLog: [[roundIdx, sec], ...] when each hole was shown on the navi screen during the round
// The result is only a suggestion: the player confirms it before anything is saved or shared.
import { dist } from './util.js';

const P = (t) => ({ lat: t[0], lon: t[1] });

/** places where the player stayed: at least minSec within radius metres. [{ c, from, to, n }] */
export function findDwells(track, { radius = 15, minSec = 40 } = {}) {
  const out = [];
  let i = 0;
  while (i < track.length) {
    let j = i, sLat = 0, sLon = 0;
    // grow the window while every point stays near the running centre
    while (j < track.length) {
      const n = j - i + 1, c = { lat: (sLat + track[j][0]) / n, lon: (sLon + track[j][1]) / n };
      if (dist(c, P(track[i])) > radius || dist(c, P(track[j])) > radius) break;
      sLat += track[j][0]; sLon += track[j][1]; j++;
    }
    const n = j - i;
    if (n >= 2 && track[j - 1][2] - track[i][2] >= minSec) out.push({ c: { lat: sLat / n, lon: sLon / n }, from: track[i][2], to: track[j - 1][2], n });
    i = Math.max(i + 1, j);
  }
  return out;
}

/**
 * suggestions per hole: { key, roundIdx, tee?, green?, moveTee?, moveGreen? } (moves in metres from what is known now)
 * @param holes planned holes (with roundIdx, key, source, tee, center)
 */
export function learnHoles(track, holeLog, holes) {
  if (!track?.length || !holeLog?.length) return [];
  const dwells = findDwells(track);
  const out = [];
  const log = holeLog.slice().sort((a, b) => a[1] - b[1]);
  for (let k = 0; k < log.length; k++) {
    const [idx, t0] = log[k];
    const t1 = k + 1 < log.length ? log[k + 1][1] : Infinity;
    const h = holes.find((x) => x.roundIdx === idx);
    if (!h || !['est', 'none', 'learned'].includes(h.source)) continue; // never overwrite mapped / registered holes
    const ds = dwells.filter((d) => d.from >= t0 - 30 && d.from < t1);
    if (ds.length < 2) continue;
    // putting: the last long stop of the hole; tee: the first stop at least 80 m before it
    const green = ds.filter((d) => d.to - d.from >= 60).pop() || ds[ds.length - 1];
    const tee = ds.find((d) => d !== green && dist(d.c, green.c) >= 80);
    if (!tee) continue;
    const len = dist(tee.c, green.c);
    if (len < 80 || len > 650) continue;
    const s = { key: h.key, roundIdx: idx, tee: tee.c, green: green.c, lengthM: Math.round(len) };
    if (h.tee) s.moveTee = Math.round(dist(h.tee, tee.c));
    if (h.center) s.moveGreen = Math.round(dist(h.center, green.c));
    // nothing to learn when the estimate was already right
    if (s.moveTee != null && s.moveGreen != null && s.moveTee < 15 && s.moveGreen < 15) continue;
    out.push(s);
  }
  return out;
}
