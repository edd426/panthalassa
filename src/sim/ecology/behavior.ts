/**
 * Behaviour policies (WP-A2).
 *
 * The policy *set* is fixed — flee, pursue, forage, climb, seek mate, wander —
 * but every parameter that decides between them is a genetic trait: `wariness`
 * sets flight-initiation distance, `forageBoldness` sets exposure,
 * `givingUpTime` sets patience. That is how behaviour evolves in Phase A
 * without evolving a network, and it is why the priority ladder below is
 * authored while the thresholds inside it are not.
 *
 * Priority: flee > pursue > forage/climb > seek mate > wander. Fleeing
 * outranks everything because a dead animal's foraging efficiency is moot.
 *
 * Decisions are staggered by `time.decisionStaggerTicks`: an organism
 * re-evaluates on the ticks where `(tick + slot) % stagger === 0` and otherwise
 * re-emits the policy it is already running. Staggering by slot spreads the
 * neighbour queries evenly across ticks instead of spiking every N-th one.
 */

import type { BehaviorDecision, SpatialIndex } from '../../contracts/apis';
import type { RandomSource, SimState, SlotIndex } from '../../contracts/types';
import {
  BEHAVIOR_CLIMB_GRADIENT,
  BEHAVIOR_FLEE,
  BEHAVIOR_FORAGE,
  BEHAVIOR_PURSUE,
  BEHAVIOR_SEEK_MATE,
  BEHAVIOR_WANDER,
  NO_SLOT,
  SEX_FEMALE,
} from '../../contracts/types';
import { isMature, sizeCurrentColumn } from '../organisms';
import {
  T_DIET,
  T_GIVING_UP_TIME,
  T_OPT,
  T_WARINESS,
  T_WIDTH,
  trait,
} from './columns';
import { ensureOrganismCache, thermalToleranceOf } from './derived';
import { barrierPermeabilityAt, currentXAt, currentYAt, localTemperatureC } from './fields';
import type { EcologyRuntime } from './runtime';
import { clamp01, sampleField } from './runtime';

/** Cruising fractions of `speedCap` for the policies the config does not name. */
const WANDER_SPEED_FRACTION = 0.35;
const FORAGE_SPEED_FRACTION = 0.22;
const SEEK_MATE_SPEED_FRACTION = 0.5;

/** A patch is worth staying in while it holds at least this share of its own capacity. */
const FORAGE_SATISFACTION = 0.4;

/** Half-widths of the predation size window, for "am I on its menu / is it on mine". Realised lengths, like the kernel itself. */
const SIZE_WINDOW_TOLERANCE = 2;

/** Below this the local gradient is noise and climbing it is a random walk with extra steps. */
const GRADIENT_EPSILON = 1e-9;

/**
 * Choose a policy and a heading for one organism, writing into the caller's
 * scratch decision. Allocates nothing.
 */
