import { describe, expect, it } from 'vitest';
import { CM_TO_WU } from './contracts';
import {
  BLEND_MS,
  GOVERNOR_DEMOTE_MS,
  GOVERNOR_HOLD_MS,
  GOVERNOR_PROMOTE_MS,
  STABILITY_MS,
  createLod,
  criteriaTier,
  medianLengthPx,
  select,
} from './lod';
import type { LodInputs } from './lod';
import type { LodTier } from './contracts';

const MEDIAN_CM = 12;

/** px/wu that puts the median animal at exactly `lengthPx` on screen. */
function zoomFor(lengthPx: number): number {
  return lengthPx / (MEDIAN_CM * CM_TO_WU);
}

function inputs(over: Partial<LodInputs> = {}): LodInputs {
  return {
    nowMs: 0,
    pxPerWu: zoomFor(60),
    visibleCount: 100,
    speedMultiplier: 1,
    renderMsEma: 4,
    medianSizeCm: MEDIAN_CM,
    ...over,
  };
}

describe('criteria boundaries', () => {
  it('reads the median length in screen pixels', () => {
    expect(medianLengthPx(inputs({ pxPerWu: 2 }))).toBeCloseTo(MEDIAN_CM * CM_TO_WU * 2, 9);
  });

  it('places each tier on its documented entry criteria', () => {
    expect(criteriaTier(inputs({ pxPerWu: zoomFor(40) }))).toBe('near');
    expect(criteriaTier(inputs({ pxPerWu: zoomFor(39.9) }))).toBe('mid');
    expect(criteriaTier(inputs({ pxPerWu: zoomFor(10) }))).toBe('mid');
    expect(criteriaTier(inputs({ pxPerWu: zoomFor(9.9) }))).toBe('far');
    expect(criteriaTier(inputs({ pxPerWu: zoomFor(3) }))).toBe('far');
    expect(criteriaTier(inputs({ pxPerWu: zoomFor(2.9) }))).toBe('abyss');
  });

  it('demotes on crowd and on watch speed, not only on zoom', () => {
    const big = { pxPerWu: zoomFor(400) };
    expect(criteriaTier(inputs({ ...big, visibleCount: 250 }))).toBe('near');
    expect(criteriaTier(inputs({ ...big, visibleCount: 251 }))).toBe('mid');
    expect(criteriaTier(inputs({ ...big, visibleCount: 1501 }))).toBe('far');
    expect(criteriaTier(inputs({ ...big, speedMultiplier: 16 }))).toBe('near');
    expect(criteriaTier(inputs({ ...big, speedMultiplier: 17 }))).toBe('mid');
    expect(criteriaTier(inputs({ ...big, speedMultiplier: 65 }))).toBe('far');
  });

  it('biases the thresholds by the hysteresis fraction', () => {
    // Just inside the nominal near band, but not by the 15% a promotion wants.
    expect(criteriaTier(inputs({ pxPerWu: zoomFor(42) }), 1.15)).toBe('mid');
    expect(criteriaTier(inputs({ pxPerWu: zoomFor(42) }), 0.85)).toBe('near');
  });
});

describe('tier switching', () => {
  it('waits out the stability window before committing a promotion', () => {
    const lod = createLod(0, 'far');
    const near = { pxPerWu: zoomFor(80) };
    expect(select(lod, inputs({ ...near, nowMs: 0 })).tier).toBe('far');
    expect(select(lod, inputs({ ...near, nowMs: STABILITY_MS - 1 })).tier).toBe('far');
    expect(select(lod, inputs({ ...near, nowMs: STABILITY_MS })).tier).toBe('near');
  });

  it('does not flap when the input jitters across a boundary', () => {
    const lod = createLod(0, 'mid');
    let now = 0;
    for (let step = 0; step < 400; step += 1) {
      now += 16;
      // ±10% around the near boundary — inside the 15% band on both sides.
      const wobble = 40 * (1 + 0.1 * Math.sin(step * 0.7));
      select(lod, inputs({ nowMs: now, pxPerWu: zoomFor(wobble) }));
      expect(lod.tier).toBe('mid');
      expect(lod.previousTier).toBeNull();
    }
  });

  it('cross-fades for exactly the blend window', () => {
    const lod = createLod(0, 'far');
    const near = { pxPerWu: zoomFor(80) };
    select(lod, inputs({ ...near, nowMs: 0 }));
    select(lod, inputs({ ...near, nowMs: STABILITY_MS }));
    expect(lod.tier).toBe('near');
    expect(lod.previousTier).toBe('far');
    expect(lod.blend).toBe(0);

    select(lod, inputs({ ...near, nowMs: STABILITY_MS + BLEND_MS / 2 }));
    expect(lod.previousTier).toBe('far');
    expect(lod.blend).toBeCloseTo(0.5, 6);

    select(lod, inputs({ ...near, nowMs: STABILITY_MS + BLEND_MS }));
    expect(lod.previousTier).toBeNull();
    expect(lod.blend).toBe(1);
  });
});

