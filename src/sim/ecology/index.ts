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
  writeTemperatureField,
} from './fields';
import { applyFeeding } from './feeding';
import { metabolismAndHazards } from './metabolism';
import { hueMorphFrequencyAt, tryPredation } from './predation';
import { kelpCoverAt, regrowResources } from './resources';
import type { EcologyRuntime } from './runtime';
import { ensureRuntime } from './runtime';

export function createEcology(): EcologyApi {
  let runtime: EcologyRuntime | undefined;
  const ensure = (state: SimState): EcologyRuntime => {
    runtime = ensureRuntime(runtime, state);
    ensureTemperatureField(runtime, state);
    return runtime;
  };

  return {
    initFields(state, rng) {
      initFields(ensure(state), state, rng);
    },
    updateFields(state, rng) {
      const runtime = ensure(state);
      stepClimate(state, rng);
      writeTemperatureField(runtime, state);
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
      ensure(state);
    },
  };
}

export { createSpatialIndex, maxInteractionRadiusWu } from '../spatial';
export type { EcologyRuntime } from './runtime';
