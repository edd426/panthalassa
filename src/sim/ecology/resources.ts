/**
 * Plankton and kelp dynamics (WP-A2).
 *
 * Plankton is logistic toward a carrying capacity that tracks light and thermal
 * suitability, stirred by the authored current. Kelp is slower, capped higher,
 * and grows only where {@link buildKelpCapacity} allows it — around reefs and
 * against barriers — because kelp is the predation refuge and a refuge that is
 * everywhere is not a refuge.
 *
 * Density dependence in this model comes from here, not from the slot cap: P3
 * fails if the cap is what is holding the population down.
 */

import type { SimState } from '../../contracts/types';
import { updateCarryingCapacity } from './fields';
import type { EcologyRuntime } from './runtime';
import { RESOURCE_UPDATE_INTERVAL, sampleField } from './runtime';

/**
 * Propagule rain, as a fraction of local carrying capacity per growth step.
 *
 * Pure logistic growth has an absorbing state at zero: a cell grazed flat stays
 * flat forever, and a heavy predation year would permanently strip the map. The
 * term is small enough to be invisible against a standing crop and large enough
 * that a cleared cell recovers in tens of steps.
 */
const PROPAGULE_FRACTION = 1e-3;

/** Kelp regrows from the holdfast, so it needs a larger seed than drifting plankton. */
const KELP_PROPAGULE_FRACTION = 5e-3;

/**
 * One logistic step toward `capacity`, with a propagule term and a hard floor
 * at zero. Exported because it is the cleanest thing in the module to assert
 * on: convergence to K from either side, and never negative.
 */
export function logisticStep(
  resource: number,
  capacity: number,
  rate: number,
  propaguleFraction: number = PROPAGULE_FRACTION,
): number {
  const current = resource > 0 ? resource : 0;
  if (capacity <= 0) {
    const decayed = current * (1 - rate);
    return decayed > 0 ? decayed : 0;
  }
  const seeded = current + propaguleFraction * capacity;
  const next = current + rate * seeded * (1 - current / capacity);
  return next > 0 ? next : 0;
}

/**
 * Advance plankton and kelp.
 *
 * Runs on `RESOURCE_UPDATE_INTERVAL` with the growth rate scaled to match, so
 * the realised timescale is the one in `SimConfig` regardless of the cadence.
 * The phase comes from `SimState.tick`, so a restored snapshot lands on the
 * same steps an uninterrupted run would have taken.
 */
export function regrowResources(runtime: EcologyRuntime, state: SimState): void {
  // K every tick, unconditionally: it is derived state a snapshot does not
  // carry, and behaviour reads it, so a restore between interval steps would
  // otherwise diverge from the uninterrupted run (P1; found by WP-A5).
  updateCarryingCapacity(runtime, state);

  if (state.tick % RESOURCE_UPDATE_INTERVAL !== 0) return;

  const { plankton, kelp, carryingCapacity } = state.field;
  const { cellCount, kelpK, scratch, advectSrcX, advectSrcY } = runtime;
  const planktonRate = state.config.resources.planktonGrowthRate * RESOURCE_UPDATE_INTERVAL;
  const kelpRate = state.config.resources.kelpGrowthRate * RESOURCE_UPDATE_INTERVAL;

  for (let cell = 0; cell < cellCount; cell += 1) {
    plankton[cell] = logisticStep(plankton[cell] ?? 0, carryingCapacity[cell] ?? 0, planktonRate);
  }

  // Semi-Lagrangian advection along the divergence-free current. Kelp is
  // rooted and does not advect.
  for (let cell = 0; cell < cellCount; cell += 1) {
    scratch[cell] = sampleField(runtime, plankton, advectSrcX[cell] ?? 0, advectSrcY[cell] ?? 0);
  }
  plankton.set(scratch);

  for (let cell = 0; cell < cellCount; cell += 1) {
    kelp[cell] = logisticStep(kelp[cell] ?? 0, kelpK[cell] ?? 0, kelpRate, KELP_PROPAGULE_FRACTION);
  }
}

/** Kelp cover at a position, 0..1 — the predation kernel's refuge term. */
export function kelpCoverAt(runtime: EcologyRuntime, state: SimState, x: number, y: number): number {
  const cover = sampleField(runtime, state.field.kelp, x, y);
  return cover > 0 ? cover : 0;
}
