import type { PolarPoint } from './physics';

const DEG = Math.PI / 180;

/** Speed polar, wind at the top, both tacks mirrored. Marks the current point and best VMG angles. */
export function drawPolar(
  canvas: HTMLCanvasElement,
  pts: PolarPoint[],
  current: { twa: number; speed: number },
  vmgAngles: { up: number; down: number },
) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const max = Math.max(2, Math.ceil(Math.max(...pts.map((p) => p.speed), current.speed) / 2) * 2);
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2 - 14;
  const at = (twa: number, v: number) => [cx + Math.sin(twa * DEG) * (v / max) * R, cy - Math.cos(twa * DEG) * (v / max) * R] as const;

  ctx.font = '500 9px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let v = 2; v <= max; v += 2) {
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
    ctx.beginPath();
    ctx.arc(cx, cy, (v / max) * R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
    ctx.fillText(`${v}`, cx + 3, cy - (v / max) * R + 7);
  }
  for (let a = 0; a < 360; a += 30) {
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(a * DEG) * R, cy - Math.cos(a * DEG) * R);
    ctx.stroke();
  }

  // Best VMG rays.
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = 'rgba(96, 165, 250, 0.55)';
  for (const a of [vmgAngles.up, -vmgAngles.up, vmgAngles.down, -vmgAngles.down]) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(a * DEG) * R, cy - Math.cos(a * DEG) * R);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Curve.
  const path = new Path2D();
  pts.forEach((p, i) => {
    const [x, y] = at(p.twa, p.speed);
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  });
  for (let i = pts.length - 1; i >= 0; i--) {
    const [x, y] = at(-pts[i].twa, pts[i].speed);
    path.lineTo(x, y);
  }
  path.closePath();
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  g.addColorStop(0, 'rgba(45, 212, 191, 0.02)');
  g.addColorStop(1, 'rgba(45, 212, 191, 0.22)');
  ctx.fillStyle = g;
  ctx.fill(path);
  ctx.strokeStyle = '#2dd4bf';
  ctx.lineWidth = 2;
  ctx.stroke(path);

  // Wind indicator.
  ctx.fillStyle = '#60a5fa';
  ctx.beginPath();
  ctx.moveTo(cx, cy - R + 2);
  ctx.lineTo(cx - 5, cy - R - 8);
  ctx.lineTo(cx + 5, cy - R - 8);
  ctx.closePath();
  ctx.fill();

  // Current point.
  const [px, py] = at(current.twa, current.speed);
  ctx.fillStyle = 'rgba(251, 191, 36, 0.25)';
  ctx.beginPath();
  ctx.arc(px, py, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fbbf24';
  ctx.beginPath();
  ctx.arc(px, py, 4, 0, Math.PI * 2);
  ctx.fill();
}
