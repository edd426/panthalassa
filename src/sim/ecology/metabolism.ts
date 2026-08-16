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

import { senescenceHazard, somaticGrowthPerTick, temperatureHazard } from '../../contracts/formulas';
import type { DeathSink } from '../../contracts/apis';
import type { RandomSource, SimState, SlotIndex } from '../../contracts/types';
import { NO_SLOT } from '../../contracts/types';
import { sizeCurrentColumn } from '../organisms';
import { T_GROWTH_ALLOCATION, T_OPT, T_SIZE, T_WIDTH, trait } from './columns';
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

  if (config.toggles.enableOntogeny) growSoma(runtime, state, slot, energy, burn);

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

/**
 * Spend this tick's energy surplus on body length (G2, ontogeny only).
 *
 * **Surplus is intake minus the tick's burn** — what the animal ate this tick
 * and did not have to spend staying alive. Intake is `runtime.tickIntake`,
 * filled by the feeding stage and topped up by a kill claimed in the predation
 * stage, both of which run before this one; the alternative operationalisation
 * the brief allowed (energy above a fraction of capacity) would have needed a
 * reserve-fraction constant that `GrowthConfig` does not have, and would have
 * made a full-bellied animal grow on calories it ate a hundred ticks ago.
 *
 * Three properties follow and are what the unit tests pin:
 *
 * - Zero surplus is zero growth, so a starving animal stunts rather than
 *   shrinking or dying of growth. Nothing here can reduce a length.
 * - The spend is bounded by the energy actually on hand after the burn. That is
 *   an energy constraint, not a cap on the trait — a predator whose kill energy
 *   the engine credits at the end of the tick can still only build tissue out of
 *   reserves it already holds.
 * - There is **no cap at the target length**. `tissueCostPerCm` makes overshoot
 *   quadratically-then-sharply expensive, so the asymptote recedes instead of
 *   clamping.
 */
function growSoma(
  runtime: EcologyRuntime,
  state: SimState,
  slot: SlotIndex,
  energyAfterBurn: number,
  burn: number,
): void {
  const surplus = (runtime.tickIntake[slot] ?? 0) - burn;
  if (surplus <= 0) return;

  const pop = state.pop;
  const allocation = trait(pop.traits, slot, T_GROWTH_ALLOCATION);
  if (!(allocation > 0)) return;

  const spend = Math.min(allocation * surplus, energyAfterBurn);
  if (!(spend > 0)) return;

  const lengths = sizeCurrentColumn(pop);
  const length = lengths[slot] ?? 0;
  // The allocation share is already in `spend`, so it is passed as 1 rather
  // than applied twice; what is left of the frozen formula is the tissue price.
  const grown = somaticGrowthPerTick(spend, length, trait(pop.traits, slot, T_SIZE), 1, state.config);
  if (!(grown > 0)) return;

  lengths[slot] = length + grown;
  pop.energy[slot] = energyAfterBurn - spend;
}
