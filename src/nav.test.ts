import { describe, expect, it } from 'vitest';
import { advise, steerHint } from './nav';
import { KN, planCourse, norm180 } from './physics';
import { bearing, offset } from './geo';

const start = { lat: 45.8, lng: 10.85 };
const mark = offset(start, 0, 1852); // 1 nm dead upwind (wind from N)

describe('advise', () => {
  it('holds the current tack and calls the tack on the layline', () => {
    const a = advise(start, 320, 12, 0, mark); // starboard tack
    expect(a.action).toBe('hold');
    expect(a.board.twa).toBeGreaterThan(0);
    expect(a.next!.twa).toBeLessThan(0);
    expect(a.turn!.kind).toBe('tack');
    // From the tack point the mark lies exactly on the other board's heading.
    expect(Math.abs(norm180(bearing(a.turn!.at, mark) - a.next!.heading))).toBeLessThan(1);
    expect(a.eta).toBeGreaterThan(a.turn!.time);
  });

  it('keeps whichever tack the boat is on', () => {
    expect(advise(start, 40, 12, 0, mark).board.twa).toBeLessThan(0); // port tack
  });

  it('says tack now once on the layline', () => {
    const port = advise(start, 40, 12, 0, mark).board; // port-tack layline into the mark
    const onLayline = offset(mark, port.heading + 180, 800);
    const a = advise(onLayline, 320, 12, 0, mark);
    expect(a.action).toBe('tack');
    expect(a.board.heading).toBeCloseTo(port.heading, 0);
  });

  it('does not call the tack early as the layline approaches', () => {
    const a = advise(start, 320, 12, 0, mark);
    const v = a.board.speed * KN;
    const near = offset(start, a.board.heading, v * (a.turn!.time - 20));
    const b = advise(near, a.board.heading, 12, 0, mark);
    expect(b.action).toBe('hold');
    expect(b.turn!.time).toBeGreaterThan(15);
    expect(b.turn!.time).toBeLessThan(25);
    const at = offset(start, a.board.heading, v * a.turn!.time);
    expect(advise(at, a.board.heading, 12, 0, mark).action).toBe('tack');
  });

  it('sails direct when the mark is fetchable', () => {
    const a = advise(start, 0, 12, 270, mark);
    expect(a.action).toBe('direct');
    expect(a.steer).toBe(0);
  });
});

describe('planCourse with tack loss', () => {
  it('only tacks when the gain outweighs the time lost tacking', () => {
    expect(planCourse(12, 0, 36, 200).strategy).toBe('direct');
    expect(planCourse(12, 0, 36, 20000).strategy).toBe('beat');
    expect(planCourse(12, 0, 0, 200).loss).toBeGreaterThan(0);
  });
});

describe('steerHint', () => {
  it('heads up towards the wind, bears away from it', () => {
    expect(steerHint(-5, 50, 0)).toBe('Head up 5°');
    expect(steerHint(5, 50, 0)).toBe('Bear away 5°');
    expect(steerHint(1, 50, 0)).toBe('On target');
  });
});
