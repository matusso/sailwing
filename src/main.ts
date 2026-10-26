import './style.css';
import { MapView, type MapMode, type RouteLeg } from './mapView';
import { BoatView } from './boatView';
import { drawPolar } from './polarView';
import {
  KN,
  MANOEUVRE_LOSS,
  norm180,
  norm360,
  optimizeTrim,
  planCourse,
  polar,
  simulate,
  type Board,
  type CoursePlan,
  type SailState,
  type Trim,
} from './physics';
import { NM, bearing, compassName, distance, offset, type LatLng } from './geo';
import { fetchWind } from './wind';
import { Gps, type Fix } from './gps';
import { PREPARE_S, advise, steerHint, type Advice } from './nav';
import { boundsAround, loadChart, type Chart, type Safety } from './chart';
import { findRoute, nextWaypoint, routeLeg, sailLeg, type RoutedLeg } from './route';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const MARKS_KEY = 'sailwing.marks';
const SAFETY_KEY = 'sailwing.safety';
const CHART_PAD = 2000; // m of chart around the course, doubled while a detour runs off its edge
const CHART_PAD_MAX = 16000;
const CHART_MAX = 80000; // m, larger areas aren't charted in detail
const HAZARD_LOOK_S = 90; // warn about land/shallows this far ahead
const ARRIVE_M = 30; // a mark counts as rounded within this distance
const WIND_REFRESH_MS = 10 * 60 * 1000;

const state = {
  wind: { speed: 12, dir: 270 },
  boat: { lat: 45.845, lng: 10.848 } as LatLng, // Lake Garda, north basin
  heading: 0,
  trim: { main: 30, jib: 30 } as Trim,
  lockTrim: false,
  course: 0,
  marks: loadMarks(),
  activeLeg: -1,
  mapMode: 'pick' as MapMode,
  safety: loadSafety(),
};

interface Leg {
  from: LatLng;
  to: LatLng;
  dist: number; // m
  bearing: number;
  plan: CoursePlan; // of the first straight piece
  time: number; // s, including manoeuvre loss
  path: LatLng[];
  route: RoutedLeg;
}

/** A race in progress: live (GPS or hand-steered) or simulated on autopilot. */
interface Race {
  mode: 'live' | 'sim';
  next: number; // index of the mark we're sailing to
  elapsed: number; // s of race time
  speedup: number; // sim time-lapse factor
  penalty: number; // s left of a simulated tack/gybe
  lastAction: Advice['action'] | null;
  route: LatLng[]; // waypoints of this leg around land and shallows, ending at the mark
  wp: number; // the waypoint we're heading for
  rerouteAt: number; // earliest time (ms) to re-plan after losing sight of the route
  hazardWarned: boolean;
}

let legs: Leg[] = [];
let race: Race | null = null;
let advice: Advice | null = null;
let freeSail = false;
let sim = simulate(state.wind.speed, norm180(state.wind.dir - state.heading), state.trim);

const gps = new Gps();
let lastFix: Fix | null = null;
let windTimer = 0;

// ---------- formatting ----------

