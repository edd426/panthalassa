/**
 * The divergence maths, pinned.
 *
 * These are the properties that make the caricature a *measurement* rather than
 * a decoration: if amplification can reorder two animals, or leave the schema
 * range, or move discontinuously, then a watcher reading the picture is reading
 * something the sim did not say. Each one is cheap to assert and none of them
 * needs a GPU.
 */

import { describe, expect, it } from 'vitest';
import { CLADE_ARCHETYPES, CLADE_SCHEMA } from '../../contracts/genome';
import {
  ASPECT_BUCKETS,
  CARICATURE_GAIN,
  FLIPBOOK_VARIANTS,
  HEAD_BUCKETS,
  PATTERN_BUCKETS,
  PATTERN_FAMILIES,
  amplifiedBodyAspect,
  amplifiedFinPairs,
  amplifiedSegments,
  aspectBucketFor,
  aspectForBucket,
  caricature,
  decodeFlipbookVariant,
  flipbookVariantIndex,
  headBucketFor,
  headFormForBucket,
  headFormFromDiet,
  patternBucketFor,
  patternFamilyFor,
  patternFamilyForBucket,
  patternPhaseFor,
  spinationFrom,
} from './divergence';

/** The three schema ranges, plus a symmetric one and a degenerate one. */
const RANGES: readonly (readonly [number, number, number])[] = [
  [8, 4, 20],
  [2, 0, 6],
  [3.2, 1.2, 9],
  [1.1, 0.6, 3],
  [0, -1, 1],
  [5, 5, 5],
];

describe('caricature amplification', () => {
  it('is the identity at the typical, exactly', () => {
    for (const [typical, low, high] of RANGES) {
      expect(caricature(typical, typical, low, high)).toBe(typical);
    }
  });

  it('preserves sign: a longer-bodied animal never draws shorter than its archetype-mate', () => {
    for (const [typical, low, high] of RANGES) {
      if (high === low) continue;
      for (let step = 1; step <= 40; step += 1) {
        const above = typical + ((high - typical) * step) / 40;
        const below = typical - ((typical - low) * step) / 40;
        expect(caricature(above, typical, low, high)).toBeGreaterThan(typical);
        expect(caricature(below, typical, low, high)).toBeLessThan(typical);
      }
    }
  });

  it('is monotone across the whole range, and beyond it', () => {
    for (const [typical, low, high] of RANGES) {
      let previous = -Infinity;
      for (let step = -10; step <= 60; step += 1) {
        const value = low + ((high - low) * step) / 50;
        const drawn = caricature(value, typical, low, high);
        expect(drawn, `typical=${typical} value=${value}`).toBeGreaterThanOrEqual(previous);
        previous = drawn;
      }
    }
  });

  it('never leaves the renderRange, however wild the trait gets', () => {
    for (const [typical, low, high] of RANGES) {
      for (const value of [-1e9, -50, low, high, 50, 1e9, Number.MAX_SAFE_INTEGER]) {
        const drawn = caricature(value, typical, low, high);
        expect(drawn).toBeGreaterThanOrEqual(Math.min(low, typical));
        expect(drawn).toBeLessThanOrEqual(Math.max(high, typical));
      }
      // The edges map to the edges: saturation, not compression of the range.
      if (high > low) {
        expect(caricature(high, typical, low, high)).toBeCloseTo(high, 12);
        expect(caricature(low, typical, low, high)).toBeCloseTo(low, 12);
      }
    }
  });

  it('amplifies near the typical and saturates near the edge', () => {
    // The whole point: a realised CV of 6-10% has to survive to the screen.
    const [typical, low, high] = [3.2, 1.2, 9] as const;
    const small = 0.08 * (high - typical);
    const drawnSmall = caricature(typical + small, typical, low, high) - typical;
    expect(drawnSmall / small).toBeGreaterThan(2.5);
    // Gain falls monotonically as the deviation grows; it is 1 at the edge.
    let previousGain = Infinity;
    for (let step = 1; step <= 20; step += 1) {
      const deviation = ((high - typical) * step) / 20;
      const gain = (caricature(typical + deviation, typical, low, high) - typical) / deviation;
      expect(gain).toBeLessThanOrEqual(previousGain + 1e-12);
      expect(gain).toBeGreaterThanOrEqual(1 - 1e-12);
      previousGain = gain;
    }
    expect(previousGain).toBeCloseTo(1, 12);
  });

  it('is smooth through the typical, even where the range is asymmetric', () => {
    // 3.2 sits 2 above the floor and 5.8 below the ceiling; a naive two-sided
    // rule kinks there, and a kink is a visible pop as a lineage drifts past.
    const [typical, low, high] = [3.2, 1.2, 9] as const;
    const eps = 1e-6;
    const slopeAbove = (caricature(typical + eps, typical, low, high) - typical) / eps;
    const slopeBelow = (typical - caricature(typical - eps, typical, low, high)) / eps;
    expect(slopeAbove).toBeCloseTo(slopeBelow, 6);
    expect(slopeAbove).toBeCloseTo(CARICATURE_GAIN / Math.tanh(CARICATURE_GAIN), 4);
  });

  it('collapses to the typical when the schema leaves it no room', () => {
    expect(caricature(9, 5, 5, 5)).toBe(5);
    expect(caricature(1, 5, 5, 5)).toBe(5);
  });

  it('holds the three schema channels inside their own archetype ranges', () => {
    for (const archetype of CLADE_ARCHETYPES) {
      const schema = CLADE_SCHEMA[archetype];
      for (const value of [-100, 0, 1, 5, 100]) {
        const [segLow, segHigh] = schema.segmentCount.renderRange;
        const [finLow, finHigh] = schema.finPairs.renderRange;
        const [aspectLow, aspectHigh] = schema.bodyAspect.renderRange;
        expect(amplifiedSegments(archetype, value)).toBeGreaterThanOrEqual(segLow);
        expect(amplifiedSegments(archetype, value)).toBeLessThanOrEqual(segHigh);
        expect(amplifiedFinPairs(archetype, value)).toBeGreaterThanOrEqual(finLow);
        expect(amplifiedFinPairs(archetype, value)).toBeLessThanOrEqual(finHigh);
        expect(amplifiedBodyAspect(archetype, value)).toBeGreaterThanOrEqual(aspectLow);
        expect(amplifiedBodyAspect(archetype, value)).toBeLessThanOrEqual(aspectHigh);
      }
      expect(amplifiedSegments(archetype, schema.segmentCount.typical)).toBe(schema.segmentCount.typical);
    }
  });
});

