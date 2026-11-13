// Routing around land and shallows: the fastest chain of waypoints between two marks,
// and where to tack on each piece so no board runs onto the shore.

import { KN, MANOEUVRE_LOSS, boardTimes, manoeuvreKind, planCourse, type Board, type CoursePlan } from './physics';
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
 * fast the boat makes good that way (beating and running included), plus the turns
 * a beat or run needs where the water is narrow. Water close to the shore margin or
 * barely deep enough costs extra, so the route stands off wherever that is cheap.
 */
export function findRoute(chart: Chart, from: LatLng, to: LatLng, tws: number, twd: number): LatLng[] | null {
  const exempt = [from, to];
  // Per metre along bearing `brg`: seconds of sailing, and seconds lost turning × the width of the water.
  // Zigzagging across water `width` m wide makes good width·(a1/c1 + a2/c2) per two turns
  // (a, c: each board's speed along and across the course).
  const rates = new Map<number, { vmc: number; pace: number; turns: number }>();
  const rate = (brg: number) => {
    const key = Math.round(brg);
    let r = rates.get(key);
    if (!r) {
      const plan = planCourse(tws, twd, key);
      const vmc = plan.vmc * KN;
      let turns = 0;
      if (plan.boards.length === 2) {
        const [b1, b2] = plan.boards;
        const along = (b: Board) => 1 / Math.abs(Math.tan(((b.cog - key) * Math.PI) / 180));
        turns = (2 / (along(b1) + along(b2))) * MANOEUVRE_LOSS[manoeuvreKind(b1, b2)];
      }
      rates.set(key, (r = { vmc, pace: vmc > 0.02 ? 1 / vmc : Infinity, turns }));
    }
    return r;
  };
  // A clear line that needs no tacking can't be beaten.
  if (chart.clear(from, to, exempt) && !rate(bearing(from, to)).turns) return [from, to];
  const start = snap(chart, from, exempt);
  const goal = snap(chart, to, exempt);
  if (start < 0 || goal < 0) return null;

  const { w, h } = chart.g;
  const { cellX, cellY } = chart;
  const moves = MOVES.map(([di, dj]) => {
    const len = Math.hypot(di * cellX, dj * cellY);
    const r = rate((Math.atan2(di * cellX, dj * cellY) * 180) / Math.PI);
    return { di, dj, vmc: r.vmc, turns: r.turns * len, cost: r.pace * len };
  });
  const cell = Math.max(cellX, cellY);
  const margin = Math.max(chart.safety.clearance, cell);
  /** 0–1: 1 at the edge of the shore margin or at the minimum depth, 0 with twice the margin and half as much depth again. */
  const risk = (k: number) => {
    // Centre to centre, as in passable(); a cell further out, so the string-pull below finds its doubled margin clear.
    const near = 1 - (chart.room(k) - chart.safety.clearance - cell / 2) / (margin + cell);
    const thin = (1.5 * chart.minDepth - chart.g.depth[k] - chart.tide) / (0.5 * chart.minDepth);
    return Math.min(1, Math.max(0, near, thin || 0)); // unknown depth (NaN) counts as deep
  };
  const width = (k: number) => 2 * Math.max(chart.room(k) - chart.safety.clearance, cell / 2);
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
      const nc = c + m.cost * (1 + risk(nk)) + m.turns / width(nk);
      if (nc < cost[nk]) {
        cost[nk] = nc;
        prev[nk] = k;
        heap.push(nk, nc + heur(ni, nj));
      }
    }
  }
  if (prev[goal] < 0 && goal !== start) return null;

  const cells: number[] = [];
  for (let k = goal; ; k = prev[k]) {
    cells.push(k);
    if (k === start) break;
  }
  cells.reverse();
  const raw = [from, ...cells.map((k) => chart.center(k)), to];
  const sofar = [0, ...cells.map((k) => cost[k]), cost[goal]]; // cost of the grid path up to each raw point
  /** The same cost model along a straight line. */
  const lineCost = (a: LatLng, b: LatLng) => {
    const len = distance(a, b);
    const r = rate(bearing(a, b));
    let sum = 0;
    let [k0, t0] = [-1, 0];
    const add = (t: number) => {
      if (k0 >= 0) sum += (t - t0) * len * (r.pace * (1 + risk(k0)) + r.turns / width(k0));
    };
    chart.walk(a, b, (k, _p, t) => {
      add(t);
      [k0, t0] = [k, t];
    });
    add(1);
    return sum;
  };
  // String-pull: from each waypoint jump to the farthest one in clear sight, keeping twice the
  // margin off the shore unless the water is too tight for that. A shortcut that costs more than
  // the way the search found (a narrow channel to tack up, say) is no shortcut.
  const short = (a: number, b: number, slack: number) =>
    chart.clear(raw[a], raw[b], exempt, slack) && lineCost(raw[a], raw[b]) <= (sofar[b] - sofar[a]) * 1.05;
  const far = (a: number, slack: number) => {
    let b = raw.length - 1;
    while (b > a + 1 && !short(a, b, slack)) b--;
    return b;
  };
  const path = [from];
  let a = 0;
  while (a < raw.length - 1) {
    let b = far(a, -margin);
    if (b === a + 1 && !chart.clear(raw[a], raw[b], exempt, -margin)) b = far(a, 0);
    path.push(raw[b]);
    a = b;
  }
  return path;
}