export function decideBehavior(
  runtime: EcologyRuntime,
  state: SimState,
  slot: SlotIndex,
  spatial: SpatialIndex,
  rng: RandomSource,
  out: BehaviorDecision,
): void {
  const config = state.config;
  const pop = state.pop;
  const stagger = Math.max(1, config.time.decisionStaggerTicks);

  if ((state.tick + slot) % stagger !== 0) {
    reemitCurrentPolicy(state, slot, out);
    return;
  }

  const traits = pop.traits;
  const x = pop.x[slot] ?? 0;
  const y = pop.y[slot] ?? 0;
  const size = sizeCurrentColumn(pop)[slot] ?? 0;
  const diet = trait(traits, slot, T_DIET);
  ensureOrganismCache(runtime, state, slot);
  const energyFraction = (pop.energy[slot] ?? 0) / Math.max(1e-6, runtime.memoMaxEnergy[slot] ?? 0);
  const previousMode = pop.behaviorState[slot] ?? BEHAVIOR_WANDER;
  const patience = trait(traits, slot, T_GIVING_UP_TIME);
  const persistedTicks = pop.behaviorTimer[slot] ?? 0;

  const neighbors = runtime.neighbors;
  const found = spatial.queryNeighbors(x, y, config.behavior.neighborScanRadiusWu, neighbors);

  out.mode = BEHAVIOR_WANDER;
  out.targetSlot = NO_SLOT;
  out.steerX = 0;
  out.steerY = 0;
  out.speedFraction = WANDER_SPEED_FRACTION;

  const threat = nearestThreat(state, slot, size, neighbors, found, trait(traits, slot, T_WARINESS));
  if (threat !== NO_SLOT) {
    out.mode = BEHAVIOR_FLEE;
    out.targetSlot = threat;
    out.steerX = x - (pop.x[threat] ?? 0);
    out.steerY = y - (pop.y[threat] ?? 0);
    out.speedFraction = config.behavior.fleeSpeedMultiplier;
    finish(runtime, state, slot, previousMode, stagger, rng, out);
    return;
  }

  const hungry = energyFraction < config.behavior.matingSeekEnergyFraction;
  const givingUp = previousMode === BEHAVIOR_PURSUE && persistedTicks >= patience;

  if (hungry && diet > 0.5 && !givingUp) {
    const prey = nearestPrey(state, slot, size, neighbors, found);
    if (prey !== NO_SLOT) {
      out.mode = BEHAVIOR_PURSUE;
      out.targetSlot = prey;
      out.steerX = (pop.x[prey] ?? 0) - x;
      out.steerY = (pop.y[prey] ?? 0) - y;
      out.speedFraction = config.behavior.pursueSpeedMultiplier;
      finish(runtime, state, slot, previousMode, stagger, rng, out);
      return;
    }
  }

  if (hungry) {
    const cellResource = sampleField(runtime, state.field.plankton, x, y);
    const cellCapacity = sampleField(runtime, state.field.carryingCapacity, x, y);
    const worthStaying = cellResource >= cellCapacity * FORAGE_SATISFACTION;
    const exhausted = previousMode === BEHAVIOR_FORAGE && persistedTicks >= patience;

    if (worthStaying && !exhausted) {
      out.mode = BEHAVIOR_FORAGE;
      // Holding station in a good patch means drifting with the water rather
      // than paying to swim against it.
      out.steerX = currentXAt(config, x, y);
      out.steerY = currentYAt(config, x, y);
      out.speedFraction = FORAGE_SPEED_FRACTION;
      finish(runtime, state, slot, previousMode, stagger, rng, out);
      return;
    }

    if (climbGradient(runtime, state, slot, x, y, out)) {
      out.mode = BEHAVIOR_CLIMB_GRADIENT;
      out.speedFraction = clamp01(config.behavior.gradientClimbGain);
      finish(runtime, state, slot, previousMode, stagger, rng, out);
      return;
    }
  }

  if (!hungry && isMature(state, slot)) {
    const mate = nearestCourtshipTarget(state, slot, neighbors, found);
    if (mate !== NO_SLOT) {
      out.mode = BEHAVIOR_SEEK_MATE;
      out.targetSlot = mate;
      out.steerX = (pop.x[mate] ?? 0) - x;
      out.steerY = (pop.y[mate] ?? 0) - y;
      out.speedFraction = SEEK_MATE_SPEED_FRACTION;
      finish(runtime, state, slot, previousMode, stagger, rng, out);
      return;
    }
  }

  wander(state, slot, rng, out);
  finish(runtime, state, slot, previousMode, stagger, rng, out);
}

/** Reproduce the policy the organism is already running, on a non-decision tick. */
function reemitCurrentPolicy(state: SimState, slot: SlotIndex, out: BehaviorDecision): void {
  const pop = state.pop;
  const mode = pop.behaviorState[slot] ?? BEHAVIOR_WANDER;
  const vx = pop.vx[slot] ?? 0;
  const vy = pop.vy[slot] ?? 0;
  const speed = Math.sqrt(vx * vx + vy * vy);

  out.mode = mode;
  out.targetSlot = pop.targetSlot[slot] ?? NO_SLOT;
  out.steerX = speed > 1e-9 ? vx / speed : 1;
  out.steerY = speed > 1e-9 ? vy / speed : 0;
  out.speedFraction = speedFractionFor(mode, state);
}

function speedFractionFor(mode: number, state: SimState): number {
  const behavior = state.config.behavior;
  switch (mode) {
    case BEHAVIOR_FLEE:
      return behavior.fleeSpeedMultiplier;
    case BEHAVIOR_PURSUE:
      return behavior.pursueSpeedMultiplier;
    case BEHAVIOR_CLIMB_GRADIENT:
      return clamp01(behavior.gradientClimbGain);
    case BEHAVIOR_FORAGE:
      return FORAGE_SPEED_FRACTION;
    case BEHAVIOR_SEEK_MATE:
      return SEEK_MATE_SPEED_FRACTION;
    default:
      return WANDER_SPEED_FRACTION;
  }
}

/**
 * The nearest hunting neighbour close enough to trigger flight.
 *
 * "Close enough" is the fleeing organism's own `wariness`, so flight-initiation
 * distance is under selection: fleeing early is safe and costs foraging time.
 */
