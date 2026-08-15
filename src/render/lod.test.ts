import { describe, expect, it } from 'vitest';
import { CM_TO_WU } from './contracts';
import {
  BLEND_MS,
  GOVERNOR_HOLD_MS,
  STABILITY_MS,
  createLod,
  criteriaTier,
  medianLengthPx,
  select,
} from './lod';
import type { LodInputs } from './lod';

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
