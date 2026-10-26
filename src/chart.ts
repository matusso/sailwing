// Where the boat can go: a grid of water / land / depth over the race area.
// Land comes from OpenStreetMap water polygons (OpenFreeMap vector tiles, worldwide, lakes included),
// depth from the EMODnet bathymetry model (European seas only; lakes have no depth data).

import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { distance, type LatLng } from './geo';

const R = 6371000;
const DEG = Math.PI / 180;

export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface Safety {
  draft: number; // m
  clearance: number; // m to keep off the shore
}

/** Water under the keel on top of the draft. */
export const UNDER_KEEL = 0.5;

export interface ChartGrid {
  south: number;
  west: number;
  dLat: number; // cell size, degrees
  dLng: number;
  w: number;
  h: number;
  water: Uint8Array; // 1 = water, row 0 is the southern edge
  depth: Float32Array; // m, NaN = unknown
}

export type Hazard = 'land' | 'shallow';

const OK = 0;
const LAND = 1;
const SHALLOW = 2;

export class Chart {
  readonly cellX: number; // m
  readonly cellY: number;
  readonly hasDepth: boolean;
  /** Bumped whenever what counts as navigable changes. */
  version = 0;
  private shore: Float32Array; // m to the nearest land or shallow cell
  private kind: Uint8Array;

  constructor(readonly g: ChartGrid, public safety: Safety) {
    const midLat = g.south + (g.h * g.dLat) / 2;
    this.cellY = g.dLat * DEG * R;
    this.cellX = g.dLng * DEG * R * Math.cos(midLat * DEG);
    this.hasDepth = g.depth.some((d) => !isNaN(d));
    this.kind = new Uint8Array(g.w * g.h);
    this.shore = new Float32Array(g.w * g.h);
    this.setSafety(safety);
  }

  get bounds(): Bounds {
    const { south, west, dLat, dLng, w, h } = this.g;
    return { south, west, north: south + h * dLat, east: west + w * dLng };
  }

  get minDepth() {
    return this.safety.draft + UNDER_KEEL;
  }

  setSafety(s: Safety) {
    this.safety = s;
    const { water, depth } = this.g;
    for (let k = 0; k < this.kind.length; k++) {
      this.kind[k] = !water[k] ? LAND : depth[k] < this.minDepth ? SHALLOW : OK;
    }
    // The margin keeps off shoals too: the depth model is coarse right where it matters.
    this.shore = hazardDistance(this.g, this.kind, this.cellX, this.cellY);
    this.version++;
  }

  contains(p: LatLng, margin = 0) {
    const b = this.bounds;
    const mLat = margin / (DEG * R);
    const mLng = mLat / Math.cos(p.lat * DEG);
    return p.lat >= b.south + mLat && p.lat <= b.north - mLat && p.lng >= b.west + mLng && p.lng <= b.east - mLng;
  }

  /** Cell index for a point, or -1 off the chart. */
  cell(p: LatLng): number {
    const i = Math.floor((p.lng - this.g.west) / this.g.dLng);
    const j = Math.floor((p.lat - this.g.south) / this.g.dLat);
    return i < 0 || j < 0 || i >= this.g.w || j >= this.g.h ? -1 : j * this.g.w + i;
  }

  center(k: number): LatLng {
    const i = k % this.g.w;
    const j = (k - i) / this.g.w;
    return { lat: this.g.south + (j + 0.5) * this.g.dLat, lng: this.g.west + (i + 0.5) * this.g.dLng };
  }

  depthAt(p: LatLng): number {
    const k = this.cell(p);
    return k < 0 ? NaN : this.g.depth[k];
  }

  hazardAt(p: LatLng): Hazard | null {
    const k = this.cell(p);
    return k < 0 ? null : this.kind[k] === LAND ? 'land' : this.kind[k] === SHALLOW ? 'shallow' : null;
  }

