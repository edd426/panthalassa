/**
 * Predation and the search-image morph structure (WP-A2).
 *
 * Predation is one of the four mortality channels P7 requires to carry weight,
 * and the only one that couples two evolving populations: `attack` and
 * `defense` chase each other through `predationKillProbability`, which is the
 * arms race P9 measures.
 *
 * The frequency-dependent term is the variance pump with teeth. A predator's
 * search image locks onto whatever morph is commonest *locally*, so a rare hue
 * is protected and `displayHue` never fixes — and because `displayHue` shares a
 * locus with `diet`, protecting rare hues also protects rare diets.
 *
 * Nothing here mutates another organism's slot. Kills go into a `KillSink` and
 * the engine applies them at the stage boundary, because a predation stage that
 * killed in place would make the outcome depend on iteration order in a way no
 * snapshot could reproduce.
 */

import type { KillSink, SpatialIndex } from '../../contracts/apis';
import { predationKillProbability } from '../../contracts/formulas';
import { HUE_PERIOD_DEG } from '../../contracts/traits';
import type { RandomSource, SimState, SlotIndex } from '../../contracts/types';
import { NO_SLOT } from '../../contracts/types';
import {
  T_ATTACK,
  T_DEFENSE,
  T_DISPLAY_HUE,
  T_FORAGE_BOLDNESS,
  T_SIZE,
  T_SPEED_CAP,
  trait,
} from './columns';
import { ensureOrganismCache } from './derived';
import { kelpCoverAt } from './resources';
import type { EcologyRuntime } from './runtime';
import { clampInt } from './runtime';

/**
 * Local frequency of a hue morph, 0..1.
 *
 * Returns the neutral `1 / hueBinCount` when the mechanism is off, matching the
 * centring in `predationKillProbability`: switching frequency dependence off
 * has to change the *shape* of predation without changing its mean, or A7
 * cannot attribute a variance difference to this mechanism rather than to
 * milder predation overall.
 */
export function hueMorphFrequencyAt(
  runtime: EcologyRuntime,
  state: SimState,
  x: number,
  y: number,
  hueDeg: number,
): number {
  const neutral = 1 / runtime.hueBins;
  if (!state.config.toggles.enableFrequencyDependentPredation) return neutral;

  ensureHueGrid(runtime, state);
  const cell = hueCellAt(runtime, x, y);
  const total = runtime.hueTotals[cell] ?? 0;
  if (total <= 0) return neutral;
  return (runtime.hueCounts[cell * runtime.hueBins + hueBinOf(hueDeg, runtime.hueBins)] ?? 0) / total;
}

/**
 * Bin the live population's display hues onto the coarse morph grid.
 *
 * Rebuilt whenever the tick has moved rather than on a cadence of its own: the
 * grid is then a pure function of `SimState` at the current tick, so a snapshot
 * restored mid-run reproduces it exactly. A cadence would leave a restored
 * world holding a differently-stale grid than the run it came from, and P1's
 * snapshot→restore→continue assertion would fail for no real reason.
 */
function ensureHueGrid(runtime: EcologyRuntime, state: SimState): void {
  if (runtime.hueGridTick === state.tick) return;

  const { hueCounts, hueTotals, hueBins } = runtime;
  hueCounts.fill(0);
  hueTotals.fill(0);

  const pop = state.pop;
  for (let slot = 0; slot < pop.capacity; slot += 1) {
    if (pop.alive[slot] !== 1) continue;
    const cell = hueCellAt(runtime, pop.x[slot] ?? 0, pop.y[slot] ?? 0);
    const bin = hueBinOf(trait(pop.traits, slot, T_DISPLAY_HUE), hueBins);
    hueCounts[cell * hueBins + bin] = (hueCounts[cell * hueBins + bin] ?? 0) + 1;
    hueTotals[cell] = (hueTotals[cell] ?? 0) + 1;
  }
  runtime.hueGridTick = state.tick;
}

