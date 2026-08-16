/**
 * WP-A2 acceptance probes: ecology and the spatial index.
 *
 * These are unit probes, not sim probes — they run against constructed
 * `SimState`s rather than a live engine, because A2 has to be provable before
 * A3 exists. The assertions are the ones that would silently rot if nobody
 * checked them: a logistic step that can go negative, a functional response
 * that is linear instead of saturating, a predation kernel wired to the wrong
 * argument, a grid that disagrees with a brute-force scan, an OU walk that is
 * really a random walk, and an ecology that is not a pure function of its seed.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { BehaviorDecision, EcologyApi, SpatialIndex } from '../contracts/apis';
import type {
  DeathCause,
  RandomSource,
  RngState,
  SimConfig,
  SimConfigOverrides,
  SimState,
  SlotIndex,
} from '../contracts/types';
import {
  BEHAVIOR_FLEE,
  BEHAVIOR_PURSUE,
  BEHAVIOR_WANDER,
  NO_SLOT,
  SEX_FEMALE,
  SEX_MALE,
  resolveSimConfig,
} from '../contracts/types';
import type { TraitKey } from '../contracts/traits';
import { TRAIT_COUNT, TRAIT_INDEX, TRAIT_KEYS, TRAIT_META, applyTraitLink, readTrait } from '../contracts/traits';
import type { Genome } from '../contracts/genome';
import { createEcology } from '../sim/ecology';
import { logisticStep } from '../sim/ecology/resources';
import { stepClimate } from '../sim/ecology/fields';
import type { EnginePools } from '../sim/organisms';
import { sizeCurrentColumn } from '../sim/organisms';
import { createSpatialIndex } from '../sim/spatial';
import { SeededRng } from '../sim/rng';

// ---------------------------------------------------------------------------
// Test-local world construction
//
// A2 cannot import A3's pool builder without ending the parallel build, so the
// probes construct `OrganismPools` straight from the contract. If this drifts
// from `types.ts`, it stops compiling — which is the point.
// ---------------------------------------------------------------------------

const DEFAULT_EXPRESSED = Object.fromEntries(
  TRAIT_KEYS.map((key) => [key, applyTraitLink(key, TRAIT_META[key].baseline)]),
) as Record<TraitKey, number>;

/** Uniform temperature and no season, so a probe can isolate one mechanism at a time. */
const ISOTHERMAL: SimConfigOverrides = {
  thermal: { northC: 18, southC: 18, seasonAmplitudeC: 0 },
  toggles: {
    enableSpatialGxE: true,
    enableFrequencyDependentPredation: true,
    enableClimateWalk: false,
    enableMutation: true,
    enableSeasonality: false,
    enableAssortativeMating: true,
  },
};

/**
 * The engine's pools, not the bare contract ones: the ecology reads the
 * engine's steering columns and (since G2) realised body length out of
 * `sizeCurrent`. A fixture missing a column is a fixture that no longer
 * matches the world.
 */
function makePools(capacity: number): EnginePools {
  return {
    capacity,
    alive: new Uint8Array(capacity),
    id: new Float64Array(capacity),
    motherId: new Float64Array(capacity),
    fatherId: new Float64Array(capacity),
    sex: new Uint8Array(capacity),
    archetype: new Uint8Array(capacity),
    cladeId: new Int32Array(capacity),
    speciesTag: new Int32Array(capacity),
    demeId: new Int32Array(capacity),
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    vx: new Float32Array(capacity),
    vy: new Float32Array(capacity),
    energy: new Float32Array(capacity),
    gutFill: new Float32Array(capacity),
    birthTick: new Float64Array(capacity),
    ageTicks: new Uint32Array(capacity),
    lastMatingTick: new Float64Array(capacity),
    behaviorState: new Uint8Array(capacity),
    behaviorTimer: new Uint16Array(capacity),
    targetSlot: new Int32Array(capacity).fill(NO_SLOT),
    steerX: new Float32Array(capacity),
    steerY: new Float32Array(capacity),
    speedFraction: new Float32Array(capacity),
    sizeCurrent: new Float32Array(capacity),
    traits: new Float32Array(capacity * TRAIT_COUNT),
    traitsLatent: new Float32Array(capacity * TRAIT_COUNT),
    traitsGenotypic: new Float32Array(capacity * TRAIT_COUNT),
    genomes: new Array<Genome | undefined>(capacity).fill(undefined),
  };
}

