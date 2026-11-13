// Live race navigation: what to steer now, and when to tack or gybe, to reach the next mark fastest.

import {
  KN,
  boardTimes,
  directBoard,
  madeGood,
  MANOEUVRE_LOSS,
  manoeuvreKind,
  norm180,
  norm360,
  planCourse,
  type Board,
  type CoursePlan,
} from './physics';
import { bearing, distance, offset, type LatLng } from './geo';
import type { Chart } from './chart';
import { longBoards } from './route';

/** Within this many seconds of the layline it's time to turn. */
export const TURN_NOW_S = 8;
export const PREPARE_S = 30;

export interface Advice {
  dist: number; // m to the mark
  brg: number; // bearing to the mark
  plan: CoursePlan;
  action: 'direct' | 'hold' | 'tack' | 'gybe';
  board: Board; // what to sail right now
  next?: Board; // what to sail after the manoeuvre
  turn?: { time: number; dist: number; at: LatLng; kind: 'tack' | 'gybe' };
  eta: number; // s to the mark including manoeuvre loss
  steer: number; // deg to turn to the target heading, + = to starboard
  laylines: [LatLng, LatLng][];
  path: LatLng[];
}

/**
 * Advice for sailing from `pos` (currently on `heading`) to `mark`.
 * On a beat or run in open water the boat stays on its current tack until the layline,
 * so there is a single, well-timed manoeuvre. With a `chart` the boards are planned all
 * the way to the mark around land, shallows and the shore margin, for the fewest turns:
 * that can mean turning now, off a board that would cost extra tacks later
 * (`exempt` points, like the mark being rounded, waive the margin around them).
 */
export function advise(
  pos: LatLng,
  heading: number,
  tws: number,
  twd: number,
  mark: LatLng,
  chart: Chart | null = null,
  exempt: LatLng[] = [],
): Advice {
  const dist = distance(pos, mark);
  const brg = bearing(pos, mark);
  const plan = planCourse(tws, twd, brg, dist);
  const steerTo = (h: number) => norm180(h - heading);

  const curTwa = norm180(twd - heading);
  const tack = curTwa >= 0 ? 1 : -1;
  // Turning the short way crosses the bow (tack) if the two TWAs add up to < 180°.
  const turnTo = (b: Board) =>
    Math.sign(b.twa || 1) === tack ? null : Math.abs(curTwa) + Math.abs(b.twa) < 180 ? ('tack' as const) : ('gybe' as const);

  // Option A: straight at the mark, turning first if it's on the other tack.
  const d = plan.direct;
  const dTurn = turnTo(d);
  const dv = madeGood(d, brg); // ≤ 0: the current is stronger than the boat on this course
  const directEta = dv > 0.05 ? dist / (dv * KN) + (dTurn ? MANOEUVRE_LOSS[dTurn] : 0) : Infinity;
  const directAdvice = (): Advice => ({
    dist,
    brg,
    plan,
    action: dTurn ?? 'direct',
    board: d,
    eta: directEta,
    steer: steerTo(d.heading),
    laylines: [],
    path: [pos, mark],
  });
  if (!plan.pair) return directAdvice();

  // Option B: hold this tack to the layline, then one tack/gybe.
  let [b1, b2] = plan.pair.boards;
  if (Math.sign(b1.twa || 1) !== tack) [b1, b2] = [b2, b1];
  const [t1, t2] = boardTimes(b1, b2, brg, dist);
  const kind = manoeuvreKind(b1, b2);
  const twoEta = Math.max(0, t1) + Math.max(0, t2) + MANOEUVRE_LOSS[kind];
  if (directEta <= twoEta) return directAdvice();

  const layLen = Math.max(dist * 1.3, 400);
  const laylines: [LatLng, LatLng][] = [b1, b2].map((b) => [mark, offset(mark, b.cog + 180, layLen)]);

  const hold = (turnAt: number): Advice => {
    const at = offset(pos, b1.cog, b1.sog * KN * turnAt);
    return {
      dist,
      brg,
      plan,
      action: 'hold',
      board: b1,
      next: b2,
      turn: { time: turnAt, dist: b1.sog * KN * turnAt, at, kind },
      eta: twoEta,
      steer: steerTo(b1.heading),
      laylines,
      path: [pos, at, mark],
    };
  };
  // Option C: on (or past) the layline — turn now onto the other board,
  // unless that board has no water: then hold on, or sail straight at the mark.
  const turnNow = (): Advice => {
    if (chart) {
      const ex = [pos, mark, ...exempt];
      const room = TURN_NOW_S * 2;
      const r2 = openRun(chart, pos, b2, room * 2, ex);
      if (r2 < room) {
        const r1 = openRun(chart, pos, b1, room * 2, ex);
        if (r1 >= room && r1 > r2) return hold(r1 - TURN_NOW_S);
        if (dv > 0.3) return directAdvice();
      }
    }
    return { dist, brg, plan, action: kind, board: b2, eta: twoEta, steer: steerTo(b2.heading), laylines, path: [pos, mark] };
  };

  if (t1 <= TURN_NOW_S) return turnNow();

  // The best moment to turn is slightly before the geometric layline: as soon as
  // sailing straight at the mark on the other board is as fast as holding on.
  const v1 = b1.sog * KN;
  const gain = (s: number) => {
    const p = offset(pos, b1.cog, v1 * s);
    const v = madeGood(directBoard(tws, twd, bearing(p, mark)), bearing(p, mark)) * KN;
    return (v > 0.05 ? distance(p, mark) / v : Infinity) - (t1 - s + Math.max(0, t2));
  };
  let lo = 0;
  let hi = t1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (gain(mid) > 0) lo = mid;
    else hi = mid;
  }
  let turnAt = hi;
  if (chart) {
    // Plan the boards all the way to the mark, starting on either one.
    const ex = [pos, mark, ...exempt];
    const stay = longBoards(chart, pos, mark, b1, b2, ex);
    const swap = longBoards(chart, pos, mark, b2, b1, ex);
    // Turning now is a manoeuvre too: only if the other board saves more than that further on.
    if (swap && (!stay || swap.length + 1 < stay.length)) return turnNow();
    turnAt = stay ? Math.min(turnAt, distance(pos, stay[1]) / v1) : safeTurn(chart, pos, b1, mark, turnAt, ex);
    if (stay && turnAt > TURN_NOW_S) return { ...hold(turnAt), eta: twoEta + (stay.length - 3) * MANOEUVRE_LOSS[kind] };
  }
  return turnAt <= TURN_NOW_S ? turnNow() : hold(turnAt);
}