function hueCellAt(runtime: EcologyRuntime, x: number, y: number): number {
  const col = clampInt(Math.floor(x / runtime.hueCellSizeWu), 0, runtime.hueCols - 1);
  const row = clampInt(Math.floor(y / runtime.hueCellSizeWu), 0, runtime.hueRows - 1);
  return row * runtime.hueCols + col;
}

function hueBinOf(hueDeg: number, bins: number): number {
  const wrapped = ((hueDeg % HUE_PERIOD_DEG) + HUE_PERIOD_DEG) % HUE_PERIOD_DEG;
  return clampInt(Math.floor((wrapped / HUE_PERIOD_DEG) * bins), 0, bins - 1);
}

/**
 * Predation attempts by one organism.
 *
 * Gated three ways: a full gut (still handling the last kill), satiety, and the
 * diet trait, which sets the *rate* of attempts rather than a hard cutoff — a
 * hard threshold would put a cliff in the middle of the trait axis selection is
 * supposed to move continuously along.
 */
export function tryPredation(
  runtime: EcologyRuntime,
  state: SimState,
  slot: SlotIndex,
  spatial: SpatialIndex,
  rng: RandomSource,
  kills: KillSink,
): void {
  const config = state.config;
  const pop = state.pop;
  const traits = pop.traits;

  if ((pop.gutFill[slot] ?? 0) > 0) return;

  const size = trait(traits, slot, T_SIZE);
  if (size <= 0) return;

  ensureOrganismCache(runtime, state, slot);
  if (
    (pop.energy[slot] ?? 0) >=
    (runtime.memoMaxEnergy[slot] ?? 0) * config.behavior.matingSeekEnergyFraction
  ) {
    return;
  }

  const preyEfficiency = runtime.memoPreyEfficiency[slot] ?? 0;
  if (!(preyEfficiency > 0) || !rng.chance(preyEfficiency)) return;

  const x = pop.x[slot] ?? 0;
  const y = pop.y[slot] ?? 0;
  const neighbors = runtime.neighbors;
  const found = spatial.queryNeighbors(x, y, config.predation.attemptRadiusWu, neighbors);
  if (found === 0) return;

  const attack = trait(traits, slot, T_ATTACK);
  const speed = trait(traits, slot, T_SPEED_CAP);
  const preyYield = runtime.memoPreyYield[slot] ?? 0;

  for (let index = 0; index < found; index += 1) {
    const victim = neighbors[index] ?? NO_SLOT;
    if (victim === slot || victim === NO_SLOT) continue;

    const victimX = pop.x[victim] ?? 0;
    const victimY = pop.y[victim] ?? 0;
    const victimSize = trait(traits, victim, T_SIZE);

    // A bold forager spends its time in open water, so the kelp it is nominally
    // standing in shelters it less. This is the cost side of `forageBoldness`.
    const shelter =
      kelpCoverAt(runtime, state, victimX, victimY) / Math.exp(trait(traits, victim, T_FORAGE_BOLDNESS));
    const cover = Math.min(config.resources.kelpCoverMax, shelter);

    const probability = predationKillProbability(
      attack,
      trait(traits, victim, T_DEFENSE),
      size,
      victimSize,
      speed,
      trait(traits, victim, T_SPEED_CAP),
      cover,
      hueMorphFrequencyAt(runtime, state, victimX, victimY, trait(traits, victim, T_DISPLAY_HUE)),
      config,
    );

    if (!rng.chance(probability)) continue;

    const yielded = config.predation.energyPerPreySize * Math.max(0, victimSize) * preyYield;
    kills.push(slot, victim, yielded);
    // The predator's own satiation store; the engine credits the energy when it
    // drains the sink, but the handling time starts now.
    pop.gutFill[slot] = (pop.gutFill[slot] ?? 0) + yielded;
    return;
  }
}
