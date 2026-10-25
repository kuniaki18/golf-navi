// Travel time to a course (like じゃらんゴルフ's comparison from several starting points).
// No routing service is used: road distance ≈ straight line × 1.3, and a blend of local roads and expressways.
// The result is a rough guide (目安) and is always labelled so.

/** @returns {{ roadKm: number, min: number }} */
export function driveEstimate(straightKm) {
  const roadKm = straightKm * 1.3;
  // first 15 km on local roads (≈30 km/h), the rest mostly expressway (≈70 km/h incl. getting on/off)
  const local = Math.min(roadKm, 15), fast = Math.max(0, roadKm - 15);
  const min = (local / 30 + fast / 70) * 60;
  return { roadKm, min: Math.max(5, Math.round(min / 5) * 5) };
}

export function fmtMinutes(min) {
  if (min < 60) return `約${min}分`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `約${h}時間${m}分` : `約${h}時間`;
}

/** address → { lat, lon, label } with 国土地理院's address search (free, no key) */
export async function geocode(q) {
  const r = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error('住所を検索できませんでした');
  const j = await r.json();
  const f = j?.[0];
  if (!f) throw new Error('その住所が見つかりませんでした。市区町村名から入れてみてください');
  const [lon, lat] = f.geometry.coordinates;
  return { lat, lon, label: f.properties?.title || q };
}
