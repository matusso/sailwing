// The view from the helm: low-poly 3D water, the real coastline, relief and seabed around the boat.
// Loaded on demand (three.js is the bulk of it), so the chart app itself stays light.

import * as THREE from 'three';
import { tileX, tileY, type Chart } from './chart';
import type { LatLng } from './geo';
import type { BoatState, Trim } from './physics';

const DEG = Math.PI / 180;
const R = 6371000;
const HAZE = 0xbfd9ea;
/** Seabed deeper than this looks the same from the cockpit. */
const SEABED_MAX = 25;

export interface SimFrame {
  pos: LatLng;
  heading: number;
  heel: number; // deg, + = to port
  rudder: number; // −1 … 1
  trim: Trim;
  state: BoatState;
  tws: number; // kn
  twd: number;
}

// ---------- relief ----------

const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const ELEV_Z = 12; // ≈ 25 m per pixel, about the chart's cell size

/** Ground elevation (m above sea level) over the chart from Mapzen Terrarium tiles (free, keyless); null if they can't be had. */
async function loadElevation(chart: Chart): Promise<((p: LatLng) => number) | null> {
  const b = chart.bounds;
  const [x0, x1] = [Math.floor(tileX(b.west, ELEV_Z)), Math.floor(tileX(b.east, ELEV_Z))];
  const [y0, y1] = [Math.floor(tileY(b.north, ELEV_Z)), Math.floor(tileY(b.south, ELEV_Z))];
  const c = document.createElement('canvas');
  c.width = (x1 - x0 + 1) * 256;
  c.height = (y1 - y0 + 1) * 256;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const tiles: Promise<void>[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      tiles.push(
        new Promise((ok, fail) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => (ctx.drawImage(img, (x - x0) * 256, (y - y0) * 256), ok());
          img.onerror = () => fail(new Error('elevation tile failed'));
          img.src = `${TERRARIUM}/${ELEV_Z}/${x}/${y}.png`;
        }),
      );
    }
  }
  try {
    await Promise.all(tiles);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    return (p) => {
      const i = Math.max(0, Math.min(c.width - 1, Math.floor((tileX(p.lng, ELEV_Z) - x0) * 256)));
      const j = Math.max(0, Math.min(c.height - 1, Math.floor((tileY(p.lat, ELEV_Z) - y0) * 256)));
      const o = (j * c.width + i) * 4;
      return px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768;
    };
  } catch {
    return null; // flat land is still a coastline
  }
}

/** Colour stops by height above the water (m): beach, meadow, forest, rock, snow. */
const LAND: [number, number][] = [
  [0, 0xd8c690],
  [3, 0x7fae5a],
  [250, 0x3f7f45],
  [900, 0x7d7a6c],
  [1700, 0x9a968c],
  [2300, 0xf2f4f7],
];
const SEABED: [number, number][] = [
  [0, 0xd8c690],
  [4, 0x4f9db0],
  [SEABED_MAX, 0x0e3552],
];
const tmpA = new THREE.Color();
const tmpB = new THREE.Color();
function ramp(stops: [number, number][], v: number, out: Float32Array, o: number) {
  let n = 1;
  while (n < stops.length - 1 && v > stops[n][0]) n++;
  const [v0, c0] = stops[n - 1];
  const [v1, c1] = stops[n];
  tmpA.setHex(c0).lerp(tmpB.setHex(c1), Math.max(0, Math.min(1, (v - v0) / (v1 - v0))));
  out[o] = tmpA.r;
  out[o + 1] = tmpA.g;
  out[o + 2] = tmpA.b;
}

// ---------- water ----------

const STEP = 3; // m between water vertices near the boat
const INNER = 48; // vertices each way that carry waves
const OUTER = 16; // ever wider rings out to the horizon
const N = 2 * (INNER + OUTER) + 1;
const waterCoord = (i: number) => {
  const m = Math.abs(i) - INNER;
  return Math.sign(i) * (m <= 0 ? Math.abs(i) * STEP : INNER * STEP + STEP * m * 1.45 ** m);
};

// ---------- the boat, as seen from behind its wheel ----------

function triangle(a: number[], b: number[], c: number[], mat: THREE.Material) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c], 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}