const deg = (d: number) => `${Math.round(norm360(d)).toString().padStart(3, '0')}°`;
const fmtTime = (s: number) => {
  if (!isFinite(s)) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m}m ${Math.floor(s % 60).toString().padStart(2, '0')}s`;
};
const fmtDist = (m: number) => (m < 926 ? `${Math.round(m)} m` : `${(m / NM).toFixed(2)} nm`);
const pointOfSail = (twa: number) => {
  const a = Math.abs(twa);
  if (a < 50) return 'Close-hauled';
  if (a < 75) return 'Close reach';
  if (a < 110) return 'Beam reach';
  if (a < 155) return 'Broad reach';
  return 'Running';
};
const tackName = (twa: number) => (twa >= 0 ? 'Starboard' : 'Port');
const STATUS_TEXT: Record<SailState['status'], string> = {
  trimmed: 'Trimmed',
  eased: 'Trim in',
  'over-trimmed': 'Ease',
  luffing: 'Luffing',
};

function setRange(el: HTMLInputElement, v: number) {
  el.value = String(v);
  const p = ((v - Number(el.min)) / (Number(el.max) - Number(el.min))) * 100;
  el.style.setProperty('--p', `${p}%`);
}

let toastTimer = 0;
function toast(msg: string, kind: 'info' | 'error' = 'info') {
  const el = $('toast');
  el.textContent = msg;
  el.dataset.kind = kind;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 3200);
}

function loadMarks(): LatLng[] {
  try {
    const v = JSON.parse(localStorage.getItem(MARKS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((p) => typeof p?.lat === 'number' && typeof p?.lng === 'number') : [];
  } catch {
    return [];
  }
}
function saveMarks() {
  try {
    localStorage.setItem(MARKS_KEY, JSON.stringify(state.marks));
  } catch {
    // storage unavailable (private mode): the course just won't survive a reload
  }
}
function loadSafety(): Safety {
  const s = { draft: 1.5, clearance: 40 };
  try {
    const v = JSON.parse(localStorage.getItem(SAFETY_KEY) ?? '{}');
    if (typeof v?.draft === 'number') s.draft = v.draft;
    if (typeof v?.clearance === 'number') s.clearance = v.clearance;
  } catch {
    // defaults
  }
  return s;
}
function saveSafety() {
  try {
    localStorage.setItem(SAFETY_KEY, JSON.stringify(state.safety));
  } catch {
    // storage unavailable: defaults next time
  }
}

// ---------- polar stats ----------

function polarStats(tws: number) {
  const pts = polar(tws);
  let up = pts[0];
  let down = pts[pts.length - 1];
  for (const p of pts) {
    const v = p.speed * Math.cos((p.twa * Math.PI) / 180);
    if (v > up.speed * Math.cos((up.twa * Math.PI) / 180)) up = p;
    if (v < down.speed * Math.cos((down.twa * Math.PI) / 180)) down = p;
  }
  const noGo = pts.find((p) => p.speed > 0.3)?.twa ?? 45;
  return { pts, up, down, noGo };
}

// ---------- views ----------

const mapView = new MapView($('map'), state.boat, {
  onPick(p) {
    if (gps.active) return toast('GPS is on — turn it off to place the boat by hand');
    stopMotion();
    state.boat = p;
    refreshBoat();
    loadLiveWind(p);
    ensureChart();
  },
  onAddMark(p) {
    state.marks.push(p);
    marksChanged();
    showTab('plan');
  },
  onMoveMark(i, p) {
    state.marks[i] = p;
    marksChanged();
  },
  onRemoveMark(i) {
    state.marks.splice(i, 1);
    marksChanged();
  },
});
const boatView = new BoatView($<HTMLCanvasElement>('boatCanvas'));

function refreshBoat() {
  const { speed: tws, dir: twd } = state.wind;
  const twa = norm180(twd - state.heading);
  const best = optimizeTrim(tws, twa).trim;
  if (state.lockTrim) state.trim = best;
  sim = simulate(tws, twa, state.trim);
  // Judge each sheet against the whole-boat optimum (which may depower to limit heel),
  // so the hints always agree with Auto-trim.
  for (const key of ['main', 'jib'] as const) {
    const diff = state.trim[key] - best[key];
    const s = sim[key];
    if (Math.abs(diff) <= 3) s.status = s.status === 'luffing' && sim.speed < 0.05 ? 'luffing' : 'trimmed';
    else if (s.status !== 'luffing') s.status = diff > 0 ? 'eased' : 'over-trimmed';
  }
  const ps = polarStats(tws);
  boatView.set({ heading: state.heading, twd, tws, trim: state.trim, state: sim, noGo: ps.noGo });

  $('speedVal').textContent = sim.speed.toFixed(1);
  $('stTwa').textContent = `${Math.abs(Math.round(sim.twa))}°`;
  $('stAwa').textContent = `${Math.abs(Math.round(sim.awa))}°`;
  $('stAws').textContent = `${sim.aws.toFixed(1)} kn`;
  $('stVmg').textContent = `${sim.vmg.toFixed(1)} kn`;
  $('stHeel').textContent = `${Math.round(sim.heel)}°`;

  setRange($<HTMLInputElement>('heading'), Math.round(norm360(state.heading)) % 360);
  setRange($<HTMLInputElement>('main'), state.trim.main);
  setRange($<HTMLInputElement>('jib'), state.trim.jib);
  $('headingVal').textContent = deg(state.heading);
  $('mainVal').textContent = `${state.trim.main}°`;
  $('jibVal').textContent = `${state.trim.jib}°`;

  const inIrons = tws > 0.5 && sim.speed < 0.05 && Math.abs(sim.twa) < ps.noGo;
  $('pointOfSail').textContent = tws < 0.5 ? 'No wind' : inIrons ? 'In irons' : `${pointOfSail(sim.twa)} · ${tackName(sim.twa)}`;
  $('pointOfSail').classList.toggle('warn', inIrons);
  $('tackBtn').textContent = Math.abs(sim.twa) > 100 ? 'Gybe' : 'Tack';
  for (const [id, s] of [['mainStatus', sim.main], ['jibStatus', sim.jib]] as const) {
    const el = $(id);
    el.textContent = STATUS_TEXT[s.status];
    el.dataset.status = s.status;
  }

  $('topWind').textContent = `${state.wind.speed.toFixed(1)} kn ${compassName(twd)}`;
  $('topBoat').textContent = `${sim.speed.toFixed(1)} kn · ${deg(state.heading)}`;

  if (!$('tab-trim').classList.contains('hidden')) {
    drawPolar($<HTMLCanvasElement>('polarCanvas'), ps.pts, { twa: -sim.twa, speed: sim.speed }, { up: ps.up.twa, down: ps.down.twa });
  }
  $('polarTws').textContent = `· ${tws.toFixed(1)} kn TWS`;
  const vmg = (p: { twa: number; speed: number }) => Math.abs(p.speed * Math.cos((p.twa * Math.PI) / 180)).toFixed(1);
  $('polarNotes').innerHTML =
    tws < 0.5
      ? '<span>Not a breath of wind.</span>'
      : `<span><b>Upwind</b> ${ps.up.twa}° TWA · VMG ${vmg(ps.up)} kn</span><span><b>Downwind</b> ${ps.down.twa}° TWA · VMG ${vmg(ps.down)} kn</span>`;

  mapView.setBoat(state.boat, state.heading, !!race || freeSail || gps.active);
}

// ---------- wind ----------

const windSpeedEl = $<HTMLInputElement>('windSpeed');

function setWind(speed: number, dir: number, source = 'Manual') {
  state.wind = { speed, dir: norm360(dir) };
  setRange(windSpeedEl, speed);
  $('windSpeedVal').textContent = speed.toFixed(1);
  $('windDirVal').textContent = `from ${compassName(dir)} · ${deg(dir)}`;
  $('windSource').textContent = source;
  $('windSource').classList.toggle('live', source !== 'Manual');
  $('dialArrow').setAttribute('transform', `rotate(${state.wind.dir} 60 60)`);
  mapView.setWind(speed, state.wind.dir);
  refreshBoat();
  schedulePlan();
}

let windAbort: AbortController | null = null;
async function loadLiveWind(p: LatLng, quiet = false) {
  windAbort?.abort();
  windAbort = new AbortController();
  const btn = $<HTMLButtonElement>('liveWindBtn');
  btn.classList.add('loading');
  try {
    const w = await fetchWind(p, windAbort.signal);
    setWind(Math.round(w.speed * 10) / 10, Math.round(w.dir), `Live ${w.time.slice(11, 16)}`);
    if (!quiet) toast(`Live wind ${w.speed.toFixed(1)} kn from ${compassName(w.dir)} · gusts ${w.gusts.toFixed(0)} kn`);
  } catch (e) {
    if ((e as Error).name !== 'AbortError' && !quiet) toast(`Couldn't load live wind: ${(e as Error).message}`, 'error');
  } finally {
    btn.classList.remove('loading');
  }
}

