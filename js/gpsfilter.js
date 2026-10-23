// GPS position filter (pure, unit-tested in tools/test).
// - standing still: accuracy-weighted mean of recent fixes
// - moving: follow the latest fix so distances don't lag behind the player
// - precise lock: average for a few seconds, then hold until the player walks away
// Reported uncertainty is conservative: GPS errors between consecutive fixes are strongly correlated,
// so averaging N fixes does NOT shrink the error by √N. We never report better than the receiver's own
// best accuracy in the window (receivers report roughly a 68–95% radius depending on the platform).
import { dist } from './util.js';

export const MOVING_MS = 0.7;      // m/s: above this the player is walking
const WINDOW_MS = 30000;           // stationary averaging window
const WINDOW_N = 10;
const STALE_S = 10;                // seconds without a fix before the position is flagged as old

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
function wmean(fs) {
  let w = 0, la = 0, lo = 0;
  for (const f of fs) { const k = 1 / Math.max(2, f.acc) ** 2; w += k; la += f.lat * k; lo += f.lon * k; }
  return { lat: la / w, lon: lo / w };
}
/** conservative uncertainty (m) for a set of fixes */
export function sigmaOf(fs) {
  const accs = fs.map((f) => f.acc).filter(Number.isFinite);
  if (!accs.length) return NaN;
  return Math.max(Math.min(...accs), median(accs) / Math.sqrt(Math.min(accs.length, 3)));
}

export class GpsFilter {
  constructor() { this.fixes = []; this.last = null; this.lock = null; this.measure = null; this.state = { pos: null, sigma: NaN, moving: false, mode: 'wait', n: 0, t: 0 }; }

  /** @param f {lat, lon, acc, t (ms), speed?} → state */
  push(f) {
    if (!Number.isFinite(f.lat) || !Number.isFinite(f.lon)) return this.state;
    const acc = Number.isFinite(f.acc) && f.acc > 0 ? f.acc : 30;
    const fix = { lat: f.lat, lon: f.lon, acc, t: f.t };
    // a hopeless fix (>80m) is ignored once we already have a usable position
    if (acc > 80 && this.state.pos) { this.state = { ...this.state }; return this.state; }

    // movement: device speed if reported, else displacement between fixes (only when it exceeds the noise)
    let speed = Number.isFinite(f.speed) && f.speed >= 0 ? f.speed : null;
    if (speed == null && this.last) {
      const dt = Math.max(0.5, (fix.t - this.last.t) / 1000);
      const d = dist(this.last, fix);
      speed = d > Math.max(acc, this.last.acc) * 0.5 ? d / dt : 0;
    }
    const moving = (speed || 0) > MOVING_MS;
    this.last = fix;

    if (this.measure) {
      this.measure.fixes.push(fix);
      if (fix.t >= this.measure.until) return this.finishMeasure(fix.t);
      this.state = { ...this.state, mode: 'measuring', t: fix.t, left: Math.ceil((this.measure.until - fix.t) / 1000) };
      return this.state;
    }
    if (this.lock) {
      // hold the averaged position until the player walks away or 90s pass
      if (fix.t < this.lock.until && !moving && dist(this.lock.pos, fix) < Math.max(6, acc * 0.8)) {
        this.state = { ...this.state, t: fix.t, mode: 'lock' };
        return this.state;
      }
      this.lock = null; this.fixes = [];
    }
    if (moving) {
      this.fixes = [fix];
      this.state = { pos: { lat: fix.lat, lon: fix.lon }, sigma: acc, moving: true, mode: 'moving', n: 1, t: fix.t };
      return this.state;
    }
    // stationary: rolling window, restarted after a jump larger than the noise
    const prev = this.fixes[this.fixes.length - 1];
    if (prev && dist(prev, fix) > Math.max(8, acc)) this.fixes = [];
    this.fixes.push(fix);
    this.fixes = this.fixes.filter((x) => fix.t - x.t <= WINDOW_MS).slice(-WINDOW_N);
    this.state = { pos: wmean(this.fixes), sigma: sigmaOf(this.fixes), moving: false, mode: acc > 15 ? 'poor' : this.fixes.length >= 3 ? 'stable' : 'settling', n: this.fixes.length, t: fix.t };
    return this.state;
  }

  startMeasure(now, ms = 6000) { this.measure = { until: now + ms, fixes: [] }; this.lock = null; return this.state; }
  finishMeasure(now) {
    const fs = [...(this.measure?.fixes || []), ...this.fixes.slice(-2)];
    this.measure = null;
    if (fs.length < 3) { this.state = { ...this.state, mode: this.state.pos ? 'stable' : 'wait', measureFailed: true }; return this.state; }
    // drop outliers (> 1.5× median distance from the first mean), then accuracy-weighted mean
    let m = wmean(fs);
    const ds = fs.map((x) => dist(x, m));
    const med = median(ds);
    const kept = fs.filter((x, i) => ds[i] <= Math.max(2, med * 1.5));
    const use = kept.length >= 3 ? kept : fs;
    m = wmean(use);
    const sigma = Math.max(Math.min(...use.map((x) => x.acc)) * 0.8, median(use.map((x) => x.acc)) / 2);
    this.lock = { until: now + 90000, pos: m };
    this.state = { pos: m, sigma, moving: false, mode: 'lock', n: use.length, t: now, measureFailed: false };
    return this.state;
  }

  /** age in seconds of the last accepted fix */
  age(now) { return this.state.pos ? (now - this.state.t) / 1000 : Infinity; }
  isStale(now) { return this.age(now) > STALE_S; }
  reset() { this.fixes = []; this.last = null; this.lock = null; this.measure = null; this.state = { pos: null, sigma: NaN, moving: false, mode: 'wait', n: 0, t: 0 }; }
}
