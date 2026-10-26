import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { LatLng } from './geo';

export type MapMode = 'pick' | 'track';

interface Callbacks {
  onPick(p: LatLng): void;
  onAddMark(p: LatLng): void;
  onMoveMark(index: number, p: LatLng): void;
  onRemoveMark(index: number): void;
}

export interface RouteLeg {
  path: LatLng[];
  active: boolean;
}

export interface NavOverlay {
  path: LatLng[];
  laylines: [LatLng, LatLng][];
  turnAt?: LatLng;
}

interface Particle {
  x: number;
  y: number;
  age: number;
  life: number;
}

const BOAT_SVG = `<svg viewBox="0 0 24 40" width="20" height="34"><path d="M12 1 C19 10 19 26 16.5 39 L7.5 39 C5 26 5 10 12 1Z" fill="#f8fafc" stroke="#0f172a" stroke-width="1.2"/><path d="M12 13 L12 30" stroke="#2dd4bf" stroke-width="2.2" stroke-linecap="round"/></svg>`;

export class MapView {
  private map: L.Map;
  private boat: L.Marker;
  private marks: L.Marker[] = [];
  private markLine: L.Polyline;
  private routeLayer = L.layerGroup();
  private navLayer = L.layerGroup();
  private accuracy: L.Circle;
  private chartOverlay: L.ImageOverlay | null = null;
  private nextMark = -1;
  private mode: MapMode = 'pick';
  private wind = { speed: 12, dir: 270 };
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private particles: Particle[] = [];