function buildBoat() {
  const white = new THREE.MeshLambertMaterial({ color: 0xf4f6f8 });
  const grey = new THREE.MeshLambertMaterial({ color: 0x9aa4b0 });
  const wood = new THREE.MeshLambertMaterial({ color: 0x9a6a3a });
  const cloth = new THREE.MeshLambertMaterial({ color: 0xfffdf5, side: THREE.DoubleSide });
  const boat = new THREE.Group();
  boat.rotation.order = 'YXZ'; // heading, then pitch, then heel
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, to: THREE.Object3D = boat) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    to.add(m);
    return m;
  };

  // Bow is −z, starboard +x, the waterline y = 0, the deck at 0.8 m.
  const plan = new THREE.Shape();
  plan.moveTo(0, 3.7);
  plan.quadraticCurveTo(1.35, 1.5, 1.25, -1);
  plan.lineTo(0.95, -3.5);
  plan.lineTo(-0.95, -3.5);
  plan.lineTo(-1.25, -1);
  plan.quadraticCurveTo(-1.35, 1.5, 0, 3.7);
  add(new THREE.ExtrudeGeometry(plan, { depth: 1.1, bevelEnabled: false }).rotateX(-Math.PI / 2), white, 0, -0.3, 0);
  add(new THREE.BoxGeometry(1.5, 0.4, 2.4), grey, 0, 1.0, -0.7); // coachroof
  add(new THREE.CylinderGeometry(0.05, 0.07, 10.2), grey, 0, 5.9, -1.3); // mast

  const boom = new THREE.Group();
  boom.position.set(0, 2.5, -1.3);
  add(new THREE.BoxGeometry(0.1, 0.1, 3.3), grey, 0, 0, 1.65, boom);
  boom.add(triangle([0, 0.1, 0], [0, 0.1, 3.2], [0, 8.3, 0], cloth));
  boat.add(boom);

  // The jib swings around the forestay, which leans aft to the mast.
  const stay = new THREE.Group();
  stay.position.set(0, 0.9, -3.6);
  stay.rotation.x = Math.atan2(2.3, 8.6);
  const jib = new THREE.Group();
  jib.add(triangle([0, 0.2, 0], [0, 1.3, 2.9], [0, 8.2, 0], cloth));
  stay.add(jib);
  boat.add(stay);

  const wheel = new THREE.Group();
  wheel.position.set(0, 1.35, 1.75);
  add(new THREE.TorusGeometry(0.32, 0.03, 6, 24), wood, 0, 0, 0, wheel);
  for (let n = 0; n < 3; n++) add(new THREE.BoxGeometry(0.64, 0.035, 0.025), wood, 0, 0, 0, wheel).rotation.z = (n * Math.PI) / 3;
  boat.add(wheel);
  add(new THREE.BoxGeometry(0.12, 0.6, 0.12), grey, 0, 1.08, 1.67); // pedestal

  return { boat, boom, jib, wheel };
}

// ---------- the scene ----------

