/**
 * Temperature, light, currents and the climate walk (WP-A2).
 *
 * Temperature is analytic rather than gridded — `T(x, y, t) = spatial gradient
 * + seasonal sinusoid + OU climate offset` — so `temperatureAt` is exact at any
 * position and a snapshot needs to carry only the three scalars in
 * `ClimateState` to reproduce the whole field.
 *
 * The OU walk is the standing variance pump. Its correlation time (≈40
 * generations) is deliberately long enough for the population to track the
 * optimum and short enough that it never finishes: a population that catches up
 * with its environment stops evolving, which is the failure this project exists
 * to avoid.
 */

import type { RandomSource, SimState } from '../../contracts/types';
import type { EcologyRuntime } from './runtime';
import {
  barrierPermeabilityAt,
  clamp01,
  clampInt,
  currentXAt,
  currentYAt,
  fieldCellAt,
  meanTemperatureC,
  spatialTemperatureC,
  spatialTemperatureSdC,
} from './runtime';

/** Seasonal sinusoid offset, °C. */
export function seasonOffsetC(state: SimState): number {
  if (!state.config.toggles.enableSeasonality) return 0;
  const { seasonAmplitudeC, seasonPeriodTicks } = state.config.thermal;
  const period = Math.max(1, seasonPeriodTicks);
  return seasonAmplitudeC * Math.sin((2 * Math.PI * state.climate.seasonPhaseTicks) / period);
}

/** Local temperature, °C. */
export function temperatureAt(state: SimState, x: number, y: number): number {
  return spatialTemperatureC(state.config, x, y) + seasonOffsetC(state) + state.climate.meanOffsetC;
}

/**
 * Standardised temperature anomaly at a position.
 *
 * Centred on the world-mean temperature and scaled by the *spatial* SD of the
 * gradient, so `z` is a position's rank in the thermal landscape. The seasonal
 * and climate offsets are included in the numerator on purpose: when the
 * climate walks warm, every birth that season sees a raised `z`, and the GxE
 * scaling in the phenotype step moves with the climate instead of being frozen
 * to geography.
 */
export function temperatureAnomalyZAt(state: SimState, x: number, y: number): number {
  const config = state.config;
  return (temperatureAt(state, x, y) - meanTemperatureC(config)) / spatialTemperatureSdC(config);
}

/**
 * Advance the climate one tick.
 *
 * The OU step is the exact discretisation
 * `m ← target + (m − target)·e^(−1/τ) + σ·√(1 − e^(−2/τ))·N(0,1)`,
 * which has stationary SD exactly `σ` for any `τ` — an Euler step would leave
 * the realised SD depending on the tick size, and A7 would be tuning a number
 * that does not mean what it says.
 */
export function stepClimate(state: SimState, rng: RandomSource): void {
  const climate = state.climate;
  const { climateTauTicks, climateSigmaC, seasonPeriodTicks } = state.config.thermal;

  const period = Math.max(1, seasonPeriodTicks);
  climate.seasonPhaseTicks = (climate.seasonPhaseTicks + 1) % period;

  if (!state.config.toggles.enableClimateWalk) {
    climate.meanOffsetC = climate.targetOffsetC;
    return;
  }

  const previous = climate.meanOffsetC;
  const tau = Math.max(1, climateTauTicks);
  const decay = Math.exp(-1 / tau);
  const noiseSd = climateSigmaC * Math.sqrt(Math.max(0, 1 - decay * decay));
  climate.meanOffsetC = climate.targetOffsetC + (previous - climate.targetOffsetC) * decay + noiseSd * rng.normal(0, 1);

  reportClimateExcursion(state, previous, climate.meanOffsetC, climateSigmaC);
}

/**
 * Narrate the walk when it crosses a whole-σ band. Band membership is computed
 * from the two offsets in hand rather than from a remembered high-water mark,
 * so a restored snapshot narrates identically to an uninterrupted run.
 */