  /**
   * Can the boat be at cell `k` (at `p`)? An `exempt` point (a mark, the boat itself) that sits
   * inside the shore margin or on a shoal relaxes the rules around it, just enough to get there
   * or back out without closing the shore any further. That way a mark near the beach or a
   * boat leaving the harbour still gets a route, but nobody is steered at the rocks.
   * `slack` (m) eases the shore margin, never the hazards themselves.
   */
  passable(k: number, p: LatLng, exempt: LatLng[] = [], slack = 0): boolean {
    if (k < 0) return true; // off the chart: unknown, assume open water
    const cell = Math.max(this.cellX, this.cellY);
    // Distances run centre to centre; the hazard cell reaches half a cell closer.
    let minShore = this.safety.clearance + cell / 2;
    let shoalOk = false;
    for (const e of exempt) {
      const ke = this.cell(e);
      if (ke < 0) continue;
      const d = this.metres(p, e);
      // The chart is coarse: a mark or a GPS fix can land on a "land" cell by the shore.
      if (this.kind[ke] !== OK && d < cell * 1.5) return true;
      if (d > this.safety.clearance + cell * 2) continue;
      if (this.shore[ke] < minShore) minShore = Math.min(minShore, this.shore[ke] - cell / 2);
      if (this.kind[ke] === SHALLOW) shoalOk = true;
    }
    if (this.kind[k] === LAND || (this.kind[k] === SHALLOW && !shoalOk)) return false;
    return this.shore[k] >= minShore - slack;
  }

  /**
   * Visit every cell the line a→b crosses, in order (exact grid traversal, so even a
   * one-cell rock clipped at a corner is seen). `visit` gets the cell (-1 off the chart),
   * the point where the line enters it and the fraction of the way along; return true to stop.
   */
  private walk(a: LatLng, b: LatLng, visit: (k: number, p: LatLng, t: number) => boolean | void): boolean {
    const { west, south, dLng, dLat, w, h } = this.g;
    const x0 = (a.lng - west) / dLng;
    const y0 = (a.lat - south) / dLat;
    const dx = (b.lng - west) / dLng - x0;
    const dy = (b.lat - south) / dLat - y0;
    let i = Math.floor(x0);
    let j = Math.floor(y0);
    const si = Math.sign(dx);
    const sj = Math.sign(dy);
    const stepX = si ? Math.abs(1 / dx) : Infinity;
    const stepY = sj ? Math.abs(1 / dy) : Infinity;
    let tx = si > 0 ? (i + 1 - x0) * stepX : si < 0 ? (x0 - i) * stepX : Infinity;
    let ty = sj > 0 ? (j + 1 - y0) * stepY : sj < 0 ? (y0 - j) * stepY : Infinity;
    let t = 0;
    for (;;) {
      const k = i < 0 || j < 0 || i >= w || j >= h ? -1 : j * w + i;
      if (visit(k, { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }, t)) return true;
      t = Math.min(tx, ty);
      if (t > 1) return false;
      if (tx < ty) {
        i += si;
        tx += stepX;
      } else {
        j += sj;
        ty += stepY;
      }
    }
  }

  /** Is the straight line a→b free of land, shallows and the shore margin? */
  clear(a: LatLng, b: LatLng, exempt: LatLng[] = [], slack = 0): boolean {
    return !this.walk(a, b, (k, p) => !this.passable(k, p, exempt, slack));
  }

  /** The first real hazard (land or shallows, not the shore margin) on the line a→b. */
  firstHazard(a: LatLng, b: LatLng): { dist: number; kind: Hazard; depth: number } | null {
    const len = this.metres(a, b);
    let hit: { dist: number; kind: Hazard; depth: number } | null = null;
    this.walk(a, b, (k, _p, t) => {
      if (k < 0 || this.kind[k] === OK) return false;
      hit = { dist: len * t, kind: this.kind[k] === LAND ? 'land' : 'shallow', depth: this.g.depth[k] };
      return true;
    });
    return hit;
  }

