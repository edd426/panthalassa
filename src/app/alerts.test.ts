/**
 * Detector tests: synthetic rows, both sides of every threshold.
 *
 * The point of a threshold test is the pair — a value that must fire and a
 * value just short of it that must not — plus the anti-spam case, because a
 * detector that fires on the level rather than the crossing passes every
 * single-value test and still ruins the feed.
 */

import { describe, expect, it } from 'vitest';
import type { TraitSample } from '../contracts/stats';
import type { TraitKey } from '../contracts/traits';
import { TRAIT_KEYS } from '../contracts/traits';
import type { Alert, AlertRow, AlertState } from './alerts';
import { createAlertState, detectAlerts, indexAtOrBefore, median, resetAlertState } from './alerts';

const CAPACITY = 4096;
/** Rows land every 200 ticks against 900-tick generations, as the shipped config does. */
const GEN_PER_ROW = 200 / 900;

interface RowSpec {
  readonly generation: number;
  readonly population?: number;
  readonly traitMeans?: Partial<Record<TraitKey, number>>;
  readonly traitSd?: number;
  readonly predatorFraction?: number;
  readonly fstDemes?: number;
  readonly fstBarrier?: number | null;
  readonly heterozygosity?: number;
}

function traitSample(mean: number, sd: number): TraitSample {
  return { mean, sd, additiveVariance: sd * sd, phenotypicVariance: sd * sd, heritability: 0.5 };
}

function makeRow(spec: RowSpec): AlertRow {
  const sd = spec.traitSd ?? 1;
  const traits = Object.fromEntries(
    TRAIT_KEYS.map((key) => [key, traitSample(spec.traitMeans?.[key] ?? 0, sd)]),
  ) as Record<TraitKey, TraitSample>;
  return {
    tick: Math.round(spec.generation * 900),
    generation: spec.generation,
    population: spec.population ?? 1000,
    traits,
    guilds: {
      // Recorded baseline/barrier runs sit at 0.43–0.73, so that is what a
      // "quiet" synthetic row carries; a default inside the alert bands would
      // make every other test start from a state the sim never occupies.
      predatorFraction: spec.predatorFraction ?? 0.55,
      filtererFraction: 1 - (spec.predatorFraction ?? 0.55),
      meanAttack: 0,
      meanDefense: 0,
    },
    popgen: {
      neDemographic: 500,
      neTemporal: 400,
      fstDemes: spec.fstDemes ?? 0.02,
      fstBarrier: spec.fstBarrier === undefined ? null : spec.fstBarrier,
      meanHeterozygosity: spec.heterozygosity ?? 0.4,
      midparentH2Size: 0.4,
    },
  };
}

/** Feed a run of rows on the shipped row spacing, returning everything emitted. */
function feed(state: AlertState, count: number, spec: (generation: number, index: number) => Omit<RowSpec, 'generation'>): Alert[] {
  const out: Alert[] = [];
  const from = state.generation[state.generation.length - 1] ?? 0;
  for (let index = 1; index <= count; index += 1) {
    const generation = from + index * GEN_PER_ROW;
    out.push(...detectAlerts(state, makeRow({ generation, ...spec(generation, index) })));
  }
  return out;
}

function fresh(): AlertState {
  return createAlertState({ slotCapacity: CAPACITY });
}

/** A quiet stretch: everything mid-range, so only the quantity under test moves. */
function calm(generation: number, index: number): Omit<RowSpec, 'generation'> {
  void generation;
  void index;
  return {};
}

describe('indexAtOrBefore', () => {
  it('finds the last entry at or before the target', () => {
    const axis = [0, 1, 2, 3, 4];
    expect(indexAtOrBefore(axis, 2)).toBe(2);
    expect(indexAtOrBefore(axis, 2.5)).toBe(2);
    expect(indexAtOrBefore(axis, 4.5)).toBe(4);
  });

  it('reports −1 when the axis starts after the target', () => {
    expect(indexAtOrBefore([5, 6], 4)).toBe(-1);
    expect(indexAtOrBefore([], 0)).toBe(-1);
  });
});

describe('median', () => {
  it('averages the middle pair on an even window and ignores input order', () => {
    expect(median([5, 1, 3, 9])).toBe(4);
    expect(median([9, 1, 3])).toBe(3);
  });

  it('honours the slice bounds', () => {
    expect(median([100, 100, 1, 3, 5], 2, 5)).toBe(3);
  });
});