describe('diet → head form', () => {
  it('is odd, bounded and zero at diet 0', () => {
    expect(headFormFromDiet(0)).toBe(0);
    for (const diet of [0.3, 1, 1.5, 4, 40]) {
      expect(headFormFromDiet(-diet)).toBeCloseTo(-headFormFromDiet(diet), 12);
      expect(Math.abs(headFormFromDiet(diet))).toBeLessThanOrEqual(1);
    }
    // Strictly inside the axis anywhere a run actually goes; only a diet far
    // past that saturates to exactly 1 in float64, which is the correct limit.
    for (const diet of [0.3, 1, 1.5, 4]) expect(Math.abs(headFormFromDiet(diet))).toBeLessThan(1);
    expect(headFormFromDiet(1e9)).toBeCloseTo(1, 12);
  });

  it('is continuous and strictly increasing across the sign change', () => {
    let previous = -Infinity;
    let worstStep = 0;
    for (let step = -200; step <= 200; step += 1) {
      const value = headFormFromDiet(step / 100);
      expect(value).toBeGreaterThan(previous);
      if (previous > -Infinity) worstStep = Math.max(worstStep, value - previous);
      previous = value;
    }
    // No jump anywhere, including at 0: a 0.01-logit step moves head form by
    // at most a hundredth of the axis.
    expect(worstStep).toBeLessThan(0.01);
  });

  it('uses most of the axis at the diet spread a run actually reaches', () => {
    // Population means reach +/-1.5 logits; if that mapped to +/-0.2 the channel
    // would be plumbed and still invisible, which is the bug being fixed.
    expect(headFormFromDiet(1.5)).toBeGreaterThan(0.8);
    expect(headFormFromDiet(0.7)).toBeGreaterThan(0.5);
  });
});