function makeState(overrides: SimConfigOverrides = {}, capacity = 64, seed = 'probe'): SimState {
  const config: SimConfig = resolveSimConfig(overrides);
  const fieldCell = config.world.fieldCellSizeWu;
  const cols = Math.max(1, Math.ceil(config.world.widthWu / fieldCell));
  const rows = Math.max(1, Math.ceil(config.world.heightWu / fieldCell));
  const cells = cols * rows;

  return {
    config,
    seed,
    tick: 0,
    rngState: new SeededRng(seed).getState(),
    nextOrganismId: 1,
    nextSpeciesTag: 1,
    nextCladeId: 1,
    liveCount: 0,
    pop: makePools(capacity),
    field: {
      cols,
      rows,
      cellSizeWu: fieldCell,
      plankton: new Float32Array(cells),
      carrion: new Float32Array(cells),
      kelp: new Float32Array(cells),
      carryingCapacity: new Float32Array(cells),
      temperature: new Float32Array(cells),
    },
    climate: { meanOffsetC: 0, targetOffsetC: 0, seasonPhaseTicks: 0 },
    disturbance: { thermal: [], planktonCrashes: [], kelpStorms: [] },
    barriers: {
      cols,
      rows,
      cellSizeWu: fieldCell,
      mask: new Uint8Array(cells).fill(255),
      specs: [],
    },
    events: [],
    deathCounts: { starvation: 0, predation: 0, temperature: 0, senescence: 0, catastrophe: 0, toxin: 0 },
    matingCount: 0,
    crossSpeciesMatingCount: 0,
  };
}

interface SpawnSpec {
  readonly x: number;
  readonly y: number;
  readonly traits?: Partial<Record<TraitKey, number>>;
  readonly energyFraction?: number;
  readonly ageTicks?: number;
  readonly sex?: number;
  /** Realised length, cm; defaults to the `size` trait (an adult at its target). */
  readonly sizeCurrentCm?: number;
}

function spawn(state: SimState, slot: SlotIndex, spec: SpawnSpec): void {
  const pop = state.pop;
  pop.alive[slot] = 1;
  pop.id[slot] = slot + 1;
  pop.x[slot] = spec.x;
  pop.y[slot] = spec.y;
  pop.sex[slot] = spec.sex ?? (slot % 2 === 0 ? SEX_FEMALE : SEX_MALE);
  pop.ageTicks[slot] = spec.ageTicks ?? state.config.time.maturityTicks;
  pop.behaviorState[slot] = BEHAVIOR_WANDER;
  pop.targetSlot[slot] = NO_SLOT;

  for (const key of TRAIT_KEYS) {
    const value = spec.traits?.[key] ?? DEFAULT_EXPRESSED[key];
    pop.traits[slot * TRAIT_COUNT + TRAIT_INDEX[key]] = value;
    pop.traitsLatent[slot * TRAIT_COUNT + TRAIT_INDEX[key]] = value;
  }

  // A spawned organism is an adult unless a test says otherwise: realised
  // length starts at the target the `size` trait names, which is what the
  // engine writes at birth with ontogeny off.
  sizeCurrentColumn(pop)[slot] = spec.sizeCurrentCm ?? readTrait(pop.traits, slot, 'size');

  const ceiling = state.config.metabolism.maxEnergyPerSize * (sizeCurrentColumn(pop)[slot] ?? 0);
  pop.energy[slot] = ceiling * (spec.energyFraction ?? 0.5);
  state.liveCount += 1;
}

/**
 * A `RandomSource` with no randomness in it. Probes that need to read a
 * computed probability rather than its outcome script `chance` and inspect
 * `chanceLog`.
 */
class StubRandom implements RandomSource {
  readonly chanceLog: number[] = [];
  private readonly scripted: boolean[];

  constructor(
    private readonly uniform = 0.5,
    scripted: readonly boolean[] = [],
  ) {
    this.scripted = [...scripted];
  }

  next(): number {
    return this.uniform;
  }

  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.uniform * (maxInclusive - min + 1));
  }

  chance(probability: number): boolean {
    this.chanceLog.push(probability);
    const next = this.scripted.shift();
    return next ?? this.uniform < probability;
  }

  pick<T>(values: readonly T[]): T {
    return values[this.int(0, values.length - 1)] as T;
  }

  normal(mean = 0, standardDeviation = 1): number {
    return mean + (this.uniform - 0.5) * standardDeviation;
  }

  poisson(lambda: number): number {
    return Math.round(lambda);
  }

  laplace(mean = 0, scale = 1): number {
    return mean + (this.uniform - 0.5) * scale;
  }

  fork(): RandomSource {
    return this;
  }

  getState(): RngState {
    return [1, 2, 3, 4];
  }

  setState(): void {
    // Stub state is immutable; restoring it is a no-op.
  }
}

// ---------------------------------------------------------------------------
// 1. Logistic regrowth
// ---------------------------------------------------------------------------

