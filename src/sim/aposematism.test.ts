/**
 * G3 — aposematism: toxin, signal, and the population statistic that pays for it.
 *
 * The **off** arm must be inert to the draw: every term and every roll this
 * package adds is gated on `toggles.enableAposematism`, so a world with the
 * toggle off is bit-identical however violently the `aposematism.*` knobs are
 * set. That is what lets the golden trajectory hash in
 * `probes/disturbance-units.test.ts` stay untouched, and it is asserted here
 * directly rather than inferred from that hash.
 *
 * The **on** arm is asserted through the stage functions wherever the claim is
 * about the world (a meal is smaller, a predator dies, a male is preferred) and
 * against the frozen formulas only where the claim is about the shape of a term.
 */

import { describe, expect, it } from 'vitest';

import type { KillSink, DeathSink } from '../contracts/apis';
import {
  aposematismLogit,
  toxinMetabolicCostPerTick,
  toxinYieldMultiplier,
} from '../contracts/formulas';
import { DISCRETE_LOCUS_BY_ID, createEmptyGenome, discreteAlleleIndex } from '../contracts/genome';
import type { Genome } from '../contracts/genome';
import { TRAIT_COUNT, TRAIT_INDEX } from '../contracts/traits';
import type { RandomSource, RngState, SimConfigOverrides, SlotIndex } from '../contracts/types';
import { resolveSimConfig, SEX_MALE } from '../contracts/types';
import { buildModules } from '../probes/harness';
import { createEcology } from './ecology';
import { hueBinToxicityAt } from './ecology/predation';
import { ensureRuntime } from './ecology/runtime';
import { createSim, inventsToxinMacro } from './engine';
import type { SimHandleInternal } from './engine';
import { createMating } from './mating';
import { T, traitAt } from './organisms';
import { createSpatialIndex } from './spatial';

const T_TOXICITY = TRAIT_INDEX.toxicity;
const T_CONSPICUOUSNESS = TRAIT_INDEX.conspicuousness;

function makeSim(seed: string, overrides: SimConfigOverrides): SimHandleInternal {
  const config = resolveSimConfig(overrides);
  const { modules } = buildModules(config);
  return createSim({ seed, config: overrides, modules });
}

function firstLiveSlot(sim: SimHandleInternal, from = 0): SlotIndex {
  for (let slot = from; slot < sim.pools.capacity; slot += 1) {
    if ((sim.pools.alive[slot] ?? 0) === 1) return slot;
  }
  throw new Error('no live organism');
}

function setTrait(sim: SimHandleInternal, slot: SlotIndex, offset: number, value: number): void {
  sim.pools.traits[slot * TRAIT_COUNT + offset] = value;
}

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

// ---------------------------------------------------------------------------
// The off arm
// ---------------------------------------------------------------------------

/** Coefficients far past anything A7 would tune to; any leak shows up as a hash mismatch. */
const VIOLENT_APOSEMATISM = {
  toxinYieldCoef: 40,
  toxinHazardCoef: 25,
  aposematismCoef: 60,
  conspicuousnessDetectionCoef: 45,
  conspicuousnessMatingCoef: 90,
  toxinCostCoef: 70,
};

