/**
 * Grazing intake (WP-A2).
 *
 * One organism, one cell, a Holling type-II bite. The saturation is what keeps
 * a rich patch from being convertible into unbounded energy, so the population
 * is limited by the rate it can harvest rather than by the slot cap.
 *
 * The convex diet efficiency from `formulas.ts` is the disruptive-selection
 * engine: a 50/50 generalist is worse at filtering *and* worse at hunting than
 * either specialist, so selection pushes the diet distribution apart rather
 * than toward its mean. Nothing in this file may soften that.
 */

import { grazingIntake, thermalPerformance } from '../../contracts/formulas';
import type { RandomSource, SimState, SlotIndex } from '../../contracts/types';
import { T_METABOLIC_EFF, T_OPT, T_WIDTH, trait } from './columns';
import { ensureOrganismCache } from './derived';
import type { EcologyRuntime } from './runtime';
import { fieldCellAt } from './runtime';

/**
 * Multiplicative encounter noise on a bite, mean 1.
 *
 * A cell is not homogeneous; two identical animals in the same water do not
 * eat identical amounts. Without this every organism in a patch has exactly the
 * same energy trajectory, which turns starvation into a synchronised cull.
 */
const INTAKE_JITTER_HALF_WIDTH = 0.25;

/**
 * Graze the cell under one organism.
 *
 * Debits the field and **returns** the energy gained without crediting
 * `pop.energy` — the contract says "returns energy gained and debits the field
 * cell", so the engine owns the credit. The return is pre-capped at the
 * organism's remaining storage headroom, and the cell is debited only for what
 * actually fits, so the storage ceiling holds whether or not the engine knows
 * about it and a full animal stops grazing rather than wasting the patch.
 */
export function applyFeeding(
  runtime: EcologyRuntime,
  state: SimState,
  slot: SlotIndex,
  rng: RandomSource,
): number {
  const pop = state.pop;
  const x = pop.x[slot] ?? 0;
  const y = pop.y[slot] ?? 0;
  const cell = fieldCellAt(runtime, x, y);
  const resource = state.field.plankton[cell] ?? 0;
  if (resource <= 0) return 0;

  ensureOrganismCache(runtime, state, slot);
  const headroom = (runtime.memoMaxEnergy[slot] ?? 0) - (pop.energy[slot] ?? 0);
  if (headroom <= 0) return 0;

  const traits = pop.traits;
  // A bigger mouth takes a bigger bite, and a bold animal spends its time in
  // open water where the plankton is — the same trait raises its exposure in
  // the predation kernel, which is the tradeoff that keeps boldness honest.
  const performance = thermalPerformance(
    state.field.temperature[cell] ?? 0,
    trait(traits, slot, T_OPT),
    trait(traits, slot, T_WIDTH),
    state.config,
  );
  const jitter = 1 + INTAKE_JITTER_HALF_WIDTH * (2 * rng.next() - 1);

  let harvested =
    grazingIntake(runtime.memoBite[slot] ?? 0, runtime.memoPlantEfficiency[slot] ?? 0, resource, state.config) *
    performance *
    jitter;
  if (harvested <= 0) return 0;
  if (harvested > resource) harvested = resource;

  let gained = harvested * Math.max(0, trait(traits, slot, T_METABOLIC_EFF));
  if (gained > headroom) {
    harvested *= headroom / gained;
    gained = headroom;
  }

  state.field.plankton[cell] = resource - harvested;
  return gained;
}
