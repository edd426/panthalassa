/**
 * S-wave (v1.9) unit pins: the ornament axis.
 *
 * The claims that matter: the authored runaway null is the q71 cell of W and
 * nothing else (P20's analytic anchor, gwave-units style); the mating term is
 * exactly `exp(prefScale · herPref · hisOrnament)` when armed and exactly 1 in
 * a dark-founder world even with the toggle on (preference sits at its 0
 * baseline with zero variance, so the arm boots inert by construction); the
 * lottery cannot be pushed to Infinity; and the episode detector recognises
 * co-directional escalation in either direction while refusing escalation the
 * preference did not follow.
 */

import { describe, expect, it } from 'vitest';

import {
  ornamentDetectionLogit,
  ornamentMatingLogit,
  ornamentMetabolicCostPerTick,
} from '../contracts/formulas';
import { QUANT_LOCUS_BY_ID, founderGeneticVariance } from '../contracts/genome';
import type { SampleRow } from '../contracts/stats';
import { TRAIT_COUNT, TRAIT_INDEX, applyTraitLink } from '../contracts/traits';
import type { SlotIndex } from '../contracts/types';
import { SEX_FEMALE, SEX_MALE, resolveSimConfig } from '../contracts/types';
import { createSim } from '../sim/engine';
import type { SimHandleInternal } from '../sim/engine';
import { createMating } from '../sim/mating';
import { buildModules } from './harness';
import { authoredTraitCorrelation, founderGeneticCovariance, gatesOf } from './probes/aposematism';
import { detectRunawayEpisodes } from './probes/runaway';

const ARMED = resolveSimConfig({ toggles: { enableSexualSelection: true } });
const ARMED_GATES = gatesOf(ARMED);

function makeSim(seed: string, config = resolveSimConfig({})): SimHandleInternal {
  const { modules } = buildModules(config);
  return createSim({ seed, config, modules });
}

function firstFemaleAndMale(sim: SimHandleInternal): [SlotIndex, SlotIndex] {
  let female = -1;
  let male = -1;
  for (let slot = 0; slot < sim.pools.capacity; slot += 1) {
    if ((sim.pools.alive[slot] ?? 0) !== 1) continue;
    const sex = sim.pools.sex[slot];
    if (sex === SEX_FEMALE && female < 0) female = slot;
    if (sex === SEX_MALE && male < 0) male = slot;
    if (female >= 0 && male >= 0) return [female, male];
  }
  throw new Error('founder pool is missing a sex');
}

function expressedTrait(sim: SimHandleInternal, slot: SlotIndex, index: number): number {
  return sim.pools.traits[slot * TRAIT_COUNT + index] ?? 0;
}

describe('the authored runaway null', () => {
  it('is the q71 cell of W and nothing else', () => {
    // Hand-computed from the authored table: q71 is the only locus loading
    // both traits (0.28 ornament, 0.30 ornamentPref, founderSd 0.45), so
    //   Cov = 2 · 0.28 · 0.30 · 0.45²                       = 0.03402
    //   V_orn  = 2 · Σ (w·sd)² over q69,q70,q71,q75          = 0.185948
    //   V_pref = 2 · Σ (w·sd)² over q71,q72,q73,q74,q76      = 0.250468
    //   r = 0.03402 / √(0.185948 · 0.250468) = 0.15764…
    // (ornamentMacro is founder-fixed, so it adds no sampling variance.)
    expect(founderGeneticCovariance('ornament', 'ornamentPref', 1, ARMED_GATES)).toBeCloseTo(0.03402, 6);
    expect(authoredTraitCorrelation('ornament', 'ornamentPref', 1, ARMED_GATES)).toBeCloseTo(0.15764, 4);
    expect(QUANT_LOCUS_BY_ID.q71.chromosome).toBe('A7');
  });

  it('collapses to zero when A7 is dark, because everything ornamental lives there', () => {
    const dark = gatesOf(resolveSimConfig({}));
    expect(founderGeneticCovariance('ornament', 'ornamentPref', 1, dark)).toBe(0);
    expect(founderGeneticVariance('ornament', 1, dark)).toBe(0);
    expect(founderGeneticVariance('ornamentPref', 1, dark)).toBe(0);
  });
});

