import { describe, expect, it } from 'vitest';
import { Chart, boundsAround, emptyGrid, fillPolygon, parseDepthGrid, strokeLine, type ChartGrid } from './chart';
import { findRoute, nextWaypoint, routeLeg, sailLeg } from './route';
import { advise } from './nav';
import { distance, offset, type LatLng } from './geo';
import { KN, norm180, polar, polarLookup } from './physics';

const start = { lat: 45.8, lng: 10.85 };
const safety = { draft: 1.5, clearance: 40 };

/** 4 km × 4 km of open water around `start`, 20 m cells, 10 m deep. */
function sea(): ChartGrid {
  const g = emptyGrid(boundsAround([start], 2000), 20);
  g.water.fill(1);
  g.depth.fill(10);
  return g;
}
/** Paint a rectangle (metres east/north of `start`) as land or with a depth. */
function paint(g: ChartGrid, x0: number, y0: number, x1: number, y1: number, what: 'land' | number) {
  const c = new Chart(g, safety);
  for (let k = 0; k < g.w * g.h; k++) {
    const p = c.center(k);
    const y = (p.lat - start.lat) * 111195;
    const x = (p.lng - start.lng) * 111195 * Math.cos(start.lat * (Math.PI / 180));
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
      if (what === 'land') g.water[k] = 0;
      else g.depth[k] = what;
    }
  }
}
const east = (m: number, from: LatLng = start) => offset(from, 90, m);
const north = (m: number, from: LatLng = start) => offset(from, 0, m);

describe('Chart', () => {
  it('flags land, shallows and the shore margin', () => {
    const g = sea();
    paint(g, 300, -100, 400, 100, 'land');
    paint(g, -400, -100, -300, 100, 1.2);
    const c = new Chart(g, safety);
    expect(c.hazardAt(east(350))).toBe('land');
    expect(c.hazardAt(east(-350))).toBe('shallow');
    expect(c.hazardAt(start)).toBeNull();
    expect(c.clear(start, east(230))).toBe(true);
    expect(c.clear(start, east(280))).toBe(false); // inside the 40 m margin
    expect(c.clear(start, east(600))).toBe(false);
    expect(c.firstHazard(start, east(600))!.kind).toBe('land');
    expect(c.firstHazard(start, east(600))!.dist).toBeGreaterThan(280);
    expect(c.firstHazard(start, east(-600))!.depth).toBeCloseTo(1.2);
  });

  it('waives the margin around exempt points but never lets you through land', () => {
    const g = sea();
    paint(g, 300, -100, 400, 100, 'land');
    const c = new Chart(g, safety);
    const nearShore = east(275);
    expect(c.clear(start, nearShore)).toBe(false);
    expect(c.clear(start, nearShore, [nearShore])).toBe(true);
    expect(c.clear(start, east(600), [east(600)])).toBe(false);
  });

  it('a deeper draft turns more water into shallows', () => {
    const g = sea();
    paint(g, -400, -100, -300, 100, 2.5);
    const c = new Chart(g, safety);
    expect(c.hazardAt(east(-350))).toBeNull();
    c.setSafety({ draft: 2.2, clearance: 40 });
    expect(c.hazardAt(east(-350))).toBe('shallow');
  });
});

describe('rasterising', () => {
  it('fills polygons with holes and strokes piers', () => {
    const g = emptyGrid({ south: 0, west: 0, north: 0.001, east: 0.001 }, 10);
    const sq = (a: number, b: number) => [{ x: a, y: a }, { x: b, y: a }, { x: b, y: b }, { x: a, y: b }];
    fillPolygon(g, [sq(1, 9), sq(4, 6)], 1);
    const at = (i: number, j: number) => g.water[j * g.w + i];
    expect(at(2, 2)).toBe(1);
    expect(at(5, 5)).toBe(0); // the hole
    expect(at(0, 0)).toBe(0);
    strokeLine(g, [{ x: 2.5, y: 1.5 }, { x: 2.5, y: 8.5 }], 0);
    expect(at(2, 7)).toBe(0);
    expect(at(3, 7)).toBe(1);
  });

  it('parses the EMODnet text grid', () => {
    const d = parseDepthGrid('Grid bounds: GeneralBounds[(14.4, 44.95), (14.43, 44.97)]\nGrid CRS: x\nContents:\nBand 0:\n-1.5 -2 3\n-4 -5 6\n')!;
    expect(d).toMatchObject({ west: 14.4, south: 44.95, east: 14.43, north: 44.97 });
    expect(d.rows).toEqual([[-1.5, -2, 3], [-4, -5, 6]]);
  });
});

describe('findRoute', () => {
  it('goes straight when the water is open', () => {
    const c = new Chart(sea(), safety);
    expect(findRoute(c, start, east(1500), 12, 0)).toEqual([start, east(1500)]);
  });

  it('goes around an island in the way, with every piece clear', () => {
    const g = sea();
    paint(g, 500, -300, 900, 600, 'land');
    const c = new Chart(g, safety);
    const to = east(1500);
    const r = findRoute(c, start, to, 12, 0)!;
    expect(r.length).toBeGreaterThan(2);
    for (let n = 1; n < r.length; n++) expect(c.clear(r[n - 1], r[n], [start, to])).toBe(true);
  });

  it('gives up when the mark is walled off', () => {
    const g = sea();
    paint(g, 800, -2100, 900, 2100, 'land');
    expect(findRoute(new Chart(g, safety), start, east(1500), 12, 0)).toBeNull();
  });

  it('avoids shallows too', () => {
    const g = sea();
    paint(g, 500, -300, 900, 600, 0.8);
    const c = new Chart(g, safety);
    const leg = routeLeg(c, start, east(1500), 12, 0);
    expect(leg.blocked).toBe(false);
    expect(leg.waypoints.length).toBeGreaterThan(2);
    for (let n = 1; n < leg.path.length; n++) expect(c.firstHazard(leg.path[n - 1], leg.path[n])).toBeNull();
  });
});

