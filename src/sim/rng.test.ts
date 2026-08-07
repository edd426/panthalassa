import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { RandomSource } from '../contracts/types';
import { SeededRng } from './rng';

const N = 100_000;

function draws(rng: SeededRng, count: number): number[] {
  return Array.from({ length: count }, () => rng.next());
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: readonly number[]): number {
  const m = mean(values);
  return values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
}

function correlation(a: readonly number[], b: readonly number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let index = 0; index < a.length; index += 1) {
    const da = (a[index] ?? 0) - ma;
    const db = (b[index] ?? 0) - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  return cov / Math.sqrt(va * vb);
}

describe('SeededRng as the injected RandomSource', () => {
  it('satisfies the RandomSource contract every sim module is written against', () => {
    // The annotation is the assertion: it stops compiling if SeededRng ever
    // drifts from the interface in contracts/types.ts, which is what the whole
    // dependency-injection seam rests on.
    const source: RandomSource = new SeededRng('contract');
    expect(typeof source.next()).toBe('number');
    expect(typeof source.fork('stage').next()).toBe('number');
    expect(source.getState()).toHaveLength(4);
  });
});

describe('SeededRng determinism', () => {
  it('produces an identical sequence for the same seed', () => {
    const a = draws(new SeededRng('panthalassa'), 1000);
    const b = draws(new SeededRng('panthalassa'), 1000);
    expect(a).toEqual(b);
  });

  it('produces a different sequence for a different seed', () => {
    const a = draws(new SeededRng('panthalassa'), 1000);
    const b = draws(new SeededRng('panthalassb'), 1000);
    expect(a).not.toEqual(b);
  });

  it('round-trips through getState', () => {
    const rng = new SeededRng('snapshot');
    draws(rng, 137);
    const state = rng.getState();
    const continued = draws(rng, 500);
    expect(draws(new SeededRng(state), 500)).toEqual(continued);
  });

  it('restores through setState', () => {
    const rng = new SeededRng('restore');
    const state = rng.getState();
    const first = draws(rng, 200);
    rng.setState(state);
    expect(draws(rng, 200)).toEqual(first);
  });

  it('is deterministic for arbitrary seeds', () => {
    fc.assert(
      fc.property(fc.string(), (seed) => {
        expect(draws(new SeededRng(seed), 50)).toEqual(draws(new SeededRng(seed), 50));
      }),
      { numRuns: 200 },
    );
  });
});

describe('SeededRng distributions', () => {
  it('next() is uniform on [0,1)', () => {
    const values = draws(new SeededRng('uniform'), N);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    expect(mean(values)).toBeCloseTo(0.5, 2);
    expect(Math.abs(mean(values) - 0.5)).toBeLessThan(0.005);
    expect(Math.abs(variance(values) - 1 / 12)).toBeLessThan(0.002);
  });

  it('normal() has the requested mean and sd', () => {
    const rng = new SeededRng('normal');
    const values = Array.from({ length: N }, () => rng.normal());
    expect(Math.abs(mean(values))).toBeLessThan(0.02);
    expect(Math.abs(Math.sqrt(variance(values)) - 1)).toBeLessThan(0.015);

    const scaled = new SeededRng('normal-scaled');
    const shifted = Array.from({ length: N }, () => scaled.normal(5, 2));
    expect(Math.abs(mean(shifted) - 5)).toBeLessThan(0.04);
    expect(Math.abs(Math.sqrt(variance(shifted)) - 2)).toBeLessThan(0.03);
  });

  it('poisson() has mean equal to lambda', () => {
    const rng = new SeededRng('poisson');
    const values = Array.from({ length: N }, () => rng.poisson(1));
    expect(Math.abs(mean(values) - 1)).toBeLessThan(0.02);
    // Poisson variance equals its mean; the crossover count depends on it.
    expect(Math.abs(variance(values) - 1)).toBeLessThan(0.04);
  });

  it('laplace() has mean 0 and variance 2b²', () => {
    const rng = new SeededRng('laplace');
    const values = Array.from({ length: N }, () => rng.laplace(0, 1));
    expect(Math.abs(mean(values))).toBeLessThan(0.03);
    expect(Math.abs(variance(values) - 2)).toBeLessThan(0.15);
  });

  it('int() and chance() respect their bounds', () => {
    const rng = new SeededRng('bounds');
    const ints = Array.from({ length: 20_000 }, () => rng.int(3, 7));
    expect(Math.min(...ints)).toBe(3);
    expect(Math.max(...ints)).toBe(7);
    const hits = Array.from({ length: 20_000 }, () => rng.chance(0.25)).filter(Boolean).length;
    expect(Math.abs(hits / 20_000 - 0.25)).toBeLessThan(0.02);
  });
});

describe('SeededRng.fork', () => {
  it('is deterministic for the same label and parent state', () => {
    const parent = new SeededRng('fork-seed');
    const first = draws(parent.fork('predation'), 500);
    const second = draws(parent.fork('predation'), 500);
    expect(first).toEqual(second);
  });

  it('does not consume parent entropy', () => {
    const untouched = draws(new SeededRng('fork-seed'), 500);
    const parent = new SeededRng('fork-seed');
    parent.fork('a');
    parent.fork('b');
    parent.fork('a-very-long-label-with-different-length');
    expect(draws(parent, 500)).toEqual(untouched);
  });

  it('gives different labels independent streams', () => {
    const parent = new SeededRng('fork-seed');
    const a = draws(parent.fork('mating'), 20_000);
    const b = draws(parent.fork('mutation'), 20_000);
    expect(a).not.toEqual(b);
    expect(Math.abs(correlation(a, b))).toBeLessThan(0.04);
  });

  it('gives labels that differ by one character independent streams', () => {
    const parent = new SeededRng('fork-seed');
    const a = draws(parent.fork('tick:1000'), 20_000);
    const b = draws(parent.fork('tick:1001'), 20_000);
    expect(Math.abs(correlation(a, b))).toBeLessThan(0.04);
  });

  it('gives the same label different streams after the parent advances', () => {
    const parent = new SeededRng('fork-seed');
    const before = draws(parent.fork('stage'), 200);
    parent.next();
    const after = draws(parent.fork('stage'), 200);
    expect(before).not.toEqual(after);
  });

  it('is deterministic for arbitrary labels', () => {
    fc.assert(
      fc.property(fc.string(), (label) => {
        const parent = new SeededRng('property');
        expect(draws(parent.fork(label), 20)).toEqual(draws(parent.fork(label), 20));
      }),
      { numRuns: 200 },
    );
  });

  it('forked streams stay uniform', () => {
    const values = draws(new SeededRng('quality').fork('substream'), N);
    expect(Math.abs(mean(values) - 0.5)).toBeLessThan(0.005);
    expect(Math.abs(variance(values) - 1 / 12)).toBeLessThan(0.002);
  });
});