describe('aposematism: the off arm is inert', () => {
  it('ignores every aposematism coefficient with the toggle off', () => {
    const base: SimConfigOverrides = {
      world: { widthWu: 400, heightWu: 260, initialPopulation: 40, slotCapacity: 512, fieldCellSizeWu: 20 },
    };
    const quiet = makeSim('aposematism-off-inert', base);
    const violent = makeSim('aposematism-off-inert', { ...base, aposematism: VIOLENT_APOSEMATISM });

    for (let window = 0; window < 5; window += 1) {
      quiet.step(60);
      violent.step(60);
      // Same hash tick after tick, not just at the end: a leaked draw that
      // cancelled out by tick 300 would still be a leaked draw.
      expect(violent.stateHash()).toBe(quiet.stateHash());
    }
    expect(quiet.diagnostics.birthsApplied).toBeGreaterThan(0);
    expect(quiet.state.deathCounts.toxin).toBe(0);
    expect(violent.state.deathCounts.toxin).toBe(0);
  });

  it('reports a hue bin as untoxic off the toggle, however toxic its occupants are', () => {
    const overrides: SimConfigOverrides = {
      world: { widthWu: 200, heightWu: 200, initialPopulation: 4, slotCapacity: 16, fieldCellSizeWu: 50 },
    };
    const sim = makeSim('bin-toxicity-off', overrides);
    const slot = firstLiveSlot(sim);
    setTrait(sim, slot, T_TOXICITY, 9);
    const runtime = ensureRuntime(undefined, sim.state);
    const x = sim.pools.x[slot] ?? 0;
    const y = sim.pools.y[slot] ?? 0;
    expect(hueBinToxicityAt(runtime, sim.state, x, y, traitAt(sim.pools, slot, T.displayHue))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Predation: yield, hazard, and the aposematic credit
// ---------------------------------------------------------------------------

/**
 * Two animals in one cell: slot 0 hunts, slot 1 is inside its size window. Their
 * display hues sit two bins apart, so the victim is alone in its hue bin and the
 * bin's mean toxicity is exactly the victim's own — which is what makes the
 * aposematic term checkable against the frozen formula rather than against a
 * population average nobody can reproduce.
 */
const PREDATION_RIG: SimConfigOverrides = {
  world: {
    widthWu: 200,
    heightWu: 200,
    initialPopulation: 2,
    slotCapacity: 16,
    fieldCellSizeWu: 50,
    spatialCellSizeWu: 100,
  },
  senescence: { gompertzA: 0 },
  thermal: { hazardCoef: 0 },
  toggles: {
    enableAposematism: true,
    enableDisturbances: false,
    enableCarrion: false,
    enableSeasonality: false,
    enableClimateWalk: false,
  },
};

function armPredationRig(seed: string, overrides: SimConfigOverrides = PREDATION_RIG): SimHandleInternal {
  const sim = makeSim(seed, overrides);
  const pools = sim.pools;
  const config = sim.state.config;

  for (const slot of [0, 1]) {
    pools.x[slot] = 100;
    pools.y[slot] = 100 + slot * 5;
    pools.gutFill[slot] = 0;
    pools.speciesTag[slot] = slot;
    setTrait(sim, slot, T.diet, 1);
    setTrait(sim, slot, T_CONSPICUOUSNESS, 0);
    setTrait(sim, slot, T_TOXICITY, 0);
  }
  setTrait(sim, 0, T.displayHue, 0);
  setTrait(sim, 1, T.displayHue, 180);
  pools.sizeCurrent[0] = 20;
  pools.sizeCurrent[1] = 20 * config.predation.sizeRatioOptimum;
  pools.energy[0] = 0.01;
  pools.energy[1] = 0.01;
  return sim;
}

interface Attempt {
  readonly probability: number;
  readonly yielded: number;
  readonly binToxicity: number;
  /** The float32 the pool actually held, since later attempts overwrite it. */
  readonly toxicity: number;
  readonly conspicuousness: number;
}

/**
 * One predation attempt by slot 0 against slot 1 with the victim's signal set as
 * given. A fresh ecology each time, so the hue grid is rebuilt against the
 * traits this call just wrote rather than served from the tick's cache.
 */
function attemptOn(
  sim: SimHandleInternal,
  victim: { conspicuousness: number; toxicity: number },
): Attempt {
  const pools = sim.pools;
  setTrait(sim, 1, T_CONSPICUOUSNESS, victim.conspicuousness);
  setTrait(sim, 1, T_TOXICITY, victim.toxicity);
  pools.gutFill[0] = 0;

  const ecology = createEcology();
  const spatial = createSpatialIndex(sim.state.config);
  spatial.build(sim.state);

  const rng = new AlwaysChance();
  let yielded = 0;
  const kills: KillSink = {
    push: (_predator, _victim, energyYield) => {
      yielded = energyYield;
    },
  };
  ecology.tryPredation(sim.state, 0, spatial, rng, kills);
  expect(rng.asked.length).toBeGreaterThanOrEqual(2);

  const runtime = ensureRuntime(undefined, sim.state);
  return {
    probability: rng.asked[1] ?? 0,
    yielded,
    binToxicity: hueBinToxicityAt(
      runtime,
      sim.state,
      pools.x[1] ?? 0,
      pools.y[1] ?? 0,
      traitAt(pools, 1, T.displayHue),
    ),
    toxicity: traitAt(pools, 1, T_TOXICITY),
    conspicuousness: traitAt(pools, 1, T_CONSPICUOUSNESS),
  };
}

const odds = (p: number): number => p / (1 - p);

describe('aposematism: toxin is a post-kill penalty', () => {
  it('shrinks the meal by exactly exp(-coef · toxicity) and leaves toxicity 0 alone', () => {
    const sim = armPredationRig('toxin-yield');
    const config = sim.state.config;

    const clean = attemptOn(sim, { conspicuousness: 0, toxicity: 0 });
    const toxic = attemptOn(sim, { conspicuousness: 0, toxicity: 2.5 });

    expect(clean.yielded).toBeGreaterThan(0);
    // Toxicity 0 is exactly the pre-G3 meal: the multiplier is 1, not ≈1.
    expect(toxinYieldMultiplier(0, config)).toBe(1);
    expect(clean.toxicity).toBe(0);
    expect(toxic.yielded / clean.yielded).toBeCloseTo(toxinYieldMultiplier(toxic.toxicity, config), 10);
    expect(toxic.yielded).toBeLessThan(clean.yielded);

    // And it is a penalty on the meal only — the victim died just as readily.
    expect(toxic.probability).toBeCloseTo(clean.probability, 12);
  });

  it('kills the predator that ate a toxic victim, and lets its kill stand', () => {
    const sim = armToxinTick('toxin-hazard-lethal', 100);
    const events = sim.step(1);

    const deaths = events.filter((event) => event.kind === 'death');
    const toxinDeath = deaths.find((event) => event.kind === 'death' && event.cause === 'toxin');
    expect(toxinDeath).toBeDefined();
    expect(sim.state.deathCounts.toxin).toBe(1);
    // Both died: the predator of the toxin, the victim of the predator.
    expect(sim.state.deathCounts.predation).toBe(1);
    expect(sim.state.liveCount).toBe(0);
    if (toxinDeath?.kind === 'death') {
      expect(toxinDeath.id).toBe(PREDATOR_ID);
      expect(toxinDeath.killerId).toBe(VICTIM_ID);
    }
  });

  it('rolls the hazard but takes nobody at coefficient zero', () => {
    const sim = armToxinTick('toxin-hazard-zero', 0);
    sim.step(1);
    expect(sim.state.deathCounts.predation).toBe(1);
    expect(sim.state.deathCounts.toxin).toBe(0);
    expect(sim.state.liveCount).toBe(1);
  });
});

/** Organism ids of the two founders in {@link armToxinTick}; ids start at 1. */
const PREDATOR_ID = 1;
const VICTIM_ID = 2;

/**
 * A world where one whole tick is a certain kill: the predator is a starving
 * pure carnivore standing on a well-sized herbivore, and the kernel's base logit
 * is pinned so high that the kill roll cannot miss. The victim is a pure grazer
 * so it never hunts back, which is what keeps the two deaths attributable.
 */
function armToxinTick(seed: string, hazardCoef: number): SimHandleInternal {
  const overrides: SimConfigOverrides = {
    ...PREDATION_RIG,
    predation: { baseLogit: 50, attemptRadiusWu: 150 },
    aposematism: { toxinHazardCoef: hazardCoef },
  };
  const sim = armPredationRig(seed, overrides);
  // A herbivore cannot open a predation attempt at all (its prey efficiency is
  // zero), so only slot 0 hunts and only slot 0 can be poisoned.
  setTrait(sim, 1, T.diet, 0);
  setTrait(sim, 1, T_TOXICITY, 4);
  sim.state.field.plankton.fill(0);
  // Fed enough not to starve in the same tick — the predator has to be alive at
  // the end of a hazard-free run or the test cannot tell the channels apart —
  // and still hungry enough to hunt (`matingSeekEnergyFraction` is 0.55).
  for (const slot of [0, 1]) {
    sim.pools.energy[slot] = 0.3 * sim.state.config.metabolism.maxEnergyPerSize * (sim.pools.sizeCurrent[slot] ?? 0);
  }
  expect(sim.pools.id[0]).toBe(PREDATOR_ID);
  expect(sim.pools.id[1]).toBe(VICTIM_ID);
  return sim;
}

describe('aposematism: the signal is credited only where the bin is toxic', () => {
  it('separates detection cost from aposematic credit', () => {
    const sim = armPredationRig('aposematic-credit');
    const config = sim.state.config;

    const plain = attemptOn(sim, { conspicuousness: 0, toxicity: 0 });
    const loudPalatable = attemptOn(sim, { conspicuousness: 1.5, toxicity: 0 });
    const loudToxic = attemptOn(sim, { conspicuousness: 1.5, toxicity: 3 });
    const cryptic = attemptOn(sim, { conspicuousness: -1.5, toxicity: 0 });

    // The bin holds this victim alone, so its mean toxicity is the victim's own
    // and the credit term is checkable exactly.
    expect(loudToxic.binToxicity).toBeCloseTo(loudToxic.toxicity, 12);
    expect(loudPalatable.binToxicity).toBe(0);

    // Loud and palatable is worse than plain — the mimic's bill before it finds
    // a model. Loud and toxic is the only combination that buys protection.
    expect(loudPalatable.probability).toBeGreaterThan(plain.probability);
    expect(loudToxic.probability).toBeLessThan(plain.probability);
    expect(loudToxic.probability).toBeLessThan(loudPalatable.probability);
    // Crypsis is the same term with the sign flipped: it buys hiding, not
    // warning, and it works whether or not anything nearby is toxic.
    expect(cryptic.probability).toBeLessThan(plain.probability);

    // Exactly the logit the frozen formula names, on top of the frozen kernel.
    expect(Math.log(odds(loudToxic.probability) / odds(plain.probability))).toBeCloseTo(
      aposematismLogit(loudToxic.conspicuousness, loudToxic.binToxicity, config),
      6,
    );
    expect(Math.log(odds(loudPalatable.probability) / odds(plain.probability))).toBeCloseTo(
      config.aposematism.conspicuousnessDetectionCoef * loudPalatable.conspicuousness,
      6,
    );
  });

  it('adds no signal term at all with the toggle off', () => {
    const off: SimConfigOverrides = {
      ...PREDATION_RIG,
      toggles: { ...PREDATION_RIG.toggles, enableAposematism: false },
    };
    const sim = armPredationRig('aposematic-credit-off', off);

    const plain = attemptOn(sim, { conspicuousness: 0, toxicity: 0 });
    const loudToxic = attemptOn(sim, { conspicuousness: 1.5, toxicity: 3 });
    expect(loudToxic.probability).toBe(plain.probability);
    expect(loudToxic.yielded).toBe(plain.yielded);
    expect(loudToxic.binToxicity).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Metabolism
// ---------------------------------------------------------------------------

/** The tick's metabolic burn for one organism carrying `toxicity`. */
function burnWithToxicity(sim: SimHandleInternal, slot: SlotIndex, toxicity: number): number {
  const pools = sim.pools;
  pools.vx[slot] = 0;
  pools.vy[slot] = 0;
  setTrait(sim, slot, T_TOXICITY, toxicity);
  pools.energy[slot] = 40;

  const ecology = createEcology();
  const sink: DeathSink = { push: () => undefined };
  ecology.metabolismAndHazards(sim.state, slot, new AlwaysChance(), sink);
  return 40 - (pools.energy[slot] ?? 0);
}

const METABOLISM_RIG: SimConfigOverrides = {
  world: { widthWu: 200, heightWu: 200, initialPopulation: 4, slotCapacity: 16, fieldCellSizeWu: 50 },
  senescence: { gompertzA: 0 },
  thermal: { hazardCoef: 0 },
  toggles: { enableAposematism: true, enableDisturbances: false, enableCarrion: false },
};

describe('aposematism: toxin costs metabolism', () => {
  it('charges the frozen per-tick cost against realised length', () => {
    const sim = makeSim('toxin-metabolism-on', METABOLISM_RIG);
    const slot = firstLiveSlot(sim);
    sim.pools.sizeCurrent[slot] = 14;

    const clean = burnWithToxicity(sim, slot, 0);
    const toxic = burnWithToxicity(sim, slot, 6);

    expect(toxic).toBeGreaterThan(clean);
    expect(toxic - clean).toBeCloseTo(
      toxinMetabolicCostPerTick(traitAt(sim.pools, slot, T_TOXICITY), 14, sim.state.config),
      5,
    );

    // Realised length, not the genetic target: the same toxin load on a smaller
    // body is a smaller bill (G2's rewiring, ^0.75 of length).
    sim.pools.sizeCurrent[slot] = 3.5;
    const smallClean = burnWithToxicity(sim, slot, 0);
    const smallToxic = burnWithToxicity(sim, slot, 6);
    expect(smallToxic - smallClean).toBeLessThan(toxic - clean);
    expect(smallToxic - smallClean).toBeCloseTo(
      toxinMetabolicCostPerTick(traitAt(sim.pools, slot, T_TOXICITY), 3.5, sim.state.config),
      5,
    );
  });

  it('bills nothing for toxin with the toggle off', () => {
    const sim = makeSim('toxin-metabolism-off', {
      ...METABOLISM_RIG,
      toggles: { ...METABOLISM_RIG.toggles, enableAposematism: false },
      aposematism: VIOLENT_APOSEMATISM,
    });
    const slot = firstLiveSlot(sim);
    expect(burnWithToxicity(sim, slot, 30)).toBe(burnWithToxicity(sim, slot, 0));
  });
});

// ---------------------------------------------------------------------------
// Mating
// ---------------------------------------------------------------------------

const MATING_RIG: SimConfigOverrides = {
  world: { widthWu: 300, heightWu: 300, initialPopulation: 20, slotCapacity: 64, fieldCellSizeWu: 50 },
  toggles: { enableAposematism: true, enableDisturbances: false, enableCarrion: false },
};

function firstFemaleAndMale(sim: SimHandleInternal): readonly [SlotIndex, SlotIndex] {
  let female = -1;
  let male = -1;
  for (let slot = 0; slot < sim.pools.capacity; slot += 1) {
    if ((sim.pools.alive[slot] ?? 0) === 0) continue;
    if ((sim.pools.sex[slot] ?? 0) === SEX_MALE) {
      if (male < 0) male = slot;
    } else if (female < 0) {
      female = slot;
    }
  }
  if (female < 0 || male < 0) throw new Error('rig needs one of each sex');
  return [female, male];
}

describe('aposematism: loud males are chosen more often', () => {
  it('adds exactly the mating coefficient to the acceptance weight', () => {
    const sim = makeSim('conspicuous-mating-on', MATING_RIG);
    const mating = createMating();
    const [female, male] = firstFemaleAndMale(sim);

    setTrait(sim, male, T_CONSPICUOUSNESS, 0);
    const plain = mating.acceptanceWeight(sim.state, female, male);
    setTrait(sim, male, T_CONSPICUOUSNESS, 2);
    const loud = mating.acceptanceWeight(sim.state, female, male);

    expect(loud).toBeGreaterThan(plain);
    expect(loud - plain).toBeCloseTo(
      sim.state.config.aposematism.conspicuousnessMatingCoef * traitAt(sim.pools, male, T_CONSPICUOUSNESS),
      10,
    );

    // The term is signed, so crypsis is paid for in the mating lottery as well
    // as earned in the water.
    setTrait(sim, male, T_CONSPICUOUSNESS, -2);
    expect(mating.acceptanceWeight(sim.state, female, male)).toBeLessThan(plain);
  });

  it('leaves the weight bit-identical with the toggle off', () => {
    const sim = makeSim('conspicuous-mating-off', {
      ...MATING_RIG,
      toggles: { ...MATING_RIG.toggles, enableAposematism: false },
      aposematism: VIOLENT_APOSEMATISM,
    });
    const mating = createMating();
    const [female, male] = firstFemaleAndMale(sim);

    setTrait(sim, male, T_CONSPICUOUSNESS, 0);
    const plain = mating.acceptanceWeight(sim.state, female, male);
    setTrait(sim, male, T_CONSPICUOUSNESS, 5);
    expect(mating.acceptanceWeight(sim.state, female, male)).toBe(plain);
  });
});

// ---------------------------------------------------------------------------
// The invention event
// ---------------------------------------------------------------------------

const TOXIN_MACRO = DISCRETE_LOCUS_BY_ID.toxinMacro.index;

function genomeWithToxinMacro(maternal: number, paternal: number): Genome {
  const genome = createEmptyGenome('XX');
  genome.discrete[discreteAlleleIndex(0, TOXIN_MACRO)] = maternal;
  genome.discrete[discreteAlleleIndex(1, TOXIN_MACRO)] = paternal;
  return genome;
}

describe('aposematism: the toxin invention predicate', () => {
  const mother = genomeWithToxinMacro(0, 1);
  const father = genomeWithToxinMacro(0, 0);

  it('fires on an allele neither parent carries', () => {
    expect(inventsToxinMacro(genomeWithToxinMacro(0, 2), mother, father)).toBe(true);
    expect(inventsToxinMacro(genomeWithToxinMacro(2, 1), mother, father)).toBe(true);
  });

  it('stays silent on an inherited allele, however toxic', () => {
    expect(inventsToxinMacro(genomeWithToxinMacro(1, 1), mother, father)).toBe(false);
    expect(inventsToxinMacro(genomeWithToxinMacro(0, 1), mother, father)).toBe(false);
    // Two allele-2 parents pass allele 2 on; the invention already happened.
    const toxic = genomeWithToxinMacro(2, 2);
    expect(inventsToxinMacro(genomeWithToxinMacro(2, 2), toxic, toxic)).toBe(false);
  });

  it('stays silent on the ancestral allele', () => {
    expect(inventsToxinMacro(genomeWithToxinMacro(0, 0), mother, father)).toBe(false);
  });
});

/** A breeding world whose discrete mutation rate makes macro-steps common. */
const INVENTION_RIG: SimConfigOverrides = {
  world: { widthWu: 500, heightWu: 320, initialPopulation: 60, slotCapacity: 1024, fieldCellSizeWu: 20 },
  genetics: { discreteMutationRate: 1 },
  toggles: { enableAposematism: true, enableDisturbances: false, enableCarrion: false },
};

describe('aposematism: the invention event', () => {
  it('announces a fresh toxinMacro allele once, after the birth that carried it', () => {
    const sim = makeSim('toxin-invention', INVENTION_RIG);
    const pools = sim.pools;
    const seen = new Set<number>();
    let toxicitySum = 0;

    // Tick by tick, so the inventor is still in the pool when its payload is
    // checked against the phenotype the birth actually wrote.
    for (let tick = 0; tick < 600; tick += 1) {
      const events = sim.step(1);
      for (let index = 0; index < events.length; index += 1) {
        const invention = events[index];
        if (invention?.kind !== 'toxinInvention') continue;

        expect(invention.viaMacroLocus).toBe(true);
        // Once per organism, and never for an organism the feed has not met.
        expect(seen.has(invention.id)).toBe(false);
        seen.add(invention.id);
        const birth = events.findIndex((event) => event.kind === 'birth' && event.id === invention.id);
        expect(birth).toBeGreaterThanOrEqual(0);
        expect(index).toBeGreaterThan(birth);
        const birthEvent = events[birth];
        // Same place the birth was announced at, to the bit: both carry the
        // pre-float32 scatter position the birth queue held.
        expect(invention.x).toBe(birthEvent?.kind === 'birth' ? birthEvent.x : Number.NaN);
        expect(invention.y).toBe(birthEvent?.kind === 'birth' ? birthEvent.y : Number.NaN);

        let slot = -1;
        for (let candidate = 0; candidate < pools.capacity; candidate += 1) {
          if ((pools.alive[candidate] ?? 0) === 1 && pools.id[candidate] === invention.id) slot = candidate;
        }
        expect(slot).toBeGreaterThanOrEqual(0);
        // The payload is the newborn's expressed toxicity, to the bit.
        expect(invention.toxicity).toBe(traitAt(pools, slot, T_TOXICITY));
        toxicitySum += invention.toxicity;
      }
    }

    // Achieved 28 inventions on this rig.
    expect(seen.size).toBeGreaterThan(20);
    // A macro allele is a jump, not a nudge: one copy adds 0.5 to the latent
    // value, and inventors average an order above the founding baseline
    // (softplus(0) ≈ 0.104) even though the polygenic tail can bury an
    // individual one below it. Achieved 1.07.
    expect(toxicitySum / seen.size).toBeGreaterThan(0.8);
  });

  it('says nothing when no allele is new, and nothing at all off the toggle', () => {
    const quiet = makeSim('toxin-invention-quiet', {
      ...INVENTION_RIG,
      genetics: { discreteMutationRate: 0 },
    });
    const quietEvents = quiet.step(600);
    expect(quiet.diagnostics.birthsApplied).toBeGreaterThan(0);
    expect(quietEvents.filter((event) => event.kind === 'toxinInvention')).toHaveLength(0);

    const off = makeSim('toxin-invention-off', {
      ...INVENTION_RIG,
      toggles: { ...INVENTION_RIG.toggles, enableAposematism: false },
    });
    const offEvents = off.step(600);
    expect(off.diagnostics.birthsApplied).toBeGreaterThan(0);
    expect(offEvents.filter((event) => event.kind === 'toxinInvention')).toHaveLength(0);
  });
});