describe('the formulas', () => {
  it('prices the display against tissue and clamps only the lottery exponent', () => {
    const config = ARMED;
    expect(ornamentMetabolicCostPerTick(2, 12, config)).toBeCloseTo(
      config.sexualSelection.ornamentCostCoef * 2 * 12 ** 0.75,
      12,
    );
    expect(ornamentMetabolicCostPerTick(-1, 12, config)).toBe(0);
    expect(ornamentDetectionLogit(2, config)).toBeCloseTo(config.sexualSelection.ornamentDetectionCoef * 2, 12);
    expect(ornamentMatingLogit(1.5, 2, config)).toBeCloseTo(config.sexualSelection.prefScale * 3, 12);
    // The clamp is a numerical guard on the weighted draw, not a trait bound.
    expect(ornamentMatingLogit(100, 100, config)).toBe(8);
    expect(ornamentMatingLogit(-100, 100, config)).toBe(-8);
  });
});

describe('the mating term', () => {
  it('multiplies the armed ticket by exp(prefScale · herPref · hisOrnament)', () => {
    const sim = makeSim('swave-mating', ARMED);
    const mating = createMating();
    const [female, male] = firstFemaleAndMale(sim);

    const armed = mating.acceptanceWeight(sim.state, female, male);
    // Flip the toggle off mid-run: phenotypes were computed at birth and do
    // not move, so the ratio isolates exactly the mating term.
    sim.command({ kind: 'setToggle', toggle: 'enableSexualSelection', value: false });
    const dark = mating.acceptanceWeight(sim.state, female, male);

    const herPref = expressedTrait(sim, female, TRAIT_INDEX.ornamentPref);
    const hisOrnament = expressedTrait(sim, male, TRAIT_INDEX.ornament);
    expect(herPref).not.toBe(0);
    expect(armed / dark).toBeCloseTo(Math.exp(ornamentMatingLogit(herPref, hisOrnament, ARMED)), 10);
  });

  it('boots exactly inert in a dark-founder world even with the toggle on', () => {
    // Dark founders carry ornamentPref at exactly its 0 baseline (zero founder
    // variance, zero environmental SD), so arming the toggle multiplies every
    // ticket by exp(pref · ornament) = exp(0) = 1 — bit-identical lotteries
    // until preference variation actually exists.
    const sim = makeSim('swave-dark');
    const mating = createMating();
    const [female, male] = firstFemaleAndMale(sim);

    const plain = mating.acceptanceWeight(sim.state, female, male);
    expect(expressedTrait(sim, female, TRAIT_INDEX.ornamentPref)).toBe(0);
    // The expressed ornament is NOT zero (softplus floor of a 0 latent), which
    // is why inertness rides on the preference baseline, not the ornament.
    expect(expressedTrait(sim, male, TRAIT_INDEX.ornament)).toBeCloseTo(applyTraitLink('ornament', 0), 6);
    sim.command({ kind: 'setToggle', toggle: 'enableSexualSelection', value: true });
    expect(mating.acceptanceWeight(sim.state, female, male)).toBe(plain);
  });
});

describe('the episode detector', () => {
  const row = (generation: number, ornament: number, pref: number): SampleRow =>
    ({ generation, traits: { ornament: { mean: ornament }, ornamentPref: { mean: pref } } }) as unknown as SampleRow;

  it('recognises co-directional escalation, in either direction', () => {
    const up = detectRunawayEpisodes(
      [row(0, 0, 0), row(10, 0.3, 0.1), row(20, 0.7, 0.25), row(30, 1.1, 0.6)],
      1,
      1,
    );
    expect(up).toHaveLength(1);
    expect(up[0]?.ornamentMoveSd).toBeGreaterThan(1);
    expect(up[0]?.prefMoveSd).toBeGreaterThan(0.5);

    const down = detectRunawayEpisodes(
      [row(0, 0, 0), row(10, -0.5, -0.2), row(20, -1.2, -0.7)],
      1,
      1,
    );
    expect(down).toHaveLength(1);
    expect(down[0]?.ornamentMoveSd).toBeLessThan(-1);
    expect(down[0]?.prefMoveSd).toBeLessThan(-0.5);
  });

  it('refuses escalation the preference did not follow — that is selection, not runaway', () => {
    const episodes = detectRunawayEpisodes(
      [row(0, 0, 0), row(10, 0.6, 0.01), row(20, 1.2, -0.02), row(30, 1.8, 0.03)],
      1,
      1,
    );
    expect(episodes).toHaveLength(0);
  });
});
