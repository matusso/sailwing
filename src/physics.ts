// Simplified velocity-prediction model for a small keelboat with main + jib.
// Angles in degrees, wind/boat speeds in knots unless noted.

export const KN = 0.514444; // m/s per knot
const DEG = Math.PI / 180;
const RHO_AIR = 1.225;
const RHO_WATER = 1025;

export const BOAT = {
  name: 'Sailwing 24',
  lwl: 7.0, // m
  mainArea: 16, // m²
  jibArea: 10, // m²
  ceHeight: 4.0, // m, centre of effort above waterline
  rmMax: 8500, // N·m, max righting moment
  keelSpan: 1.6, // m, effective span for induced drag
  wetted: 11, // m²
};

const HULL_SPEED = 1.34 * Math.sqrt(BOAT.lwl * 3.28084) * KN; // m/s

export interface Trim {
  main: number; // boom angle from centreline, 0–90
  jib: number; // jib sheet angle from centreline, 0–90
}

// "eased" = let out too far, "over-trimmed" = sheeted in too hard
export type SailStatus = 'luffing' | 'eased' | 'trimmed' | 'over-trimmed';

export interface SailState {
  aoa: number; // angle of attack, deg
  status: SailStatus;
  efficiency: number; // 0–1 vs best trim for this sail at this AWA
  bestAngle: number; // the sheet angle that maximises drive
}

export interface BoatState {
  speed: number; // kn
  twa: number; // signed, + = wind from starboard
  awa: number; // signed
  aws: number; // kn
  heel: number; // deg
  vmg: number; // kn, towards the wind (+) or away (−)
  main: SailState;
  jib: SailState;
}

export const norm360 = (a: number) => ((a % 360) + 360) % 360;
export const norm180 = (a: number) => {
  const x = norm360(a);
  return x > 180 ? x - 360 : x;
};

/** Sheets can't pull the sails onto the centreline (traveller / jib track limits). */
export const MIN_SHEET: Trim = { main: 2, jib: 9 };

/** A soft sail needs a few degrees of angle of attack before it fills. */
export const LUFF_AOA = 4;

const WINDAGE_AREA = 2.5; // m² × Cd of hull, rig and crew

/** Lift/drag coefficients for a soft sail at a given angle of attack. */
export function sailCoeffs(aoa: number, clMax: number): { cl: number; cd: number } {
  if (aoa <= LUFF_AOA) return { cl: 0, cd: 0.1 }; // flogging
  const a = Math.min(aoa - LUFF_AOA, 180) * DEG;
  const stall = 20 * DEG;
  const w = 1 / (1 + Math.exp((a - stall) / (3 * DEG))); // attached-flow weight
  const clAtt = clMax * Math.sin((Math.min(a / stall, 1) * Math.PI) / 2);
  const clSep = 1.1 * Math.sin(2 * a);
  const cl = w * clAtt + (1 - w) * clSep;
  const cd = w * (0.03 + 0.09 * clAtt * clAtt) + (1 - w) * (0.05 + 1.5 * Math.sin(a) ** 2);
  return { cl, cd };
}

/** Driving and side force coefficients of one sail (per unit q·area). */
function sailDrive(awaAbs: number, sheet: number, clMax: number) {
  const { cl, cd } = sailCoeffs(awaAbs - sheet, clMax);
  const s = Math.sin(awaAbs * DEG);
  const c = Math.cos(awaAbs * DEG);
  return { drive: cl * s - cd * c, side: cl * c + cd * s };
}

/** Jib loses effectiveness when blanketed by the main on a run. */
const jibFactor = (awaAbs: number) => (awaAbs < 135 ? 1 : Math.max(0.35, 1 - ((awaAbs - 135) / 45) * 0.65));

function apparent(tws: number, twa: number, v: number) {
  const x = tws * Math.cos(twa * DEG) + v;
  const y = tws * Math.sin(twa * DEG);
  return { aws: Math.hypot(x, y), awa: Math.atan2(y, x) / DEG };
}

function hullResistance(v: number, side: number) {
  const viscous = 0.5 * RHO_WATER * BOAT.wetted * 0.0045 * v * v;
  const wave = 650 * (v / HULL_SPEED) ** 7;
  const vv = Math.max(v, 0.1);
  const induced = (side * side) / (0.5 * RHO_WATER * vv * vv * Math.PI * BOAT.keelSpan ** 2);
  // At low speed the boat slips sideways instead; leeway drag tops out around 14°.
  return viscous + wave + Math.min(induced, 0.25 * side);
}

