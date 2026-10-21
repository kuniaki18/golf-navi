// Community course map: holes registered by any user are sent (opt-out in settings) to a public relay;
// a scheduled GitHub Action validates and merges them into data/community/<courseId>.json for everyone.
import { state } from './store.js';
import { fetchJSON } from './util.js';

export const COMMUNITY_TOPIC = 'kunikuni-golf-holes-v1';
const round6 = (p) => p && { lat: Math.round(p.lat * 1e6) / 1e6, lon: Math.round(p.lon * 1e6) / 1e6 };

export async function submitHole(course, key, hole) {
  if (state.settings.shareMaps === false || !course || !hole?.tee || !hole?.green) return;
  state.deviceId ??= Math.random().toString(36).slice(2);
  const body = JSON.stringify({
    v: 1, courseId: course.id, courseName: course.name, key: String(key),
    tee: round6(hole.tee), green: round6(hole.green), mid: round6(hole.mid), par: hole.par || null,
    by: state.deviceId.slice(0, 8), at: Date.now(),
  });
  try { await fetch(`https://ntfy.sh/${COMMUNITY_TOPIC}`, { method: 'POST', body }); } catch {}
}

const cache = new Map();
let index = null;
export async function communityIndex() {
  if (!index) { try { index = await fetchJSON('data/community/_index.json', {}, 15000); } catch { index = {}; } }
  return index;
}
export async function communityHoles(courseId) {
  if (!courseId) return {};
  if (cache.has(courseId)) return cache.get(courseId);
  let holes = {};
  if (!(await communityIndex())[courseId]) { cache.set(courseId, holes); return holes; }
  try { const j = await fetchJSON(`data/community/${encodeURIComponent(courseId)}.json`, {}, 15000); holes = j.holes || {}; } catch {}
  for (const h of Object.values(holes)) h.community = true;
  cache.set(courseId, holes);
  return holes;
}
