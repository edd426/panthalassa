/**
 * Mate choice (WP-A3, `MatingApi`).
 *
 * A ready female surveys the males within `mating.surveyRadiusWu`, keeps the
 * nearest `maxSuitorsSurveyed`, and draws one in proportion to an acceptance
 * weight. The weight is a Gaussian on the circular distance between his
 * `displayHue` and her `prefTarget`, with the width set by her `choosiness`,
 * multiplied by a condition term.
 *
 *     sigma  = prefSigmaBaseDeg / (choosinessScale · choosiness)      [traits.ts]
 *     weight = exp(−Δ² / (2·sigma²)) · ((1 − w) + w · condition)
 *
 * `Δ` is the signed shortest hue difference and `w` is `mating.conditionWeight`,
 * so `w = 0` ignores condition entirely and `w = 1` makes the weight
 * proportional to it. Because `displayHue`, `prefTarget` and `diet` share loci
 * (q36/q38), assortment here is a speciation route rather than decoration —
 * which is why the weight is exported: P8 measures cross-side acceptance
 * offline, without having to reproduce the formula.
 *
 * With `toggles.enableAssortativeMating` off the display term becomes 1 and
 * males are accepted at random up to condition, killing the assortative route
 * without changing anything else.
 */

import type { MatingApi, SpatialIndex } from '../contracts/apis';
import { hueDelta } from '../contracts/traits';
import type { RandomSource, SimConfig, SimState, SlotIndex } from '../contracts/types';
import { NO_SLOT, SEX_MALE } from '../contracts/types';
import { T, energyCapacityOf, isMature, traitAt } from './organisms';

/** Energy the mother is debited for a clutch of `clutchSize`. */
export function maternalClutchCost(clutchSize: number, config: SimConfig): number {
  return config.metabolism.reproductionEnergyCost * clutchSize;
}

/** Energy the father is debited for a clutch of `clutchSize`. */
export function paternalClutchCost(clutchSize: number, config: SimConfig): number {
  return config.metabolism.reproductionEnergyCost * clutchSize * config.mating.paternalCostFraction;
}

/**
 * Mature, off cooldown, and carrying enough energy to survey suitors.
 *
 * Maturity is {@link isMature}, which adds a realised-length floor to the age
 * floor once ontogeny is on — a stunted female is not a small adult, she is
 * still a juvenile, and the age at which she recruits is set by how well she
 * has eaten rather than by a constant.
 */
export function isFemaleReady(state: SimState, slot: SlotIndex): boolean {
  const pop = state.pop;
  const config = state.config;
  if ((pop.sex[slot] ?? 0) === SEX_MALE) return false;
  if (!isMature(state, slot)) return false;
  if (state.tick - (pop.lastMatingTick[slot] ?? 0) < config.mating.matingCooldownTicks) return false;
  const capacity = energyCapacityOf(pop, slot, config);
  return (pop.energy[slot] ?? 0) >= config.mating.femaleReadyEnergyFraction * capacity;
}

/** A male who is alive, mature, and not the female herself. */
export function isEligibleSuitor(state: SimState, slot: SlotIndex, femaleSlot: SlotIndex): boolean {
  if (slot === femaleSlot) return false;
  const pop = state.pop;
  if ((pop.alive[slot] ?? 0) === 0) return false;
  if ((pop.sex[slot] ?? 0) !== SEX_MALE) return false;
  return isMature(state, slot);
}

const NEIGHBOR_BUFFER_SIZE = 512;

