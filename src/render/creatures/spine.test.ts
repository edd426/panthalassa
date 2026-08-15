import { describe, expect, it } from 'vitest';
import type { SpineParams } from './spine';
import {
  MAX_SPINE_POINTS,
  MAX_SWIM_HZ,
  MIN_SWIM_HZ,
  bellPulse,
  bellPulsePhase,
  buildSpine,
  createSpineChain,
  spineAmplitudeAt,
  spineSegmentCount,
  swimFrequencyHz,
  wavePhase,
} from './spine';

function params(overrides: Partial<SpineParams> = {}): SpineParams {
  return {
    segmentCount: 10,
    amplitudeHead: 0.02,
    amplitudeTail: 0.12,
    wavelength: 0.8,
    phase: 0,
    amplitudeScale: 1,
    ...overrides,
  };
}

describe('spine chain', () => {
  it('preserves segment spacing exactly under undulation', () => {
    const chain = createSpineChain();
    for (const segments of [4, 8, 13, 20, 28]) {
      for (const phase of [0, 0.7, 1.9, 3.4, 5.8]) {
        buildSpine(params({ segmentCount: segments, phase }), chain);
        const expected = 1 / (segments - 1);
        for (let i = 1; i < chain.count; i += 1) {
          const dx = (chain.xs[i] ?? 0) - (chain.xs[i - 1] ?? 0);
          const dy = (chain.ys[i] ?? 0) - (chain.ys[i - 1] ?? 0);
          expect(Math.hypot(dx, dy)).toBeCloseTo(expected, 12);
        }
        expect(chain.segmentLength).toBeCloseTo(expected, 12);
      }
    }
  });

  it('keeps the total chain length at exactly one body length', () => {
    const chain = createSpineChain();
    buildSpine(params({ segmentCount: 16, phase: 2.2 }), chain);
    let total = 0;
    for (let i = 1; i < chain.count; i += 1) {
      total += Math.hypot((chain.xs[i] ?? 0) - (chain.xs[i - 1] ?? 0), (chain.ys[i] ?? 0) - (chain.ys[i - 1] ?? 0));
    }
    expect(total).toBeCloseTo(1, 12);
  });

  it('is 2π-periodic in phase', () => {
    const a = createSpineChain();
    const b = createSpineChain();
    for (const phase of [0, 1.3, -2.6, 4.9]) {
      buildSpine(params({ phase }), a);
      buildSpine(params({ phase: phase + 2 * Math.PI }), b);
      expect(a.count).toBe(b.count);
      for (let i = 0; i < a.count; i += 1) {
        expect(a.xs[i] ?? 0).toBeCloseTo(b.xs[i] ?? 0, 12);
        expect(a.ys[i] ?? 0).toBeCloseTo(b.ys[i] ?? 0, 12);
        expect(a.angles[i] ?? 0).toBeCloseTo(b.angles[i] ?? 0, 12);
      }
    }
  });

  it('puts the head at the origin and extends anti-heading', () => {
    const chain = createSpineChain();
    for (const phase of [0, 1.1, 3.7, 5.2]) {
      buildSpine(params({ segmentCount: 12, phase }), chain);
      expect(chain.xs[0]).toBe(0);
      expect(chain.ys[0]).toBe(0);
      for (let i = 1; i < chain.count; i += 1) {
        expect(chain.xs[i] ?? 0).toBeLessThan(chain.xs[i - 1] ?? 0);
      }
      expect(chain.xs[chain.count - 1] ?? 0).toBeLessThan(-0.5);
      expect(chain.xs[chain.count - 1] ?? 0).toBeGreaterThanOrEqual(-1);
    }
  });

  it('grows the amplitude envelope monotonically tail-ward', () => {
    const p = params();
    let previous = -Infinity;
    for (let step = 0; step <= 40; step += 1) {
      const amplitude = spineAmplitudeAt(step / 40, p);
      expect(amplitude).toBeGreaterThan(previous);
      previous = amplitude;
    }
    expect(spineAmplitudeAt(0, p)).toBeCloseTo(0.02, 12);
    expect(spineAmplitudeAt(1, p)).toBeCloseTo(0.12, 12);
  });

  it('sweeps a wider lateral arc at the tail than at the head', () => {
    const chain = createSpineChain();
    let headSwing = 0;
    let tailSwing = 0;
    const segments = 21;
    for (let step = 0; step < 24; step += 1) {
      buildSpine(params({ segmentCount: segments, phase: (step / 24) * 2 * Math.PI }), chain);
      headSwing = Math.max(headSwing, Math.abs(chain.ys[2] ?? 0));
      tailSwing = Math.max(tailSwing, Math.abs(chain.ys[segments - 1] ?? 0));
    }
    expect(tailSwing).toBeGreaterThan(headSwing * 3);
  });

  it('freezes to a straight chain at amplitudeScale 0', () => {
    const chain = createSpineChain();
    buildSpine(params({ segmentCount: 14, phase: 2.4, amplitudeScale: 0 }), chain);
    for (let i = 0; i < chain.count; i += 1) {
      expect(chain.ys[i] ?? 0).toBeCloseTo(0, 12);
      expect(chain.xs[i] ?? 0).toBeCloseTo(-i / (chain.count - 1), 12);
    }
  });

  it('emits unit normals perpendicular to the local tangent', () => {
    const chain = createSpineChain();
    buildSpine(params({ segmentCount: 18, phase: 1.7 }), chain);
    for (let i = 0; i < chain.count; i += 1) {
      const nx = chain.nxs[i] ?? 0;
      const ny = chain.nys[i] ?? 0;
      expect(Math.hypot(nx, ny)).toBeCloseTo(1, 12);
      const tx = Math.cos(chain.angles[i] ?? 0);
      const ty = Math.sin(chain.angles[i] ?? 0);
      expect(nx * tx + ny * ty).toBeCloseTo(0, 12);
    }
  });

  it('clamps the chain length to a drawable range', () => {
    expect(spineSegmentCount(1)).toBe(2);
    expect(spineSegmentCount(-40)).toBe(2);
    expect(spineSegmentCount(8.4)).toBe(8);
    expect(spineSegmentCount(1000)).toBe(MAX_SPINE_POINTS);
    const chain = createSpineChain();
    buildSpine(params({ segmentCount: 1000 }), chain);
    expect(chain.count).toBe(MAX_SPINE_POINTS);
  });
});