function nearestThreat(
  state: SimState,
  slot: SlotIndex,
  size: number,
  neighbors: Int32Array,
  found: number,
  wariness: number,
): SlotIndex {
  const pop = state.pop;
  const predation = state.config.predation;
  const x = pop.x[slot] ?? 0;
  const y = pop.y[slot] ?? 0;
  const reach = Math.min(wariness, state.config.behavior.neighborScanRadiusWu);
  if (!(reach > 0)) return NO_SLOT;
  const reachSq = reach * reach;
  const lengths = sizeCurrentColumn(pop);

  let best = NO_SLOT;
  let bestSq = Number.POSITIVE_INFINITY;
  for (let index = 0; index < found; index += 1) {
    const other = neighbors[index] ?? NO_SLOT;
    if (other === slot || other === NO_SLOT) continue;
    if (trait(pop.traits, other, T_DIET) <= 0.5) continue;
    if ((pop.gutFill[other] ?? 0) > 0) continue;
    const theirSize = lengths[other] ?? 0;
    if (theirSize <= 0) continue;
    const ratio = size / theirSize;
    if (Math.abs(ratio - predation.sizeRatioOptimum) > SIZE_WINDOW_TOLERANCE * predation.sizeRatioWidth) continue;
    const dx = (pop.x[other] ?? 0) - x;
    const dy = (pop.y[other] ?? 0) - y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq > reachSq || distanceSq >= bestSq) continue;
    bestSq = distanceSq;
    best = other;
  }
  return best;
}

/** The nearest neighbour inside this organism's predation size window. */
function nearestPrey(
  state: SimState,
  slot: SlotIndex,
  size: number,
  neighbors: Int32Array,
  found: number,
): SlotIndex {
  const pop = state.pop;
  const predation = state.config.predation;
  const x = pop.x[slot] ?? 0;
  const y = pop.y[slot] ?? 0;
  if (size <= 0) return NO_SLOT;
  const lengths = sizeCurrentColumn(pop);

  let best = NO_SLOT;
  let bestSq = Number.POSITIVE_INFINITY;
  for (let index = 0; index < found; index += 1) {
    const other = neighbors[index] ?? NO_SLOT;
    if (other === slot || other === NO_SLOT) continue;
    const ratio = (lengths[other] ?? 0) / size;
    if (Math.abs(ratio - predation.sizeRatioOptimum) > SIZE_WINDOW_TOLERANCE * predation.sizeRatioWidth) continue;
    const dx = (pop.x[other] ?? 0) - x;
    const dy = (pop.y[other] ?? 0) - y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq >= bestSq) continue;
    bestSq = distanceSq;
    best = other;
  }
  return best;
}

/** The nearest mature neighbour of the opposite sex. Mate *choice* is A3's; this is only approach. */
function nearestCourtshipTarget(
  state: SimState,
  slot: SlotIndex,
  neighbors: Int32Array,
  found: number,
): SlotIndex {
  const pop = state.pop;
  const x = pop.x[slot] ?? 0;
  const y = pop.y[slot] ?? 0;
  const ownSex = pop.sex[slot] ?? SEX_FEMALE;

  let best = NO_SLOT;
  let bestSq = Number.POSITIVE_INFINITY;
  for (let index = 0; index < found; index += 1) {
    const other = neighbors[index] ?? NO_SLOT;
    if (other === slot || other === NO_SLOT) continue;
    if ((pop.sex[other] ?? SEX_FEMALE) === ownSex) continue;
    if (!isMature(state, other)) continue;
    const dx = (pop.x[other] ?? 0) - x;
    const dy = (pop.y[other] ?? 0) - y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq >= bestSq) continue;
    bestSq = distanceSq;
    best = other;
  }
  return best;
}

/**
 * Steer up the local habitat-quality gradient — saturating resource plus
 * thermal comfort — by central differences one field cell either side.
 *
 * Combining the two into a single scalar is what makes `tOpt` a *spatial*
 * trait: a cold specialist climbs toward different water than a warm one, so
 * the population sorts itself along the gradient and the demes acquire the
 * thermal identity that Fst and GxE both need.
 */
function climbGradient(
  runtime: EcologyRuntime,
  state: SimState,
  slot: SlotIndex,
  x: number,
  y: number,
  out: BehaviorDecision,
): boolean {
  const step = runtime.cellSizeWu;
  const tOpt = trait(state.pop.traits, slot, T_OPT);
  const tWidth = trait(state.pop.traits, slot, T_WIDTH);
  const tax = runtime.memoThermalTax[slot] ?? 0;
  const east = habitatQuality(runtime, state, x + step, y, tOpt, tWidth, tax);
  const west = habitatQuality(runtime, state, x - step, y, tOpt, tWidth, tax);
  const south = habitatQuality(runtime, state, x, y + step, tOpt, tWidth, tax);
  const north = habitatQuality(runtime, state, x, y - step, tOpt, tWidth, tax);

  const gx = east - west;
  const gy = south - north;
  if (Math.abs(gx) < GRADIENT_EPSILON && Math.abs(gy) < GRADIENT_EPSILON) return false;
  out.steerX = gx;
  out.steerY = gy;
  return true;
}