/** Net forward force (N) and heel at boat speed v (m/s). */
function forces(twsMs: number, twaAbs: number, trim: Trim, v: number) {
  const { aws, awa } = apparent(twsMs, twaAbs, v);
  const q = 0.5 * RHO_AIR * aws * aws;
  const m = sailDrive(awa, Math.max(MIN_SHEET.main, trim.main), 1.5);
  const j = sailDrive(awa, Math.max(MIN_SHEET.jib, trim.jib), 1.6);
  const jf = jibFactor(awa);
  let drive = q * (m.drive * BOAT.mainArea + j.drive * BOAT.jibArea * jf - WINDAGE_AREA * Math.cos(awa * DEG));
  let side = q * (m.side * BOAT.mainArea + j.side * BOAT.jibArea * jf);
  // Heel reduces projected sail area; resolve with one correction pass.
  const heel0 = Math.asin(Math.min(0.9, (side * BOAT.ceHeight) / BOAT.rmMax));
  const k = Math.cos(heel0) ** 2;
  drive *= k;
  side *= k;
  const heel = Math.asin(Math.min(0.9, (side * BOAT.ceHeight) / BOAT.rmMax)) / DEG;
  return { net: drive - hullResistance(v, side), aws, awa, heel };
}

function sailState(awaAbs: number, sheetIn: number, minSheet: number, clMax: number): SailState {
  const sheet = Math.max(minSheet, sheetIn);
  let best = minSheet;
  let bestDrive = -Infinity;
  for (let b = minSheet; b <= 90; b++) {
    const d = sailDrive(awaAbs, b, clMax).drive;
    if (d > bestDrive) {
      bestDrive = d;
      best = b;
    }
  }
  const aoa = awaAbs - sheet;
  const drive = sailDrive(awaAbs, sheet, clMax).drive;
  const efficiency = bestDrive > 0 ? Math.max(0, Math.min(1, drive / bestDrive)) : 0;
  let status: SailStatus = 'trimmed';
  if (aoa <= LUFF_AOA + 1) status = 'luffing';
  else if (efficiency < 0.95) status = sheet > best ? 'eased' : 'over-trimmed';
  return { aoa, status, efficiency, bestAngle: best };
}

/** Equilibrium boat speed in m/s (speed only, no diagnostics). */
function equilibrium(twsMs: number, twaAbs: number, trim: Trim): number {
  let v = 0;
  // Highest speed at which the sails still out-pull the hull, then refine.
  const vMax = HULL_SPEED * 1.8;
  const steps = 24;
  let k = steps - 1;
  while (k >= 0 && twsMs > 0 && forces(twsMs, twaAbs, trim, ((k + 0.5) / steps) * vMax).net <= 0) k--;
  if (k >= 0) {
    let lo = ((k + 0.5) / steps) * vMax;
    let hi = Math.min(vMax, lo + vMax / steps);
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (forces(twsMs, twaAbs, trim, mid).net > 0) lo = mid;
      else hi = mid;
    }
    v = lo;
  }
  return v;
}

/** Equilibrium boat state for a true wind speed/angle and sail trim. */
export function simulate(tws: number, twa: number, trim: Trim): BoatState {
  const twaAbs = Math.abs(norm180(twa));
  const twsMs = tws * KN;
  const v = equilibrium(twsMs, twaAbs, trim);
  const f = forces(twsMs, twaAbs, trim, v);
  const sign = norm180(twa) < 0 ? -1 : 1;
  const speed = v / KN;
  return {
    speed,
    twa: norm180(twa),
    awa: sign * f.awa,
    aws: f.aws / KN,
    heel: Math.max(0, f.heel),
    vmg: speed * Math.cos(twaAbs * DEG),
    main: sailState(f.awa, trim.main, MIN_SHEET.main, 1.5),
    jib: sailState(f.awa, trim.jib, MIN_SHEET.jib, 1.6),
  };
}

