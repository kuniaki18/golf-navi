// Small helpers shared by the tests: local metric offsets → lat/lon around a fixed origin.
export const O = { lat: 35.9, lon: 139.4 };
const R = 6371008.8, rad = Math.PI / 180;
export const at = (east, north, o = O) => ({ lat: o.lat + north / (rad * R), lon: o.lon + east / (rad * R * Math.cos(o.lat * rad)) });
// deterministic pseudo-random numbers (tests must be reproducible)
export function rng(seed = 1) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
export const gauss = (r) => { const u = Math.max(1e-12, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
export const square = (cx, cy, half) => [at(cx - half, cy - half), at(cx + half, cy - half), at(cx + half, cy + half), at(cx - half, cy + half), at(cx - half, cy - half)];