describe('wall-clock drivers', () => {
  it('clamps swim frequency into the believable band', () => {
    expect(swimFrequencyHz(0)).toBeCloseTo(0.9, 12);
    expect(swimFrequencyHz(-100)).toBe(MIN_SWIM_HZ);
    expect(swimFrequencyHz(10_000)).toBe(MAX_SWIM_HZ);
    expect(swimFrequencyHz(2)).toBeGreaterThan(swimFrequencyHz(1));
  });

  it('advances wave phase linearly in wall-clock time and offsets it by jitter', () => {
    expect(wavePhase(0, 1, 0)).toBe(0);
    expect(wavePhase(1000, 1, 0)).toBeCloseTo(2 * Math.PI, 12);
    expect(wavePhase(0, 1, 0.25)).toBeCloseTo(Math.PI / 2, 12);
  });

  it('pulses the bell with a fast contraction and a slow relax', () => {
    for (const t of [0, 0.13, 0.4, 0.77, 0.99]) {
      expect(bellPulse(t)).toBeCloseTo(bellPulse(t + 1), 12);
      expect(bellPulse(t)).toBeCloseTo(bellPulse(t + 7), 12);
      expect(Math.abs(bellPulse(t))).toBeLessThanOrEqual(1 + 1e-12);
    }
    expect(bellPulse(0)).toBeCloseTo(1, 12);
    // Contracted at the end of the snap, back to expanded at the end of the relax.
    expect(bellPulse(0.28)).toBeCloseTo(-1, 12);
    expect(bellPulse(0.999999)).toBeGreaterThan(0.99);
    // The snap covers the same swing in far less of the period than the relax.
    const contractRate = Math.abs(bellPulse(0.14) - bellPulse(0)) / 0.14;
    const relaxRate = Math.abs(bellPulse(0.64) - bellPulse(0.28)) / 0.36;
    expect(contractRate).toBeGreaterThan(relaxRate * 2);
  });

  it('keeps the bell pulse phase inside [0, 1)', () => {
    for (const now of [0, 137, 2200, 98_765, 1_234_567]) {
      for (const jitter of [0, 0.37, 0.99]) {
        const phase = bellPulsePhase(now, jitter);
        expect(phase).toBeGreaterThanOrEqual(0);
        expect(phase).toBeLessThan(1);
      }
    }
  });
});