describe('trait excursion', () => {
  it('fires past 2 pooled σ inside the window and names the trait', () => {
    const state = fresh();
    feed(state, 120, () => ({ traitMeans: { size: 0 } }));
    const alerts = feed(state, 4, (generation) => ({ traitMeans: { size: (generation - 26) * 2 } }));
    const excursion = alerts.filter((alert) => alert.line.startsWith('size is running'));
    expect(excursion).toHaveLength(1);
    expect(excursion[0]?.severity).toBe('notice');
    expect(excursion[0]?.line).toMatch(/size is running · \+\d+\.\dσ in 20 gen/);
  });

  it('does not fire just below the threshold', () => {
    const state = fresh();
    feed(state, 120, () => ({ traitMeans: { size: 0 } }));
    // 1.9σ over the whole 20-generation window: a real move, and still short.
    const alerts = feed(state, 90, (generation) => ({ traitMeans: { size: ((generation - 26) / 20) * 1.9 } }));
    expect(alerts.filter((alert) => alert.line.includes('is running'))).toHaveLength(0);
  });

  it('reports a sustained excursion once, then again after the window settles', () => {
    const state = fresh();
    feed(state, 120, () => ({ traitMeans: { size: 0 } }));
    // Step up and hold: for the next 20 generations every window still spans
    // the step, which is exactly the shape that spams a level-triggered detector.
    const held = feed(state, 140, () => ({ traitMeans: { size: 3 } }));
    expect(held.filter((alert) => alert.line.includes('size is running'))).toHaveLength(1);
    // The window has now cleared the step, so the detector is armed again and a
    // second step is a second line.
    const again = feed(state, 90, () => ({ traitMeans: { size: 6 } }));
    expect(again.filter((alert) => alert.line.includes('size is running'))).toHaveLength(1);
  });

  it('stays silent when the trait has no variance to measure against', () => {
    const state = fresh();
    feed(state, 120, () => ({ traitMeans: { size: 0 }, traitSd: 0 }));
    const alerts = feed(state, 90, () => ({ traitMeans: { size: 40 }, traitSd: 0 }));
    expect(alerts.filter((alert) => alert.line.includes('is running'))).toHaveLength(0);
  });
});

describe('guild collapse and rebirth', () => {
  it('fires an alert below 0.05 and only once while it stays there', () => {
    const state = fresh();
    feed(state, 10, calm);
    const alerts = feed(state, 40, () => ({ predatorFraction: 0.03 }));
    const collapse = alerts.filter((alert) => alert.line.startsWith('the hunters are gone'));
    expect(collapse).toHaveLength(1);
    expect(collapse[0]?.severity).toBe('alert');
    expect(collapse[0]?.line).toBe('the hunters are gone · predator share 3.0%');
  });

  it('does not fire at 0.06', () => {
    const state = fresh();
    feed(state, 10, calm);
    expect(feed(state, 40, () => ({ predatorFraction: 0.06 }))).toHaveLength(0);
  });

  it('holds the collapsed state through the hysteresis band and reports the rebirth above it', () => {
    const state = fresh();
    feed(state, 10, calm);
    feed(state, 10, () => ({ predatorFraction: 0.03 }));
    expect(feed(state, 10, () => ({ predatorFraction: 0.07 }))).toHaveLength(0);
    const back = feed(state, 10, () => ({ predatorFraction: 0.09 }));
    expect(back).toHaveLength(1);
    expect(back[0]?.line).toBe('the hunters are back · predator share 9.0%');
    expect(back[0]?.severity).toBe('notice');
  });

  it('fires the boom above 0.15 but not at 0.15 itself', () => {
    const state = fresh();
    feed(state, 10, () => ({ predatorFraction: 0.1 }));
    expect(feed(state, 10, () => ({ predatorFraction: 0.15 }))).toHaveLength(0);
    const boom = feed(state, 10, () => ({ predatorFraction: 0.17 }));
    expect(boom).toHaveLength(1);
    expect(boom[0]?.line).toBe('predators everywhere · predator share 17%');
  });
});

describe('guild first reading', () => {
  it('classifies the opening level without reporting it', () => {
    const state = fresh();
    // A run that opens at a 0.55 predator share is every recorded run; opening
    // with "predators everywhere" would be a line on every world, which is a
    // line that says nothing.
    expect(feed(state, 40, calm)).toHaveLength(0);
    // The crossing out of that state is still reported.
    expect(feed(state, 5, () => ({ predatorFraction: 0.11 }))).toHaveLength(0);
    expect(feed(state, 5, () => ({ predatorFraction: 0.02 }))).toHaveLength(1);
  });
});

describe('Fst surge', () => {
  it('fires when the barrier reading climbs 0.1 over its trailing median', () => {
    const state = fresh();
    feed(state, 200, () => ({ fstBarrier: 0.05 }));
    const alerts = feed(state, 5, () => ({ fstBarrier: 0.31 }));
    expect(alerts.filter((alert) => alert.line.startsWith('populations diverging across the wall'))).toHaveLength(1);
    expect(alerts[0]?.line).toBe('populations diverging across the wall · Fst 0.31');
  });

  it('ignores a climb of 0.08 and reports the deme reading separately', () => {
    const state = fresh();
    feed(state, 200, () => ({ fstBarrier: 0.05, fstDemes: 0.05 }));
    expect(feed(state, 5, () => ({ fstBarrier: 0.13, fstDemes: 0.13 }))).toHaveLength(0);
    const alerts = feed(state, 5, () => ({ fstBarrier: 0.05, fstDemes: 0.4 }));
    expect(alerts.map((alert) => alert.line)).toEqual(['the demes are pulling apart · Fst 0.40']);
  });

  it('reports a sustained wall once, and again only after it settles and climbs anew', () => {
    const state = fresh();
    feed(state, 200, () => ({ fstBarrier: 0.05 }));
    expect(feed(state, 60, () => ({ fstBarrier: 0.31 }))).toHaveLength(1);
    // Long enough at the new level that it becomes the trailing median itself.
    feed(state, 260, () => ({ fstBarrier: 0.31 }));
    expect(feed(state, 10, () => ({ fstBarrier: 0.5 }))).toHaveLength(1);
  });

  it('needs a window before it will call anything a surge', () => {
    const state = fresh();
    // A world whose very first barrier reading is high has no baseline to be
    // high against; calling that a surge would fire on every barrier scenario.
    expect(feed(state, 4, () => ({ fstBarrier: 0.6 }))).toHaveLength(0);
  });

  it('skips rows with no barrier up', () => {
    const state = fresh();
    feed(state, 200, () => ({ fstBarrier: null }));
    expect(state.fstBarrier.values).toHaveLength(0);
    expect(feed(state, 5, () => ({ fstBarrier: 0.6 }))).toHaveLength(0);
  });
});