describe('defense → spination', () => {
  it('leaves a lightly defended animal smooth and saturates a heavily defended one', () => {
    expect(spinationFrom(0, 0)).toBe(0);
    expect(spinationFrom(0.3, 0.35)).toBeLessThan(0.05);
    expect(spinationFrom(3, 1.15)).toBeGreaterThan(0.9);
    expect(spinationFrom(1e6, 1e6)).toBeCloseTo(1, 12);
  });

  it('is monotone in both inputs and never negative', () => {
    let previous = -1;
    for (let step = 0; step <= 60; step += 1) {
      const value = spinationFrom(step / 10, 0.35);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      previous = value;
    }
    expect(spinationFrom(2, 2)).toBeGreaterThan(spinationFrom(2, 0));
    // A negative decode is a floor, not a negative spine.
    expect(spinationFrom(-5, -5)).toBe(0);
  });

  it('lets armour push an undulator onto the serrated end, which is the point', () => {
    // Before this, armorPlating only did anything on a crawler.
    expect(spinationFrom(1, 2.5)).toBeGreaterThan(spinationFrom(1, 0));
  });
});

describe('species patterning', () => {
  it('gives the same species the same family, every time it is asked', () => {
    for (let tag = 1; tag <= 40; tag += 1) {
      const first = patternFamilyFor(tag, 0.11);
      for (const jitter of [0, 0.25, 0.5, 0.75, 0.999]) {
        expect(patternFamilyFor(tag, jitter), `tag=${tag} jitter=${jitter}`).toBe(first);
      }
      // Rounding, not truncation: the tag arrives as a float out of the stride.
      expect(patternFamilyFor(tag + 0.4, 0.5)).toBe(first);
      expect(patternFamilyFor(tag - 0.4, 0.5)).toBe(first);
    }
  });

  it('spreads species across all four families rather than favouring one', () => {
    const seen = new Map<string, number>();
    for (let tag = 1; tag <= 200; tag += 1) {
      const family = patternFamilyFor(tag, 0.5);
      seen.set(family, (seen.get(family) ?? 0) + 1);
    }
    expect(seen.size).toBe(PATTERN_FAMILIES.length);
    for (const count of seen.values()) expect(count).toBeGreaterThan(30);
  });

  it('falls back to the slot jitter before the stats layer has assigned a species', () => {
    // Tag 0 is "unclassified", and it is what a founder population is made of;
    // keying it on the tag alone would leave every founder wearing nothing.
    const families = new Set<string>();
    for (let step = 0; step < 64; step += 1) families.add(patternFamilyFor(0, step / 64));
    expect(families.size).toBeGreaterThan(1);
    // Still stable: the same slot jitter always gives the same family.
    expect(patternFamilyFor(0, 0.3)).toBe(patternFamilyFor(0, 0.3));
  });

  it('clamps the mark phase into the unit interval', () => {
    expect(patternPhaseFor(-3)).toBe(0);
    expect(patternPhaseFor(0.42)).toBe(0.42);
    expect(patternPhaseFor(9)).toBe(1);
  });
});