windSpeedEl.addEventListener('input', () => setWind(Number(windSpeedEl.value), state.wind.dir));
$('liveWindBtn').addEventListener('click', () => loadLiveWind(state.boat));

// Dial: drag the handle to where the wind comes from.
{
  const dial = $('windDial') as unknown as SVGSVGElement;
  const ticks = document.getElementById('dialTicks')!;
  for (let a = 0; a < 360; a += 15) {
    const major = a % 45 === 0;
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    t.setAttribute('x1', '60');
    t.setAttribute('x2', '60');
    t.setAttribute('y1', '8');
    t.setAttribute('y2', major ? '14' : '11');
    t.setAttribute('transform', `rotate(${a} 60 60)`);
    t.setAttribute('class', major ? 'tick major' : 'tick');
    ticks.appendChild(t);
  }
  const fromPointer = (e: PointerEvent) => {
    const r = dial.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    setWind(state.wind.speed, Math.round(norm360((Math.atan2(dx, -dy) * 180) / Math.PI)));
  };
  dial.addEventListener('pointerdown', (e) => {
    dial.setPointerCapture(e.pointerId);
    fromPointer(e);
  });
  dial.addEventListener('pointermove', (e) => {
    if (dial.hasPointerCapture(e.pointerId)) fromPointer(e);
  });
}

// ---------- GPS ----------

let wakeLock: WakeLockSentinel | null = null;
async function keepAwake(on: boolean) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!on) {
      await wakeLock?.release();
      wakeLock = null;
    }
  } catch {
    // not supported or denied: the screen may dim, nothing else breaks
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (gps.active || race?.mode === 'live')) keepAwake(true);
});

function setGpsUi(mode: 'off' | 'searching' | 'on') {
  const btn = $('gpsBtn');
  btn.classList.toggle('loading', mode === 'searching');
  btn.classList.toggle('on', mode !== 'off');
  $('gpsChip').classList.toggle('hidden', mode === 'off');
  if (mode === 'searching') $('topGps').textContent = 'GPS…';
}

function stopGps() {
  gps.stop();
  lastFix = null;
  clearInterval(windTimer);
  mapView.setAccuracy(null);
  setGpsUi('off');
  if (race?.mode !== 'live') keepAwake(false);
}

$('gpsBtn').addEventListener('click', () => {
  if (gps.active) return stopGps();
  if (race?.mode === 'sim') endRace();
  freeSail = false;
  $('sailBtn').classList.remove('on');
  setGpsUi('searching');
  keepAwake(true);
  gps.start(onFix, (msg) => {
    toast(msg, 'error');
    if (!gps.active) stopGps();
  });
  if (!gps.active) stopGps();
});

function onFix(f: Fix) {
  const first = !lastFix;
  lastFix = f;
  state.boat = f.pos;
  // COG is only meaningful while moving.
  if (f.cog !== null && (f.sog ?? 0) >= 0.7) state.heading = f.cog;
  mapView.setAccuracy(f.pos, f.accuracy);
  setGpsUi('on');
  $('topGps').textContent = `±${Math.round(f.accuracy)} m · ${f.sog !== null ? f.sog.toFixed(1) : '—'} kn`;
  if (first) {
    mapView.centerOn(f.pos);
    setLock(true);
    loadLiveWind(f.pos);
    windTimer = window.setInterval(() => loadLiveWind(state.boat, true), WIND_REFRESH_MS);
  }
  refreshBoat();
  ensureChart();
  if (race) {
    checkArrival(Math.max(ARRIVE_M, f.accuracy));
    refreshNav();
  }
}

// ---------- trim controls ----------

function userSteer(fn: () => void) {
  if (race?.mode === 'sim') endRace();
  fn();
  refreshBoat();
}

$<HTMLInputElement>('heading').addEventListener('input', (e) =>
  userSteer(() => (state.heading = Number((e.target as HTMLInputElement).value))),
);
for (const key of ['main', 'jib'] as const) {
  $<HTMLInputElement>(key).addEventListener('input', (e) =>
    userSteer(() => {
      state.trim = { ...state.trim, [key]: Number((e.target as HTMLInputElement).value) };
      setLock(false);
    }),
  );
}
const tack = () => userSteer(() => (state.heading = norm360(2 * state.wind.dir - state.heading)));
$('tackBtn').addEventListener('click', tack);

