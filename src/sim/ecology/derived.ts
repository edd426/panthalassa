/**
 * Per-organism derived quantities and their cache (WP-A2).
 *
 * Everything here is a pure function of one organism's phenotype, which is
 * written once at birth and never changes. The tick loop asks for these on
 * every one of an animal's ~900 ticks, so they are computed once per organism
 * and memoised in the runtime rather than recomputed — `Math.pow` for a bite
 * size and a diet efficiency, three times per organism-tick, is most of the
 * ecology's cost otherwise.
 *
 * The cache is a memo of the frozen `formulas.ts` functions, never a
 * reimplementation of them: every value below comes out of a contract function
 * called once. If A7 retunes a formula the cache retunes with it.
 */

import {
  dietEfficiencyPlankton,
  dietEfficiencyCarrion,
  dietEfficiencyPrey,
  metabolicCostPerTick,
  thermalPerformance,
} from '../../contracts/formulas';
import { TRAIT_META } from '../../contracts/traits';
import type { SimConfig, SimState, SlotIndex } from '../../contracts/types';
import { sizeCurrentAt } from '../organisms';
import {
  T_ARMOR_PLATING,
  T_DIET,
  T_FORAGE_BOLDNESS,
  T_OPT,
  T_WARINESS,
  T_WIDTH,
  trait,
} from './columns';
import type { EcologyRuntime } from './runtime';

/** Speed-fraction quantisation for the metabolic-cost memo, in steps per unit. */
const SPEED_QUANTISATION = 64;

/**
 * The position-dependent half of `thermalPerformance`.
 *
 * The formula factors as `tolerance(T, tOpt, tWidth) · tax(tWidth)`, and the tax
 * is a fractional `Math.pow` on a trait that never changes. `memoThermalTax`
 * holds the tax; this is the part that has to be recomputed wherever the
 * organism happens to be standing, and `tolerance · tax` is bit-identical to
 * calling the frozen formula.
 */
export function thermalToleranceOf(temperatureC: number, tOpt: number, tWidth: number): number {
  const z = (temperatureC - tOpt) / Math.max(1e-3, tWidth);
  return Math.exp(-z * z);
}

/** Founder-population reference body length, cm, for scaling a bite. */
export function referenceSizeCm(config: SimConfig): number {
  return config.genetics.traitBaselineOverrides.size ?? TRAIT_META.size.baseline;
}

/**
 * Specialist premium on assimilation, 1 at the generalist midpoint and
 * `1 + dietSpecialistBonus` at either end of the diet axis. It reinforces the
 * convexity `dietEfficiency*` already provides rather than replacing it.
 */
export function dietSpecialisationBonus(diet: number, config: SimConfig): number {
  return 1 + config.metabolism.dietSpecialistBonus * Math.min(1, 2 * Math.abs(diet - 0.5));
}

/** Energy storage ceiling for a body of this length. */
export function maxEnergyFor(size: number, config: SimConfig): number {
  return Math.max(1e-6, config.metabolism.maxEnergyPerSize * Math.max(0, size));
}

/**
 * Digestive throughput, energy per tick: one prey-sized meal cleared over the
 * satiation-plus-handling window. This is what makes the predator's functional
 * response type-II — a saturating kill rate falls out of handling time, it is
 * not imposed on top of it.
 */
export function digestionRate(size: number, config: SimConfig): number {
  const predation = config.predation;
  const window = Math.max(1, predation.satiationTicks + predation.handlingTicks);
  return (predation.energyPerPreySize * Math.max(0, size)) / window;
}

/**
 * Bring one organism's memo up to date. Keyed on `pop.id` — never reused — with
 * realised length as a second witness, so a recycled slot or an edited
 * phenotype misses rather than reading the previous occupant's numbers.
 *
 * Length is the one input here that is *not* fixed for life once ontogeny is
 * on, so a growing juvenile misses this cache on every tick it grows and pays
 * the two `Math.pow`s again. That is the intended cost of the axis: everything
 * scaled by body size has to track the body. Off the toggle `sizeCurrent` never
 * changes and the memo behaves exactly as it did.
 */
export function ensureOrganismCache(runtime: EcologyRuntime, state: SimState, slot: SlotIndex): void {
  const pop = state.pop;
  const id = pop.id[slot] ?? 0;
  const size = sizeCurrentAt(pop, slot);
  if (runtime.memoId[slot] === id && runtime.memoSize[slot] === size) return;

  const config = state.config;
  const diet = trait(pop.traits, slot, T_DIET);
  const bonus = dietSpecialisationBonus(diet, config);
  const preyEfficiency = dietEfficiencyPrey(diet, config);

  runtime.memoBite[slot] =
    config.resources.grazingMaxIntake *
    Math.pow(Math.max(0, size) / referenceSizeCm(config), config.metabolism.sizeExponent) *
    Math.exp(trait(pop.traits, slot, T_FORAGE_BOLDNESS));
  runtime.memoPlantEfficiency[slot] = dietEfficiencyPlankton(diet, config) * bonus;
  runtime.memoCarrionEfficiency[slot] = dietEfficiencyCarrion(diet, config);
  runtime.memoPreyEfficiency[slot] = preyEfficiency;
  runtime.memoPreyYield[slot] = preyEfficiency * bonus;
  runtime.memoMaxEnergy[slot] = maxEnergyFor(size, config);
  runtime.memoDigestion[slot] = digestionRate(size, config);
  // Read back out of the frozen formula at the performance peak, where the
  // tolerance factor is exactly 1 and what is left is the tax alone.
  const tOpt = trait(pop.traits, slot, T_OPT);
  runtime.memoThermalTax[slot] = thermalPerformance(tOpt, tOpt, trait(pop.traits, slot, T_WIDTH), config);

  runtime.memoId[slot] = id;
  runtime.memoSize[slot] = size;
  runtime.memoCostKey[slot] = Number.NaN;
}

/**
 * Metabolic cost for this tick, memoised on a quantised absolute speed.
 *
 * The policies pick from a small fixed menu of cruising speeds, so the key
 * repeats tick after tick and the `Math.pow` on body size runs about once per
 * organism per policy change rather than once per tick. The 1/64 wu/tick
 * quantisation moves the cost by well under a tenth of a percent. Armor and
 * wariness are traits — constant for the organism's lifetime — and the speed
 * key is invalidated by {@link ensureOrganismCache} whenever realised length
 * moves, so the speed key alone identifies the cost.
 */
export function metabolicCostFor(
  runtime: EcologyRuntime,
  state: SimState,
  slot: SlotIndex,
  speedWuPerTick: number,
): number {
  const key = Math.round(speedWuPerTick * SPEED_QUANTISATION);
  if (runtime.memoCostKey[slot] === key) return runtime.memoCostValue[slot] ?? 0;

  const value = metabolicCostPerTick(
    sizeCurrentAt(state.pop, slot),
    key / SPEED_QUANTISATION,
    trait(state.pop.traits, slot, T_ARMOR_PLATING),
    trait(state.pop.traits, slot, T_WARINESS),
    state.config,
  );
  runtime.memoCostKey[slot] = key;
  runtime.memoCostValue[slot] = value;
  // Read back through the float32 memo: a hit and a miss have to agree to the
  // bit, or the first tick after a snapshot restore diverges from the run the
  // snapshot was taken from (P1's restore-continuity assertion).
  return runtime.memoCostValue[slot] ?? 0;
}