export function createMating(): MatingApi {
  const neighbors = new Int32Array(NEIGHBOR_BUFFER_SIZE);
  // Nearest-N suitors, kept sorted by (distance², slot) while scanning.
  let suitorSlots = new Int32Array(0);
  let suitorDistances = new Float64Array(0);
  let suitorWeights = new Float64Array(0);

  const ensureSuitorCapacity = (size: number): void => {
    if (suitorSlots.length >= size) return;
    suitorSlots = new Int32Array(size);
    suitorDistances = new Float64Array(size);
    suitorWeights = new Float64Array(size);
  };

  const acceptanceWeight = (state: SimState, femaleSlot: SlotIndex, maleSlot: SlotIndex): number => {
    const pop = state.pop;
    const config = state.config;
    const mating = config.mating;

    let display = 1;
    if (config.toggles.enableAssortativeMating) {
      const choosiness = traitAt(pop, femaleSlot, T.choosiness);
      const sigma = mating.prefSigmaBaseDeg / Math.max(1e-3, mating.choosinessScale * choosiness);
      const delta = hueDelta(traitAt(pop, maleSlot, T.displayHue), traitAt(pop, femaleSlot, T.prefTarget));
      display = Math.exp(-(delta * delta) / (2 * sigma * sigma));
    }

    const capacity = energyCapacityOf(pop, maleSlot, config);
    const condition = Math.max(0, Math.min(1, (pop.energy[maleSlot] ?? 0) / capacity));
    const conditionTerm = 1 - mating.conditionWeight + mating.conditionWeight * condition;

    return display * conditionTerm;
  };

  const findMate = (
    state: SimState,
    femaleSlot: SlotIndex,
    spatial: SpatialIndex,
    rng: RandomSource,
  ): SlotIndex => {
    const pop = state.pop;
    const mating = state.config.mating;
    const maxSuitors = Math.max(1, Math.floor(mating.maxSuitorsSurveyed));
    ensureSuitorCapacity(maxSuitors);

    const fx = pop.x[femaleSlot] ?? 0;
    const fy = pop.y[femaleSlot] ?? 0;
    const found = spatial.queryNeighbors(fx, fy, mating.surveyRadiusWu, neighbors);
    const radiusSq = mating.surveyRadiusWu * mating.surveyRadiusWu;

    // Insertion sort into the nearest-N window. Neighbours arrive in ascending
    // slot order, and ties keep the earlier (lower) slot, so the window is a
    // deterministic function of the pool.
    let suitorCount = 0;
    for (let index = 0; index < found; index += 1) {
      const slot = neighbors[index] ?? NO_SLOT;
      if (!isEligibleSuitor(state, slot, femaleSlot)) continue;
      const dx = (pop.x[slot] ?? 0) - fx;
      const dy = (pop.y[slot] ?? 0) - fy;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > radiusSq) continue;

      if (suitorCount === maxSuitors && distanceSq >= (suitorDistances[suitorCount - 1] ?? 0)) continue;
      let position = Math.min(suitorCount, maxSuitors - 1);
      while (position > 0 && (suitorDistances[position - 1] ?? 0) > distanceSq) {
        suitorDistances[position] = suitorDistances[position - 1] ?? 0;
        suitorSlots[position] = suitorSlots[position - 1] ?? NO_SLOT;
        position -= 1;
      }
      suitorDistances[position] = distanceSq;
      suitorSlots[position] = slot;
      if (suitorCount < maxSuitors) suitorCount += 1;
    }

    if (suitorCount === 0) return NO_SLOT;

    // Re-sort the window by slot so the weighted draw walks a canonical order.
    for (let i = 1; i < suitorCount; i += 1) {
      const slot = suitorSlots[i] ?? NO_SLOT;
      let j = i - 1;
      while (j >= 0 && (suitorSlots[j] ?? NO_SLOT) > slot) {
        suitorSlots[j + 1] = suitorSlots[j] ?? NO_SLOT;
        j -= 1;
      }
      suitorSlots[j + 1] = slot;
    }

    let total = 0;
    for (let i = 0; i < suitorCount; i += 1) {
      const weight = Math.max(0, acceptanceWeight(state, femaleSlot, suitorSlots[i] ?? NO_SLOT));
      suitorWeights[i] = weight;
      total += weight;
    }
    if (!(total > 0)) return NO_SLOT;

    let draw = rng.next() * total;
    for (let i = 0; i < suitorCount; i += 1) {
      draw -= suitorWeights[i] ?? 0;
      if (draw <= 0) return suitorSlots[i] ?? NO_SLOT;
    }
    return suitorSlots[suitorCount - 1] ?? NO_SLOT;
  };

  return { findMate, acceptanceWeight };
}