function reportClimateExcursion(state: SimState, previous: number, next: number, sigma: number): void {
  if (sigma <= 0) return;
  const before = Math.trunc(previous / sigma);
  const after = Math.trunc(next / sigma);
  if (before === after) return;
  state.events.push({
    kind: 'climateEvent',
    tick: state.tick,
    cause: 'walk',
    meanOffsetC: next,
    deltaC: next - previous,
  });
}

/**
 * Publish the temperature field.
 *
 * `temperatureAt` stays the analytic authority — it is exact at any position,
 * not just at cell centres — and this array is the per-cell projection of it
 * that the recorder, the renderer overlays and organism dumps read. Written
 * every tick because the season and the climate offset both move every tick;
 * the spatial part is precomputed, so the per-cell cost is one addition.
 */
export function writeTemperatureField(runtime: EcologyRuntime, state: SimState): void {
  const offset = seasonOffsetC(state) + state.climate.meanOffsetC;
  const temperature = state.field.temperature;
  const { baseTempC, cellCount } = runtime;
  for (let cell = 0; cell < cellCount; cell += 1) {
    temperature[cell] = (baseTempC[cell] ?? 0) + offset;
  }
  runtime.temperatureTick = state.tick;
}

/**
 * Publish the field if this tick has not been published yet.
 *
 * Called on the way into every `EcologyApi` method so the hot stages can read
 * `field.temperature` instead of evaluating two sines per organism per tick.
 * It also means the field is never stale-zero on the first tick, or after a
 * snapshot restore, whatever order the engine runs its stages in.
 */
export function ensureTemperatureField(runtime: EcologyRuntime, state: SimState): void {
  if (runtime.temperatureTick === state.tick) return;
  writeTemperatureField(runtime, state);
}

/**
 * Local temperature from the published field, °C.
 *
 * The gridded value, not the analytic one: a field cell is 25 wu across and an
 * organism moves a couple of wu per tick, so the difference is far below the
 * noise in everything that reads it. `temperatureAt` remains the exact
 * authority for the once-per-birth GxE anomaly.
 */
export function localTemperatureC(runtime: EcologyRuntime, state: SimState, x: number, y: number): number {
  return state.field.temperature[fieldCellAt(runtime, x, y)] ?? 0;
}

/**
 * Recompute per-cell plankton carrying capacity.
 *
 * `K = base · light(y) · patch(x, y) · exp(−((T − T_plankton)/w)²)`: productive
 * where it is bright and where the water suits plankton, which is what gives
 * the world somewhere worth swimming to.
 */
export function updateCarryingCapacity(runtime: EcologyRuntime, state: SimState): void {
  const { thermalSuitabilityWidthC, planktonOptimumC } = state.config.resources;
  const width = Math.max(1e-3, thermalSuitabilityWidthC);
  const offset = seasonOffsetC(state) + state.climate.meanOffsetC;
  const capacity = state.field.carryingCapacity;
  const { baseTempC, kBase, cellCount } = runtime;

  for (let cell = 0; cell < cellCount; cell += 1) {
    const z = ((baseTempC[cell] ?? 0) + offset - planktonOptimumC) / width;
    capacity[cell] = (kBase[cell] ?? 0) * Math.exp(-z * z);
  }
  runtime.capacityTick = state.tick;
}

/** Publish K if this tick has not published it yet. */
export function ensureCarryingCapacity(runtime: EcologyRuntime, state: SimState): void {
  if (runtime.capacityTick === state.tick) return;
  updateCarryingCapacity(runtime, state);
}

/**
 * Publish the temperature and carrying-capacity fields together.
 *
 * Both are the same function of the same two scalars — the season phase and the
 * climate offset — and both read `baseTempC` for every cell. Run as two passes
 * they walk the same four thousand cells twice; fused they walk them once. The
 * engine publishes here, once, immediately after the climate steps.
 */