/** Seconds board `b` can be sailed from `pos` (up to `max`) before it runs out of clear water. */
function openRun(chart: Chart, pos: LatLng, b: Board, max: number, exempt: LatLng[]): number {
  const v = b.sog * KN;
  let open = 0;
  for (let s = 2; s <= max; s += 2) {
    if (!chart.clear(pos, offset(pos, b.cog, v * s), exempt)) break;
    open = s;
  }
  return open;
}

/**
 * The latest time (≤ `turnAt`) to turn off board `b` such that the run to the turn and the
 * line from there to the mark are both clear. If no turn point sees the mark (a narrow channel),
 * turn just before this board would run out of water, which makes it a short tack.
 */
function safeTurn(chart: Chart, pos: LatLng, b: Board, mark: LatLng, turnAt: number, exempt: LatLng[]): number {
  const v = b.sog * KN;
  const at = (s: number) => offset(pos, b.cog, v * s);
  const STEPS = 48;
  // Furthest we can hold this board before it gets into trouble.
  let open = 0;
  for (let n = 1; n <= STEPS; n++) {
    const s = (turnAt * n) / STEPS;
    if (!chart.clear(pos, at(s), exempt)) break;
    open = s;
  }
  for (let n = STEPS; n >= 0; n--) {
    const s = (turnAt * n) / STEPS;
    if (s <= open && chart.clear(at(s), mark, exempt)) return s;
  }
  return open;
}

/** "Head up" / "Bear away" for a small correction, else the heading to steer. */
export function steerHint(steer: number, heading: number, twd: number): string {
  if (Math.abs(steer) < 3) return 'On target';
  if (Math.abs(steer) > 45) return `Steer ${Math.round(norm360(heading + steer))}°`;
  const before = Math.abs(norm180(twd - heading));
  const after = Math.abs(norm180(twd - heading - steer));
  return `${after < before ? 'Head up' : 'Bear away'} ${Math.round(Math.abs(steer))}°`;
}
