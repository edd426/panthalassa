/**
 * The seam's own pure helpers (G5).
 *
 * These are the two centring guarantees the whole G-wave render arm rests on:
 * an animal at `conspicuousness` 0 and `lifeStage` 1 must reach every consumer
 * as the neutral pair, because that is the state the previous wave's picture
 * was tuned against and the state the off arm sits at.
 */

import { describe, expect, it } from 'vitest';
import {
  CONSPICUOUSNESS_SCALE,
  VISUAL,
  VISUAL_STRIDE,
  POSE_STRIDE,
  conspicuousnessSignal,
  isJuvenile,
  readCreatureVisual,
} from './contracts';
import type { CreatureFrame, CreatureVisual } from './contracts';

function emptyVisual(): CreatureVisual {
  return {
    archetype: 'undulator',
    sizeCm: 0,
    hueDeg: 0,
    segmentCount: 0,
    finPairs: 0,
    bodyAspect: 1,
    armorPlating: 0,
    diet: 0,
    defense: 0,
    lifeStage: 0,
    conspicuousness: 999,
    tint: 0,
    alpha: 0,
    jitter: 0,
    heading: 0,
    speed: 0,
    fade: 0,
  };
}

function frameOf(visuals: Float32Array, rows: number): CreatureFrame {
  return {
    count: rows,
    poses: new Float32Array(rows * POSE_STRIDE),
    visuals,
    tints: new Uint32Array(rows),
    alphas: new Float32Array(rows).fill(1),
    visible: Uint16Array.from({ length: rows }, (_unused, i) => i),
    visibleCount: rows,
  };
}

describe('conspicuousnessSignal', () => {
  it('is exactly zero at the baseline', () => {
    // Not "close to": the tint mapping keys its identity branch off this being
    // literally 0, which is what makes an unsignalled animal render as the same
    // integer it did before the channel existed.
    expect(conspicuousnessSignal(0)).toBe(0);
  });

  it('is odd, monotone and bounded', () => {
    let previous = -1;
    for (let value = -8; value <= 8; value += 0.25) {
      const signal = conspicuousnessSignal(value);
      expect(signal).toBeGreaterThan(previous);
      expect(Math.abs(signal)).toBeLessThan(1);
      expect(signal).toBeCloseTo(-conspicuousnessSignal(-value), 12);
      previous = signal;
    }
  });

  it('spends about two thirds of its range on the values G3 measured', () => {
    // The population means G3's cliff runs reached, so the scale is anchored to
    // observed behaviour rather than to a round number.
    expect(conspicuousnessSignal(1.69)).toBeGreaterThan(0.6);
    expect(conspicuousnessSignal(1.69)).toBeLessThan(0.85);
    expect(conspicuousnessSignal(CONSPICUOUSNESS_SCALE)).toBeCloseTo(Math.tanh(1), 12);
  });
});

describe('isJuvenile', () => {
  it('splits on the midpoint, so a partly written channel still resolves', () => {
    expect(isJuvenile(0)).toBe(true);
    expect(isJuvenile(1)).toBe(false);
    expect(isJuvenile(0.49)).toBe(true);
    expect(isJuvenile(0.51)).toBe(false);
  });
});

describe('readCreatureVisual', () => {
  it('decodes both G-wave channels off the row', () => {
    const visuals = new Float32Array(VISUAL_STRIDE);
    visuals[VISUAL.lifeStage] = 0;
    visuals[VISUAL.conspicuousness] = -2.25;
    const out = emptyVisual();
    readCreatureVisual(frameOf(visuals, 1), 0, out);
    expect(out.lifeStage).toBe(0);
    expect(out.conspicuousness).toBeCloseTo(-2.25, 6);
  });

  it('defaults a row past the end of the buffer to a mature, unsignalled animal', () => {
    const out = emptyVisual();
    readCreatureVisual(frameOf(new Float32Array(VISUAL_STRIDE), 1), 4, out);
    expect(out.lifeStage).toBe(1);
    expect(out.conspicuousness).toBe(0);
  });
});