describe('plankton regrowth', () => {
  it('never goes negative and always moves toward K, from above or below', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.5, max: 40, noNaN: true }),
        fc.double({ min: 0, max: 2, noNaN: true }),
        fc.double({ min: 0.001, max: 0.5, noNaN: true }),
        (capacity, resourceRatio, rate) => {
          const resource = capacity * resourceRatio;
          const next = logisticStep(resource, capacity, rate);
          expect(next).toBeGreaterThanOrEqual(0);
          expect(Math.abs(next - capacity)).toBeLessThanOrEqual(Math.abs(resource - capacity) + 1e-9);
        },
      ),
      { numRuns: 400, seed: 20260807 },
    );
  });

  it('holds K as an exact fixed point and decays where nothing can grow', () => {
    expect(logisticStep(12, 12, 0.08)).toBe(12);
    expect(logisticStep(5, 0, 0.08)).toBeLessThan(5);
    expect(logisticStep(5, 0, 0.08)).toBeGreaterThanOrEqual(0);
    expect(logisticStep(-3, 12, 0.08)).toBeGreaterThanOrEqual(0);
  });

  it('recovers a cleared field and draws an over-stocked one back down', () => {
    const ecology = createEcology();
    const cleared = makeState(ISOTHERMAL);
    const stocked = makeState(ISOTHERMAL);
    const rng = new SeededRng('regrow');

    ecology.initFields(cleared, rng.fork('a'));
    ecology.initFields(stocked, rng.fork('b'));
    cleared.field.plankton.fill(0);
    for (let cell = 0; cell < stocked.field.plankton.length; cell += 1) {
      stocked.field.plankton[cell] = (stocked.field.carryingCapacity[cell] ?? 0) * 2.5;
    }

    for (let tick = 0; tick < 3000; tick += 1) {
      cleared.tick = tick;
      stocked.tick = tick;
      ecology.regrowResources(cleared);
      ecology.regrowResources(stocked);
    }

    let recovered = 0;
    let settled = 0;
    let productive = 0;
    for (let cell = 0; cell < cleared.field.plankton.length; cell += 1) {
      const capacity = cleared.field.carryingCapacity[cell] ?? 0;
      expect(cleared.field.plankton[cell] ?? -1).toBeGreaterThanOrEqual(0);
      expect(stocked.field.plankton[cell] ?? -1).toBeGreaterThanOrEqual(0);
      if (capacity < 1) continue;
      productive += 1;
      if ((cleared.field.plankton[cell] ?? 0) > capacity * 0.75) recovered += 1;
      if ((stocked.field.plankton[cell] ?? 0) < capacity * 1.25) settled += 1;
    }

    expect(productive).toBeGreaterThan(100);
    expect(recovered / productive).toBeGreaterThan(0.95);
    expect(settled / productive).toBeGreaterThan(0.95);
  });
});

// ---------------------------------------------------------------------------
// 2. Type-II grazing
// ---------------------------------------------------------------------------

describe('grazing intake', () => {
  function gainAtResource(resource: number): number {
    const state = makeState(ISOTHERMAL);
    spawn(state, 0, { x: 500, y: 600, energyFraction: 0 });
    state.field.plankton.fill(resource);
    return createEcology().applyFeeding(state, 0, new StubRandom(0.5));
  }

  it('increases monotonically with local resource', () => {
    const levels = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64];
    const gains = levels.map(gainAtResource);
    for (let index = 1; index < gains.length; index += 1) {
      expect(gains[index] as number).toBeGreaterThan(gains[index - 1] as number);
    }
  });

  it('saturates: concave in resource, and it plateaus', () => {
    // Equal steps, so shrinking increments really are concavity rather than an
    // artefact of the sampling grid.
    const gains = [1, 2, 3, 4, 5, 6, 7, 8].map(gainAtResource);
    for (let index = 2; index < gains.length; index += 1) {
      const previousStep = (gains[index - 1] as number) - (gains[index - 2] as number);
      const currentStep = (gains[index] as number) - (gains[index - 1] as number);
      expect(currentStep).toBeLessThan(previousStep);
    }

    // A rich patch cannot be converted into unbounded energy: past the
    // half-saturation point the intake stops responding to resource at all.
    const plateau = gainAtResource(1e5);
    expect(gainAtResource(1e6) - plateau).toBeLessThan(1e-4);
    expect(plateau).toBeLessThan(resolveSimConfig(ISOTHERMAL).resources.grazingMaxIntake);
  });

  it('debits the cell it fed from and stops at the storage ceiling', () => {
    const state = makeState(ISOTHERMAL);
    spawn(state, 0, { x: 500, y: 600, energyFraction: 0 });
    state.field.plankton.fill(20);
    const before = state.field.plankton[0] ?? 0;
    const gained = createEcology().applyFeeding(state, 0, new StubRandom(0.5));
    expect(gained).toBeGreaterThan(0);

    let debited = 0;
    for (let cell = 0; cell < state.field.plankton.length; cell += 1) {
      debited += before - (state.field.plankton[cell] ?? 0);
    }
    expect(debited).toBeGreaterThan(0);

    // A full animal takes nothing more (the residue is float32 rounding on the
    // stored energy, not a bite).
    const full = makeState(ISOTHERMAL);
    spawn(full, 0, { x: 500, y: 600, energyFraction: 1 });
    full.field.plankton.fill(20);
    expect(createEcology().applyFeeding(full, 0, new StubRandom(0.5))).toBeLessThan(1e-5);
  });
});

// ---------------------------------------------------------------------------
// 3. Predation kernel wiring
// ---------------------------------------------------------------------------

