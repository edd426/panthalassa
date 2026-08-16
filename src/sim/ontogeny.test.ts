/**
 * G2 — ontogeny: growth, size-based maturity, genetic provisioning, cannibalism.
 *
 * Two arms are pinned here. The **off** arm must be inert: `sizeCurrent` is the
 * expressed `size` trait to the bit and never moves, which is what lets the
 * golden trajectory hash in `probes/disturbance-units.test.ts` stay untouched.
 * The **on** arm is asserted through the engine wherever the claim is about the
 * world (a fish grows, stunts, matures late, pays for its clutch) and through
 * the frozen formulas only where the claim is about the price curve itself.
 */

import { describe, expect, it } from 'vitest';

import type { KillSink } from '../contracts/apis';
import { clutchInvestment, tissueCostPerCm } from '../contracts/formulas';
import type { RandomSource, RngState, SimConfig, SimConfigOverrides, SlotIndex } from '../contracts/types';
import { TRAIT_COUNT } from '../contracts/traits';
import { resolveSimConfig } from '../contracts/types';
import { buildModules } from '../probes/harness';
import { createEcology } from './ecology';
import { createSim } from './engine';
import type { SimHandleInternal } from './engine';
import { T, isMature, traitAt } from './organisms';
import { createSpatialIndex } from './spatial';

function makeSim(seed: string, overrides: SimConfigOverrides): SimHandleInternal {
  const config = resolveSimConfig(overrides);
  const { modules } = buildModules(config);
  return createSim({ seed, config: overrides, modules });
}

function firstLiveSlot(sim: SimHandleInternal): SlotIndex {
  for (let slot = 0; slot < sim.pools.capacity; slot += 1) {
    if ((sim.pools.alive[slot] ?? 0) === 1) return slot;
  }
  throw new Error('no live organism');
}

/**
 * A world where the only thing that can kill the fish under observation is
 * running out of energy, so a growth trajectory is not cut short by a hazard
 * roll that has nothing to do with ontogeny.
 */
const QUIET: SimConfigOverrides = {
  world: {
    widthWu: 400,
    heightWu: 240,
    initialPopulation: 6,
    slotCapacity: 128,
    fieldCellSizeWu: 20,
    spatialCellSizeWu: 80,
  },
  senescence: { gompertzA: 0 },
  thermal: { hazardCoef: 0 },
  predation: { baseLogit: -50 },
  toggles: {
    enableOntogeny: true,
    enableDisturbances: false,
    enableCarrion: false,
    enableClimateWalk: false,
    enableSeasonality: false,
  },
};

/** {@link QUIET} with the axis switched off, for the inertness assertions. */
const QUIET_OFF: SimConfigOverrides = { ...QUIET, toggles: { ...QUIET.toggles, enableOntogeny: false } };

/**
 * {@link QUIET} with the plankton carrying capacity at zero. Wiping the field
 * by hand is not enough — regrowth carries a propagule term, so an empty cell
 * with positive K re-seeds itself — but at K = 0 the field decays to nothing
 * and stays there, which is a famine with no back door.
 */
const STARVED: SimConfigOverrides = { ...QUIET, resources: { planktonCarryingCapacityBase: 0 } };

/** A world big enough to breed in, for the assertions that need newborns. */
const BREEDING_OFF: SimConfigOverrides = {
  ...QUIET_OFF,
  world: { ...QUIET_OFF.world, widthWu: 800, heightWu: 500, initialPopulation: 80, slotCapacity: 1024 },
};