describe('population regime', () => {
  it('fires on a 40% loss inside five generations, once', () => {
    const state = fresh();
    feed(state, 100, () => ({ population: 1000 }));
    const alerts = feed(state, 30, () => ({ population: 400 }));
    const crash = alerts.filter((alert) => alert.line.startsWith('the population is falling'));
    expect(crash).toHaveLength(1);
    expect(crash[0]?.severity).toBe('alert');
    expect(crash[0]?.line).toBe('the population is falling · -60% in 5 gen');
  });

  it('does not fire on a 30% loss', () => {
    const state = fresh();
    feed(state, 100, () => ({ population: 1000 }));
    const alerts = feed(state, 30, () => ({ population: 700 }));
    expect(alerts.filter((alert) => alert.line.includes('falling'))).toHaveLength(0);
  });

  it('reports cap-riding only once it has been sustained', () => {
    const state = fresh();
    const early = feed(state, 40, () => ({ population: 3700 }));
    // 40 rows is under 9 generations: at capacity, but not yet a regime.
    expect(early).toHaveLength(0);
    const later = feed(state, 60, () => ({ population: 3700 }));
    expect(later).toHaveLength(1);
    expect(later[0]?.line).toBe('the ocean is full · 3700 of 4096 slots for 20 gen');
    expect(feed(state, 200, () => ({ population: 3700 }))).toHaveLength(0);
  });

  it('re-arms cap-riding once the ocean empties out below 75%', () => {
    const state = fresh();
    feed(state, 120, () => ({ population: 3700 }));
    // A dip that stays above the clear line does not re-arm it.
    feed(state, 10, () => ({ population: 3300 }));
    expect(feed(state, 120, () => ({ population: 3700 }))).toHaveLength(0);
    feed(state, 10, () => ({ population: 2000 }));
    expect(feed(state, 120, () => ({ population: 3700 }))).toHaveLength(1);
  });

  it('does not read the founding of a world as a crash', () => {
    const state = fresh();
    const alerts = feed(state, 60, (_generation, index) => ({ population: index < 20 ? 0 : 40 }));
    expect(alerts.filter((alert) => alert.line.includes('falling'))).toHaveLength(0);
  });
});

describe('diversity drain', () => {
  it('fires when heterozygosity falls 0.15 over a hundred generations', () => {
    const state = fresh();
    const alerts = feed(state, 600, (generation) => ({ heterozygosity: Math.max(0.1, 0.5 - generation * 0.002) }));
    const drain = alerts.filter((alert) => alert.line.startsWith('variance is draining'));
    expect(drain).toHaveLength(1);
    expect(drain[0]?.severity).toBe('alert');
    expect(drain[0]?.line).toMatch(/heterozygosity 0\.\d+ → 0\.\d+ over 100 gen/);
  });

  it('ignores a drain of 0.1 over the same window', () => {
    const state = fresh();
    const alerts = feed(state, 600, (generation) => ({ heterozygosity: Math.max(0.3, 0.5 - generation * 0.001) }));
    expect(alerts.filter((alert) => alert.line.includes('draining'))).toHaveLength(0);
  });
});

describe('resetAlertState', () => {
  it('forgets the previous world, so a small new one is not a crash', () => {
    const state = fresh();
    feed(state, 200, () => ({ population: 3900, predatorFraction: 0.02, heterozygosity: 0.2 }));
    resetAlertState(state);
    expect(state.generation).toHaveLength(0);
    // Back to "no reading yet", so the new world's opening level classifies
    // silently instead of being compared against the dead world's.
    expect(state.guild).toBeNull();
    expect(state.capRidingSince).toBeNull();
    const alerts = feed(state, 30, () => ({ population: 40 }));
    expect(alerts.filter((alert) => alert.line.includes('falling'))).toHaveLength(0);
  });
});

describe('history trimming', () => {
  it('keeps detector state bounded across a long run', () => {
    const state = fresh();
    feed(state, 3000, calm);
    // 100 generations of 200-tick rows is 450 entries; the trim keeps the
    // window and nothing else, whatever the run length.
    expect(state.generation.length).toBeLessThan(470);
    expect(state.generation.length).toBeGreaterThan(440);
  });
});