describe('flipbook bucketing', () => {
  it('round-trips every variant index', () => {
    expect(FLIPBOOK_VARIANTS).toBe(ASPECT_BUCKETS * HEAD_BUCKETS * PATTERN_BUCKETS);
    for (let variant = 0; variant < FLIPBOOK_VARIANTS; variant += 1) {
      const decoded = decodeFlipbookVariant(variant);
      expect(flipbookVariantIndex(decoded.aspectBucket, decoded.headBucket, decoded.patternBucket)).toBe(variant);
      expect(decoded.aspectBucket).toBeLessThan(ASPECT_BUCKETS);
      expect(decoded.headBucket).toBeLessThan(HEAD_BUCKETS);
      expect(decoded.patternBucket).toBeLessThan(PATTERN_BUCKETS);
    }
  });

  it('keeps an out-of-range bucket inside the texture array', () => {
    // The index is a texture lookup; a stray one is a blank animal, not a throw.
    expect(flipbookVariantIndex(-5, -5, -5)).toBe(0);
    expect(flipbookVariantIndex(99, 99, 99)).toBe(FLIPBOOK_VARIANTS - 1);
    expect(decodeFlipbookVariant(-1)).toEqual(decodeFlipbookVariant(0));
    expect(decodeFlipbookVariant(999)).toEqual(decodeFlipbookVariant(FLIPBOOK_VARIANTS - 1));
  });

  it('covers every archetype range with all its buckets, monotonically and without gaps', () => {
    for (const archetype of CLADE_ARCHETYPES) {
      const [low, high] = CLADE_SCHEMA[archetype].bodyAspect.renderRange;
      expect(aspectBucketFor(archetype, low)).toBe(0);
      expect(aspectBucketFor(archetype, low - 100)).toBe(0);
      expect(aspectBucketFor(archetype, high)).toBe(ASPECT_BUCKETS - 1);
      expect(aspectBucketFor(archetype, high + 100)).toBe(ASPECT_BUCKETS - 1);
      // Non-decreasing, one step at a time, and every bucket is reached. The
      // exact aspect a boundary lands on is float noise and is deliberately not
      // asserted — either side of it is a legitimate answer, and pinning it
      // would be a test of `Math.log`'s last bit rather than of the bucketing.
      let previous = 0;
      const seen = new Set<number>([0]);
      for (let step = 0; step <= 2000; step += 1) {
        const aspect = low + ((high - low) * step) / 2000;
        const bucket = aspectBucketFor(archetype, aspect);
        expect(bucket).toBeGreaterThanOrEqual(previous);
        expect(bucket - previous).toBeLessThanOrEqual(1);
        seen.add(bucket);
        previous = bucket;
      }
      expect(seen.size, archetype).toBe(ASPECT_BUCKETS);
      // Every bake sits inside the band it stands for.
      for (let bucket = 0; bucket < ASPECT_BUCKETS; bucket += 1) {
        expect(aspectBucketFor(archetype, aspectForBucket(archetype, bucket))).toBe(bucket);
        expect(aspectForBucket(archetype, bucket)).toBeGreaterThanOrEqual(low);
        expect(aspectForBucket(archetype, bucket)).toBeLessThanOrEqual(high);
      }
    }
  });

  it('bounds the mid-tier squash, which is the reason the aspect buckets exist', () => {
    // One bake per archetype meant squashing an eel's sprite to 0.36 of its
    // baked width. Bucketing has to keep that correction near 1 or the mid tier
    // draws crushed heads and fins. The bound is `exp(ln(high/low) / 2N)` for
    // the widest range (the undulator's 1.2–9), which is 1.40.
    for (const archetype of CLADE_ARCHETYPES) {
      const [low, high] = CLADE_SCHEMA[archetype].bodyAspect.renderRange;
      let worst = 1;
      for (let step = 0; step <= 1000; step += 1) {
        const aspect = low + ((high - low) * step) / 1000;
        const squash = aspectForBucket(archetype, aspectBucketFor(archetype, aspect)) / aspect;
        worst = Math.max(worst, squash, 1 / squash);
      }
      expect(worst, archetype).toBeLessThan(1.45);
    }
  });

  it('splits head form at diet 0 and bakes inside each band', () => {
    expect(headBucketFor(-0.001)).toBe(0);
    expect(headBucketFor(0)).toBe(1);
    expect(headBucketFor(1)).toBe(1);
    expect(headFormForBucket(0)).toBeLessThan(0);
    expect(headFormForBucket(1)).toBeGreaterThan(0);
    for (const bucket of [0, 1]) {
      expect(Math.abs(headFormForBucket(bucket))).toBeLessThan(1);
      expect(headBucketFor(headFormForBucket(bucket))).toBe(bucket);
    }
  });

  it('buckets a pattern family by whether it breaks the outline', () => {
    expect(patternBucketFor('none')).toBe(0);
    expect(patternBucketFor('countershading')).toBe(0);
    expect(patternBucketFor('stripes')).toBe(1);
    expect(patternBucketFor('spots')).toBe(1);
    for (const bucket of [0, 1]) {
      expect(patternBucketFor(patternFamilyForBucket(bucket))).toBe(bucket);
    }
  });
});