function habitatQuality(
  runtime: EcologyRuntime,
  state: SimState,
  x: number,
  y: number,
  tOpt: number,
  tWidth: number,
  thermalTax: number,
): number {
  const resource = sampleField(runtime, state.field.plankton, x, y);
  const forage = resource / (state.config.resources.grazingHalfSaturation + Math.max(0, resource));
  const comfort = thermalToleranceOf(localTemperatureC(runtime, state, x, y), tOpt, tWidth) * thermalTax;
  return forage + comfort;
}

function wander(state: SimState, slot: SlotIndex, rng: RandomSource, out: BehaviorDecision): void {
  const pop = state.pop;
  const vx = pop.vx[slot] ?? 0;
  const vy = pop.vy[slot] ?? 0;
  const heading = vx === 0 && vy === 0 ? rng.next() * 2 * Math.PI : Math.atan2(vy, vx);
  const turned = heading + rng.normal(0, state.config.behavior.wanderTurnSd);
  out.mode = BEHAVIOR_WANDER;
  out.targetSlot = NO_SLOT;
  out.steerX = Math.cos(turned);
  out.steerY = Math.sin(turned);
  out.speedFraction = WANDER_SPEED_FRACTION;
}

/** Normalise the steer, deflect it off land and the world edge, and persist the policy. */
function finish(
  runtime: EcologyRuntime,
  state: SimState,
  slot: SlotIndex,
  previousMode: number,
  stagger: number,
  rng: RandomSource,
  out: BehaviorDecision,
): void {
  const pop = state.pop;
  const x = pop.x[slot] ?? 0;
  const y = pop.y[slot] ?? 0;

  normalise(out);
  avoidEdges(state, x, y, out);
  avoidBarriers(runtime, state, x, y, out);
  normalise(out);
  if (out.steerX === 0 && out.steerY === 0) {
    const heading = rng.next() * 2 * Math.PI;
    out.steerX = Math.cos(heading);
    out.steerY = Math.sin(heading);
  }

  pop.behaviorState[slot] = out.mode;
  pop.targetSlot[slot] = out.targetSlot;
  const held = out.mode === previousMode ? (pop.behaviorTimer[slot] ?? 0) + stagger : 0;
  pop.behaviorTimer[slot] = Math.min(65_535, held);
}

function normalise(out: BehaviorDecision): void {
  const length = Math.sqrt(out.steerX * out.steerX + out.steerY * out.steerY);
  if (length <= 1e-9) {
    out.steerX = 0;
    out.steerY = 0;
    return;
  }
  out.steerX /= length;
  out.steerY /= length;
}

function avoidEdges(state: SimState, x: number, y: number, out: BehaviorDecision): void {
  const margin = state.config.world.spatialCellSizeWu;
  const { widthWu, heightWu } = state.config.world;
  if (x < margin) out.steerX += (margin - x) / margin;
  else if (x > widthWu - margin) out.steerX -= (x - (widthWu - margin)) / margin;
  if (y < margin) out.steerY += (margin - y) / margin;
  else if (y > heightWu - margin) out.steerY -= (y - (heightWu - margin)) / margin;
}

/**
 * If the water one probe-step ahead is impassable, turn. Both perpendiculars
 * are tried and the more permeable wins, with a fixed tie-break, so two
 * organisms meeting the same wall from the same angle turn the same way.
 */
function avoidBarriers(
  runtime: EcologyRuntime,
  state: SimState,
  x: number,
  y: number,
  out: BehaviorDecision,
): void {
  if (state.barriers.specs.length === 0) return;
  const probe = runtime.cellSizeWu * 2;
  const ahead = barrierPermeabilityAt(state.barriers, x + out.steerX * probe, y + out.steerY * probe);
  if (ahead >= 0.5) return;

  const leftX = -out.steerY;
  const leftY = out.steerX;
  const left = barrierPermeabilityAt(state.barriers, x + leftX * probe, y + leftY * probe);
  const right = barrierPermeabilityAt(state.barriers, x - leftX * probe, y - leftY * probe);

  if (right > left) {
    out.steerX = -leftX;
    out.steerY = -leftY;
  } else {
    out.steerX = leftX;
    out.steerY = leftY;
  }
}