export class Sim3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, 1, 0.3, 45000);
  private parts = buildBoat();
  private water: THREE.Mesh;
  private sky: THREE.Mesh;
  private terrain: THREE.Mesh | null = null;
  private origin: LatLng | null = null;
  private side = -1; // where the sails lie: −1 port … 1 starboard, eased across in a tack
  private last = 0;
  private wind = { amp: 0, x: 0, z: 1 };

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); // phones: 3× is wasted on flat shading
    this.scene.fog = new THREE.Fog(HAZE, 1200, 3600);
    this.scene.add(new THREE.HemisphereLight(0xdcefff, 0x47607a, 1.6));
    const sun = new THREE.DirectionalLight(0xfff1d0, 2.2);
    sun.position.set(-0.5, 0.8, 0.35);
    this.scene.add(sun);

    // Sky: haze at the horizon, blue overhead. It travels with the camera.
    const dome = new THREE.SphereGeometry(20000, 24, 12);
    const tint = new Float32Array(dome.attributes.position.count * 3);
    const zenith = new THREE.Color(0x4a8fd6);
    for (let n = 0; n < dome.attributes.position.count; n++) {
      tmpA.setHex(HAZE).lerp(zenith, Math.sqrt(Math.max(0, dome.attributes.position.getY(n) / 20000))).toArray(tint, n * 3);
    }
    dome.setAttribute('color', new THREE.BufferAttribute(tint, 3));
    this.sky = new THREE.Mesh(dome, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    this.scene.add(this.sky);

    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(N * N * 3);
    const idx = new Uint32Array((N - 1) * (N - 1) * 6);
    for (let j = 0, o = 0, q = 0; j < N; j++) {
      for (let i = 0; i < N; i++, o += 3) {
        pos[o] = waterCoord(i - INNER - OUTER);
        pos[o + 2] = waterCoord(j - INNER - OUTER);
        if (i < N - 1 && j < N - 1) {
          const a = j * N + i;
          idx.set([a, a + N, a + 1, a + 1, a + N, a + N + 1], q);
          q += 6;
        }
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.water = new THREE.Mesh(
      geo,
      new THREE.MeshPhongMaterial({ color: 0x1f76ad, specular: 0x9fd0ee, shininess: 70, flatShading: true, transparent: true, opacity: 0.84 }),
    );
    this.water.frustumCulled = false; // its vertices move every frame
    this.scene.add(this.water);

    this.parts.boat.add(this.camera);
    this.scene.add(this.parts.boat);
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 78 : 60; // a phone held upright needs the wider view to see the bow
    this.camera.updateProjectionMatrix();
  }

  /** Build the land and seabed of `chart` around the boat. */
  async setWorld(chart: Chart, boat: LatLng) {
    const elev = await loadElevation(chart);
    const { g } = chart;
    const b = chart.bounds;
    // Lakes sit above sea level: heights are taken from the water the boat floats on.
    const datum = elev ? Math.max(0, elev(boat)) : 0;
    const pos = new Float32Array(g.w * g.h * 3);
    const col = new Float32Array(g.w * g.h * 3);
    const idx = new Uint32Array((g.w - 1) * (g.h - 1) * 6);
    for (let j = 0, k = 0, q = 0; j < g.h; j++) {
      for (let i = 0; i < g.w; i++, k++) {
        const o = k * 3;
        pos[o] = (i + 0.5 - g.w / 2) * chart.cellX;
        pos[o + 2] = -(j + 0.5 - g.h / 2) * chart.cellY;
        if (g.water[k]) {
          const d = g.depth[k] + chart.tide;
          // Uncharted water (lakes, far seas) just shelves away from the shore.
          const depth = Math.min(SEABED_MAX, isNaN(d) ? 1 + chart.room(k) * 0.1 : Math.max(0.3, d));
          pos[o + 1] = -depth;
          ramp(SEABED, depth, col, o);
        } else {
          const h = Math.max(0.8, elev ? elev(chart.center(k)) - datum : 4);
          pos[o + 1] = h;
          ramp(LAND, h, col, o);
        }
        if (i < g.w - 1 && j < g.h - 1) {
          idx.set([k, k + 1, k + g.w, k + 1, k + g.w + 1, k + g.w], q);
          q += 6;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    if (this.terrain) {
      this.scene.remove(this.terrain);
      this.terrain.geometry.dispose();
    }
    this.terrain = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    this.scene.add(this.terrain);
    this.origin = { lat: (b.south + b.north) / 2, lng: (b.west + b.east) / 2 };
  }

  private wave(x: number, z: number, t: number) {
    const w = this.wind;
    const u = x * w.x + z * w.z; // m downwind
    const v = x * w.z - z * w.x;
    return w.amp * (0.6 * Math.sin(u * 0.22 - t * 1.5) + 0.3 * Math.sin(u * 0.47 + v * 0.31 - t * 2.3) + 0.15 * Math.sin(v * 0.6 + u * 0.13 + t * 1.1));
  }

  /** Render one frame; `t` in seconds. */
  draw(f: SimFrame, t: number) {
    const dt = Math.min(0.1, t - this.last);
    this.last = t;
    this.origin ??= f.pos; // open water until the chart arrives
    const x = (f.pos.lng - this.origin.lng) * DEG * R * Math.cos(this.origin.lat * DEG);
    const z = -(f.pos.lat - this.origin.lat) * DEG * R;
    this.wind = { amp: Math.min(1, 0.06 + 0.01 * f.tws ** 1.5), x: -Math.sin(f.twd * DEG), z: Math.cos(f.twd * DEG) };

    // Waves live on a lattice fixed to the world: the mesh jumps a whole cell at a time, so the sea doesn't slide along with the boat.
    const wx = Math.round(x / STEP) * STEP;
    const wz = Math.round(z / STEP) * STEP;
    this.water.position.set(wx, 0, wz);
    const pos = this.water.geometry.attributes.position as THREE.BufferAttribute;
    const reach = INNER * STEP;
    for (let j = OUTER; j < N - OUTER; j++) {
      for (let i = OUTER; i < N - OUTER; i++) {
        const k = j * N + i;
        const [lx, lz] = [pos.getX(k), pos.getZ(k)];
        const fade = Math.min(1, 3 * (1 - Math.max(Math.abs(lx), Math.abs(lz)) / reach)); // calm towards the flat rings
        pos.setY(k, fade * this.wave(wx + lx, wz + lz, t));
      }
    }
    pos.needsUpdate = true;

    const { boat, boom, jib, wheel } = this.parts;
    const [fx, fz] = [Math.sin(f.heading * DEG), -Math.cos(f.heading * DEG)];
    const bow = this.wave(x + fx * 3, z + fz * 3, t);
    const stern = this.wave(x - fx * 3, z - fz * 3, t);
    boat.position.set(x, (bow + stern) * 0.3, z);
    boat.rotation.set(Math.atan2(bow - stern, 6) * 0.6, -f.heading * DEG, f.heel * DEG);

    // Sails fall to leeward; flogging ones shake.
    this.side += ((f.state.awa >= 0 ? -1 : 1) - this.side) * Math.min(1, dt * 4);
    const flog = (luffing: boolean, phase: number) => (luffing ? Math.sin(t * 28 + phase) * 4 : 0);
    boom.rotation.y = (this.side * Math.max(2, f.trim.main) + flog(f.state.main.status === 'luffing', 0)) * DEG;
    jib.rotation.y = (this.side * Math.max(6, f.trim.jib) + flog(f.state.jib.status === 'luffing', 2)) * DEG;
    wheel.rotation.z = -f.rudder * 2.2;

    // The helmsman stands a little to windward, clear of the mainsail.
    this.camera.position.set(-this.side * 0.45, 2.05, 3.35);
    this.camera.rotation.set(-0.1, 0, 0);
    this.camera.getWorldPosition(this.sky.position);
    this.renderer.render(this.scene, this.camera);
  }
}
