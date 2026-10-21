// Everything is kept on the device (localStorage). Videos are never stored; they are exported instead.
const KEY = 'golfnavi:v1';
const CACHE_KEY = 'golfnavi:coursecache:v1';

export const DEFAULT_CLUBS = [
  { name: '1W', carry: 220 }, { name: '3W', carry: 200 }, { name: '5W', carry: 185 },
  { name: '4U', carry: 175 }, { name: '5I', carry: 165 }, { name: '6I', carry: 155 },
  { name: '7I', carry: 145 }, { name: '8I', carry: 135 }, { name: '9I', carry: 125 },
  { name: 'PW', carry: 110 }, { name: '50°', carry: 95 }, { name: '56°', carry: 80 },
];

const defaults = () => ({
  settings: { unit: 'yd', name: '', claudeKey: '', model: 'claude-sonnet-5-5', rakutenId: '', rakutenKey: '', rakutenAff: '', targetScore: 90 },
  clubs: DEFAULT_CLUBS.map((c) => ({ ...c })),
  course: null,
  notes: {},
  greenPins: {},
  aiTips: {},
  current: null,
  rounds: [],
  shots: [],
  pendingShot: null,
  ui: { tab: 'navi', hole: 1 },
});

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const d = JSON.parse(raw), base = defaults();
    return { ...base, ...d, settings: { ...base.settings, ...d.settings }, ui: { ...base.ui, ...d.ui } };
  } catch { return defaults(); }
}

export const state = load();
const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

let saveTimer;
export function save(reason) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { console.warn('save failed', e); }
  }, 150);
  listeners.forEach((fn) => { try { fn(reason); } catch (e) { console.error(e); } });
}
export function saveNow() { clearTimeout(saveTimer); try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} }
window.addEventListener('pagehide', saveNow);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

// ---- course feature cache (separate key so the main state stays small) ----
function readCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; } }
export function getCourseCache(id) { return readCache()[id] || null; }
export function putCourseCache(id, data) {
  const c = readCache();
  c[id] = { ...data, savedAt: Date.now() };
  const keys = Object.keys(c).sort((a, b) => c[b].savedAt - c[a].savedAt);
  for (const k of keys.slice(8)) delete c[k];
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); }
  catch { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ [id]: c[id] })); } catch {} }
}

// ---- notes / pins per course & hole ----
export function getNote(courseId, hole) { return state.notes[courseId]?.[hole]?.text || ''; }
export function setNote(courseId, hole, text) {
  state.notes[courseId] ??= {};
  state.notes[courseId][hole] = { text, updatedAt: Date.now(), by: state.settings.name || '' };
  save('note');
}
export function getPin(courseId, hole) { return state.greenPins[courseId]?.[hole] || null; }
export function setPin(courseId, hole, p) {
  state.greenPins[courseId] ??= {};
  if (p) state.greenPins[courseId][hole] = { lat: p.lat, lon: p.lon, updatedAt: Date.now() };
  else delete state.greenPins[courseId][hole];
  save('pin');
}

// ---- export / import (sharing course knowledge with friends) ----
export function exportBundle({ includeRounds = true } = {}) {
  return {
    app: 'golf-navi', version: 1, exportedAt: new Date().toISOString(), by: state.settings.name || '',
    clubs: state.clubs, notes: state.notes, greenPins: state.greenPins, aiTips: state.aiTips,
    rounds: includeRounds ? state.rounds : [],
  };
}
/** merge: newer note/pin wins, rounds are added by id */
export function importBundle(b) {
  if (!b || b.app !== 'golf-navi') throw new Error('KUNIKUNIゴルフのファイルではありません');
  let notes = 0, pins = 0, rounds = 0;
  for (const [cid, holes] of Object.entries(b.notes || {})) {
    state.notes[cid] ??= {};
    for (const [h, n] of Object.entries(holes)) {
      const cur = state.notes[cid][h];
      if (!cur || (n.updatedAt || 0) > (cur.updatedAt || 0)) { state.notes[cid][h] = n; notes++; }
    }
  }
  for (const [cid, holes] of Object.entries(b.greenPins || {})) {
    state.greenPins[cid] ??= {};
    for (const [h, p] of Object.entries(holes)) {
      const cur = state.greenPins[cid][h];
      if (!cur || (p.updatedAt || 0) > (cur.updatedAt || 0)) { state.greenPins[cid][h] = p; pins++; }
    }
  }
  for (const [cid, holes] of Object.entries(b.aiTips || {})) {
    state.aiTips[cid] ??= {};
    for (const [h, t] of Object.entries(holes)) {
      const cur = state.aiTips[cid][h];
      if (!cur || (t.updatedAt || 0) > (cur.updatedAt || 0)) state.aiTips[cid][h] = t;
    }
  }
  const ids = new Set(state.rounds.map((r) => r.id));
  for (const r of b.rounds || []) if (!ids.has(r.id)) { state.rounds.push(r); rounds++; }
  state.rounds.sort((a, b2) => (a.date < b2.date ? 1 : -1));
  save('import');
  return { notes, pins, rounds };
}