/** Find the sheet angles that maximise boat speed (coordinate descent). */
export function optimizeTrim(tws: number, twa: number): { trim: Trim; state: BoatState } {
  const twaAbs = Math.abs(norm180(twa));
  const speedOf = (t: Trim) => equilibrium(tws * KN, twaAbs, t);
  let trim: Trim = { main: 20, jib: 15 };
  let best = speedOf(trim);
  for (const step of [10, 5, 2, 1]) {
    for (let round = 0; round < 3; round++) {
      let improved = false;
      for (const key of ['main', 'jib'] as const) {
        const range =
          step === 10
            ? [...Array(10).keys()].map((i) => i * 10)
            : [-2, -1, 1, 2].map((i) => trim[key] + i * step);
        for (const val of range) {
          if (val < MIN_SHEET[key] || val > 90) continue;
          const cand = { ...trim, [key]: val };
          const s = speedOf(cand);
          if (s > best + 1e-6) {
            best = s;
            trim = cand;
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
  }
  if (best === 0) {
    // In irons: let the sails flag.
    const awaAbs = Math.round(Math.min(90, Math.abs(norm180(twa))));
    trim = { main: awaAbs, jib: awaAbs };
  }
  return { trim, state: simulate(tws, twa, trim) };
}

export interface PolarPoint {
  twa: number;
  speed: number;
  trim: Trim;
}

const polarCache = new Map<number, PolarPoint[]>();

/** Optimally-trimmed boat speed for TWA 0–180 in 2° steps. */
export function polar(tws: number): PolarPoint[] {
  const key = Math.round(tws * 2) / 2;
  const cached = polarCache.get(key);
  if (cached) return cached;
  const pts: PolarPoint[] = [];
  for (let twa = 0; twa <= 180; twa += 2) {
    const { trim, state } = optimizeTrim(key, twa);
    pts.push({ twa, speed: state.speed, trim });
  }
  if (polarCache.size > 40) polarCache.clear();
  polarCache.set(key, pts);
  return pts;
}

export function polarLookup(pts: PolarPoint[], twa: number): PolarPoint {
  const a = Math.min(180, Math.abs(norm180(twa)));
  const i = Math.min(pts.length - 2, Math.floor(a / 2));
  const p0 = pts[i];
  const p1 = pts[i + 1];
  const t = (a - p0.twa) / 2;
  return {
    twa: a,
    speed: p0.speed + (p1.speed - p0.speed) * t,
    trim: t < 0.5 ? p0.trim : p1.trim,
  };
}

export interface Board {
  heading: number;
  twa: number; // signed
  speed: number;
  trim: Trim;
  fraction: number; // share of leg time
}

export interface CoursePlan {
  bearing: number;
  strategy: 'direct' | 'beat' | 'run' | 'reach';
  boards: Board[];
  vmc: number; // effective speed along the bearing, kn (manoeuvre loss excluded)
  loss: number; // s lost in manoeuvres
  direct: Board; // sailing straight at the bearing
  pair?: { boards: [Board, Board]; vmc: number }; // best two-board option, even if not chosen
}

/** Seconds lost per manoeuvre (slowing down, turning, rebuilding speed). */
export const MANOEUVRE_LOSS = { tack: 10, gybe: 6 };

export const manoeuvreKind = (a: Board, b: Board) =>
  Math.abs(a.twa) > 90 && Math.abs(b.twa) > 90 ? 'gybe' : 'tack';

/**
 * Fastest way to make good a bearing: sail it directly or split into two boards.
 * With a `distance` (m) the tack/gybe time loss is weighed against the gain;
 * without one, a manoeuvre must be at least 3% faster.
 */
export function planCourse(tws: number, twd: number, bearing: number, distance?: number): CoursePlan {
  const pts = polar(tws);
  const board = (heading: number, fraction: number): Board => {
    const twa = norm180(twd - heading);
    const p = polarLookup(pts, twa);
    return { heading: norm360(heading), twa, speed: p.speed, trim: p.trim, fraction };
  };
  const direct = board(bearing, 1);
  let best: CoursePlan = { bearing, strategy: 'direct', boards: [direct], vmc: direct.speed, loss: 0, direct };

  // Velocity components along (a) and across (c) the bearing, per relative heading.
  const comps: { rel: number; a: number; c: number }[] = [];
  for (let rel = -179; rel <= 180; rel++) {
    const s = board(bearing + rel, 1).speed;
    comps.push({ rel, a: s * Math.cos(rel * DEG), c: s * Math.sin(rel * DEG) });
  }
  const left = comps.filter((x) => x.c < -1e-6);
  const right = comps.filter((x) => x.c > 1e-6);
  let pair: { l: (typeof comps)[number]; r: (typeof comps)[number]; vmc: number } | null = null;
  for (const l of left) {
    for (const r of right) {
      // times t_l = c_r, t_r = −c_l cancel the cross-track drift
      const vmc = (l.a * r.c - r.a * l.c) / (r.c - l.c);
      if (!pair || vmc > pair.vmc) pair = { l, r, vmc };
    }
  }
  if (!pair || pair.vmc <= best.vmc) return best;

  const { l, r, vmc } = pair;
  const fl = r.c / (r.c - l.c); // time share on the left board
  const b1 = board(bearing + l.rel, fl);
  const b2 = board(bearing + r.rel, 1 - fl);
  best.pair = { boards: [b1, b2], vmc };
  const loss = MANOEUVRE_LOSS[manoeuvreKind(b1, b2)];
  const worthIt =
    distance === undefined
      ? vmc > best.vmc * 1.03 && vmc > best.vmc + 0.05
      : distance / (vmc * KN) + loss < (best.vmc > 0.05 ? distance / (best.vmc * KN) : Infinity);
  if (worthIt) {
    const up = Math.abs(b1.twa) < 90 && Math.abs(b2.twa) < 90;
    const down = Math.abs(b1.twa) > 90 && Math.abs(b2.twa) > 90;
    best = { ...best, strategy: up ? 'beat' : down ? 'run' : 'reach', boards: [b1, b2], vmc, loss };
  }
  return best;
}
