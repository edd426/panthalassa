/** Deterministic disturbance scheduler and active-shock field effects. */

import type { DisturbanceRegion, SimState } from '../../contracts/types';
import { SeededRng } from '../rng';

export function regionContains(region: DisturbanceRegion, x: number, y: number): boolean {
  if (region.kind === 'disc') {
    const dx = x - region.xWu;
    const dy = y - region.yWu;
    return dx * dx + dy * dy <= region.radiusWu * region.radiusWu;
  }
  return x >= region.xWu && y >= region.yWu && x < region.xWu + region.widthWu && y < region.yWu + region.heightWu;
}

function durationTicks(minGenerations: number, maxGenerations: number, state: SimState, rng: SeededRng): number {
  const generations = minGenerations + (maxGenerations - minGenerations) * rng.next();
  return Math.max(1, Math.round(generations * state.config.time.generationTicks));
}

function fires(ratePerGeneration: number, state: SimState, rng: SeededRng): boolean {
  const probability = 1 - Math.exp(-ratePerGeneration / Math.max(1, state.config.time.generationTicks));
  return rng.next() < probability;
}

function ageActive(state: SimState): void {
  const groups = [state.disturbance.thermal, state.disturbance.planktonCrashes, state.disturbance.kelpStorms];
  for (const group of groups) {
    for (let index = group.length - 1; index >= 0; index -= 1) {
      const shock = group[index];
      if (shock === undefined) continue;
      shock.remainingTicks -= 1;
      if (shock.remainingTicks <= 0) group.splice(index, 1);
    }
  }
}

export function thermalShockOffsetC(state: SimState): number {
  if (!state.config.toggles.enableDisturbances) return 0;
  let offset = 0;
  for (const shock of state.disturbance.thermal) {
    const elapsedFraction = 1 - shock.remainingTicks / shock.durationTicks;
    const end = Math.exp(-3);
    const decay = (Math.exp(-3 * elapsedFraction) - end) / (1 - end);
    offset += shock.magnitudeC * decay;
  }
  return offset;
}

export function planktonProductivityMultiplierAt(state: SimState, x: number, y: number): number {
  if (!state.config.toggles.enableDisturbances) return 1;
  let multiplier = 1;
  for (const shock of state.disturbance.planktonCrashes) {
    if (shock.region === null || regionContains(shock.region, x, y)) multiplier *= shock.productivityMultiplier;
  }
  return multiplier;
}

export function clearKelpRegion(state: SimState, region: DisturbanceRegion, clearFraction: number): void {
  const field = state.field;
  for (let row = 0; row < field.rows; row += 1) {
    const y = (row + 0.5) * field.cellSizeWu;
    for (let col = 0; col < field.cols; col += 1) {
      const x = (col + 0.5) * field.cellSizeWu;
      if (!regionContains(region, x, y)) continue;
      const cell = row * field.cols + col;
      field.kelp[cell] = (field.kelp[cell] ?? 0) * (1 - clearFraction);
    }
  }
}

function scheduleThermal(state: SimState, rng: SeededRng): void {
  const config = state.config.disturbance;
  if (!fires(config.thermalRatePerGeneration, state, rng)) return;
  const magnitude = config.thermalMagnitudeMinC +
    (config.thermalMagnitudeMaxC - config.thermalMagnitudeMinC) * rng.next();
  const signed = rng.next() < 0.5 ? -magnitude : magnitude;
  const duration = durationTicks(config.thermalDurationMinGenerations, config.thermalDurationMaxGenerations, state, rng);
  state.disturbance.thermal.push({
    kind: 'thermal', startedTick: state.tick, magnitudeC: signed, durationTicks: duration, remainingTicks: duration,
  });
  state.events.push({ kind: 'thermalShock', tick: state.tick, magnitudeC: signed, durationTicks: duration });
}

function schedulePlanktonCrash(state: SimState, rng: SeededRng): void {
  const config = state.config.disturbance;
  if (!fires(config.planktonCrashRatePerGeneration, state, rng)) return;
  const productivityMultiplier = config.planktonCrashProductivityMin +
    (config.planktonCrashProductivityMax - config.planktonCrashProductivityMin) * rng.next();
  const duration = durationTicks(
    config.planktonCrashDurationMinGenerations,
    config.planktonCrashDurationMaxGenerations,
    state,
    rng,
  );
  const region: DisturbanceRegion | null = rng.next() < config.planktonCrashRegionalProbability
    ? {
        kind: 'disc',
        xWu: rng.next() * state.config.world.widthWu,
        yWu: rng.next() * state.config.world.heightWu,
        radiusWu: config.planktonCrashRadiusWu,
      }
    : null;
  state.disturbance.planktonCrashes.push({
    kind: 'planktonCrash',
    startedTick: state.tick,
    productivityMultiplier,
    durationTicks: duration,
    remainingTicks: duration,
    region,
  });
  state.events.push({ kind: 'planktonCrash', tick: state.tick, productivityMultiplier, durationTicks: duration, region });
}

function scheduleKelpStorm(state: SimState, rng: SeededRng): void {
  const config = state.config.disturbance;
  if (!fires(config.kelpStormRatePerGeneration, state, rng)) return;
  const clearFraction = config.kelpStormClearFractionMin +
    (config.kelpStormClearFractionMax - config.kelpStormClearFractionMin) * rng.next();
  const duration = durationTicks(config.kelpStormDurationMinGenerations, config.kelpStormDurationMaxGenerations, state, rng);
  const vertical = rng.next() < 0.5;
  const region: DisturbanceRegion = vertical
    ? {
        kind: 'rect',
        xWu: rng.next() * (state.config.world.widthWu - config.kelpStormSwathWidthWu),
        yWu: 0,
        widthWu: config.kelpStormSwathWidthWu,
        heightWu: state.config.world.heightWu,
      }
    : {
        kind: 'rect',
        xWu: 0,
        yWu: rng.next() * (state.config.world.heightWu - config.kelpStormSwathWidthWu),
        widthWu: state.config.world.widthWu,
        heightWu: config.kelpStormSwathWidthWu,
      };
  state.disturbance.kelpStorms.push({
    kind: 'kelpStorm', startedTick: state.tick, clearFraction, durationTicks: duration, remainingTicks: duration, region,
  });
  clearKelpRegion(state, region, clearFraction);
  state.events.push({ kind: 'kelpStorm', tick: state.tick, clearFraction, durationTicks: duration, region });
}

/** One scheduler step. Each shock type has a forked tick-keyed stream. */
export function updateDisturbances(state: SimState): void {
  if (!state.config.toggles.enableDisturbances) return;
  ageActive(state);
  const tickRng = new SeededRng(state.seed).fork(`disturbance:${state.tick}`);
  scheduleThermal(state, tickRng.fork('thermal'));
  schedulePlanktonCrash(state, tickRng.fork('planktonCrash'));
  scheduleKelpStorm(state, tickRng.fork('kelpStorm'));
}
