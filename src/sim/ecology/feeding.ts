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

import { carrionIntake, grazingIntake } from '../../contracts/formulas';
import type { RandomSource, SimState, SlotIndex } from '../../contracts/types';
import { T_METABOLIC_EFF, T_OPT, T_WIDTH, trait } from './columns';
import { ensureOrganismCache, thermalToleranceOf } from './derived';
import { carrionEnabled } from './resources';
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
  // Recorded for the growth stage, which spends what is left of this tick's
  // intake after the metabolic burn. Assignment, not accumulation: feeding runs
  // over every live slot before any other intake stage, so this is where the
  // tick's tally starts and a recycled slot cannot inherit one.
  const gained = grazeAndScavenge(runtime, state, slot, rng);
  runtime.tickIntake[slot] = gained;
  return gained;
}

function grazeAndScavenge(
  runtime: EcologyRuntime,
  state: SimState,
  slot: SlotIndex,
  rng: RandomSource,
): number {
  const pop = state.pop;
  const x = pop.x[slot] ?? 0;
  const y = pop.y[slot] ?? 0;
  const cell = fieldCellAt(runtime, x, y);
  const plankton = state.field.plankton[cell] ?? 0;
  const carrion = state.field.carrion[cell] ?? 0;
  if (plankton <= 0 && (!carrionEnabled(state) || carrion <= 0)) return 0;

  ensureOrganismCache(runtime, state, slot);
  const headroom = (runtime.memoMaxEnergy[slot] ?? 0) - (pop.energy[slot] ?? 0);
  if (headroom <= 0) return 0;

  const traits = pop.traits;
  // A bigger mouth takes a bigger bite, and a bold animal spends its time in
  // open water where the plankton is — the same trait raises its exposure in
  // the predation kernel, which is the tradeoff that keeps boldness honest.
  const performance =
    thermalToleranceOf(
      state.field.temperature[cell] ?? 0,
      trait(traits, slot, T_OPT),
      trait(traits, slot, T_WIDTH),
    ) * (runtime.memoThermalTax[slot] ?? 0);
  const jitter = 1 + INTAKE_JITTER_HALF_WIDTH * (2 * rng.next() - 1);

  const assimilation = Math.max(0, trait(traits, slot, T_METABOLIC_EFF));
  let remainingHeadroom = headroom;
  let totalGained = 0;

  let planktonHarvest = grazingIntake(
    runtime.memoBite[slot] ?? 0,
    runtime.memoPlantEfficiency[slot] ?? 0,
    plankton,
    state.config,
  ) * performance * jitter;
  if (planktonHarvest > plankton) planktonHarvest = plankton;
  if (planktonHarvest > 0 && assimilation > 0) {
    let gained = planktonHarvest * assimilation;
    if (gained > remainingHeadroom) {
      planktonHarvest *= remainingHeadroom / gained;
      gained = remainingHeadroom;
    }
    state.field.plankton[cell] = plankton - planktonHarvest;
    totalGained += gained;
    remainingHeadroom -= gained;
  }

  if (!carrionEnabled(state) || carrion <= 0 || remainingHeadroom <= 0) return totalGained;
  const grazingMax = state.config.resources.grazingMaxIntake;
  const biteScale = grazingMax > 0 ? (runtime.memoBite[slot] ?? 0) / grazingMax : 0;
  let carrionHarvest = carrionIntake(
    biteScale,
    runtime.memoCarrionEfficiency[slot] ?? 0,
    carrion,
    state.config,
  ) * performance * jitter;
  if (carrionHarvest > carrion) carrionHarvest = carrion;
  if (carrionHarvest <= 0 || assimilation <= 0) return totalGained;
  let gained = carrionHarvest * assimilation;
  if (gained > remainingHeadroom) {
    carrionHarvest *= remainingHeadroom / gained;
    gained = remainingHeadroom;
  }
  state.field.carrion[cell] = carrion - carrionHarvest;
  return totalGained + gained;
}