  constructor(el: HTMLElement, start: LatLng, private cb: Callbacks) {
    this.map = L.map(el, { zoomControl: false }).setView([start.lat, start.lng], 12);
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    // Keyless OSM tiles, darkened with a CSS filter (see .dark-tiles).
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
      className: 'dark-tiles',
    }).addTo(this.map);

    this.markLine = L.polyline([], { color: '#94a3b8', opacity: 0.5, weight: 1.5, dashArray: '4 7', interactive: false }).addTo(this.map);
    this.routeLayer.addTo(this.map);
    this.navLayer.addTo(this.map);
    this.accuracy = L.circle([start.lat, start.lng], {
      radius: 0,
      color: '#60a5fa',
      weight: 1,
      opacity: 0,
      fillColor: '#60a5fa',
      fillOpacity: 0,
      interactive: false,
    }).addTo(this.map);
    this.boat = L.marker([start.lat, start.lng], {
      icon: L.divIcon({ className: 'boat-marker', html: `<div class="boat-rot">${BOAT_SVG}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }),
      interactive: false,
      zIndexOffset: 1000,
    }).addTo(this.map);

    this.map.on('click', (e: L.LeafletMouseEvent) => {
      const p = { lat: e.latlng.lat, lng: e.latlng.lng };
      if (this.mode === 'pick') this.cb.onPick(p);
      else this.cb.onAddMark(p);
    });

    this.canvas.className = 'wind-layer';
    el.appendChild(this.canvas);
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    requestAnimationFrame(this.frame);
  }

  setMode(mode: MapMode) {
    this.mode = mode;
    this.map.getContainer().classList.toggle('mode-track', mode === 'track');
  }

  setWind(speed: number, dir: number) {
    this.wind = { speed, dir };
  }

  setBoat(p: LatLng, heading: number, follow = false) {
    this.boat.setLatLng([p.lat, p.lng]);
    const rot = this.boat.getElement()?.querySelector<HTMLElement>('.boat-rot');
    if (rot) rot.style.transform = `rotate(${heading}deg)`;
    if (follow && !this.map.getBounds().pad(-0.15).contains([p.lat, p.lng])) this.map.panTo([p.lat, p.lng]);
  }

  /** GPS accuracy circle; null hides it. */
  setAccuracy(p: LatLng | null, metres = 0) {
    this.accuracy.setLatLng(p ? [p.lat, p.lng] : this.accuracy.getLatLng());
    this.accuracy.setRadius(p ? metres : 0);
    this.accuracy.setStyle({ opacity: p ? 0.5 : 0, fillOpacity: p ? 0.1 : 0 });
  }

  centerOn(p: LatLng, zoom = 15) {
    this.map.setView([p.lat, p.lng], Math.max(this.map.getZoom(), zoom));
  }

  /** Live race guidance: laylines at the next mark, the planned path and the tack point. */
  setNav(nav: NavOverlay | null) {
    this.navLayer.clearLayers();
    if (!nav) return;
    for (const [a, b] of nav.laylines) {
      L.polyline([[a.lat, a.lng], [b.lat, b.lng]], { color: '#fbbf24', weight: 1.5, opacity: 0.55, dashArray: '2 6', interactive: false }).addTo(this.navLayer);
    }
    L.polyline(nav.path.map((p) => [p.lat, p.lng] as [number, number]), { color: '#f8fafc', weight: 2, opacity: 0.85, dashArray: '6 6', interactive: false }).addTo(this.navLayer);
    if (nav.turnAt) {
      L.circleMarker([nav.turnAt.lat, nav.turnAt.lng], { radius: 6, color: '#fbbf24', weight: 2, fillColor: '#0b1220', fillOpacity: 1, interactive: false }).addTo(this.navLayer);
    }
  }

  setNextMark(i: number) {
    this.nextMark = i;
    this.marks.forEach((m, k) => m.getElement()?.classList.toggle('next', k === i));
  }

  setMarks(points: LatLng[]) {
    this.marks.forEach((m) => m.remove());
    this.marks = points.map((p, i) => {
      const label = i === 0 ? 'S' : i === points.length - 1 && points.length > 1 ? 'F' : String(i);
      const m = L.marker([p.lat, p.lng], {
        draggable: true,
        icon: L.divIcon({ className: `mark${i === this.nextMark ? ' next' : ''}`, html: `<span>${label}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
      }).addTo(this.map);
      m.on('dragend', () => {
        const ll = m.getLatLng();
        this.cb.onMoveMark(i, { lat: ll.lat, lng: ll.lng });
      });
      m.on('contextmenu', () => this.cb.onRemoveMark(i));
      return m;
    });
    this.markLine.setLatLngs(points.map((p) => [p.lat, p.lng]));
  }

  setRoute(legs: RouteLeg[]) {
    this.routeLayer.clearLayers();
    for (const leg of legs) {
      const ll = leg.path.map((p) => [p.lat, p.lng] as [number, number]);
      L.polyline(ll, { color: '#2dd4bf', weight: 8, opacity: leg.active ? 0.25 : 0.08, interactive: false }).addTo(this.routeLayer);
      L.polyline(ll, { color: leg.active ? '#5eead4' : '#2dd4bf', weight: leg.active ? 3 : 2, opacity: leg.active ? 1 : 0.7, interactive: false }).addTo(this.routeLayer);
      for (const p of leg.path.slice(1, -1)) {
        L.circleMarker([p.lat, p.lng], { radius: 3, color: '#5eead4', fillColor: '#0b1220', fillOpacity: 1, weight: 2, interactive: false }).addTo(this.routeLayer);
      }
    }
  }

  /** Shade the water the router keeps out of (shallows, shore margin). */
  setChartOverlay(img: { w: number; h: number; data: Uint8ClampedArray<ArrayBuffer> } | null, b?: { south: number; west: number; north: number; east: number }) {
    this.chartOverlay?.remove();
    this.chartOverlay = null;
    if (!img || !b) return;
    const c = document.createElement('canvas');
    c.width = img.w;
    c.height = img.h;
    c.getContext('2d')!.putImageData(new ImageData(img.data, img.w, img.h), 0, 0);
    this.chartOverlay = L.imageOverlay(c.toDataURL(), [[b.south, b.west], [b.north, b.east]], {
      interactive: false,
      className: 'chart-overlay',
    }).addTo(this.map);
  }

  fitTo(points: LatLng[]) {
    if (points.length > 1) this.map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng])), { padding: [60, 60] });
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round((w * h) / 5500);
    this.particles = Array.from({ length: n }, () => this.spawn(w, h, true));
  }

  private spawn(w: number, h: number, randomAge = false): Particle {
    const life = 60 + Math.random() * 90;
    return { x: Math.random() * w, y: Math.random() * h, age: randomAge ? Math.random() * life : 0, life };
  }

  // Wind streaks drifting downwind across the whole map (uniform wind field).
  private frame = () => {
    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    const to = ((this.wind.dir + 180) * Math.PI) / 180;
    const v = 0.25 + this.wind.speed * 0.09;
    const vx = Math.sin(to) * v;
    const vy = -Math.cos(to) * v;
    const trail = 6 + this.wind.speed * 0.9;
    ctx.lineWidth = 1.3;
    ctx.lineCap = 'round';
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.x += vx;
      p.y += vy;
      p.age++;
      if (p.age > p.life || p.x < -20 || p.y < -20 || p.x > w + 20 || p.y > h + 20) {
        this.particles[i] = this.spawn(w, h);
        continue;
      }
      const a = Math.sin((Math.PI * p.age) / p.life) * (this.wind.speed > 0.5 ? 0.45 : 0);
      ctx.strokeStyle = `rgba(147, 197, 253, ${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - (vx / v) * trail, p.y - (vy / v) * trail);
      ctx.stroke();
    }
    requestAnimationFrame(this.frame);
  };
}