function autoTrim() {
  userSteer(() => (state.trim = optimizeTrim(state.wind.speed, norm180(state.wind.dir - state.heading)).trim));
}
$('autoTrimBtn').addEventListener('click', autoTrim);

function setLock(on: boolean) {
  state.lockTrim = on;
  $<HTMLInputElement>('lockTrim').checked = on;
}
$<HTMLInputElement>('lockTrim').addEventListener('change', (e) => {
  setLock((e.target as HTMLInputElement).checked);
  refreshBoat();
});

$('sailBtn').addEventListener('click', () => {
  if (gps.active) return toast('GPS is moving the boat — turn GPS off to sail by hand');
  if (race?.mode === 'sim') endRace();
  freeSail = !freeSail;
  $('sailBtn').classList.toggle('on', freeSail);
  if (freeSail) toast('Sailing on the map · time-lapse ×60 · steer with ← →');
});

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'checkbox') return;
  const step = e.shiftKey ? 10 : 2;
  if (e.key === 'ArrowLeft') userSteer(() => (state.heading = norm360(state.heading - step)));
  else if (e.key === 'ArrowRight') userSteer(() => (state.heading = norm360(state.heading + step)));
  else if (e.key === 't' || e.key === 'T') tack();
  else if (e.key === 'a' || e.key === 'A') autoTrim();
  else return;
  e.preventDefault();
});

// ---------- planning ----------

function boardHtml(b: Board, showShare: boolean) {
  const payload = JSON.stringify({ heading: b.heading, main: b.trim.main, jib: b.trim.jib });
  return `<div class="board">
    <div class="board-main">
      <div class="board-title">${tackName(b.twa)} · <span class="mono">${deg(b.heading)}</span>${
        showShare ? `<span class="muted"> · ${Math.round(b.fraction * 100)}% of time</span>` : ''
      }</div>
      <div class="board-sub">${pointOfSail(b.twa)} · TWA ${Math.abs(Math.round(b.twa))}° · <b>${b.speed.toFixed(1)} kn</b></div>
    </div>
    <div class="trim-chips"><span title="Mainsheet angle">M ${b.trim.main}°</span><span title="Jib sheet angle">J ${b.trim.jib}°</span></div>
    <button class="btn ghost small" data-sail='${payload}'>Sail</button>
  </div>`;
}

function strategyTag(p: CoursePlan) {
  if (p.strategy === 'direct') return `<span class="tag">${pointOfSail(p.boards[0].twa)}</span>`;
  const label = { beat: 'Beat · tack', run: 'Run · gybe', reach: 'Two boards' }[p.strategy];
  return `<span class="tag ${p.strategy}">${label}</span>`;
}

// ---------- chart: land and depth ----------

let chart: Chart | null = null;
let chartAbort: AbortController | null = null;
let chartTimer = 0;
let chartPad = CHART_PAD;
let chartLoading = false;
const routeCache = new Map<string, RoutedLeg>();

function setChartStatus(text: string, kind: 'ok' | 'warn' = 'ok') {
  const el = $('chartStatus');
  el.textContent = text ? `· ${text}` : '';
  el.classList.toggle('warn', kind === 'warn');
}

/** What the chart has to cover: the course, plus the boat when it's out racing near it (or there's no course). */
function chartPoints(): LatLng[] {
  if (!state.marks.length) return [state.boat];
  const near = state.marks.some((m) => distance(m, state.boat) < 10000);
  return race && near ? [...state.marks, state.boat] : state.marks;
}

/** Load a chart for the course area unless the current one already covers it. */
function ensureChart() {
  const pts = chartPoints();
  if (chart && pts.every((p) => chart!.contains(p, CHART_PAD / 4))) return;
  clearTimeout(chartTimer);
  chartTimer = window.setTimeout(refreshChart, 400);
}

async function refreshChart() {
  const pts = chartPoints();
  const b = boundsAround(pts, chartPad);
  chartAbort?.abort();
  if (distance({ lat: b.south, lng: b.west }, { lat: b.north, lng: b.east }) > CHART_MAX) {
    if (chart && chartPad > CHART_PAD) {
      // Growing it to find a way round went too far: keep what we have.
      chartPad = CHART_PAD_MAX;
      return;
    }
    setChart(null);
    setChartStatus('course too large to chart — no land/depth checks', 'warn');
    return;
  }
  const abort = (chartAbort = new AbortController());
  setChartStatus('loading chart…');
  chartLoading = true;
  try {
    const c = await loadChart(b, state.safety, abort.signal);
    chartLoading = false;
    setChart(c);
    setChartStatus(c.hasDepth ? 'land + depth' : 'land only (no depth data here)', c.hasDepth ? 'ok' : 'warn');
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    chartLoading = false;
    setChartStatus(`chart unavailable — no land/depth checks (${(e as Error).message})`, 'warn');
    toast(`Couldn't load land/depth data: ${(e as Error).message}`, 'error');
  }
}

function setChart(c: Chart | null) {
  chart = c;
  routeCache.clear();
  drawChart();
  schedulePlan();
}

function drawChart() {
  mapView.setChartOverlay(chart?.overlay() ?? null, chart?.bounds);
}

function setSafetyUi() {
  setRange($<HTMLInputElement>('draft'), state.safety.draft);
  setRange($<HTMLInputElement>('clearance'), state.safety.clearance);
  $('draftVal').textContent = `${state.safety.draft.toFixed(1)} m`;
  $('clearanceVal').textContent = `${state.safety.clearance} m`;
}

