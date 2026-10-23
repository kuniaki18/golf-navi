// Club distance math (pure; unit-tested in tools/test).
// GPS shot records measure where the ball STOPPED (carry + roll). Club settings are CARRY.
// We therefore keep totals as totals, and only offer a carry ESTIMATE using typical roll ratios.

// typical carry / total ratios on a firm-ish fairway (guide values; real roll depends on turf, slope, spin)
export function carryRatio(club) {
  const n = String(club).toUpperCase();
  if (/^1W|DR|ドライバー/.test(n)) return 0.88;
  if (/^\d+W$/.test(n)) return 0.9;
  if (/^\d+U$|^\d+H$|UT/.test(n)) return 0.92;
  if (/^[3-6]I$/.test(n)) return 0.94;
  if (/^[7-9]I$/.test(n)) return 0.95;
  return 0.97; // wedges
}

export const MAX_SHOT_ACC_M = 10; // a shot is only used when both GPS fixes were at least this good

/** per-club statistics of GPS-measured TOTAL distance (yards) */
export function clubStats(shots) {
  const by = {};
  for (const s of shots || []) {
    if (!s.yards || /パター|PT/i.test(s.club)) continue;
    const acc = Math.max(s.acc ?? 0, s.accTo ?? 0);
    if (acc > MAX_SHOT_ACC_M) continue; // poor GPS on either end → too uncertain
    (by[s.club] ??= []).push(s.yards);
  }
  return Object.entries(by).map(([club, arr]) => {
    arr.sort((a, b) => a - b);
    // drop the shortest 20% (mishits / layups) for a "typical good shot" number
    const keep = arr.slice(Math.floor(arr.length * 0.2));
    const avg = keep.reduce((s, x) => s + x, 0) / keep.length;
    return { club, n: arr.length, total: Math.round(avg), max: arr[arr.length - 1], min: arr[0], carryEst: Math.round(avg * carryRatio(club)) };
  }).sort((a, b) => b.total - a.total);
}
