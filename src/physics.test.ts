import { describe, expect, it } from 'vitest';
import { optimizeTrim, planCourse, polar, simulate } from './physics';

describe('simulate', () => {
  it('stays in irons when pointing into the wind', () => {
    expect(simulate(12, 0, { main: 0, jib: 0 }).speed).toBe(0);
    expect(optimizeTrim(12, 20).state.speed).toBe(0);
  });

  it('is symmetric between tacks', () => {
    const t = { main: 30, jib: 30 };
    expect(simulate(12, 70, t).speed).toBeCloseTo(simulate(12, -70, t).speed, 6);
  });

  it('flags a sheeted-in sail on a run as over-trimmed', () => {
    const s = simulate(12, 170, { main: 5, jib: 10 });
    expect(s.main.status).toBe('over-trimmed');
  });

  it('marks the optimal trim as trimmed', () => {
    const { state } = optimizeTrim(12, 90);
    expect(state.main.status).toBe('trimmed');
    expect(state.speed).toBeGreaterThan(5);
    expect(state.speed).toBeLessThan(8);
  });
});

describe('polar', () => {
  it('reaches faster than it beats, and more wind is never slower', () => {
    const p = polar(12);
    const at = (twa: number) => p.find((x) => x.twa === twa)!.speed;
    expect(at(90)).toBeGreaterThan(at(44));
    for (const twa of [50, 90, 150]) {
      expect(polar(18).find((x) => x.twa === twa)!.speed).toBeGreaterThanOrEqual(at(twa));
    }
  });

  it('eases sheets as the wind goes aft', () => {
    const p = polar(12);
    const at = (twa: number) => p.find((x) => x.twa === twa)!.trim.main;
    expect(at(50)).toBeLessThan(at(90));
    expect(at(90)).toBeLessThan(at(180));
  });
});

describe('planCourse', () => {
  it('tacks dead upwind on both tacks with equal time', () => {
    const plan = planCourse(12, 0, 0);
    expect(plan.strategy).toBe('beat');
    const [a, b] = plan.boards;
    expect(Math.sign(a.twa)).not.toBe(Math.sign(b.twa));
    expect(a.fraction).toBeCloseTo(0.5, 1);
    expect(plan.vmc).toBeGreaterThan(0);
  });

  it('sails a beam reach directly', () => {
    const plan = planCourse(12, 270, 0);
    expect(plan.strategy).toBe('direct');
    expect(plan.boards[0].heading).toBe(0);
  });
});