let safetyRedraw = 0;
for (const key of ['draft', 'clearance'] as const) {
  $<HTMLInputElement>(key).addEventListener('input', (e) => {
    state.safety = { ...state.safety, [key]: Number((e.target as HTMLInputElement).value) };
    setSafetyUi();
    saveSafety();
    chart?.setSafety(state.safety);
    routeCache.clear();
    schedulePlan();
    clearTimeout(safetyRedraw);
    safetyRedraw = window.setTimeout(drawChart, 150);
  });
}

function routed(from: LatLng, to: LatLng): RoutedLeg {
  const { speed: tws, dir: twd } = state.wind;
  const key = `${from.lat},${from.lng},${to.lat},${to.lng},${tws},${twd},${chart?.version ?? 0}`;
  let r = routeCache.get(key);
  if (!r) {
    r = routeLeg(chart, from, to, tws, twd);
    if (routeCache.size > 200) routeCache.clear();
    routeCache.set(key, r);
  }
  return r;
}

function computeLegs() {
  legs = [];
  for (let i = 0; i + 1 < state.marks.length; i++) {
    const from = state.marks[i];
    const to = state.marks[i + 1];
    const route = routed(from, to);
    legs.push({
      from,
      to,
      dist: distance(from, to),
      bearing: bearing(from, to),
      plan: route.pieces[0].plan,
      time: route.time,
      path: route.path,
      route,
    });
  }
}

/** Why a leg can't be sailed, if a mark itself is on land or in the shallows. */
function markProblem(i: number): string | null {
  const h = chart?.hazardAt(state.marks[i]);
  if (!h || !chart) return null;
  const d = chart.depthAt(state.marks[i]);
  return h === 'land' ? `${markName(i)} is on land` : `${markName(i)} is in ${d.toFixed(1)} m of water`;
}

function legNotes(l: Leg, i: number): string {
  const notes: string[] = [];
  const r = l.route;
  if (r.blocked) {
    const why = markProblem(i) ?? markProblem(i + 1);
    notes.push(`<div class="leg-note danger">⚠ No safe way through${why ? ` — ${why}` : ' — land or shallows block it'}. Move the mark.</div>`);
  } else {
    const turns = r.pieces.reduce((s, p) => s + p.manoeuvres, 0);
    const loss = r.pieces.reduce((s, p) => s + p.manoeuvres * MANOEUVRE_LOSS[p.plan.strategy === 'run' ? 'gybe' : 'tack'], 0);
    if (r.waypoints.length > 2) notes.push(`<div class="leg-note warn">Routed around land/shallows · ${r.waypoints.length - 2} waypoint${r.waypoints.length > 3 ? 's' : ''}</div>`);
    if (r.tight) notes.push('<div class="leg-note danger">⚠ Very narrow water: short-tacking, keep a sharp lookout</div>');
    if (turns > (l.plan.boards.length > 1 ? 1 : 0) || r.waypoints.length > 2) {
      if (loss) notes.push(`<div class="leg-note"><span class="muted">incl. ${turns} tack/gybe · ${Math.round(loss)}s</span></div>`);
    } else if (l.plan.loss) {
      notes.push(`<div class="leg-note"><span class="muted">incl. ${l.plan.loss}s ${l.plan.strategy === 'run' ? 'gybe' : 'tack'}</span></div>`);
    }
    for (const m of i === 0 ? [0, 1] : [i + 1]) {
      const shoal = markProblem(m);
      if (shoal) notes.push(`<div class="leg-note warn">⚠ ${shoal}</div>`);
    }
  }
  return notes.join('');
}

function markName(i: number) {
  return i === 0 ? 'Start' : i === state.marks.length - 1 ? 'Finish' : `Mark ${i}`;
}

function refreshPlan() {
  const { speed: tws, dir: twd } = state.wind;
  const course = planCourse(tws, twd, state.course);
  setRange($<HTMLInputElement>('course'), state.course);
  $('courseVal').textContent = deg(state.course);
  $('courseResult').innerHTML =
    course.vmc < 0.05
      ? '<p class="empty">No wind, no progress.</p>'
      : `<div class="result-head">${strategyTag(course)}<span class="muted">made good</span><b class="mono">${course.vmc.toFixed(2)} kn</b></div>
         ${course.boards.map((b) => boardHtml(b, course.boards.length > 1)).join('')}`;

  computeLegs();
  const total = legs.reduce((s, l) => s + l.time, 0);
  const totalDist = legs.reduce((s, l) => s + l.dist, 0);
  const manoeuvres = legs.reduce((s, l) => s + l.route.pieces.reduce((n, p) => n + p.manoeuvres, 0), 0);
  $('trackTotal').textContent = legs.length
    ? `· ${(totalDist / NM).toFixed(2)} nm · ${fmtTime(total)}${manoeuvres ? ` · ${manoeuvres} tack/gybe` : ''}`
    : '';
  // A leg with no way through may just need a bigger chart (the way round runs off its edge).
  if (chart && !chartLoading && chartPad < CHART_PAD_MAX && legs.some((l, i) => l.route.blocked && !markProblem(i) && !markProblem(i + 1))) {
    chartPad *= 2;
    refreshChart();
  }
  const raceable = legs.length > 0 && isFinite(total);
  $<HTMLButtonElement>('raceBtn').disabled = !raceable && race?.mode !== 'sim';
  $<HTMLButtonElement>('startRaceBtn').disabled = !raceable && race?.mode !== 'live';
  $<HTMLButtonElement>('clearTrackBtn').disabled = !state.marks.length;
  $('legs').innerHTML = legs.length
    ? legs
        .map((l, i) => {
          return `<div class="leg ${i === state.activeLeg ? 'active' : ''}" data-leg="${i}">
        <div class="leg-head">
          <span class="leg-num">${i + 1}</span>
          <div class="leg-title"><b>${markName(i)} → ${markName(i + 1)}</b>
            <span class="muted mono">${fmtDist(l.dist)} · ${deg(l.bearing)}</span></div>
          ${strategyTag(l.plan)}
          <span class="eta mono">${fmtTime(l.time)}</span>
        </div>
        ${l.plan.boards.map((b) => boardHtml(b, l.plan.boards.length > 1)).join('')}
        ${legNotes(l, i)}
      </div>`;
        })
        .join('')
    : `<p class="empty">Switch the map to <b>Race track</b> and click to drop marks.<br/>Drag a mark to move it, right-click to remove it.</p>`;

  const route: RouteLeg[] = legs.map((l, i) => ({ path: l.path, active: i === state.activeLeg }));
  mapView.setRoute(route);
}

