// Round plan: which nines are played (front / back) and in which order, for clubs with several courses
// (27 holes: 中・西・東 …, 36 holes: two 18s) or one 18-hole course (OUT / IN). Pure; unit-tested.

const keyOf = (no, set) => (set ? `${no}-${set + 1}` : String(no));

/** nines as the map data has them: each course split into OUT / IN when it has 18 holes */
function mapNines(allHoles, nameOf) {
  const sets = [...new Set(allHoles.map((h) => h.set || 0))].sort((a, b) => a - b);
  if (!sets.length) sets.push(0);
  const out = [];
  for (const s of sets) {
    const nos = allHoles.filter((h) => (h.set || 0) === s && h.no <= 18).map((h) => h.no);
    const max = nos.length ? Math.max(...nos) : 18;
    const count = (a, b) => nos.filter((n) => n >= a && n <= b).length;
    if (max > 9) {
      const base = sets.length > 1 ? `${nameOf(s)} ` : '';
      out.push({ id: `${s}:1`, set: s, from: 1, to: 9, name: `${base}OUT（1〜9番）`, short: sets.length > 1 ? `${nameOf(s)} OUT` : 'OUT', mapped: count(1, 9) });
      out.push({ id: `${s}:10`, set: s, from: 10, to: 18, name: `${base}IN（10〜18番）`, short: sets.length > 1 ? `${nameOf(s)} IN` : 'IN', mapped: count(10, 18) });
    } else {
      out.push({ id: `${s}:1`, set: s, from: 1, to: 9, name: nameOf(s), short: nameOf(s), mapped: count(1, 9) });
    }
  }
  return out;
}

/**
 * the nines a player can choose from
 * @param allHoles  holes from buildHoles (with .set and .no)
 * @param nameOf    (set) => course name, e.g. '中コース' or 'コースA'
 * @param scorecard official scorecard { courses: [{ name, holes: [...] }] } (optional)
 *
 * A 27-hole club whose official scorecard lists three 9-hole courses (中・西・東) is offered by those names even when
 * the map numbers its holes 1–18: the k-th official course uses the k-th nine of the map (order is an assumption the
 * player can correct with 番号修正), and a course the map does not have becomes empty holes the player can register.
 */
export function ninesOf(allHoles, nameOf, scorecard = null) {
  const map = mapNines(allHoles, nameOf);
  const sc = scorecard?.courses || [];
  // 36-hole club (two 18-hole courses on the card) but the map has fewer courses: offer every course's OUT / IN,
  // the k-th course on its own set of holes (empty until registered)
  const sets = [...new Set(allHoles.map((h) => h.set || 0))];
  if (sc.length >= 2 && sc.every((c) => c.holes?.length === 18) && sets.length < sc.length) {
    return sc.flatMap((c, k) => {
      const nm = c.name ? (/コース$/.test(c.name) ? c.name : `${c.name}コース`) : nameOf(k);
      const cnt = (a, b) => allHoles.filter((h) => (h.set || 0) === k && h.no >= a && h.no <= b && h.center).length;
      return [
        { id: `${k}:1`, set: k, from: 1, to: 9, name: `${nm} OUT（1〜9番）`, short: `${nm} OUT`, mapped: cnt(1, 9) },
        { id: `${k}:10`, set: k, from: 10, to: 18, name: `${nm} IN（10〜18番）`, short: `${nm} IN`, mapped: cnt(10, 18) },
      ];
    });
  }
  if (sc.length < 2 || !sc.every((c) => c.holes?.length === 9)) return map;
  const used = new Set(map.map((n) => n.set));
  let spare = Math.max(0, ...used) + 1;
  return sc.map((c, k) => {
    const m = map[k];
    const name = c.name ? (/コース$/.test(c.name) ? c.name : `${c.name}コース`) : nameOf(k);
    const base = m || { set: spare++, from: 1, to: 9, mapped: 0 };
    return { id: `sc${k}`, set: base.set, from: base.from, to: base.to, mapped: base.mapped, name, short: name, sc: k };
  });
}

/** usual choice: the first two nines (OUT → IN, or the first two courses of a 27-hole club) */
export function defaultPlan(nines) { return { front: nines[0] || null, back: nines[1] || null }; }

/**
 * holes in playing order. Missing holes become placeholders so the round always has 9 / 18 positions.
 * Each hole gets roundIdx (0–17, the scorecard column), nine (0 = front, 1 = back) and dispNo (the number to show).
 */
export function planHoles(allHoles, plan) {
  const out = [];
  [plan.front, plan.back].forEach((nine, k) => {
    if (!nine) return;
    for (let no = nine.from; no <= nine.to; no++) {
      const pos = k * 9 + (no - nine.from);
      const h = allHoles.find((x) => (x.set || 0) === nine.set && x.no === no)
        || { no, key: keyOf(no, nine.set), set: nine.set, par: null, line: [], tee: null, green: null, center: null, lengthM: 0, source: 'none' };
      const extra = { roundIdx: pos, nine: k, nineName: nine.short, dispNo: nine.sc != null ? no - nine.from + 1 : no };
      if (nine.sc != null) Object.assign(extra, { scIdx: nine.sc, scNo: no - nine.from + 1 });
      out.push(Object.assign({}, h, extra));
    }
  });
  return out;
}

/** the official scorecard row for a hole of the plan (or null) */
export function scRow(h, scorecard) {
  const c = scorecard?.courses?.[h.scIdx ?? (h.set || 0)];
  return c?.holes?.[(h.scNo ?? h.no) - 1] || null;
}

/** pars for the 18 scorecard columns: official scorecard first, then the hole data */
export function planPars(plan, holes, scorecard) {
  const pars = Array(18).fill(4);
  for (const h of holes) pars[h.roundIdx] = scRow(h, scorecard)?.par || (h.parEst ? null : h.par) || 4;
  return pars;
}
