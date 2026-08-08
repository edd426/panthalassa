/**
 * Metabolism and the non-predation mortality channels (WP-A2).
 *
 * Three of the four channels P7 requires live here: starvation, temperature and
 * senescence. Herdloom died because old age was the *only* way to die, which
 * removes natural selection entirely — so each channel is rolled independently
 * and each is expected to carry between 5% and 70% of deaths.
 *
 * One knob per channel, deliberately: `metabolism.*` sets the energy bill,
 * `metabolism.thermalStressCostCoef` the surcharge for living out of your
 * thermal window, `thermal.hazardCoef` the outright thermal kill rate, and
 * `senescence.*` the Gompertz curve. Overlapping two knobs onto one channel is
 * what makes a tuning campaign unable to attribute an effect.
 */

import { senescenceHazard, temperatureHazard } from '../../contracts/formulas';
import type { DeathSink } from '../../contracts/apis';
import type { RandomSource, SimState, SlotIndex } from '../../contracts/types';
import { NO_SLOT } from '../../contracts/types';
import { T_OPT, T_WIDTH, trait } from './columns';
import { ensureOrganismCache, metabolicCostFor } from './derived';
import { localTemperatureC } from './fields';
import type { EcologyRuntime } from './runtime';

/**
 * Burn one organism's tick and roll its hazards.
 *
 * Rolls stop at the first death: an organism that starves is not then also
 * asked whether it died of old age, or the death-cause tally would double-count
 * and P7's mix would be measuring the roll order rather than the ecology.
 */
export function metabolismAndHazards(
  runtime: EcologyRuntime,
  state: SimState,
  slot: SlotIndex,
  rng: RandomSource,
  deaths: DeathSink,
): void {
  const config = state.config;
  const pop = state.pop;
  const traits = pop.traits;

  const temperature = localTemperatureC(runtime, state, pop.x[slot] ?? 0, pop.y[slot] ?? 0);
  const tOpt = trait(traits, slot, T_OPT);
  const tWidth = trait(traits, slot, T_WIDTH);
  const vx = pop.vx[slot] ?? 0;
  const vy = pop.vy[slot] ?? 0;
  const speedWuPerTick = Math.sqrt(vx * vx + vy * vy);

  ensureOrganismCache(runtime, state, slot);
  let burn = metabolicCostFor(runtime, state, slot, speedWuPerTick);
  const excess = Math.max(0, Math.abs(temperature - tOpt) - Math.max(0, tWidth));
  burn += config.metabolism.thermalStressCostCoef * excess * excess;

  const energy = (pop.energy[slot] ?? 0) - burn;
  pop.energy[slot] = energy > 0 ? energy : 0;

  const gut = (pop.gutFill[slot] ?? 0) - (runtime.memoDigestion[slot] ?? 0);
  pop.gutFill[slot] = gut > 0 ? gut : 0;

  if (energy <= 0) {
    deaths.push(slot, 'starvation', NO_SLOT);
    return;
  }

  // Competing risks off a single uniform rather than a hazard roll each. An
  // organism dies once, so the causes have to be mutually exclusive anyway, and
  // partitioning one draw gives each channel its exact marginal rate — rolling
  // sequentially would quietly discount senescence by the thermal survival
  // probability, which is a bias P7 would then be measuring.
  const thermal = temperatureHazard(temperature, tOpt, tWidth, config);
  const senescence = senescenceHazard(pop.ageTicks[slot] ?? 0, config);
  const draw = rng.next();
  if (draw < thermal) {
    deaths.push(slot, 'temperature', NO_SLOT);
    return;
  }
  if (draw < thermal + senescence) {
    deaths.push(slot, 'senescence', NO_SLOT);
  }
}