let planQueued = false;
function schedulePlan() {
  if (planQueued) return;
  planQueued = true;
  requestAnimationFrame(() => {
    planQueued = false;
    refreshPlan();
    if (race) refreshNav();
  });
}

function marksChanged() {
  if (race) endRace();
  chartPad = CHART_PAD;
  state.activeLeg = Math.min(state.activeLeg, state.marks.length - 2);
  saveMarks();
  mapView.setMarks(state.marks);
  ensureChart();
  refreshPlan();
}

$<HTMLInputElement>('course').addEventListener('input', (e) => {
  state.course = Number((e.target as HTMLInputElement).value);
  refreshPlan();
});

$('tab-plan').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const sail = t.closest<HTMLElement>('[data-sail]');
  if (sail) {
    const { heading, main, jib } = JSON.parse(sail.dataset.sail!);
    if (race?.mode === 'sim') endRace();
    setLock(false);
    state.heading = heading;
    state.trim = { main, jib };
    showTab('trim');
    refreshBoat();
    return;
  }
  const leg = t.closest<HTMLElement>('[data-leg]');
  if (leg) {
    const i = Number(leg.dataset.leg);
    state.activeLeg = state.activeLeg === i ? -1 : i;
    refreshPlan();
  }
});

$('clearTrackBtn').addEventListener('click', () => {
  state.marks = [];
  state.activeLeg = -1;
  marksChanged();
});

// ---------- racing ----------

function startRace(mode: Race['mode']) {
  const total = legs.reduce((s, l) => s + l.time, 0);
  if (!legs.length || !isFinite(total)) return;
  endRace();
  freeSail = false;
  $('sailBtn').classList.remove('on');
  race = {
    mode,
    next: 1,
    elapsed: 0,
    speedup: Math.max(20, total / 45),
    penalty: 0,
    lastAction: null,
    route: legs[0].route.waypoints,
    wp: 1,
    rerouteAt: 0,
    hazardWarned: false,
  };
  setLock(true);
  if (mode === 'sim') {
    state.boat = state.marks[0];
    const a = advise(state.boat, state.heading, state.wind.speed, state.wind.dir, navTarget(state.marks[1]), chart, [state.marks[1]]);
    state.heading = a.board.heading;
    mapView.fitTo(state.marks);
  } else {
    keepAwake(true);
    if (!gps.active) toast('Racing without GPS — press ▶ to sail by hand, or turn on GPS');
  }
  $(mode === 'sim' ? 'raceBtn' : 'startRaceBtn').classList.add('on');
  $('startRaceBtn').lastChild!.textContent = mode === 'live' ? ' End' : ' Race';
  $('raceBtn').textContent = mode === 'sim' ? 'Stop' : 'Simulate';
  $('navCard').classList.remove('hidden');
  ensureChart();
  showTab('trim');
  refreshBoat();
  refreshNav();
}

function endRace() {
  if (!race) return;
  race = null;
  advice = null;
  $('raceBtn').classList.remove('on');
  $('startRaceBtn').classList.remove('on');
  $('startRaceBtn').lastChild!.textContent = ' Race';
  $('raceBtn').textContent = 'Simulate';
  $('navCard').classList.add('hidden');
  mapView.setNav(null);
  mapView.setNextMark(-1);
  if (!gps.active) keepAwake(false);
  schedulePlan();
}

function stopMotion() {
  freeSail = false;
  $('sailBtn').classList.remove('on');
  if (race?.mode === 'sim') endRace();
}

$('raceBtn').addEventListener('click', () => (race?.mode === 'sim' ? endRace() : startRace('sim')));
$('startRaceBtn').addEventListener('click', () => (race?.mode === 'live' ? endRace() : startRace('live')));
$('endRaceBtn').addEventListener('click', endRace);

function checkArrival(radius = ARRIVE_M) {
  if (!race) return;
  const mark = state.marks[race.next];
  if (!mark || distance(state.boat, mark) > radius) return;
  navigator.vibrate?.([120, 80, 120]);
  if (race.next >= state.marks.length - 1) {
    const time = race.elapsed;
    endRace();
    toast(`Finished! Race time ${fmtTime(time)}`);
    return;
  }
  toast(`${markName(race.next)} rounded · ${fmtTime(race.elapsed)}`);
  race.next++;
  race.lastAction = null;
  race.route = legs[race.next - 1]?.route.waypoints ?? [state.boat, state.marks[race.next]];
  race.wp = 1;
  schedulePlan();
}