describe('sailLeg', () => {
  it('puts the tack on the side that has water', () => {
    // Beat 1 km north with land 150 m to the west: the corner must go out east.
    const g = sea();
    paint(g, -2000, -2000, -150, 2000, 'land');
    const c = new Chart(g, safety);
    const to = north(1000);
    expect(sailLeg(null, start, to, 12, 0).manoeuvres).toBe(1);
    const safe = sailLeg(c, start, to, 12, 0);
    expect(safe.manoeuvres).toBe(1);
    for (let n = 1; n < safe.path.length; n++) expect(c.clear(safe.path[n - 1], safe.path[n], [start, to])).toBe(true);
    expect(safe.path[1].lng).toBeGreaterThan(start.lng);
  });

  it('short-tacks up a narrow channel', () => {
    const g = sea();
    paint(g, -2000, -2000, -150, 2000, 'land');
    paint(g, 150, -2000, 2000, 2000, 'land');
    const c = new Chart(g, { draft: 1.5, clearance: 20 });
    const to = north(1500);
    const leg = sailLeg(c, start, to, 12, 0);
    expect(leg.manoeuvres).toBeGreaterThan(2);
    expect(leg.tight).toBe(false);
    for (let n = 1; n < leg.path.length; n++) expect(c.clear(leg.path[n - 1], leg.path[n], [start, to])).toBe(true);
    expect(leg.time).toBeGreaterThan(sailLeg(null, start, to, 12, 0).time);
  });
});

describe('advise with a chart', () => {
  it('tacks before the shore instead of sailing on to the layline', () => {
    const mark = north(1852);
    const free = advise(start, 320, 12, 0, mark); // starboard, heading NW
    expect(free.action).toBe('hold');
    const g = sea();
    paint(g, -2000, -2000, -250, 2000, 'land');
    const c = new Chart(g, safety);
    const a = advise(start, 320, 12, 0, mark, c);
    expect(a.action).toBe('hold');
    expect(a.turn!.time).toBeLessThan(free.turn!.time);
    expect(c.clear(start, a.turn!.at)).toBe(true);
  });

  it('tacks within seconds when already close to the shore', () => {
    // Inside the 40 m margin, heading in: don't get any closer (to the grid's 20 m resolution).
    const g = sea();
    paint(g, -2000, -2000, -25, 2000, 'land');
    const c = new Chart(g, safety);
    const a = advise(start, 320, 12, 0, north(1852), c);
    expect(a.action === 'tack' || a.turn!.time < 15).toBe(true);
    if (a.turn) expect(c.firstHazard(start, a.turn.at)).toBeNull();
    // ...but the boat may still sail away from the shore.
    expect(c.clear(start, east(300), [start])).toBe(true);
  });

  it('calls the tack now when the bow is at the margin', () => {
    const g = sea();
    paint(g, -2000, -2000, -50, 2000, 'land');
    const c = new Chart(g, safety);
    const near = offset(start, 320, 20); // ~ 35 m off, heading in
    expect(advise(near, 320, 12, 0, north(1852), c).action).toBe('tack');
  });
});

describe('racing a course with land and shallows in the way', () => {
  // The app's navigator loop: steer for the furthest waypoint in sight, re-plan when lost,
  // let advise() place the tacks. The boat must get round without touching anything.
  function race(c: Chart, from: LatLng, to: LatLng, twd: number) {
    const pts = polar(12);
    let route = routeLeg(c, from, to, 12, twd).waypoints;
    let wp = 1;
    let pos = from;
    let heading = 0;
    for (let t = 0; t < 3 * 3600; t += 2) {
      if (distance(pos, to) < 30) return { arrived: true, aground: false };
      const next = nextWaypoint(c, pos, route, wp, to);
      wp = next.wp;
      if (next.lost) {
        const r = findRoute(c, pos, to, 12, twd);
        if (r) [route, wp] = [r, 1];
      }
      heading = advise(pos, heading, 12, twd, route[wp], c, [to]).board.heading;
      pos = offset(pos, heading, polarLookup(pts, norm180(twd - heading)).speed * KN * 2);
      if (c.hazardAt(pos) && distance(pos, to) > 50) return { arrived: false, aground: true };
    }
    return { arrived: false, aground: false };
  }

  it('gets round in any wind', () => {
    const g = sea();
    paint(g, 400, -500, 800, 300, 'land'); // island across the rhumb line
    paint(g, 1000, 200, 1300, 700, 1.0); // shoal off the far side
    const c = new Chart(g, safety);
    const from = offset(start, 200, 300);
    const to = offset(start, 70, 1700);
    for (const twd of [0, 45, 90, 135, 180, 225, 270, 315]) {
      expect({ twd, ...race(c, from, to, twd) }).toEqual({ twd, arrived: true, aground: false });
    }
  });
});