describe('frame-time governor', () => {
  /** A zoom whose criteria tier is solidly 'mid', so only the governor moves the tier. */
  const midZoom = { pxPerWu: zoomFor(20) };

  it('demotes immediately, then holds for the dwell before demoting again', () => {
    const lod = createLod(0, 'mid');
    const slow = { ...midZoom, renderMsEma: 15 };

    select(lod, inputs({ ...slow, nowMs: 0 }));
    expect(lod.tier).toBe('far');
    expect(lod.penalty).toBe(1);

    for (let now = 100; now < GOVERNOR_HOLD_MS; now += 100) {
      select(lod, inputs({ ...slow, nowMs: now }));
      expect(lod.tier).toBe('far');
    }

    select(lod, inputs({ ...slow, nowMs: GOVERNOR_HOLD_MS }));
    expect(lod.tier).toBe('abyss');
    expect(lod.penalty).toBe(2);
  });

  it('keeps the criteria tier intact underneath the penalty', () => {
    const lod = createLod(0, 'mid');
    select(lod, inputs({ ...midZoom, nowMs: 0, renderMsEma: 15 }));
    expect(lod.tier).toBe('far');
    expect(lod.criteria).toBe('mid');
  });

  /**
   * Closed-loop: the frame cost is a function of the tier, which is what makes
   * the limit cycle possible. The promote decision is taken from inside the
   * cheap tier, so without a memory the governor keeps concluding that the
   * expensive tier is affordable, walking back into it and stuttering.
   */
  function simulate(costOf: (tier: LodTier, nowMs: number) => number, durationMs: number) {
    // A zoom whose criteria tier is 'near', so the governor is the only thing
    // that can push detail down and the loop is isolated.
    const nearZoom = { pxPerWu: zoomFor(80) };
    const lod = createLod(0, 'near');
    let ema = costOf('near', 0);
    let now = 0;
    let promotionsIntoNear = 0;
    let framesOverBudget = 0;
    let framesInNear = 0;
    let frames = 0;
    while (now < durationMs) {
      now += 16;
      frames += 1;
      // The EMA is the shell's, so the cost of a tier switch is felt gradually.
      ema = ema * 0.9 + costOf(lod.tier, now) * 0.1;
      const before = lod.tier;
      select(lod, inputs({ ...nearZoom, nowMs: now, renderMsEma: ema }));
      if (lod.tier === 'near' && before !== 'near') promotionsIntoNear += 1;
      if (ema > GOVERNOR_DEMOTE_MS) framesOverBudget += 1;
      if (lod.tier === 'near') framesInNear += 1;
    }
    return {
      lod,
      promotionsIntoNear,
      ema,
      overBudgetFraction: framesOverBudget / frames,
      nearFraction: framesInNear / frames,
    };
  }

  it('does not limit-cycle back into a tier it cannot afford', () => {
    // near is hopeless (17 ms); everything below it is nearly free. Before the
    // memory this oscillated forever at roughly one round trip every 5.5 s.
    const expensiveNear = (tier: LodTier): number => (tier === 'near' ? 17 : 0.4);
    const run = simulate(expensiveNear, 60_000);

    // Occasional probes as the backoff widens are the design; a cycle is not.
    // Ungoverned this oscillated every ~5 s: 12 promotions and a third of every
    // frame budget blown. The probe interval doubles, so the count is bounded.
    expect(run.promotionsIntoNear).toBeLessThanOrEqual(4);
    expect(run.overBudgetFraction).toBeLessThan(0.15);
    expect(run.nearFraction).toBeLessThan(0.25);
  });

  it('still returns to a tier once the world genuinely becomes cheap', () => {
    // The same hopeless near tier, until a die-off at 30 s makes it affordable.
    const relenting = (tier: LodTier, nowMs: number): number =>
      tier === 'near' ? (nowMs < 30_000 ? 17 : 2) : 0.4;
    const run = simulate(relenting, 90_000);

    // The backoff must not become a life sentence: once near is affordable the
    // next probe finds it and stays.
    expect(run.lod.tier).toBe('near');
    expect(run.ema).toBeLessThan(GOVERNOR_PROMOTE_MS);
    expect(run.nearFraction).toBeGreaterThan(0.5);
  });

  it('does not distrust a tier that was dropped for being too small to see', () => {
    const lod = createLod(0, 'near');
    // Cheap frames throughout: the demotion here is criteria-driven (zoom out),
    // which must not count against the tier's reputation.
    for (let now = 0; now <= 2000; now += 100) {
      select(lod, inputs({ nowMs: now, pxPerWu: zoomFor(4), renderMsEma: 2 }));
    }
    expect(lod.tier).toBe('far');
    expect(lod.rememberedCost.near).toBe(0);
    expect(lod.failures.near).toBe(0);
  });

  it('only promotes after the frame cost has been good for the sustain window', () => {
    const lod = createLod(0, 'mid');
    select(lod, inputs({ ...midZoom, nowMs: 0, renderMsEma: 15 }));
    expect(lod.tier).toBe('far');

    // Between the two thresholds is not "good": it keeps resetting the timer.
    for (let now = 100; now <= 6000; now += 100) {
      select(lod, inputs({ ...midZoom, nowMs: now, renderMsEma: 9 }));
    }
    expect(lod.tier).toBe('far');

    let now = 6000;
    let promotedAt = 0;
    while (now < 20_000 && promotedAt === 0) {
      now += 100;
      select(lod, inputs({ ...midZoom, nowMs: now, renderMsEma: 3 }));
      if (lod.penalty === 0) promotedAt = now;
    }
    expect(promotedAt).toBeGreaterThanOrEqual(6000 + 3000);
    expect(lod.tier).toBe('mid');
  });
});
