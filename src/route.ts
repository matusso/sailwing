// Routing around land and shallows: the fastest chain of waypoints between two marks,
// and where to tack on each piece so no board runs onto the shore.

import { KN, MANOEUVRE_LOSS, manoeuvreKind, planCourse, type Board, type CoursePlan } from './physics';
import { bearing, distance, offset, type LatLng } from './geo';
import type { Chart } from './chart';

// 16 grid moves: the 8 neighbours plus knight's moves, for smoother headings.
const MOVES: [number, number][] = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
  [2, 1], [1, 2], [-1, 2], [-2, 1], [-2, -1], [-1, -2], [1, -2], [2, -1],
];

/** Snap a point to the nearest cell the boat can be in and sail to in a straight line, within `cells` cells. */
function snap(chart: Chart, p: LatLng, exempt: LatLng[], cells = 8): number {
  const k0 = chart.cell(p);
  if (k0 < 0) return -1;
  const { w, h } = chart.g;
  const i0 = k0 % w;
  const j0 = (k0 - i0) / w;
  let best = -1;
  let bestD = Infinity;
  let bestSeen = false;
  for (let dj = -cells; dj <= cells; dj++) {
    for (let di = -cells; di <= cells; di++) {
      const [i, j] = [i0 + di, j0 + dj];
      if (i < 0 || j < 0 || i >= w || j >= h) continue;
      const k = j * w + i;
      const d = di * di + dj * dj;
      // Cells out of sight (behind a shoal) only count when nothing in sight is passable.
      const c = chart.center(k);
      if (d >= bestD || !chart.passable(k, c, exempt)) continue;
      const seen = chart.clear(p, c, exempt);
      if (seen || !bestSeen) [best, bestD, bestSeen] = [k, seen ? d : d + 1e6, seen];
    }
  }
  return best;
}

class Heap {
  private k: number[] = [];
  private f: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, pri: number) {
    let i = this.k.length;
    this.k.push(key);
    this.f.push(pri);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[p] <= pri) break;
      [this.k[i], this.f[i]] = [this.k[p], this.f[p]];
      i = p;
    }
    [this.k[i], this.f[i]] = [key, pri];
  }
  pop(): number {
    const top = this.k[0];
    const key = this.k.pop()!;
    const pri = this.f.pop()!;
    const n = this.k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && this.f[c + 1] < this.f[c]) c++;
        if (this.f[c] >= pri) break;
        [this.k[i], this.f[i]] = [this.k[c], this.f[c]];
        i = c;
      }
      [this.k[i], this.f[i]] = [key, pri];
    }
    return top;
  }
}

/**
 * Fastest chain of straight, clear waypoints from `from` to `to`, or null if the
 * mark can't be reached. Cost is sailing time: each direction is weighed by how
 * fast the boat makes good that way (beating and running included).
 */
export function findRoute(chart: Chart, from: LatLng, to: LatLng, tws: number, twd: number): LatLng[] | null {
  const exempt = [from, to];
  if (chart.clear(from, to, exempt)) return [from, to];
  const start = snap(chart, from, exempt);
  const goal = snap(chart, to, exempt);
  if (start < 0 || goal < 0) return null;

  const { w, h } = chart.g;
  const { cellX, cellY } = chart;
  const moves = MOVES.map(([di, dj]) => {
    const len = Math.hypot(di * cellX, dj * cellY);
    const brg = (Math.atan2(di * cellX, dj * cellY) * 180) / Math.PI;
    const vmc = planCourse(tws, twd, brg).vmc * KN;
    return { di, dj, vmc, cost: vmc > 0.02 ? len / vmc : Infinity };
  });
  const vMax = Math.max(...moves.map((m) => m.vmc));
  if (!(vMax > 0.02)) return null;
  const gi = goal % w;
  const gj = (goal - gi) / w;
  const heur = (i: number, j: number) => Math.hypot((i - gi) * cellX, (j - gj) * cellY) / vMax;

  const ok = new Int8Array(w * h); // 0 unknown, 1 passable, -1 blocked
  const passable = (i: number, j: number) => {
    if (i < 0 || j < 0 || i >= w || j >= h) return false;
    const k = j * w + i;
    if (!ok[k]) ok[k] = chart.passable(k, chart.center(k), exempt) ? 1 : -1;
    return ok[k] > 0;
  };
  const cost = new Float64Array(w * h).fill(Infinity);
  const prev = new Int32Array(w * h).fill(-1);
  const heap = new Heap();
  cost[start] = 0;
  heap.push(start, heur(start % w, Math.floor(start / w)));
  while (heap.size) {
    const k = heap.pop();
    if (k === goal) break;
    const i = k % w;
    const j = (k - i) / w;
    const c = cost[k];
    for (const m of moves) {
      if (m.cost === Infinity) continue;
      const [ni, nj] = [i + m.di, j + m.dj];
      if (!passable(ni, nj)) continue;
      // Diagonals mustn't cut a corner, and knight's moves cut across two cells: all must be open.
      if (Math.abs(m.di) === 1 && Math.abs(m.dj) === 1 && (!passable(i + m.di, j) || !passable(i, j + m.dj))) continue;
      if (Math.abs(m.di) + Math.abs(m.dj) === 3) {
        const a = Math.abs(m.di) === 2 ? [i + Math.sign(m.di), j] : [i, j + Math.sign(m.dj)];
        const b = Math.abs(m.di) === 2 ? [i + Math.sign(m.di), j + m.dj] : [i + m.di, j + Math.sign(m.dj)];
        if (!passable(a[0], a[1]) || !passable(b[0], b[1])) continue;
      }
      const nk = nj * w + ni;
      const nc = c + m.cost;
      if (nc < cost[nk]) {
        cost[nk] = nc;
        prev[nk] = k;
        heap.push(nk, nc + heur(ni, nj));
      }
    }
  }
  if (prev[goal] < 0 && goal !== start) return null;

  const cells: LatLng[] = [];
  for (let k = goal; ; k = prev[k]) {
    cells.push(chart.center(k));
    if (k === start) break;
  }
  const raw = [from, ...cells.reverse(), to];
  // String-pull: from each waypoint jump to the farthest one still in clear sight.
  const path = [from];
  let a = 0;
  while (a < raw.length - 1) {
    let b = raw.length - 1;
    while (b > a + 1 && !chart.clear(raw[a], raw[b], exempt)) b--;
    path.push(raw[b]);
    a = b;
  }
  return path;
}

