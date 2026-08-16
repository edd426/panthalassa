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
import { aposematismLogit, predationKillProbability, toxinYieldMultiplier } from '../../contracts/formulas';
import { HUE_PERIOD_DEG } from '../../contracts/traits';
import type { RandomSource, SimState, SlotIndex } from '../../contracts/types';
import { NO_SLOT } from '../../contracts/types';
import { sizeCurrentColumn } from '../organisms';
import {
  T_ATTACK,
  T_CONSPICUOUSNESS,
  T_DEFENSE,
  T_DISPLAY_HUE,
  T_FORAGE_BOLDNESS,
  T_SPEED_CAP,
  T_TOXICITY,
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
 * {@link hueMorphFrequencyAt} for an organism the grid has already binned.
 *
 * The predation kernel asks this of every candidate victim, and the cell and
 * bin it needs were both computed when the grid was built this tick. Reading
 * them back is exact rather than approximate — the position and hue are the
 * same ones {@link ensureHueGrid} saw, because nothing moves or is born between
 * the index rebuild and the end of the predation stage.
 */
export function hueMorphFrequencyOfSlot(
  runtime: EcologyRuntime,
  state: SimState,
  slot: SlotIndex,
): number {
  const neutral = 1 / runtime.hueBins;
  if (!state.config.toggles.enableFrequencyDependentPredation) return neutral;

  ensureHueGrid(runtime, state);
  const cell = runtime.hueSlotCell[slot] ?? 0;
  const total = runtime.hueTotals[cell] ?? 0;
  if (total <= 0) return neutral;
  return (runtime.hueCounts[cell * runtime.hueBins + (runtime.hueSlotBin[slot] ?? 0)] ?? 0) / total;
}

/**
 * Local mean expressed toxicity of one hue bin — the population statistic the
 * aposematic credit is read off (G3).
 *
 * Sibling of {@link hueMorphFrequencyAt} on purpose, and it inherits that term's
 * honesty: no predator remembers anything, and no organism is told who is toxic.
 * The avoidance a loud victim earns is a function of what the *neighbourhood's*
 * bin has been like to eat, which is the same abstraction the search image
 * already makes.
 *
 * Zero when the mechanism is off or the bin is empty, so the aposematic term of
 * {@link aposematismLogit} vanishes rather than defaulting to a neutral value —
 * an unoccupied bin has taught the population nothing.
 */
export function hueBinToxicityAt(
  runtime: EcologyRuntime,
  state: SimState,
  x: number,
  y: number,
  hueDeg: number,
): number {
  if (!state.config.toggles.enableAposematism) return 0;

  ensureHueGrid(runtime, state);
  const index = hueCellAt(runtime, x, y) * runtime.hueBins + hueBinOf(hueDeg, runtime.hueBins);
  const count = runtime.hueCounts[index] ?? 0;
  if (count <= 0) return 0;
  return (runtime.hueToxicitySums[index] ?? 0) / count;
}

/**
 * {@link hueBinToxicityAt} for an organism the grid has already binned; the same
 * exactness argument as {@link hueMorphFrequencyOfSlot}.
 */
export function hueBinToxicityOfSlot(
  runtime: EcologyRuntime,
  state: SimState,
  slot: SlotIndex,
): number {
  if (!state.config.toggles.enableAposematism) return 0;

  ensureHueGrid(runtime, state);
  const index = (runtime.hueSlotCell[slot] ?? 0) * runtime.hueBins + (runtime.hueSlotBin[slot] ?? 0);
  const count = runtime.hueCounts[index] ?? 0;
  if (count <= 0) return 0;
  return (runtime.hueToxicitySums[index] ?? 0) / count;
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

  const { hueCounts, hueTotals, hueBins, hueSlotCell, hueSlotBin, hueToxicitySums } = runtime;
  hueCounts.fill(0);
  hueTotals.fill(0);
  // One pass fills both statistics (CLAUDE.md: no second sweep). The toxicity
  // accumulator is gated rather than written unconditionally, so the off arm
  // does not pay for a number nothing there can read.
  const aposematism = state.config.toggles.enableAposematism;
  if (aposematism) hueToxicitySums.fill(0);

  const pop = state.pop;
  for (let slot = 0; slot < pop.capacity; slot += 1) {
    if (pop.alive[slot] !== 1) continue;
    const cell = hueCellAt(runtime, pop.x[slot] ?? 0, pop.y[slot] ?? 0);
    const bin = hueBinOf(trait(pop.traits, slot, T_DISPLAY_HUE), hueBins);
    hueCounts[cell * hueBins + bin] = (hueCounts[cell * hueBins + bin] ?? 0) + 1;
    hueTotals[cell] = (hueTotals[cell] ?? 0) + 1;
    hueSlotCell[slot] = cell;
    hueSlotBin[slot] = bin;
    if (aposematism) {
      hueToxicitySums[cell * hueBins + bin] =
        (hueToxicitySums[cell * hueBins + bin] ?? 0) + trait(pop.traits, slot, T_TOXICITY);
    }
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

  // Realised length on both sides of the kernel: the size window is about the
  // bodies in the water, and juveniles are what put prey inside it.
  const lengths = sizeCurrentColumn(pop);
  const size = lengths[slot] ?? 0;
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
  // Cannibalism is not banned — the kernel never checked species — it is
  // priced. `growth.conspecificLogit` (negative) is added to the kill logit
  // when predator and victim carry the same tag, which is the whole mechanism:
  // eating your own recruitment stays possible and stays expensive.
  const conspecificOdds = config.toggles.enableOntogeny ? Math.exp(config.growth.conspecificLogit) : 1;
  const predatorTag = pop.speciesTag[slot] ?? 0;
  const aposematism = config.toggles.enableAposematism;

  for (let index = 0; index < found; index += 1) {
    const victim = neighbors[index] ?? NO_SLOT;
    if (victim === slot || victim === NO_SLOT) continue;

    const victimX = pop.x[victim] ?? 0;
    const victimY = pop.y[victim] ?? 0;
    const victimSize = lengths[victim] ?? 0;

    // A bold forager spends its time in open water, so the kelp it is nominally
    // standing in shelters it less. This is the cost side of `forageBoldness`.
    const shelter =
      kelpCoverAt(runtime, state, victimX, victimY) / Math.exp(trait(traits, victim, T_FORAGE_BOLDNESS));
    const cover = Math.min(config.resources.kelpCoverMax, shelter);

    let probability = predationKillProbability(
      attack,
      trait(traits, victim, T_DEFENSE),
      size,
      victimSize,
      speed,
      trait(traits, victim, T_SPEED_CAP),
      cover,
      hueMorphFrequencyOfSlot(runtime, state, victim),
      config,
    );

    // Adding the conspecific logit as an odds multiplier on the frozen kernel's
    // output, rather than reimplementing the sum, keeps `formulas.ts` the single
    // source of the probability. Written so p = 1 stays 1 instead of dividing by
    // a zero complement.
    if (conspecificOdds !== 1 && (pop.speciesTag[victim] ?? 0) === predatorTag) {
      const scaled = probability * conspecificOdds;
      probability = scaled / (1 - probability + scaled);
    }

    // The signal terms ride on the same odds multiplier for the same reason:
    // `formulas.ts` stays the one place the probability is defined. Detection
    // (loud is easier to find) and aposematic credit (loud is a warning only
    // where the local bin has actually been toxic) are both inside
    // `aposematismLogit`, so nothing here may add a conspicuousness term of its
    // own.
    if (aposematism) {
      const signalOdds = Math.exp(
        aposematismLogit(
          trait(traits, victim, T_CONSPICUOUSNESS),
          hueBinToxicityOfSlot(runtime, state, victim),
          config,
        ),
      );
      if (signalOdds !== 1) {
        const scaled = probability * signalOdds;
        probability = scaled / (1 - probability + scaled);
      }
    }

    if (!rng.chance(probability)) continue;

    let yielded = config.predation.energyPerPreySize * Math.max(0, victimSize) * preyYield;
    // Toxin is a post-kill penalty: the victim is already dead, and what it
    // bought is a smaller meal (here) plus a hazard on the predator (rolled by
    // the engine at the kill site, since this stage is handed a `KillSink` and
    // not a `DeathSink`).
    if (aposematism) yielded *= toxinYieldMultiplier(trait(traits, victim, T_TOXICITY), config);
    kills.push(slot, victim, yielded);
    // Counted as intake for this tick's growth surplus even though the engine
    // credits the energy when it drains the sink (after the metabolism stage):
    // a pure carnivore's calories arrive here and nowhere else, and a predator
    // that could not grow could never reach its target length. The growth spend
    // is bounded by the energy actually on hand, so a kill the engine later
    // ignores — a victim another predator claimed first — cannot mint any.
    runtime.tickIntake[slot] = (runtime.tickIntake[slot] ?? 0) + yielded;
    // The predator's own satiation store; the engine credits the energy when it
    // drains the sink, but the handling time starts now.
    pop.gutFill[slot] = (pop.gutFill[slot] ?? 0) + yielded;
    return;
  }
}