/**
 * Where to point the navigator: the furthest waypoint of the leg's route that is in clear
 * sight from the boat. If the boat has strayed off the route, re-plan from where it is.
 */
function navTarget(mark: LatLng): LatLng {
  if (!race || !chart) return mark;
  const next = nextWaypoint(chart, state.boat, race.route, race.wp, mark);
  race.wp = next.wp;
  const now = performance.now();
  if (next.lost && now >= race.rerouteAt) {
    race.rerouteAt = now + 1000;
    const r = findRoute(chart, state.boat, mark, state.wind.speed, state.wind.dir);
    if (r) {
      race.route = r;
      race.wp = 1;
    }
  }
  return race.route[race.wp] ?? mark;
}

/** Time from waypoint `k` of the current route to the mark. */
let restMemo = { key: '', time: 0 };
function routeRest(k: number): number {
  if (!race) return 0;
  const key = `${race.route.map((p) => `${p.lat},${p.lng}`).join(';')}|${k}|${state.wind.speed}|${state.wind.dir}|${chart?.version}`;
  if (restMemo.key !== key) {
    let time = 0;
    for (let n = k; n + 1 < race.route.length; n++) {
      time += sailLeg(chart, race.route[n], race.route[n + 1], state.wind.speed, state.wind.dir, [race.route[race.route.length - 1]]).time;
    }
    restMemo = { key, time };
  }
  return restMemo.time;
}

/** Has the (simulated) boat hit land or the shallows? Not counted right at a mark, where the chart is too coarse to judge. */
function aground(): 'land' | 'shallows' | null {
  const h = chart?.hazardAt(state.boat);
  if (!h || state.marks.some((m) => distance(m, state.boat) < 50)) return null;
  return h === 'land' ? 'land' : 'shallows';
}

/** Land or shallows on the bow within `HAZARD_LOOK_S` seconds (or 150 m). */
function hazardAhead(speed: number) {
  if (!chart) return null;
  const v = Math.max(0.5, speed) * KN;
  const look = Math.max(150, v * HAZARD_LOOK_S);
  const h = chart.firstHazard(state.boat, offset(state.boat, state.heading, look));
  return h && { ...h, secs: h.dist / v };
}

/** Recompute the advice from the boat's current position and update the nav card + map overlay. */
function refreshNav() {
  if (!race) return;
  const { speed: tws, dir: twd } = state.wind;
  const mark = state.marks[race.next];
  if (!mark) return endRace();
  const target = navTarget(mark);
  const viaWaypoint = target !== mark;
  const a = advise(state.boat, state.heading, tws, twd, target, chart, [mark]);
  advice = a;
  state.activeLeg = race.next - 1;
  mapView.setNextMark(race.next);
  mapView.setNav({
    path: [...a.path, ...race.route.slice(race.wp + 1)],
    laylines: viaWaypoint ? [] : a.laylines,
    turnAt: a.turn?.at,
  });

  const toMark = a.eta + (viaWaypoint ? routeRest(race.wp) : 0);
  const rest = legs.slice(race.next).reduce((s, l) => s + l.time, 0);
  $('navMark').textContent = viaWaypoint ? `${markName(race.next)} · via waypoint` : markName(race.next);
  $('navDist').textContent = `${fmtDist(a.dist)} · ${deg(a.brg)}`;
  $('navEtaMark').textContent = fmtTime(toMark);
  $('navEtaFinish').textContent = fmtTime(toMark + rest);
  $('navElapsed').textContent = fmtTime(race.elapsed);

  const kindName = (k: 'tack' | 'gybe') => (k === 'tack' ? 'Tack' : 'Gybe');
  let action = '';
  let detail = '';
  let level: 'ok' | 'prepare' | 'now' = 'ok';
  if (a.action === 'direct') {
    action = `Sail direct ${deg(a.board.heading)}`;
    detail = `${pointOfSail(a.board.twa)} · ${tackName(a.board.twa)} · the mark is fetchable`;
  } else if (a.action === 'hold' && a.turn && a.next) {
    const soon = a.turn.time < PREPARE_S;
    level = soon ? 'prepare' : 'ok';
    action = soon ? `Prepare to ${a.turn.kind}` : `Hold ${tackName(a.board.twa).toLowerCase()} ${deg(a.board.heading)}`;
    detail = `${kindName(a.turn.kind)} in ${fmtTime(a.turn.time)} · ${fmtDist(a.turn.dist)} → then ${deg(a.next.heading)}`;
  } else {
    level = 'now';
    action = `${kindName(a.action as 'tack' | 'gybe')} now → ${deg(a.board.heading)}`;
    detail = `You're on the layline · ${tackName(a.board.twa)} ${pointOfSail(a.board.twa).toLowerCase()}`;
  }
  if (race.mode === 'live' && level === 'now' && race.lastAction !== a.action) navigator.vibrate?.([300, 100, 300]);
  race.lastAction = a.action;

  // Whatever the tactics say, land or shallows on the bow come first.
  const gpsSog = gps.active && lastFix?.sog != null ? lastFix.sog : null;
  const hz = hazardAhead(gpsSog ?? sim.speed);
  // No need to shout if the plan already turns before it (or says turn now and there's time).
  const turnsFirst =
    hz &&
    (a.action === 'hold' && a.turn
      ? a.turn.dist < hz.dist - 30
      : a.action === 'direct'
        ? Math.abs(a.steer) < 10 && a.dist < hz.dist - 30
        : hz.secs >= 30);
  if (hz && !turnsFirst) {
    const what = hz.kind === 'land' ? 'Land' : `Shallow water${isNaN(hz.depth) ? '' : ` (${hz.depth.toFixed(1)} m)`}`;
    const urgent = hz.secs < 30;
    action = urgent ? `${what} ahead — turn away` : action;
    detail = `⚠ ${what} ${hz.dist < 15 ? 'here' : `${fmtDist(hz.dist)} ahead`} on ${deg(state.heading)} · ${detail}`;
    level = urgent ? 'now' : level === 'now' ? 'now' : 'prepare';
    if (race.mode === 'live' && urgent && !race.hazardWarned) navigator.vibrate?.([500, 150, 500, 150, 500]);
    race.hazardWarned = urgent;
  } else {
    race.hazardWarned = false;
  }
  $('navAction').textContent = action;
  $('navDetail').textContent = detail;
  $('navAdvice').dataset.level = level;

  $('navSteer').textContent = `${steerHint(a.steer, state.heading, twd)} · target ${deg(a.board.heading)}`;
  const gpsSpeed = gps.active && lastFix?.sog != null ? lastFix.sog : null;
  const you = gpsSpeed ?? sim.speed;
  const pct = a.board.speed > 0.1 ? Math.round((you / a.board.speed) * 100) : 0;
  $('navPerf').innerHTML = `Target <b>${a.board.speed.toFixed(1)}</b> kn · ${gpsSpeed !== null ? 'SOG' : 'you'} <b>${you.toFixed(1)}</b> kn <span class="perf ${
    pct >= 95 ? 'good' : pct >= 85 ? 'ok' : 'low'
  }">${pct}%</span>`;
}