export function writeClimateFields(runtime: EcologyRuntime, state: SimState): void {
  const { thermalSuitabilityWidthC, planktonOptimumC } = state.config.resources;
  const width = Math.max(1e-3, thermalSuitabilityWidthC);
  const offset = seasonOffsetC(state) + state.climate.meanOffsetC;
  const temperature = state.field.temperature;
  const capacity = state.field.carryingCapacity;
  const { baseTempC, kBase, cellCount } = runtime;

  for (let cell = 0; cell < cellCount; cell += 1) {
    const base = baseTempC[cell] ?? 0;
    temperature[cell] = base + offset;
    const z = (base + offset - planktonOptimumC) / width;
    capacity[cell] = (kBase[cell] ?? 0) * Math.exp(-z * z);
  }
  runtime.temperatureTick = state.tick;
  runtime.capacityTick = state.tick;
}

/**
 * Seed reefs, kelp and the initial fields. The jitter drawn here is snapshotted
 * with the plankton and kelp arrays, so it does not have to be reproducible
 * from the seed the way the reef positions do.
 */
export function initFields(runtime: EcologyRuntime, state: SimState, rng: RandomSource): void {
  state.climate.meanOffsetC = state.climate.targetOffsetC;
  rebuildBarrierMask(state);
  writeClimateFields(runtime, state);

  const { plankton, kelp } = state.field;
  for (let cell = 0; cell < runtime.cellCount; cell += 1) {
    plankton[cell] = (state.field.carryingCapacity[cell] ?? 0) * (0.4 + 0.6 * rng.next());
    kelp[cell] = (runtime.kelpK[cell] ?? 0) * (0.5 + 0.5 * rng.next());
  }
}

/**
 * Rasterise the barrier specs into the permeability mask.
 *
 * Specs are applied in array order and combined by minimum, so overlapping
 * barriers give the least permeable answer and the result does not depend on
 * which order a god tool happened to raise them in.
 */
export function rebuildBarrierMask(state: SimState): void {
  const barriers = state.barriers;
  barriers.mask.fill(255);
  const size = Math.max(1e-6, barriers.cellSizeWu);

  for (const spec of barriers.specs) {
    const value = Math.round(clamp01(spec.permeability) * 255);
    let x0 = 0;
    let x1 = barriers.cols * size;
    let y0 = 0;
    let y1 = barriers.rows * size;

    switch (spec.shape.kind) {
      case 'verticalRidge':
        x0 = spec.shape.xWu - spec.shape.thicknessWu / 2;
        x1 = spec.shape.xWu + spec.shape.thicknessWu / 2;
        break;
      case 'horizontalRidge':
        y0 = spec.shape.yWu - spec.shape.thicknessWu / 2;
        y1 = spec.shape.yWu + spec.shape.thicknessWu / 2;
        break;
      case 'rect':
        x0 = spec.shape.xWu;
        x1 = spec.shape.xWu + spec.shape.widthWu;
        y0 = spec.shape.yWu;
        y1 = spec.shape.yWu + spec.shape.heightWu;
        break;
    }

    const colLo = clampInt(Math.floor(x0 / size), 0, barriers.cols - 1);
    const colHi = clampInt(Math.ceil(x1 / size) - 1, 0, barriers.cols - 1);
    const rowLo = clampInt(Math.floor(y0 / size), 0, barriers.rows - 1);
    const rowHi = clampInt(Math.ceil(y1 / size) - 1, 0, barriers.rows - 1);

    for (let row = rowLo; row <= rowHi; row += 1) {
      for (let col = colLo; col <= colHi; col += 1) {
        const index = row * barriers.cols + col;
        if (value < (barriers.mask[index] ?? 255)) barriers.mask[index] = value;
      }
    }
  }
}

/** Re-exported so the behaviour policies can steer around land and drift with the water. */
export { barrierPermeabilityAt, currentXAt, currentYAt };
