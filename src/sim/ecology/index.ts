/**
 * Ecology module assembly (WP-A2).
 *
 * `createEcology()` returns the `EcologyApi` the engine is wired with. The
 * derived runtime (reefs, patchiness, kelp map, morph grid) is private to the
 * instance and rebuilt lazily from `SimState`, so restoring a snapshot into a
 * fresh module gives a bit-identical world without `initFields` running again.
 */

import type { EcologyApi } from '../../contracts/apis';
import type { SimState } from '../../contracts/types';
import { decideBehavior } from './behavior';
import {
  ensureTemperatureField,
  initFields,
  rebuildBarrierMask,
  stepClimate,
  temperatureAnomalyZAt,
  temperatureAt,
  writeClimateFields,
} from './fields';
import { applyFeeding } from './feeding';
import { metabolismAndHazards } from './metabolism';
import { hueMorphFrequencyAt, tryPredation } from './predation';
import { kelpCoverAt, regrowResources } from './resources';
import { updateDisturbances } from './disturbances';
import type { EcologyRuntime } from './runtime';
import { ensureRuntime } from './runtime';

export function createEcology(): EcologyApi {
  let runtime: EcologyRuntime | undefined;

  // The engine calls four of the methods below once per organism per tick, and
  // each of them opened by revalidating the runtime and the published
  // temperature field — tens of millions of repeats of a check whose answer can
  // only change when the tick, the config or the state object does. Caching the
  // answer against exactly those three collapses it to one full check per tick.
  // Keying on the state *identity* matters: one ecology instance may be handed
  // two worlds standing at the same tick, and each needs its own field written.
  let checkedState: SimState | undefined;
  let checkedTick = Number.NaN;
  let checkedConfig: SimState['config'] | undefined;

  const ensure = (state: SimState): EcologyRuntime => {
    if (
      runtime !== undefined &&
      checkedState === state &&
      checkedTick === state.tick &&
      checkedConfig === state.config
    ) {
      return runtime;
    }
    runtime = ensureRuntime(runtime, state);
    ensureTemperatureField(runtime, state);
    checkedState = state;
    checkedTick = state.tick;
    checkedConfig = state.config;
    return runtime;
  };

  /** Force the next `ensure` to do the full check; for the paths that change the world under it. */
  const invalidate = (): void => {
    checkedState = undefined;
  };

  return {
    initFields(state, rng) {
      invalidate();
      initFields(ensure(state), state, rng);
    },
    updateFields(state, rng) {
      // Deliberately not through `ensure`: the climate moves in this call, so
      // publishing the fields on the way in would write them once from the
      // previous offset and again from the new one. Take the runtime, step,
      // publish once, then stamp the cache so the rest of the tick skips it.
      runtime = ensureRuntime(runtime, state);
      updateDisturbances(state);
      stepClimate(state, rng);
      writeClimateFields(runtime, state);
      checkedState = state;
      checkedTick = state.tick;
      checkedConfig = state.config;
    },
    regrowResources(state) {
      regrowResources(ensure(state), state);
    },
    decideBehavior(state, slot, spatial, rng, out) {
      decideBehavior(ensure(state), state, slot, spatial, rng, out);
    },
    applyFeeding(state, slot, rng) {
      return applyFeeding(ensure(state), state, slot, rng);
    },
    tryPredation(state, slot, spatial, rng, kills) {
      tryPredation(ensure(state), state, slot, spatial, rng, kills);
    },
    metabolismAndHazards(state, slot, rng, deaths) {
      metabolismAndHazards(ensure(state), state, slot, rng, deaths);
    },
    temperatureAt(state, x, y) {
      return temperatureAt(state, x, y);
    },
    temperatureAnomalyZAt(state, x, y) {
      return temperatureAnomalyZAt(state, x, y);
    },
    kelpCoverAt(state, x, y) {
      return kelpCoverAt(ensure(state), state, x, y);
    },
    hueMorphFrequencyAt(state, x, y, hueDeg) {
      return hueMorphFrequencyAt(ensure(state), state, x, y, hueDeg);
    },
    rebuildBarrierMask(state) {
      rebuildBarrierMask(state);
      invalidate();
      ensure(state);
    },
  };
}

export { createSpatialIndex, maxInteractionRadiusWu } from '../spatial';
export type { EcologyRuntime } from './runtime';