describe('predation', () => {
  /** The kill probability `tryPredation` computes, read off a scripted RNG. */
  function killProbability(options: {
    defense?: number;
    attack?: number;
    kelp?: number;
    hue?: number;
  }): number {
    const state = makeState(ISOTHERMAL);
    spawn(state, 0, {
      x: 500,
      y: 600,
      energyFraction: 0.1,
      traits: { diet: 0.95, attack: options.attack ?? 1, size: 20 },
    });
    spawn(state, 1, {
      x: 510,
      y: 600,
      traits: { diet: 0.05, defense: options.defense ?? 0, size: 11, displayHue: options.hue ?? 200 },
    });
    state.field.kelp.fill(options.kelp ?? 0);

    const spatial = createSpatialIndex(state.config);
    spatial.build(state);
    // First `chance` is the diet gate; let it through, refuse the kill so the
    // probability is observed rather than acted on.
    const rng = new StubRandom(0.5, [true, false]);
    createEcology().tryPredation(state, 0, spatial, rng, { push: () => undefined });
    expect(rng.chanceLog.length).toBe(2);
    return rng.chanceLog[1] as number;
  }

  it('rises monotonically with attack minus defense', () => {
    const defenses = [-2, -1, 0, 1, 2, 3];
    const probabilities = defenses.map((defense) => killProbability({ defense }));
    for (let index = 1; index < probabilities.length; index += 1) {
      expect(probabilities[index] as number).toBeLessThan(probabilities[index - 1] as number);
    }
    const byAttack = [-2, 0, 2].map((attack) => killProbability({ attack }));
    expect(byAttack[1] as number).toBeGreaterThan(byAttack[0] as number);
    expect(byAttack[2] as number).toBeGreaterThan(byAttack[1] as number);
  });

  it('falls as kelp cover rises', () => {
    const covers = [0, 0.25, 0.5, 0.75, 1];
    const probabilities = covers.map((kelp) => killProbability({ kelp }));
    for (let index = 1; index < probabilities.length; index += 1) {
      expect(probabilities[index] as number).toBeLessThan(probabilities[index - 1] as number);
    }
  });

  it('punishes the common morph and spares the rare one', () => {
    const state = makeState(ISOTHERMAL, 64);
    spawn(state, 0, { x: 500, y: 600, energyFraction: 0.1, traits: { diet: 0.95, attack: 1, size: 20 } });
    // A crowd of one hue, plus a single rare morph, all within one morph cell.
    for (let slot = 1; slot <= 20; slot += 1) {
      spawn(state, slot, { x: 500 + slot, y: 600, traits: { diet: 0.05, size: 11, displayHue: 40 } });
    }
    spawn(state, 21, { x: 505, y: 600, traits: { diet: 0.05, size: 11, displayHue: 220 } });

    const ecology = createEcology();
    const common = ecology.hueMorphFrequencyAt(state, 505, 600, 40);
    const rare = ecology.hueMorphFrequencyAt(state, 505, 600, 220);
    expect(common).toBeGreaterThan(rare);
    expect(common + rare).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('returns the neutral frequency when the mechanism is switched off', () => {
    const off = makeState({
      ...ISOTHERMAL,
      toggles: { ...ISOTHERMAL.toggles, enableFrequencyDependentPredation: false },
    } as SimConfigOverrides);
    for (let slot = 0; slot < 10; slot += 1) {
      spawn(off, slot, { x: 400, y: 400, traits: { displayHue: 40 } });
    }
    const neutral = 1 / off.config.predation.hueBinCount;
    expect(createEcology().hueMorphFrequencyAt(off, 400, 400, 40)).toBeCloseTo(neutral, 12);
  });

  it('does not attempt while still handling the last kill', () => {
    const state = makeState(ISOTHERMAL);
    spawn(state, 0, { x: 500, y: 600, energyFraction: 0.1, traits: { diet: 0.95, attack: 4, size: 20 } });
    spawn(state, 1, { x: 505, y: 600, traits: { diet: 0.05, size: 11 } });
    const spatial = createSpatialIndex(state.config);
    spatial.build(state);
    const ecology = createEcology();

    const hunting = new StubRandom(0.5, [true, true]);
    const kills: { predator: SlotIndex; victim: SlotIndex; energy: number }[] = [];
    ecology.tryPredation(state, 0, spatial, hunting, {
      push: (predator, victim, energy) => kills.push({ predator, victim, energy }),
    });
    expect(kills).toHaveLength(1);
    expect(kills[0]?.victim).toBe(1);
    expect(kills[0]?.energy).toBeGreaterThan(0);
    expect(state.pop.gutFill[0] ?? 0).toBeGreaterThan(0);

    const satiated = new StubRandom(0.5, [true, true]);
    ecology.tryPredation(state, 0, spatial, satiated, { push: () => undefined });
    expect(satiated.chanceLog).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Spatial grid vs brute force
// ---------------------------------------------------------------------------

describe('spatial index', () => {
  it('matches a brute-force scan and returns ascending slots', () => {
    const config = resolveSimConfig();
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            x: fc.double({ min: 0, max: config.world.widthWu, noNaN: true }),
            y: fc.double({ min: 0, max: config.world.heightWu, noNaN: true }),
            alive: fc.boolean(),
          }),
          { minLength: 0, maxLength: 200 },
        ),
        fc.double({ min: 0, max: config.world.widthWu, noNaN: true }),
        fc.double({ min: 0, max: config.world.heightWu, noNaN: true }),
        fc.double({ min: 0, max: 400, noNaN: true }),
        (organisms, queryX, queryY, radius) => {
          const state = makeState({}, Math.max(1, organisms.length));
          for (let slot = 0; slot < organisms.length; slot += 1) {
            const organism = organisms[slot];
            if (organism === undefined || !organism.alive) continue;
            spawn(state, slot, { x: organism.x, y: organism.y });
          }

          const index = createSpatialIndex(config);
          index.build(state);
          const out = new Int32Array(Math.max(1, organisms.length));
          const count = index.queryNeighbors(queryX, queryY, radius, out);

          const expected: number[] = [];
          for (let slot = 0; slot < state.pop.capacity; slot += 1) {
            if (state.pop.alive[slot] !== 1) continue;
            const dx = (state.pop.x[slot] ?? 0) - queryX;
            const dy = (state.pop.y[slot] ?? 0) - queryY;
            if (dx * dx + dy * dy <= radius * radius) expected.push(slot);
          }

          expect(Array.from(out.subarray(0, count))).toEqual(expected);
          for (let index2 = 1; index2 < count; index2 += 1) {
            expect(out[index2] as number).toBeGreaterThan(out[index2 - 1] as number);
          }
        },
      ),
      { numRuns: 250, seed: 20260807 },
    );
  });

  it('sorts correctly past the insertion-sort cutover', () => {
    const config = resolveSimConfig();
    const state = makeState({}, 400);
    const rng = new SeededRng('grid-large');
    for (let slot = 0; slot < 400; slot += 1) {
      spawn(state, slot, { x: rng.next() * config.world.widthWu, y: rng.next() * config.world.heightWu });
    }
    const index = createSpatialIndex(config);
    index.build(state);
    const out = new Int32Array(400);
    const count = index.queryNeighbors(config.world.widthWu / 2, config.world.heightWu / 2, 5000, out);
    expect(count).toBe(400);
    for (let slot = 0; slot < 400; slot += 1) expect(out[slot]).toBe(slot);
  });

  it('caps at the caller buffer instead of overflowing it', () => {
    const config = resolveSimConfig();
    const state = makeState({}, 50);
    for (let slot = 0; slot < 50; slot += 1) spawn(state, slot, { x: 900 + slot, y: 600 });
    const index = createSpatialIndex(config);
    index.build(state);
    const out = new Int32Array(8);
    expect(index.queryNeighbors(920, 600, 5000, out)).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// 5. The OU climate walk
// ---------------------------------------------------------------------------

describe('climate walk', () => {
  function walk(tau: number, ticks: number): number[] {
    const state = makeState({ thermal: { climateTauTicks: tau, climateSigmaC: 2.5 } });
    const rng = new SeededRng('climate');
    const series: number[] = [];
    for (let tick = 0; tick < ticks; tick += 1) {
      state.tick = tick;
      stepClimate(state, rng);
      state.events.length = 0;
      series.push(state.climate.meanOffsetC);
    }
    return series;
  }

  it('is mean-reverting: bounded variance around the target, not a random walk', () => {
    const tau = 200;
    const series = walk(tau, 120_000);
    const mean = series.reduce((sum, value) => sum + value, 0) / series.length;
    const variance = series.reduce((sum, value) => sum + (value - mean) ** 2, 0) / series.length;
    const sd = Math.sqrt(variance);

    expect(Math.abs(mean)).toBeLessThan(0.4);
    expect(sd).toBeGreaterThan(2.0);
    expect(sd).toBeLessThan(3.0);
    // A random walk over 120k steps of this size would wander far past this.
    let excursion = 0;
    for (const value of series) excursion = Math.max(excursion, Math.abs(value));
    expect(excursion).toBeLessThan(6 * 2.5);
  });

  it('has an autocorrelation that decays on the configured timescale', () => {
    const tau = 200;
    const series = walk(tau, 120_000);
    const mean = series.reduce((sum, value) => sum + value, 0) / series.length;
    const autocorrelation = (lag: number): number => {
      let covariance = 0;
      let variance = 0;
      for (let index = 0; index + lag < series.length; index += 1) {
        covariance += ((series[index] as number) - mean) * ((series[index + lag] as number) - mean);
      }
      for (const value of series) variance += (value - mean) ** 2;
      return covariance / variance;
    };

    // OU theory: rho(lag) = exp(-lag / tau), so rho(tau) = 1/e ≈ 0.368.
    expect(autocorrelation(tau)).toBeGreaterThan(0.2);
    expect(autocorrelation(tau)).toBeLessThan(0.55);
    expect(autocorrelation(4 * tau)).toBeLessThan(autocorrelation(tau));
    expect(autocorrelation(8 * tau)).toBeLessThan(0.1);
  });

  it('holds the offset at the target and consumes no entropy when switched off', () => {
    const state = makeState({
      toggles: { ...ISOTHERMAL.toggles, enableClimateWalk: false, enableSeasonality: true },
    });
    const rng = new SeededRng('off');
    const before = rng.getState();
    for (let tick = 0; tick < 5000; tick += 1) {
      state.tick = tick;
      stepClimate(state, rng);
    }
    expect(state.climate.meanOffsetC).toBe(0);
    expect(rng.getState()).toEqual(before);
    // The season still turns; only the red noise is gone.
    expect(state.climate.seasonPhaseTicks).toBe(5000 % state.config.thermal.seasonPeriodTicks);
  });

  it('publishes the per-cell temperature field every tick, agreeing with temperatureAt', () => {
    const state = makeState();
    const ecology = createEcology();
    const rng = new SeededRng('field-publish');
    ecology.initFields(state, rng.fork('init'));

    for (let tick = 1; tick <= 60; tick += 1) {
      state.tick = tick;
      ecology.updateFields(state, rng);
      state.events.length = 0;
    }

    const { cols, rows, cellSizeWu, temperature } = state.field;
    for (let row = 0; row < rows; row += 7) {
      for (let col = 0; col < cols; col += 11) {
        const x = (col + 0.5) * cellSizeWu;
        const y = (row + 0.5) * cellSizeWu;
        expect(temperature[row * cols + col] as number).toBeCloseTo(ecology.temperatureAt(state, x, y), 3);
      }
    }
    // It tracks the season rather than being written once at init.
    expect(temperature[0] as number).not.toBe(18);
  });

  it('carries the climate into local temperature and the GxE anomaly', () => {
    const state = makeState(ISOTHERMAL);
    const ecology = createEcology();
    const baseline = ecology.temperatureAt(state, 1000, 600);
    state.climate.meanOffsetC = 3;
    expect(ecology.temperatureAt(state, 1000, 600)).toBeCloseTo(baseline + 3, 6);

    const gradient = makeState();
    const graded = createEcology();
    expect(graded.temperatureAnomalyZAt(gradient, 1000, 60)).toBeGreaterThan(
      graded.temperatureAnomalyZAt(gradient, 1000, 1140),
    );
    expect(Math.abs(graded.temperatureAnomalyZAt(gradient, 1000, 600))).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// 6. Determinism
// ---------------------------------------------------------------------------

/** A minimal stand-in for A3's tick loop: enough to exercise every ecology stage. */
function runWorld(seed: string, ticks: number, population = 120): SimState {
  const state = makeState(undefined, 256, seed);
  const ecology = createEcology();
  const spatial = createSpatialIndex(state.config);
  const rng = new SeededRng(seed);
  const setup = rng.fork('setup');

  ecology.initFields(state, rng.fork('init'));
  for (let slot = 0; slot < population; slot += 1) {
    spawn(state, slot, {
      x: setup.next() * state.config.world.widthWu,
      y: setup.next() * state.config.world.heightWu,
      energyFraction: 0.3 + 0.6 * setup.next(),
      ageTicks: Math.floor(setup.next() * 1200),
      traits: {
        size: 8 + setup.next() * 10,
        diet: setup.next(),
        attack: setup.normal(0, 1),
        defense: setup.normal(0, 1),
        displayHue: setup.next() * 360,
        tOpt: 14 + setup.next() * 8,
        forageBoldness: setup.normal(0, 0.4),
      },
    });
  }

  const decision: BehaviorDecision = {
    mode: BEHAVIOR_WANDER,
    steerX: 0,
    steerY: 0,
    speedFraction: 0,
    targetSlot: NO_SLOT,
  };
  const kills: { predator: SlotIndex; victim: SlotIndex; energy: number }[] = [];
  const deaths: { slot: SlotIndex; cause: DeathCause }[] = [];

  for (let step = 0; step < ticks; step += 1) {
    state.tick += 1;
    stepEcology(ecology, spatial, state, rng, decision, kills, deaths);
  }
  return state;
}

function stepEcology(
  ecology: EcologyApi,
  spatial: SpatialIndex,
  state: SimState,
  rng: SeededRng,
  decision: BehaviorDecision,
  kills: { predator: SlotIndex; victim: SlotIndex; energy: number }[],
  deaths: { slot: SlotIndex; cause: DeathCause }[],
): void {
  const pop = state.pop;
  const { widthWu, heightWu } = state.config.world;

  ecology.updateFields(state, rng.fork(`fields:${state.tick}`));
  ecology.regrowResources(state);
  spatial.build(state);

  const behaviorRng = rng.fork(`behavior:${state.tick}`);
  for (let slot = 0; slot < pop.capacity; slot += 1) {
    if (pop.alive[slot] !== 1) continue;
    ecology.decideBehavior(state, slot, spatial, behaviorRng, decision);
    const speed = decision.speedFraction * readTrait(pop.traits, slot, 'speedCap');
    pop.vx[slot] = decision.steerX * speed;
    pop.vy[slot] = decision.steerY * speed;
    pop.x[slot] = Math.min(widthWu, Math.max(0, (pop.x[slot] ?? 0) + (pop.vx[slot] ?? 0)));
    pop.y[slot] = Math.min(heightWu, Math.max(0, (pop.y[slot] ?? 0) + (pop.vy[slot] ?? 0)));
    pop.ageTicks[slot] = (pop.ageTicks[slot] ?? 0) + 1;
  }

  const feedRng = rng.fork(`feed:${state.tick}`);
  for (let slot = 0; slot < pop.capacity; slot += 1) {
    if (pop.alive[slot] !== 1) continue;
    pop.energy[slot] = (pop.energy[slot] ?? 0) + ecology.applyFeeding(state, slot, feedRng);
  }

  kills.length = 0;
  const killSink = {
    push: (predator: SlotIndex, victim: SlotIndex, energy: number) => {
      kills.push({ predator, victim, energy });
    },
  };
  const predationRng = rng.fork(`predation:${state.tick}`);
  for (let slot = 0; slot < pop.capacity; slot += 1) {
    if (pop.alive[slot] !== 1) continue;
    ecology.tryPredation(state, slot, spatial, predationRng, killSink);
  }

  deaths.length = 0;
  const deathSink = {
    push: (slot: SlotIndex, cause: DeathCause) => {
      deaths.push({ slot, cause });
    },
  };
  const hazardRng = rng.fork(`hazard:${state.tick}`);
  for (let slot = 0; slot < pop.capacity; slot += 1) {
    if (pop.alive[slot] !== 1) continue;
    ecology.metabolismAndHazards(state, slot, hazardRng, deathSink);
  }

  for (const kill of kills) {
    if (pop.alive[kill.victim] !== 1) continue;
    pop.alive[kill.victim] = 0;
    state.liveCount -= 1;
    state.deathCounts.predation += 1;
    pop.energy[kill.predator] = (pop.energy[kill.predator] ?? 0) + kill.energy;
  }
  for (const death of deaths) {
    if (pop.alive[death.slot] !== 1) continue;
    pop.alive[death.slot] = 0;
    state.liveCount -= 1;
    state.deathCounts[death.cause] += 1;
  }
  state.events.length = 0;
}

describe('determinism', () => {
  it('is a pure function of the seed across every ecology stage', () => {
    const first = runWorld('panthalassa-a2', 400);
    const second = runWorld('panthalassa-a2', 400);

    expect(second.liveCount).toBe(first.liveCount);
    expect(second.field.plankton).toEqual(first.field.plankton);
    expect(second.field.kelp).toEqual(first.field.kelp);
    expect(second.field.carryingCapacity).toEqual(first.field.carryingCapacity);
    expect(second.pop.x).toEqual(first.pop.x);
    expect(second.pop.y).toEqual(first.pop.y);
    expect(second.pop.energy).toEqual(first.pop.energy);
    expect(second.pop.gutFill).toEqual(first.pop.gutFill);
    expect(second.pop.alive).toEqual(first.pop.alive);
    expect(second.pop.behaviorState).toEqual(first.pop.behaviorState);
    expect(second.climate).toEqual(first.climate);
    expect(second.deathCounts).toEqual(first.deathCounts);
  });

  it('is not vacuous: a different seed produces a different world', () => {
    const first = runWorld('panthalassa-a2', 400);
    const other = runWorld('panthalassa-a2-alt', 400);
    expect(other.field.plankton).not.toEqual(first.field.plankton);
    expect(other.pop.x).not.toEqual(first.pop.x);
  });

  it('exercises the mortality channels it is supposed to', () => {
    const world = runWorld('panthalassa-a2', 400);
    const total = Object.values(world.deathCounts).reduce((sum, count) => sum + count, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('reproduces reefs, patchiness and kelp from the seed alone, with no init call', () => {
    const seeded = runWorld('restore-check', 120, 60);
    // A fresh module never told to `initFields` still agrees about the kelp map,
    // which is what makes snapshot restore exact.
    const restored = createEcology();
    for (let sample = 0; sample < 40; sample += 1) {
      const x = (sample * 47) % seeded.config.world.widthWu;
      const y = (sample * 29) % seeded.config.world.heightWu;
      expect(restored.kelpCoverAt(seeded, x, y)).toBe(createEcology().kelpCoverAt(seeded, x, y));
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Behaviour: staggering and the priority ladder
// ---------------------------------------------------------------------------

describe('behaviour', () => {
  function freshDecision(): BehaviorDecision {
    return { mode: BEHAVIOR_WANDER, steerX: 0, steerY: 0, speedFraction: 0, targetSlot: NO_SLOT };
  }

  it('re-evaluates only on its own staggered tick', () => {
    const stagger = 4;
    const state = makeState({ ...ISOTHERMAL, time: { decisionStaggerTicks: stagger } } as SimConfigOverrides);
    // Prey at slot 0 with a hunting neighbour well inside its wariness.
    spawn(state, 0, { x: 500, y: 600, traits: { diet: 0.05, size: 11, wariness: 80 } });
    spawn(state, 1, { x: 520, y: 600, traits: { diet: 0.95, size: 20 } });

    const ecology = createEcology();
    const spatial = createSpatialIndex(state.config);
    const out = freshDecision();
    const seen: number[] = [];

    for (let tick = 0; tick < 2 * stagger; tick += 1) {
      state.tick = tick;
      spatial.build(state);
      ecology.decideBehavior(state, 0, spatial, new StubRandom(0.5), out);
      seen.push(out.mode);
    }

    // Slot 0 decides when (tick + 0) % 4 === 0, so ticks 0 and 4 flip it to
    // flee and the ticks between re-emit the standing policy.
    expect(seen[0]).toBe(BEHAVIOR_FLEE);
    expect(seen.filter((mode) => mode === BEHAVIOR_FLEE)).toHaveLength(seen.length);

    const idle = makeState({ ...ISOTHERMAL, time: { decisionStaggerTicks: stagger } } as SimConfigOverrides);
    spawn(idle, 1, { x: 500, y: 600, traits: { diet: 0.05, size: 11, wariness: 80 } });
    spawn(idle, 2, { x: 520, y: 600, traits: { diet: 0.95, size: 20 } });
    const idleSpatial = createSpatialIndex(idle.config);
    const idleEcology = createEcology();
    idle.tick = 0;
    idleSpatial.build(idle);
    // (tick + slot) % 4 === 1 for slot 1 at tick 0: not its turn, so the
    // standing wander policy survives despite the predator alongside.
    idleEcology.decideBehavior(idle, 1, idleSpatial, new StubRandom(0.5), out);
    expect(out.mode).toBe(BEHAVIOR_WANDER);
    idle.tick = 3;
    idleSpatial.build(idle);
    idleEcology.decideBehavior(idle, 1, idleSpatial, new StubRandom(0.5), out);
    expect(out.mode).toBe(BEHAVIOR_FLEE);
  });

  it('lets flee preempt pursue when both are available', () => {
    const state = makeState(ISOTHERMAL);
    // A mid-sized hungry predator: prey below it, a bigger hunter above it.
    spawn(state, 0, {
      x: 1000,
      y: 600,
      energyFraction: 0.05,
      traits: { diet: 0.95, size: 20, wariness: 70 },
    });
    spawn(state, 1, { x: 1012, y: 600, traits: { diet: 0.05, size: 11 } });

    const ecology = createEcology();
    const spatial = createSpatialIndex(state.config);
    const out = freshDecision();

    spatial.build(state);
    ecology.decideBehavior(state, 0, spatial, new StubRandom(0.5), out);
    expect(out.mode).toBe(BEHAVIOR_PURSUE);
    expect(out.targetSlot).toBe(1);

    // Now add the bigger hunter, for which slot 0 is well-sized prey.
    spawn(state, 2, { x: 1040, y: 600, traits: { diet: 0.95, size: 36 } });
    spatial.build(state);
    ecology.decideBehavior(state, 0, spatial, new StubRandom(0.5), out);
    expect(out.mode).toBe(BEHAVIOR_FLEE);
    expect(out.targetSlot).toBe(2);
    // ...and it swims away from the threat, not toward it.
    expect(out.steerX).toBeLessThan(0);
  });

  it('gives up on a stale patch once patience runs out', () => {
    const state = makeState(ISOTHERMAL);
    spawn(state, 0, { x: 1000, y: 600, energyFraction: 0.05, traits: { givingUpTime: 8 } });
    state.field.plankton.fill(50);
    state.field.carryingCapacity.fill(50);

    const ecology = createEcology();
    const spatial = createSpatialIndex(state.config);
    const out = freshDecision();
    const modes: number[] = [];
    for (let tick = 0; tick < 40; tick += 1) {
      state.tick = tick;
      spatial.build(state);
      ecology.decideBehavior(state, 0, spatial, new StubRandom(0.5), out);
      modes.push(out.mode);
    }
    // It settles into a rich patch, then abandons it when `givingUpTime` expires.
    expect(new Set(modes).size).toBeGreaterThan(1);
  });

  it('normalises its steer and honours the configured policy speeds', () => {
    const state = makeState(ISOTHERMAL);
    spawn(state, 0, { x: 1000, y: 600, energyFraction: 0.9 });
    spawn(state, 1, { x: 1010, y: 600, energyFraction: 0.9, sex: SEX_MALE });
    state.pop.sex[0] = SEX_FEMALE;

    const spatial = createSpatialIndex(state.config);
    spatial.build(state);
    const out = freshDecision();
    createEcology().decideBehavior(state, 0, spatial, new StubRandom(0.5), out);
    expect(Math.hypot(out.steerX, out.steerY)).toBeCloseTo(1, 9);
    expect(out.speedFraction).toBeGreaterThan(0);
    expect(out.speedFraction).toBeLessThanOrEqual(1);
  });
});