  private metres(a: LatLng, b: LatLng) {
    const dy = (b.lat - a.lat) * DEG * R;
    const dx = (b.lng - a.lng) * DEG * R * Math.cos(((a.lat + b.lat) / 2) * DEG);
    return Math.hypot(dx, dy);
  }

  /** RGBA pixels of the no-go water (shallows red, shore margin amber), north row first, for a map overlay. */
  overlay(): { w: number; h: number; data: Uint8ClampedArray<ArrayBuffer> } {
    const { w, h } = this.g;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        const o = ((h - 1 - j) * w + i) * 4;
        if (this.kind[k] === SHALLOW) data.set([248, 113, 113, 120], o);
        else if (this.kind[k] === OK && this.shore[k] < this.safety.clearance + Math.max(this.cellX, this.cellY) / 2) data.set([251, 191, 36, 55], o);
      }
    }
    return { w, h, data };
  }
}

/** Two-pass chamfer distance (m) from every cell to the nearest land or shallow cell. */
function hazardDistance(g: ChartGrid, kind: Uint8Array, cx: number, cy: number): Float32Array {
  const { w, h } = g;
  const d = new Float32Array(w * h);
  for (let k = 0; k < d.length; k++) d[k] = kind[k] === OK ? Infinity : 0;
  const diag = Math.hypot(cx, cy);
  const relax = (k: number, i: number, j: number, cost: number) => {
    if (i >= 0 && j >= 0 && i < w && j < h) d[k] = Math.min(d[k], d[j * w + i] + cost);
  };
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      relax(k, i - 1, j, cx);
      relax(k, i, j - 1, cy);
      relax(k, i - 1, j - 1, diag);
      relax(k, i + 1, j - 1, diag);
    }
  }
  for (let j = h - 1; j >= 0; j--) {
    for (let i = w - 1; i >= 0; i--) {
      const k = j * w + i;
      relax(k, i + 1, j, cx);
      relax(k, i, j + 1, cy);
      relax(k, i + 1, j + 1, diag);
      relax(k, i - 1, j + 1, diag);
    }
  }
  return d;
}

// ---------- building the grid ----------

/** An empty (all land, unknown depth) grid covering `b` with cells of about `cellM` metres. */
export function emptyGrid(b: Bounds, cellM: number): ChartGrid {
  const dLat = cellM / (DEG * R);
  const dLng = cellM / (DEG * R * Math.cos(((b.south + b.north) / 2) * DEG));
  const w = Math.max(1, Math.ceil((b.east - b.west) / dLng));
  const h = Math.max(1, Math.ceil((b.north - b.south) / dLat));
  return { south: b.south, west: b.west, dLat, dLng, w, h, water: new Uint8Array(w * h), depth: new Float32Array(w * h).fill(NaN) };
}

/** A ring in fractional grid coordinates (x = column, y = row, from the SW corner). */
export type GridRing = { x: number; y: number }[];

/** Fill a polygon (outer ring + holes, even-odd) into `water` with `value`. */
export function fillPolygon(g: ChartGrid, rings: GridRing[], value: 0 | 1) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const r of rings) {
    for (const p of r) {
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  const j0 = Math.max(0, Math.ceil(minY - 0.5));
  const j1 = Math.min(g.h - 1, Math.floor(maxY - 0.5));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const y = j + 0.5;
    xs.length = 0;
    for (const r of rings) {
      for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
        const p = r[a];
        const q = r[b];
        if (p.y > y !== q.y > y) xs.push(p.x + ((y - p.y) / (q.y - p.y)) * (q.x - p.x));
      }
    }
    xs.sort((m, n) => m - n);
    for (let n = 0; n + 1 < xs.length; n += 2) {
      const i0 = Math.max(0, Math.ceil(xs[n] - 0.5));
      const i1 = Math.min(g.w - 1, Math.floor(xs[n + 1] - 0.5));
      for (let i = i0; i <= i1; i++) g.water[j * g.w + i] = value;
    }
  }
}

