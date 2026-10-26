import { MIN_SHEET, type BoatState, type SailStatus, type Trim } from './physics';

export interface BoatScene {
  heading: number;
  twd: number;
  tws: number;
  trim: Trim;
  state: BoatState;
  noGo: number; // closest pointing TWA
}

const DEG = Math.PI / 180;
const C = {
  wind: '#60a5fa',
  apparent: '#fbbf24',
  ring: 'rgba(148, 163, 184, 0.22)',
  label: 'rgba(203, 213, 225, 0.75)',
};
export const STATUS_COLOR: Record<SailStatus, string> = {
  trimmed: '#2dd4bf',
  eased: '#fbbf24',
  'over-trimmed': '#fb923c',
  luffing: '#f87171',
};

interface Streak {
  x: number;
  y: number;
  len: number;
}

/** Top-down, bow-up view of the boat with sails, wind arrows and compass. */
export class BoatView {
  private ctx: CanvasRenderingContext2D;
  private scene: BoatScene | null = null;
  private streaks: Streak[] = [];
  private w = 0;
  private h = 0;
  private last = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    requestAnimationFrame(this.frame);
  }

  set(scene: BoatScene) {
    this.scene = scene;
  }

  private resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.streaks = Array.from({ length: 46 }, () => ({
      x: Math.random() * this.w,
      y: Math.random() * this.h,
      len: 6 + Math.random() * 16,
    }));
  }

  private frame = (t: number) => {
    const dt = Math.min(0.05, (t - this.last) / 1000 || 0);
    this.last = t;
    if (this.scene && this.w > 0) this.draw(this.scene, t / 1000, dt);
    requestAnimationFrame(this.frame);
  };

  private draw(s: BoatScene, time: number, dt: number) {
    const { ctx, w, h } = this;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) / 2 - 16;
    ctx.clearRect(0, 0, w, h);

    // Water moving past the boat.
    ctx.strokeStyle = 'rgba(148, 197, 255, 0.07)';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    const flow = s.state.speed * 14 + 4;
    for (const k of this.streaks) {
      k.y += flow * dt;
      if (k.y > h + 20) {
        k.y = -20;
        k.x = Math.random() * w;
      }
      ctx.beginPath();
      ctx.moveTo(k.x, k.y);
      ctx.lineTo(k.x, k.y + k.len);
      ctx.stroke();
    }

    // Screen angle for a true bearing (bow-up view).
    const rel = (bearing: number) => (bearing - s.heading) * DEG;
    const at = (a: number, r: number) => [cx + Math.sin(a) * r, cy - Math.cos(a) * r] as const;

    // No-go zone.
    const windA = rel(s.twd);
    if (s.tws > 0.5) {
      const g = ctx.createRadialGradient(cx, cy, R * 0.15, cx, cy, R);
      g.addColorStop(0, 'rgba(248, 113, 113, 0)');
      g.addColorStop(1, 'rgba(248, 113, 113, 0.14)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, windA - s.noGo * DEG - Math.PI / 2, windA + s.noGo * DEG - Math.PI / 2);
      ctx.closePath();
      ctx.fill();
      // Label sits inside the wedge, beside the wind arrows.
      const [lx, ly] = at(windA - Math.max(10, s.noGo - 14) * DEG, R * 0.8);
      ctx.fillStyle = 'rgba(248, 113, 113, 0.6)';
      ctx.font = '600 10px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('NO-GO', lx, ly);
    }

    // Compass ring.
    ctx.strokeStyle = C.ring;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    for (let b = 0; b < 360; b += 10) {
      const major = b % 30 === 0;
      const [x1, y1] = at(rel(b), R);
      const [x2, y2] = at(rel(b), R - (major ? 9 : 5));
      ctx.strokeStyle = major ? 'rgba(203, 213, 225, 0.45)' : C.ring;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [b, n] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']] as const) {
      const [x, y] = at(rel(b), R - 20);
      ctx.fillStyle = n === 'N' ? '#f87171' : C.label;
      ctx.fillText(n, x, y);
    }
    // Heading lubber line.
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.moveTo(cx, cy - R - 2);
    ctx.lineTo(cx - 6, cy - R - 12);
    ctx.lineTo(cx + 6, cy - R - 12);
    ctx.closePath();
    ctx.fill();

    // Boat.
    const L = R * 1.08;
    this.drawBoat(s, cx, cy, L, time);

    // Wind arrows (drawn last so they stay readable).
    if (s.tws > 0.5) {
      this.arrow(windA, R - 4, R * 0.62, C.wind);
      this.arrow(s.state.awa * DEG, R * 0.86, R * 0.5, C.apparent);
    }
  }

  private arrow(a: number, rFrom: number, rTo: number, color: string) {
    const { ctx } = this;
    const cx = this.w / 2;
    const cy = this.h / 2;
    const p = (r: number) => [cx + Math.sin(a) * r, cy - Math.cos(a) * r] as const;
    const [x1, y1] = p(rFrom);
    const [x2, y2] = p(rTo);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    const ang = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.moveTo(x2 + Math.cos(ang) * 4, y2 + Math.sin(ang) * 4);
    ctx.lineTo(x2 - Math.cos(ang - 0.45) * 12, y2 - Math.sin(ang - 0.45) * 12);
    ctx.lineTo(x2 - Math.cos(ang + 0.45) * 12, y2 - Math.sin(ang + 0.45) * 12);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawBoat(s: BoatScene, cx: number, cy: number, L: number, time: number) {
    const { ctx } = this;
    const heelK = Math.cos(s.state.heel * DEG);
    const W = L * 0.34 * heelK;
    // Sails go to leeward: wind from starboard (+TWA) puts them to port (−x).
    const side = s.state.twa >= 0 ? 1 : -1;

    ctx.save();
    ctx.translate(cx, cy);

    // Wake.
    const wake = Math.min(1, s.state.speed / 7);
    if (wake > 0.05) {
      ctx.strokeStyle = `rgba(226, 232, 240, ${0.25 * wake})`;
      ctx.lineWidth = 1.5;
      for (const sx of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(sx * W * 0.3, L / 2);
        ctx.quadraticCurveTo(sx * W * 0.5, L / 2 + L * 0.2 * wake, sx * W * (0.7 + wake), L / 2 + L * 0.42 * wake);
        ctx.stroke();
      }
    }

    // Heel shadow to leeward.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    this.hullPath(W, L, -side * (1 - heelK) * L * 0.25 + 3, 5);
    ctx.fill();

    const g = ctx.createLinearGradient(-W / 2, 0, W / 2, 0);
    g.addColorStop(0, '#cbd5e1');
    g.addColorStop(0.5, '#f8fafc');
    g.addColorStop(1, '#cbd5e1');
    ctx.fillStyle = g;
    this.hullPath(W, L, 0, 0);
    ctx.fill();
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Cockpit.
    ctx.fillStyle = '#cbd5e1';
    ctx.beginPath();
    ctx.roundRect(-W * 0.27, L * 0.16, W * 0.54, L * 0.26, 6);
    ctx.fill();
    ctx.fillStyle = '#94a3b8';
    ctx.beginPath();
    ctx.roundRect(-W * 0.2, L * 0.2, W * 0.4, L * 0.19, 4);
    ctx.fill();

    const mast = { x: 0, y: -L * 0.1 };
    const tack = { x: 0, y: -L * 0.47 };
    const mainB = Math.max(MIN_SHEET.main, s.trim.main) * DEG;
    const jibB = Math.max(MIN_SHEET.jib, s.trim.jib) * DEG;
    const boomEnd = { x: mast.x - side * Math.sin(mainB) * L * 0.55, y: mast.y + Math.cos(mainB) * L * 0.55 };
    const clew = { x: tack.x - side * Math.sin(jibB) * L * 0.42, y: tack.y + Math.cos(jibB) * L * 0.42 };

    this.sail(tack, clew, side, s.state.jib.status, time, 0.16);
    // Boom.
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(mast.x, mast.y);
    ctx.lineTo(boomEnd.x, boomEnd.y);
    ctx.stroke();
    this.sail(mast, boomEnd, side, s.state.main.status, time + 0.7, 0.13);
    // Mast.
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(mast.x, mast.y, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  private hullPath(W: number, L: number, dx: number, dy: number) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(dx, -L / 2 + dy);
    ctx.bezierCurveTo(dx + W * 0.55, -L * 0.28 + dy, dx + W * 0.55, L * 0.12 + dy, dx + W * 0.36, L / 2 + dy);
    ctx.lineTo(dx - W * 0.36, L / 2 + dy);
    ctx.bezierCurveTo(dx - W * 0.55, L * 0.12 + dy, dx - W * 0.55, -L * 0.28 + dy, dx, -L / 2 + dy);
    ctx.closePath();
  }

  private sail(a: { x: number; y: number }, b: { x: number; y: number }, side: number, status: SailStatus, time: number, camber: number) {
    const { ctx } = this;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    // Perpendicular pointing to leeward.
    let nx = -dy / len;
    let ny = dx / len;
    if (nx * -side < 0) {
      nx = -nx;
      ny = -ny;
    }
    const color = STATUS_COLOR[status];
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';

    if (status === 'luffing') {
      ctx.beginPath();
      const n = 28;
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const wob = Math.sin(u * Math.PI * 5 - time * 18) * len * 0.05 * Math.sin(u * Math.PI);
        const x = a.x + dx * u + nx * wob;
        const y = a.y + dy * u + ny * wob;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
      return;
    }

    const depth = len * camber;
    // Max draft about 40% back from the luff.
    const c1 = { x: a.x + dx * 0.4 + nx * depth * 1.25, y: a.y + dy * 0.4 + ny * depth * 1.25 };
    const c2 = { x: a.x + dx * 0.4 + nx * depth * 0.45, y: a.y + dy * 0.4 + ny * depth * 0.45 };
    const fill = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    fill.addColorStop(0, 'rgba(248, 250, 252, 0.96)');
    fill.addColorStop(1, 'rgba(226, 232, 240, 0.85)');
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(c1.x, c1.y, b.x, b.y);
    ctx.quadraticCurveTo(c2.x, c2.y, a.x, a.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