// ---------- tabs & map mode ----------

function showTab(tab: 'trim' | 'plan') {
  for (const b of $('tabs').querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('active', b.dataset.tab === tab);
  $('tab-trim').classList.toggle('hidden', tab !== 'trim');
  $('tab-plan').classList.toggle('hidden', tab !== 'plan');
  if (tab === 'trim') requestAnimationFrame(refreshBoat);
}
$('tabs').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]');
  if (b) showTab(b.dataset.tab as 'trim' | 'plan');
});

const HINTS: Record<MapMode, string> = {
  pick: 'Click the water to place the boat — live wind loads for that spot',
  track: 'Click to drop marks · drag to move · right-click to remove',
};
function setMapMode(mode: MapMode) {
  state.mapMode = mode;
  mapView.setMode(mode);
  for (const b of $('mapMode').querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('active', b.dataset.mode === mode);
  $('mapHint').textContent = HINTS[mode];
  if (mode === 'track') showTab('plan');
}
$('mapMode').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-mode]');
  if (b) setMapMode(b.dataset.mode as MapMode);
});

// ---------- motion loop ----------

let lastT = performance.now();
let navDue = 0;
function tick(t: number) {
  const dtReal = Math.min(0.1, (t - lastT) / 1000);
  lastT = t;

  if (race?.mode === 'sim') {
    // Slow the time-lapse around manoeuvres so the tack call is visible.
    const nearTurn = advice && (advice.action === 'tack' || advice.action === 'gybe' || (advice.turn && advice.turn.time < PREPARE_S * 1.5));
    const dt = dtReal * (nearTurn || race.penalty > 0 ? Math.min(race.speedup, 8) : race.speedup);
    race.elapsed += dt;
    // Autopilot follows the navigator; turning through the wind costs time.
    if (advice) {
      const before = Math.sign(norm180(state.wind.dir - state.heading) || 1);
      const after = Math.sign(norm180(state.wind.dir - advice.board.heading) || 1);
      if (before !== after) race.penalty = MANOEUVRE_LOSS[Math.abs(advice.board.twa) > 90 ? 'gybe' : 'tack'];
      state.heading = advice.board.heading;
    }
    refreshBoat();
    if (race.penalty > 0) race.penalty -= dt;
    else state.boat = offset(state.boat, state.heading, sim.speed * KN * dt);
    const hit = aground();
    if (hit) {
      const time = race.elapsed;
      endRace();
      toast(`Ran aground (${hit}) after ${fmtTime(time)} — the chart missed something`, 'error');
    } else {
      checkArrival(Math.max(ARRIVE_M, sim.speed * KN * dt));
    }
  } else if (freeSail && sim.speed > 0) {
    const dt = dtReal * 60;
    if (race) race.elapsed += dt;
    const before = state.boat;
    state.boat = offset(state.boat, state.heading, sim.speed * KN * dt);
    const hit = aground();
    if (hit) {
      state.boat = before;
      stopMotion();
      toast(`Aground! ${hit === 'land' ? 'That was the shore' : 'Too shallow for your draft'} — steer away and press ▶`, 'error');
    }
    mapView.setBoat(state.boat, state.heading, true);
    checkArrival();
  } else if (race) {
    race.elapsed += dtReal;
  }

  if (race && t >= navDue) {
    refreshNav();
    navDue = t + (race.mode === 'sim' ? 80 : 400);
  }
  requestAnimationFrame(tick);
}

// ---------- boot ----------

setMapMode('pick');
mapView.setMarks(state.marks);
setSafetyUi();
ensureChart();
state.trim = optimizeTrim(state.wind.speed, norm180(state.wind.dir - state.heading)).trim;
setWind(state.wind.speed, state.wind.dir);
if (state.marks.length > 1) mapView.fitTo(state.marks);
loadLiveWind(state.boat);
requestAnimationFrame(tick);