describe('ontogeny: the off arm is inert', () => {
  it('keeps sizeCurrent bit-equal to the expressed size trait for every organism', () => {
    const sim = makeSim('ontogeny-off-inert', BREEDING_OFF);
    sim.step(1_500);
    expect(sim.diagnostics.birthsApplied).toBeGreaterThan(0);

    const pools = sim.pools;
    let checked = 0;
    for (let slot = 0; slot < pools.capacity; slot += 1) {
      if ((pools.alive[slot] ?? 0) === 0) continue;
      expect(pools.sizeCurrent[slot]).toBe(traitAt(pools, slot, T.size));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('leaves maturity on the age floor alone', () => {
    const sim = makeSim('ontogeny-off-maturity', QUIET_OFF);
    const slot = firstLiveSlot(sim);
    // A fish a tenth of its target length is still an adult when the axis is
    // off: nothing reads realised length in that arm.
    sim.pools.sizeCurrent[slot] = 0.1 * traitAt(sim.pools, slot, T.size);
    sim.pools.ageTicks[slot] = sim.state.config.time.maturityTicks;
    expect(isMature(sim.state, slot)).toBe(true);
  });
});

describe('ontogeny: somatic growth', () => {
  it('grows a juvenile toward its target and decelerates on the way', () => {
    const sim = makeSim('growth-trajectory', QUIET);
    const pools = sim.pools;
    const slot = firstLiveSlot(sim);
    const id = pools.id[slot];
    const target = traitAt(pools, slot, T.size);

    pools.sizeCurrent[slot] = 2.5;
    const lengths: number[] = [2.5];
    for (let window = 0; window < 12; window += 1) {
      sim.step(50);
      expect(pools.alive[slot]).toBe(1);
      expect(pools.id[slot]).toBe(id);
      lengths.push(pools.sizeCurrent[slot] ?? 0);
    }

    for (let index = 1; index < lengths.length; index += 1) {
      expect(lengths[index]).toBeGreaterThan(lengths[index - 1] ?? 0);
    }
    // It gets most of the way to its genetic target...
    expect(lengths[lengths.length - 1]).toBeGreaterThan(0.75 * target);
    // ...and the last 50 ticks buy far less length than the first 50, because
    // tissue costs rise with L² and again with (L/Ltarget)^overshootExponent.
    const first = (lengths[1] ?? 0) - (lengths[0] ?? 0);
    const last = (lengths[lengths.length - 1] ?? 0) - (lengths[lengths.length - 2] ?? 0);
    expect(last).toBeLessThan(first / 2);
  });

  it('stunts on zero surplus: a starving juvenile burns reserves and does not grow', () => {
    const sim = makeSim('growth-stunting', STARVED);
    const pools = sim.pools;
    const slot = firstLiveSlot(sim);
    pools.sizeCurrent[slot] = 2.5;

    sim.step(1);
    const energyBefore = pools.energy[slot] ?? 0;
    sim.step(40);

    expect(sim.state.field.plankton.reduce((sum, value) => sum + value, 0)).toBe(0);
    expect(pools.alive[slot]).toBe(1);
    expect(pools.sizeCurrent[slot]).toBe(2.5);
    expect(pools.energy[slot] ?? 0).toBeLessThan(energyBefore);
  });

  it('permits overshoot past the target and prices it steeply', () => {
    const sim = makeSim('growth-overshoot', QUIET);
    const pools = sim.pools;
    const config = sim.state.config;
    const slot = firstLiveSlot(sim);
    const target = traitAt(pools, slot, T.size);

    const start = 1.15 * target;
    pools.sizeCurrent[slot] = start;
    sim.step(200);

    // No clamp anywhere: an animal already past its target still grows, it just
    // buys very little length for the energy.
    expect(pools.alive[slot]).toBe(1);
    expect(pools.sizeCurrent[slot] ?? 0).toBeGreaterThan(start);

    const belowTarget = tissueCostPerCm(0.5 * target, target, config);
    const atTarget = tissueCostPerCm(target, target, config);
    const pastTarget = tissueCostPerCm(1.5 * target, target, config);
    expect(atTarget / belowTarget).toBeGreaterThan(5);
    expect(pastTarget / atTarget).toBeGreaterThan(5);
  });
});

describe('ontogeny: maturity is length plus an age floor', () => {
  it('holds a full-grown but young fish immature (the age floor binds)', () => {
    const sim = makeSim('maturity-age-floor', QUIET);
    const pools = sim.pools;
    const slot = firstLiveSlot(sim);
    pools.sizeCurrent[slot] = traitAt(pools, slot, T.size);

    pools.ageTicks[slot] = sim.state.config.time.maturityTicks - 1;
    expect(isMature(sim.state, slot)).toBe(false);
    pools.ageTicks[slot] = sim.state.config.time.maturityTicks;
    expect(isMature(sim.state, slot)).toBe(true);
  });

  it('makes age at maturity emergent: the fed fish recruits, the starved one does not', () => {
    const prepare = (seed: string, overrides: SimConfigOverrides): SimHandleInternal => {
      const sim = makeSim(seed, overrides);
      const slot = firstLiveSlot(sim);
      sim.pools.sizeCurrent[slot] = 2.5;
      // Both fish are already past the age floor, so anything that separates
      // them is length, which is to say food.
      sim.pools.ageTicks[slot] = sim.state.config.time.maturityTicks;
      return sim;
    };

    const fed = prepare('maturity-fed', QUIET);
    const starved = prepare('maturity-starved', STARVED);

    const fedSlot = firstLiveSlot(fed);
    const starvedSlot = firstLiveSlot(starved);
    expect(isMature(fed.state, fedSlot)).toBe(false);
    expect(isMature(starved.state, starvedSlot)).toBe(false);

    fed.step(800);
    starved.step(800);

    expect(isMature(fed.state, fedSlot)).toBe(true);
    expect(starved.pools.sizeCurrent[starvedSlot]).toBe(2.5);
    expect(isMature(starved.state, starvedSlot)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Clutch and provisioning
// ---------------------------------------------------------------------------

/** Two founders, no hazards, no food: one mating per tick under full control. */
const REPRO_RIG: SimConfigOverrides = {
  world: {
    widthWu: 120,
    heightWu: 120,
    initialPopulation: 2,
    slotCapacity: 256,
    fieldCellSizeWu: 30,
    spatialCellSizeWu: 60,
  },
  time: { maturityTicks: 0 },
  mating: {
    matingCooldownTicks: 0,
    surveyRadiusWu: 400,
    femaleReadyEnergyFraction: 0.01,
    paternalCostFraction: 0,
  },
  senescence: { gompertzA: 0 },
  thermal: { hazardCoef: 0 },
  predation: { baseLogit: -50 },
  genetics: { traitBaselineOverrides: { fecundity: 12 } },
  toggles: {
    enableOntogeny: true,
    enableAssortativeMating: false,
    enableDisturbances: false,
    enableCarrion: false,
    enableClimateWalk: false,
    enableSeasonality: false,
  },
};

/** Step one tick and report the clutch that landed, plus what the mother paid. */
function mateOnce(sim: SimHandleInternal, motherSlot: SlotIndex): { clutch: number; paid: number } {
  const motherId = sim.pools.id[motherSlot] ?? 0;
  const before = sim.pools.energy[motherSlot] ?? 0;
  const events = sim.step(1);
  const clutch = events.filter((event) => event.kind === 'birth' && event.motherId === motherId).length;
  return { clutch, paid: before - (sim.pools.energy[motherSlot] ?? 0) };
}

describe('ontogeny: clutch size and provisioning', () => {
  it('drives the Poisson mean off the fecundity trait, not mating.clutchLambda', () => {
    const overrides: SimConfigOverrides = {
      world: { widthWu: 700, heightWu: 450, initialPopulation: 120, slotCapacity: 4096, fieldCellSizeWu: 25 },
      // Far from the realised mean either way, so the two arms cannot be
      // confused with each other.
      mating: { clutchLambda: 1, paternalCostFraction: 0 },
      genetics: { traitBaselineOverrides: { fecundity: 6 } },
      // Cheap eggs: this test is about the draw, not about truncation.
      growth: { provisionEnergyPerCm: 0.01 },
      senescence: { gompertzA: 0 },
      toggles: { enableOntogeny: true, enableDisturbances: false, enableCarrion: false },
    };
    const on = makeSim('clutch-mean-on', overrides);
    const off = makeSim('clutch-mean-off', { ...overrides, toggles: { ...overrides.toggles, enableOntogeny: false } });
    on.step(6_000);
    off.step(6_000);

    expect(on.diagnostics.birthsDropped).toBe(0);
    expect(off.diagnostics.birthsDropped).toBe(0);
    expect(on.diagnostics.matingsRealized).toBeGreaterThan(60);
    expect(off.diagnostics.matingsRealized).toBeGreaterThan(60);

    // Births per *realised* mating, which is the zero-truncated Poisson mean
    // (a clutch of 0 never becomes a mating), so the expectation is
    // λ / (1 − e^−λ): ≈ 6.0 against the fecundity trait and ≈ 1.6 against
    // clutchLambda, less whatever the energy budget truncates.
    const onMean = on.diagnostics.birthsApplied / on.diagnostics.matingsRealized;
    const offMean = off.diagnostics.birthsApplied / off.diagnostics.matingsRealized;
    expect(onMean).toBeGreaterThan(5);
    expect(onMean).toBeLessThan(7);
    expect(offMean).toBeGreaterThan(1.1);
    expect(offMean).toBeLessThan(2);
  });

  it('truncates an energy-poor mother to what she can provision, and mints nothing', () => {
    const sim = makeSim('clutch-truncation', REPRO_RIG);
    const config = sim.state.config;
    const pools = sim.pools;
    // No intake anywhere, so the only thing that moves her energy this tick is
    // the metabolic burn and the clutch she pays for.
    sim.state.field.plankton.fill(0);

    const mother = firstLiveSlot(sim);
    const perOffspring = clutchInvestment(traitAt(pools, mother, T.offspringSize), 1, config);
    const fecundity = traitAt(pools, mother, T.fecundity);
    expect(fecundity).toBeGreaterThan(8);

    pools.energy[mother] = 2.9 * perOffspring;
    const poor = mateOnce(sim, mother);
    expect(poor.clutch).toBeGreaterThan(0);
    expect(poor.clutch).toBeLessThanOrEqual(2);
    expect(poor.paid).toBeGreaterThanOrEqual(poor.clutch * perOffspring);
    expect(pools.energy[mother] ?? 0).toBeGreaterThanOrEqual(0);

    // Same mother, same tick machinery, a hundred eggs' worth of reserves: the
    // constraint was the energy, not the trait.
    pools.energy[mother] = 100 * perOffspring;
    const rich = mateOnce(sim, mother);
    expect(rich.clutch).toBeGreaterThan(poor.clutch);
    expect(rich.paid).toBeGreaterThanOrEqual(rich.clutch * perOffspring);
  });

  it('hatches offspring at their own expressed offspringSize with a matching reserve', () => {
    const sim = makeSim('clutch-hatchlings', REPRO_RIG);
    const config = sim.state.config;
    const pools = sim.pools;
    const mother = firstLiveSlot(sim);
    pools.energy[mother] = 100 * clutchInvestment(traitAt(pools, mother, T.offspringSize), 1, config);

    const before = sim.state.liveCount;
    const { clutch } = mateOnce(sim, mother);
    expect(clutch).toBeGreaterThan(0);
    expect(sim.state.liveCount).toBe(before + clutch);

    let hatchlings = 0;
    for (let slot = 0; slot < pools.capacity; slot += 1) {
      if ((pools.alive[slot] ?? 0) === 0) continue;
      if ((pools.ageTicks[slot] ?? 0) !== 0) continue;
      hatchlings += 1;
      // Born at its own genotype's egg size, well under its adult target.
      expect(pools.sizeCurrent[slot]).toBe(traitAt(pools, slot, T.offspringSize));
      expect(pools.sizeCurrent[slot] ?? 0).toBeLessThan(0.5 * traitAt(pools, slot, T.size));
      // And carrying a reserve scaled by that provisioning: at the founder
      // baseline the ratio is 1, so a hatchling starts within a few percent of
      // `metabolism.birthEnergy`.
      expect(pools.energy[slot] ?? 0).toBeGreaterThan(0.5 * config.metabolism.birthEnergy);
      expect(pools.energy[slot] ?? 0).toBeLessThan(2 * config.metabolism.birthEnergy);
    }
    expect(hatchlings).toBe(clutch);
  });
});

// ---------------------------------------------------------------------------
// Cannibalism
// ---------------------------------------------------------------------------

/** Says yes to everything and records the probability it was asked about. */
class AlwaysChance implements RandomSource {
  readonly asked: number[] = [];

  next(): number {
    return 0.5;
  }

  int(min: number): number {
    return min;
  }

  chance(probability: number): boolean {
    this.asked.push(probability);
    return true;
  }

  pick<T>(values: readonly T[]): T {
    return values[0] as T;
  }

  normal(mean = 0): number {
    return mean;
  }

  poisson(lambda: number): number {
    return Math.round(lambda);
  }

  laplace(mean = 0): number {
    return mean;
  }

  fork(): RandomSource {
    return this;
  }

  getState(): RngState {
    return [1, 2, 3, 4];
  }

  setState(): void {
    /* the stub has no state to restore */
  }
}

const CANNIBALISM_RIG: SimConfigOverrides = {
  world: {
    widthWu: 200,
    heightWu: 200,
    initialPopulation: 2,
    slotCapacity: 16,
    fieldCellSizeWu: 50,
    spatialCellSizeWu: 100,
  },
  toggles: { enableOntogeny: true, enableDisturbances: false, enableCarrion: false, enableSeasonality: false },
};

/**
 * The kill probability the kernel computes for slot 0 attacking slot 1, read
 * off a scripted RNG. The first `chance` is the diet-driven attempt gate; the
 * second is the kill roll.
 */
function killProbability(sim: SimHandleInternal, victimTag: number, ecology = createEcology()): number {
  const pools = sim.pools;
  const spatial = createSpatialIndex(sim.state.config);
  spatial.build(sim.state);

  pools.speciesTag[1] = victimTag;
  // A kill was pushed by the previous probe; the gut has to be empty or the
  // predator declines to hunt at all.
  pools.gutFill[0] = 0;

  const rng = new AlwaysChance();
  const sink: KillSink = { push: () => undefined };
  ecology.tryPredation(sim.state, 0, spatial, rng, sink);
  expect(rng.asked.length).toBeGreaterThanOrEqual(2);
  return rng.asked[1] ?? 0;
}

function armCannibalismRig(seed: string, overrides: SimConfigOverrides): SimHandleInternal {
  const sim = makeSim(seed, overrides);
  const pools = sim.pools;
  const config = sim.state.config;

  for (const slot of [0, 1]) {
    pools.x[slot] = 100;
    pools.y[slot] = 100 + slot * 5;
    pools.gutFill[slot] = 0;
    pools.speciesTag[slot] = 0;
    pools.traits[slot * TRAIT_COUNT + T.diet] = 1;
  }
  // Predator big, victim right inside the size window, both hungry enough to hunt.
  pools.sizeCurrent[0] = 20;
  pools.sizeCurrent[1] = 20 * config.predation.sizeRatioOptimum;
  pools.energy[0] = 0.01;
  pools.energy[1] = 0.01;
  return sim;
}

describe('ontogeny: cannibalism is priced, not banned', () => {
  it('charges the conspecific logit when predator and victim share a tag', () => {
    const sim = armCannibalismRig('cannibalism-on', CANNIBALISM_RIG);
    const conspecificLogit = sim.state.config.growth.conspecificLogit;
    expect(conspecificLogit).toBeLessThan(0);

    const ecology = createEcology();
    const sameTag = killProbability(sim, 0, ecology);
    const otherTag = killProbability(sim, 7, ecology);

    expect(sameTag).toBeGreaterThan(0);
    expect(sameTag).toBeLessThan(otherTag);
    // Exactly the logit the config names: same kernel, one term added.
    const odds = (p: number): number => p / (1 - p);
    expect(Math.log(odds(sameTag) / odds(otherTag))).toBeCloseTo(conspecificLogit, 6);
  });

  it('adds no term at all with the toggle off', () => {
    const sim = armCannibalismRig('cannibalism-off', {
      ...CANNIBALISM_RIG,
      toggles: { ...CANNIBALISM_RIG.toggles, enableOntogeny: false },
    });
    const ecology = createEcology();
    expect(killProbability(sim, 0, ecology)).toBe(killProbability(sim, 7, ecology));
  });
});

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

describe('ontogeny: snapshots', () => {
  it('round-trips sizeCurrent and continues tick-for-tick with the axis on', () => {
    const overrides: SimConfigOverrides = {
      world: { widthWu: 400, heightWu: 240, initialPopulation: 40, slotCapacity: 512, fieldCellSizeWu: 20 },
      toggles: { enableOntogeny: true },
    };
    const sim = makeSim('ontogeny-snapshot', overrides);
    sim.step(400);

    const snapshot = structuredClone(sim.snapshot());
    const config: SimConfig = resolveSimConfig(overrides);
    const { modules } = buildModules(config);
    const restored = createSim({ seed: sim.state.seed, config: overrides, modules, snapshot });

    expect(restored.stateHash()).toBe(snapshot.stateHash);
    expect(Array.from(restored.pools.sizeCurrent)).toEqual(Array.from(sim.pools.sizeCurrent));

    // The column has to be carrying information the trait no longer does, or
    // this test would pass on a world where nothing ever grew.
    let juveniles = 0;
    for (let slot = 0; slot < sim.pools.capacity; slot += 1) {
      if ((sim.pools.alive[slot] ?? 0) === 0) continue;
      if ((sim.pools.sizeCurrent[slot] ?? 0) !== traitAt(sim.pools, slot, T.size)) juveniles += 1;
    }
    expect(juveniles).toBeGreaterThan(0);

    for (let window = 0; window < 5; window += 1) {
      sim.step(40);
      restored.step(40);
      expect(restored.stateHash()).toBe(sim.stateHash());
    }
    expect(restored.state.liveCount).toBe(sim.state.liveCount);
  });
});