/**
 * Beat or run from `from` to `to` on long boards, starting on `first`: hold each as long as the
 * water allows, turning at the latest point from which the other board still gets back to the
 * rhumb line (which is clear) or, on the layline, to the mark. Null if the water is too tight.
 */
export function longBoards(chart: Chart | null, from: LatLng, to: LatLng, first: Board, second: Board, ex: LatLng[]): LatLng[] | null {
  const rhumb = { ...first, cog: bearing(from, to), sog: 1 };
  const pts = [from];
  let p = from;
  let [b, o] = [first, second];
  for (let n = 0; n < 80; n++) {
    const v = b.sog * KN;
    const at = (s: number) => offset(p, b.cog, v * s);
    const lay = Math.max(0, boardTimes(b, o, bearing(p, to), distance(p, to))[0]);
    let run = lay;
    if (chart && !chart.clear(p, at(run), ex)) {
      let lo = 0; // bisect: a longer run is never clearer
      for (let i = 0; i < 16; i++) {
        const mid = (lo + run) / 2;
        if (chart.clear(p, at(mid), ex)) lo = mid;
        else run = mid;
      }
      run = lo;
    }
    const back = (q: LatLng) => offset(q, o.cog, o.sog * KN * Math.max(0, boardTimes(o, rhumb, bearing(q, to), distance(q, to))[0]));
    const STEPS = 32;
    let k = STEPS;
    while (k > 0 && chart && !chart.clear(at((run * k) / STEPS), k === STEPS && run === lay ? to : back(at((run * k) / STEPS)), ex)) k--;
    const s = (run * k) / STEPS;
    if (v * s < 5) return null; // no room on this board
    p = at(s);
    pts.push(p);
    if (k === STEPS && run === lay) return [...pts, to];
    [b, o] = [o, b];
  }
  return null;
}

export interface SailedLeg {
  path: LatLng[];
  time: number; // s, including manoeuvres
  plan: CoursePlan;
  manoeuvres: number;
  tight: boolean; // no clear way found: short-tacking along the line, check the chart
}

/**
 * How to sail one straight, clear piece from `from` to `to`: direct, or on boards held as
 * far as the water allows, so there are as few tacks/gybes as possible (the long board first).
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
        p = offset(p, b.cog, (b.sog * KN * sailing * b.fraction) / n);
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

  const long = [longBoards(chart, from, to, b1, b2, ex), longBoards(chart, from, to, b2, b1, ex)].filter((x): x is LatLng[] => !!x);
  // Fewest turns wins; on a tie, the long board first.
  long.sort((x, y) => x.length - y.length || distance(y[0], y[1]) - distance(x[0], x[1]));
  if (long.length) return result(long[0]);
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
  const sail = (wps: LatLng[], c: Chart | null) => wps.slice(1).map((p, n) => sailLeg(c, wps[n], p, tws, twd, [from, to]));
  const total = (pieces: SailedLeg[]) => pieces.reduce((s, x) => s + x.time, 0);
  const waypoints = chart ? findRoute(chart, from, to, tws, twd) : [from, to];
  const blocked = !waypoints;
  let wps = waypoints ?? [from, to];
  let pieces = sail(wps, blocked ? null : chart);
  // The search weighs narrow water roughly; where the straight line is clear too, sail both and keep the faster.
  if (chart && wps.length > 2 && chart.clear(from, to, [from, to])) {
    const direct = sail([from, to], chart);
    if (total(direct) <= total(pieces)) [wps, pieces] = [[from, to], direct];
  }
  const path = [from, ...pieces.flatMap((s) => s.path.slice(1))];
  return {
    waypoints: wps,
    pieces,
    path,
    time: blocked ? Infinity : total(pieces),
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