/** Mark every cell a polyline passes through with `value`. */
export function strokeLine(g: ChartGrid, line: GridRing, value: 0 | 1) {
  for (let n = 0; n + 1 < line.length; n++) {
    const p = line[n];
    const q = line[n + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) * 2));
    for (let s = 0; s <= steps; s++) {
      const i = Math.floor(p.x + ((q.x - p.x) * s) / steps);
      const j = Math.floor(p.y + ((q.y - p.y) * s) / steps);
      if (i >= 0 && j >= 0 && i < g.w && j < g.h) g.water[j * g.w + i] = value;
    }
  }
}

// ---------- loading ----------

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const EMODNET = 'https://ows.emodnet-bathymetry.eu/wcs';
const MAX_TILES = 64;
let tileUrl: Promise<string> | null = null;
const tileCache = new Map<string, Promise<VectorTile>>();

function tileTemplate(signal?: AbortSignal) {
  tileUrl ??= fetch(TILEJSON, { signal })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Map data returned ${r.status}`))))
    .then((j) => j.tiles[0] as string)
    .catch((e) => {
      tileUrl = null;
      throw e;
    });
  return tileUrl;
}

function loadTile(template: string, z: number, x: number, y: number) {
  const key = `${z}/${x}/${y}`;
  let t = tileCache.get(key);
  if (!t) {
    // Not tied to one load's AbortSignal: the tile is cached and shared.
    t = fetch(template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`Map tile returned ${r.status}`))))
      .then((buf) => new VectorTile(new Pbf(buf)));
    t.catch(() => tileCache.delete(key));
    if (tileCache.size > 400) tileCache.clear();
    tileCache.set(key, t);
  }
  return t;
}

const tileX = (lng: number, z: number) => ((lng + 180) / 360) * 2 ** z;
const tileY = (lat: number, z: number) => ((1 - Math.log(Math.tan(lat * DEG) + 1 / Math.cos(lat * DEG)) / Math.PI) / 2) * 2 ** z;

/** Rasterise OSM water (and piers, as land) from vector tiles into the grid. */
async function loadWater(g: ChartGrid, b: Bounds, signal?: AbortSignal) {
  const template = await tileTemplate(signal);
  const span = (z: number) => {
    const [x0, x1] = [Math.floor(tileX(b.west, z)), Math.floor(tileX(b.east, z))];
    const [y0, y1] = [Math.floor(tileY(b.north, z)), Math.floor(tileY(b.south, z))];
    return { x0, x1, y0, y1, n: (x1 - x0 + 1) * (y1 - y0 + 1) };
  };
  let z = 14;
  while (z > 8 && span(z).n > MAX_TILES) z--;
  const { x0, x1, y0, y1 } = span(z);
  const tiles: { x: number; y: number; tile: Promise<VectorTile> }[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push({ x, y, tile: loadTile(template, z, x, y) });
  const loaded = await Promise.all(tiles.map((t) => t.tile));
  signal?.throwIfAborted();

  const piers: (() => void)[] = [];
  tiles.forEach(({ x, y }, n) => {
    const tile = loaded[n];
    const toGrid = (extent: number) => (p: { x: number; y: number }) => {
      const lng = ((x + p.x / extent) / 2 ** z) * 360 - 180;
      const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + p.y / extent)) / 2 ** z))) / DEG;
      return { x: (lng - g.west) / g.dLng, y: (lat - g.south) / g.dLat };
    };
    const water = tile.layers.water;
    for (let f = 0; water && f < water.length; f++) {
      const feat = water.feature(f);
      if (feat.type !== 3 || feat.properties.class === 'swimming_pool' || feat.properties.intermittent === 1) continue;
      fillPolygon(g, feat.loadGeometry().map((r) => r.map(toGrid(water.extent))), 1);
    }
    const roads = tile.layers.transportation;
    for (let f = 0; roads && f < roads.length; f++) {
      const feat = roads.feature(f);
      if (feat.properties.class !== 'pier') continue;
      const rings = feat.loadGeometry().map((r) => r.map(toGrid(roads.extent)));
      piers.push(() => (feat.type === 3 ? fillPolygon(g, rings, 0) : rings.forEach((l) => strokeLine(g, l, 0))));
    }
  });
  // Piers go on top of the water.
  piers.forEach((p) => p());
}

/** Parse GeoServer's text/plain coverage: bounds header, then one row of numbers per line, north first. */
export function parseDepthGrid(text: string) {
  const m = text.match(/GeneralBounds\[\(([-\d.]+), ([-\d.]+)\), \(([-\d.]+), ([-\d.]+)\)\]/);
  const body = text.split(/Band 0:\s*\n/)[1];
  if (!m || !body) return null;
  const rows = body
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number));
  if (!rows.length || !rows[0].length) return null;
  const [west, south, east, north] = m.slice(1).map(Number);
  return { west, south, east, north, rows };
}

/** Sea depth from EMODnet (≈115 m cells), bilinearly sampled onto the grid. */
async function loadDepth(g: ChartGrid, b: Bounds, signal?: AbortSignal) {
  const url = `${EMODNET}?service=WCS&version=2.0.1&request=GetCoverage&coverageId=emodnet__mean&format=text/plain&subset=Lat(${b.south.toFixed(5)},${b.north.toFixed(5)})&subset=Long(${b.west.toFixed(5)},${b.east.toFixed(5)})`;
  const res = await fetch(url, { signal });
  if (!res.ok) return false;
  const d = parseDepthGrid(await res.text());
  if (!d) return false;
  const rows = d.rows.length;
  const cols = d.rows[0].length;
  const at = (c: number, r: number) => {
    const v = d.rows[Math.max(0, Math.min(rows - 1, r))]?.[Math.max(0, Math.min(cols - 1, c))];
    // Elevation in metres, negative below sea level. Land and lake surfaces carry no depth.
    return v !== undefined && isFinite(v) && v < 0 && v > -12000 ? -v : NaN;
  };
  for (let j = 0; j < g.h; j++) {
    const lat = g.south + (j + 0.5) * g.dLat;
    const r = ((d.north - lat) / (d.north - d.south)) * rows - 0.5;
    for (let i = 0; i < g.w; i++) {
      const lng = g.west + (i + 0.5) * g.dLng;
      const c = ((lng - d.west) / (d.east - d.west)) * cols - 0.5;
      const c0 = Math.floor(c);
      const r0 = Math.floor(r);
      const [fc, fr] = [c - c0, r - r0];
      const v =
        at(c0, r0) * (1 - fc) * (1 - fr) + at(c0 + 1, r0) * fc * (1 - fr) + at(c0, r0 + 1) * (1 - fc) * fr + at(c0 + 1, r0 + 1) * fc * fr;
      // Next to the coast some corners are land: fall back to the nearest model cell.
      g.depth[j * g.w + i] = isNaN(v) ? at(Math.round(c), Math.round(r)) : v;
    }
  }
  return true;
}

export async function loadChart(b: Bounds, safety: Safety, signal?: AbortSignal): Promise<Chart> {
  const diag = distance({ lat: b.south, lng: b.west }, { lat: b.north, lng: b.east });
  const g = emptyGrid(b, Math.min(150, Math.max(10, diag / 450)));
  // Depth is a bonus: outside European seas (or if the service is down) we go by the shore margin alone.
  const depth = loadDepth(g, b, signal).catch((e) => {
    if ((e as Error).name === 'AbortError') throw e;
    return false;
  });
  await Promise.all([loadWater(g, b, signal), depth]);
  return new Chart(g, safety);
}

/** Bounds around some points, padded by `pad` metres. */
export function boundsAround(points: LatLng[], pad: number): Bounds {
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const dLat = pad / (DEG * R);
  const dLng = dLat / Math.cos(midLat * DEG);
  return { south: Math.min(...lats) - dLat, north: Math.max(...lats) + dLat, west: Math.min(...lngs) - dLng, east: Math.max(...lngs) + dLng };
}
