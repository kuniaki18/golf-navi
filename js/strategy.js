// Rule-based hole strategy from the hole's geometry and hazards. Works offline, no AI needed.
import { m2y, dist, bearing, xy } from './util.js';
import { hazardsForHole } from './osm.js';

function doglegs(line) {
  const out = [];
  if (line.length < 3) return out;
  let acc = 0;
  for (let i = 1; i < line.length - 1; i++) {
    acc += dist(line[i - 1], line[i]);
    const b1 = bearing(line[i - 1], line[i]), b2 = bearing(line[i], line[i + 1]);
    let turn = ((b2 - b1 + 540) % 360) - 180;
    if (Math.abs(turn) >= 22) out.push({ at: m2y(acc), dir: turn > 0 ? '右' : '左', deg: Math.abs(Math.round(turn)) });
  }
  return out;
}

function greenShape(hole) {
  if (!hole.green?.pts?.length) return null;
  const approachFrom = hole.line?.[Math.max(0, hole.line.length - 2)] || hole.tee;
  if (!approachFrom || !hole.center) return null; // green known but no tee / line yet
  const b = (bearing(approachFrom, hole.center) * Math.PI) / 180;
  const ux = Math.sin(b), uy = Math.cos(b);
  let minA = Infinity, maxA = -Infinity, minL = Infinity, maxL = -Infinity;
  for (const p of hole.green.pts) {
    const v = xy(hole.center, p);
    const a = v.x * ux + v.y * uy, l = v.x * uy - v.y * ux;
    minA = Math.min(minA, a); maxA = Math.max(maxA, a); minL = Math.min(minL, l); maxL = Math.max(maxL, l);
  }
  return { depth: m2y(maxA - minA), width: m2y(maxL - minL) };
}

const side = (lat) => (lat > 0 ? '左' : '右');
const opp = (lat) => (lat > 0 ? '右' : '左');