export interface SailedLeg {
  path: LatLng[];
  time: number; // s, including manoeuvres
  plan: CoursePlan;
  manoeuvres: number;
  tight: boolean; // no clear way found: short-tacking along the line, check the chart
}

/**
 * How to sail one straight, clear piece from `from` to `to`: direct, one tack/gybe with
 * the corner on whichever side is clear, or as many short boards as the water allows.
 */
export function sailLeg(chart: Chart | null, from: LatLng, to: LatLng, tws: number, twd: number, exempt: LatLng[] = []): SailedLeg {
  const dist = distance(from, to);
  const plan = planCourse(tws, twd, bearing(from, to), dist);
  if (plan.vmc < 0.05) return { path: [from, to], time: Infinity, plan, manoeuvres: 0, tight: false };
  const sailing = dist / (plan.vmc * KN);
  if (plan.boards.length < 2) return { path: [from, to], time: sailing, plan, manoeuvres: 0, tight: false };

  const [b1, b2] = plan.boards as [Board, Board];
  const loss = MANOEUVRE_LOSS[manoeuvreKind(b1, b2)];
  const ex = [from, to, ...exempt];
  const zigzag = (first: Board, second: Board, n: number) => {
    const pts = [from];
    let p = from;
    for (let s = 0; s < n; s++) {
      for (const b of [first, second]) {
        p = offset(p, b.heading, (b.speed * KN * sailing * b.fraction) / n);
        pts.push(p);
      }
    }
    pts[pts.length - 1] = to;
    return pts;
  };
  const isClear = (pts: LatLng[]) => !chart || pts.every((p, n) => n === 0 || chart.clear(pts[n - 1], p, ex));
  const result = (path: LatLng[], tight = false): SailedLeg => {
    const manoeuvres = path.length - 2;
    return { path, time: sailing + manoeuvres * loss, plan, manoeuvres, tight };
  };

  for (const x of [b1, b2]) {
    const pts = [from, offset(from, x.heading, x.speed * KN * sailing * x.fraction), to];
    if (isClear(pts)) return result(pts);
  }
  for (let n = 2; n <= 40; n++) {
    for (const [x, y] of [[b1, b2], [b2, b1]] as const) {
      const pts = zigzag(x, y, n);
      if (isClear(pts)) return result(pts);
    }
  }
  // A channel too narrow for the model's resolution: short-tack the rhumb line and flag it.
  return result(zigzag(b1, b2, 40), true);
}

export interface RoutedLeg {
  waypoints: LatLng[]; // from, any detour points, to
  pieces: SailedLeg[];
  path: LatLng[];
  time: number;
  blocked: boolean; // no way through
  tight: boolean;
}

/** Plan a whole leg: route around hazards, then sail each piece. Without a chart it's the straight line. */
export function routeLeg(chart: Chart | null, from: LatLng, to: LatLng, tws: number, twd: number): RoutedLeg {
  const waypoints = chart ? findRoute(chart, from, to, tws, twd) : [from, to];
  const blocked = !waypoints;
  const wps = waypoints ?? [from, to];
  const pieces = wps.slice(1).map((p, n) => sailLeg(blocked ? null : chart, wps[n], p, tws, twd, [from, to]));
  const path = [from, ...pieces.flatMap((s) => s.path.slice(1))];
  return {
    waypoints: wps,
    pieces,
    path,
    time: blocked ? Infinity : pieces.reduce((s, x) => s + x.time, 0),
    blocked,
    tight: pieces.some((s) => s.tight),
  };
}

/** A detour waypoint counts as rounded within this distance. */
export const WAYPOINT_M = 20;

/**
 * Which waypoint of `route` to steer for from `pos`: the furthest one in clear sight.
 * Routes run along the edge of the shore margin, so sight is judged with half the margin:
 * a boat a few metres off the line still sees the next waypoint round the corner.
 * Failing that, the next waypoint, if only the margin (not land or shallows) is in the way.
 * `lost` means none is in sight and the boat needs a new route.
 */
export function nextWaypoint(chart: Chart, pos: LatLng, route: LatLng[], wp: number, mark: LatLng): { wp: number; lost: boolean } {
  const exempt = [pos, mark];
  const last = route.length - 1;
  const slack = Math.max(chart.safety.clearance / 2, Math.max(chart.cellX, chart.cellY));
  let w = Math.min(Math.max(1, wp), last);
  while (w < last && distance(pos, route[w]) < WAYPOINT_M) w++;
  for (let k = last; k >= w; k--) if (chart.clear(pos, route[k], exempt, slack)) return { wp: k, lost: false };
  // Right by the route, the next waypoint will do as long as nothing solid is in the way.
  if (chart.clear(pos, route[w], exempt, Infinity)) return { wp: w, lost: false };
  return { wp: w, lost: true };
}