/** returns { tips: string[], hazards: [...], summary } */
export function holeStrategy(hole, features, clubs) {
  const tips = [];
  if (!hole) return { tips: ['このホールのデータがありません。グリーン位置を手動設定すると距離が出せます。'], hazards: [] };
  const L = m2y(hole.lengthM);
  const par = hole.par || (L < 250 ? 3 : L < 470 ? 4 : 5);
  const sorted = clubs.filter((c) => c.carry > 0).sort((a, b) => b.carry - a.carry);
  const driver = sorted[0]?.carry || 210;
  const fav = sorted.reduce((best, c) => (Math.abs(c.carry - 100) < Math.abs((best?.carry ?? 999) - 100) ? c : best), null);
  const hz = hazardsForHole(hole, features).map((h) => ({ ...h, alongY: m2y(h.along), latY: m2y(h.lateral) }));
  const shape = greenShape(hole);
  const dl = doglegs(hole.line);

  if (par === 3) {
    const club = sorted.slice().reverse().find((c) => c.carry >= L - 3);
    tips.push(`パー3・約${Math.round(L)}y。${club ? `${club.name}が目安。` : ''}ピンよりグリーンセンターを狙うのが鉄則。`);
  } else {
    tips.push(`パー${par}・約${Math.round(L)}y。${dl.length ? `${dl.map((d) => `${Math.round(d.at)}y付近で${d.dir}に曲がるドッグレッグ`).join('、')}。` : 'ほぼストレートなホール。'}`);
  }

  // tee shot landing zone hazards
  if (par >= 4) {
    const zoneLo = driver - 35, zoneHi = driver + 15;
    const danger = hz.filter((h) => !h.nearGreen && h.alongY > zoneLo - 20 && h.alongY < zoneHi);
    if (danger.length) {
      const water = danger.find((h) => h.type === 'water');
      const left = danger.filter((h) => h.latY > 0).length, right = danger.filter((h) => h.latY < 0).length;
      if (water) tips.push(`ティーショットの落下地点（${Math.round(water.alongY)}y付近・${side(water.latY)}）に池。ドライバーにこだわらず手前に刻む選択も。`);
      if (left && !right) tips.push(`落下地点の左にハザード。フェアウェイ右サイドを狙うと安全。`);
      else if (right && !left) tips.push(`落下地点の右にハザード。フェアウェイ左サイドを狙うと安全。`);
      else if (left && right) tips.push(`落下地点は両サイドにハザードがあって狭い。キャリー${Math.round(zoneLo - 10)}y前後の番手で刻むのが堅実。`);
      const first = danger[0];
      const carryOver = first.alongY + m2y(first.size);
      if (first.alongY > 0 && carryOver < driver - 5) tips.push(`${first.type === 'water' ? '池' : 'バンカー'}越えはキャリー約${Math.round(carryOver)}y必要。`);
    } else if (!dl.length) {
      tips.push('ティーショットの落下地点にハザードは少なめ。思い切ってドライバーでOK。');
    }
    const dlTurn = dl[0];
    if (dlTurn && dlTurn.at < driver + 10) {
      tips.push(`${Math.round(dlTurn.at)}yで${dlTurn.dir}に曲がるので、${dlTurn.at < driver - 15 ? `ドライバーだと突き抜ける恐れ。${Math.round(dlTurn.at)}y前後で止まる番手が◎` : `曲がり角の${dlTurn.dir === '左' ? '右' : '左'}サイドへ打つと2打目が見やすい`}。`);
    }
  }

  // par 5 plan
  if (par === 5) {
    const second = sorted.find((c) => !/1W|Driver/i.test(c.name))?.carry || 190;
    if (L - driver <= second + 10) tips.push(`ナイスショットなら2オンも狙える距離（残り約${Math.round(L - driver)}y）。ただしグリーン周りのハザード次第。`);
    else if (fav) tips.push(`3打目を得意の${fav.name}（${fav.carry}y）で打てるよう、2打目は残り約${fav.carry}yに置く3オン作戦がおすすめ。`);
  }

  // green complex
  const gh = hz.filter((h) => h.nearGreen);
  if (gh.length) {
    const sides = {};
    for (const h of gh) {
      const k = h.alongY > L - 5 ? '奥' : Math.abs(h.latY) < 8 ? '手前' : side(h.latY);
      sides[k] = (sides[k] || []).concat(h.type === 'water' ? '池' : 'バンカー');
    }
    tips.push(`グリーン周り: ${Object.entries(sides).map(([k, v]) => `${k}に${[...new Set(v)].join('・')}`).join('、')}。`);
    const safe = ['左', '右'].find((s) => !sides[s]);
    if (sides['手前'] && !sides['奥']) tips.push('手前のハザードに注意。番手を1つ上げて奥目でもOK。');
    else if (safe && (sides['左'] || sides['右'])) tips.push(`外すなら${safe}サイド。ハザードのない側に外すと寄せやすい。`);
  }
  if (shape) {
    if (shape.depth < 25) tips.push(`グリーンは縦に浅い（奥行き約${Math.round(shape.depth)}y）。距離の打ち分けが大事。`);
    else if (shape.depth > 38) tips.push(`グリーンは縦長（奥行き約${Math.round(shape.depth)}y）。ピン位置で1〜2番手変わるので要確認。`);
    if (shape.width < 22) tips.push('グリーンの横幅が狭い。方向性重視でコンパクトに。');
  }
  if (hz.some((h) => h.type === 'water')) tips.push('池があるホールは「迷ったら大きめ・安全側」。ペナルティ1打は大きい。');

  return { tips, hazards: hz, par, lengthY: L, shape, doglegs: dl };
}

/** distances to each hazard from the player (front edge / carry-over) */
export function hazardDistancesFrom(me, hazards, center) {
  const toCenter = dist(me, center);
  return hazards.map((h) => {
    const ds = h.hz.pts.length ? h.hz.pts.map((p) => dist(me, p)) : [dist(me, h.hz.c)];
    return { ...h, front: m2y(Math.min(...ds)), carry: m2y(Math.max(...ds)), ahead: dist(me, h.hz.c) < toCenter + 30 };
  }).filter((h) => h.ahead);
}
