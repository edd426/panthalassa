/**
 * Derived ecology state (WP-A2).
 *
 * Everything here is a *cache*: a pure function of `(seed, config, barrier
 * specs)` that would be identical if recomputed from scratch. That is the rule
 * that keeps it out of `SimState` and still leaves snapshots exact — a restored
 * world builds a fresh runtime and gets bit-identical reefs, patchiness and
 * kelp maps, because none of it depends on the history of the run.
 *
 * The consequence for anyone extending this file: if a quantity would differ
 * depending on *when* it was first computed, it does not belong here. It
 * belongs in `SimState`, which means it belongs in a contract change request.
 */

import { SeededRng } from '../rng';
import type { SimConfig, SimState } from '../../contracts/types';

/** Neighbour buffer shared by the per-organism stages; beyond this a scan truncates. */
const NEIGHBOR_SCRATCH = 256;

/**
 * Amplitude of the static multiplicative patchiness on plankton carrying
 * capacity. Without it K is a smooth function of latitude alone, every
 * gradient-climbing organism in a row sees the same slope, and the world has no
 * patches to give up on — which is what `givingUpTime` is a trait *for*.
 */
const PATCH_AMPLITUDE = 0.35;

/**
 * Longitudinal temperature undulation, as a fraction of the north–south range.
 * Pure latitude bands make every deme in a row thermally identical, so the deme
 * grid carries no thermal signal for GxE or Fst to work with.
 */
const LONGITUDINAL_TEMPERATURE_FRACTION = 0.08;

/** Kelp reaches this fraction of the reef radius out from an impassable barrier cell. */
const BARRIER_KELP_RADIUS_FRACTION = 0.45;

/**
 * Peak speed of the authored current field, wu/tick. Gentle by design: the
 * current stirs the plankton field and nudges drifters, it does not decide
 * where anything ends up.
 */
const CURRENT_SPEED_WU_PER_TICK = 0.25;

/**
 * Ticks between resource field updates, with growth scaled to match.
 *
 * The field has ~3.8k cells against a few hundred organisms, so updating it
 * every tick would spend most of the P12 budget on water rather than on
 * animals. Plankton turns over on a ~50-tick timescale, so a 4-tick step is
 * indistinguishable in the dynamics and four times cheaper. The cadence is read
 * off `SimState.tick`, never off a counter, so it survives a snapshot restore.
 */
export const RESOURCE_UPDATE_INTERVAL = 4;

export interface EcologyRuntime {
  config: SimConfig;
  seed: string;

  cols: number;
  rows: number;
  cellCount: number;
  cellSizeWu: number;
  /** `1 / cellSizeWu`; cell lookups run once per organism per stage and a divide is not free. */
  invCellSizeWu: number;

  /** Static spatial temperature per field cell, °C, before season and climate offset. */
  baseTempC: Float32Array;
  /** `planktonCarryingCapacityBase · light(y) · patch(x, y)`; the thermal factor is applied per tick. */
  kBase: Float32Array;
  /** Per-cell kelp carrying capacity in [0, kelpCoverMax]; zero in open water. */
  kelpK: Float32Array;
  /** Advection scratch, one field wide. */
  scratch: Float32Array;
  /** Back-traced source position per cell for one advection step; static, the current does not vary in time. */
  advectSrcX: Float32Array;
  advectSrcY: Float32Array;

  reefX: Float32Array;
  reefY: Float32Array;

  /** Cheap numeric fingerprint of the barrier specs the kelp map was built from. */
  barrierSignature: number;

  hueCols: number;
  hueRows: number;
  hueCellSizeWu: number;
  hueBins: number;
  hueCounts: Float32Array;
  hueTotals: Float32Array;
  /** Tick the hue-morph grid was last binned for; `-1` means invalid. */
  hueGridTick: number;

  neighbors: Int32Array;

  /** Slot capacity the per-organism caches below are sized for. */
  capacity: number;
  /** Tick the published temperature field is current for; `NaN` means unwritten. */
  temperatureTick: number;

  /**
   * Per-organism memo of quantities that are pure functions of a fixed
   * phenotype — a bite size, a diet efficiency, a storage ceiling. Traits are
   * written once at birth and never change, so recomputing `Math.pow` for them
   * on every one of an organism's ~900 ticks is pure waste.
   *
   * Validity is keyed on `pop.id`, which is never reused, plus the size trait
   * as a witness, so a recycled slot or an externally edited phenotype misses
   * the cache rather than reading a previous animal's numbers.
   */
  memoId: Float64Array;
  memoSize: Float32Array;
  memoBite: Float32Array;
  memoPlantEfficiency: Float32Array;
  memoPreyEfficiency: Float32Array;
  memoPreyYield: Float32Array;
  memoMaxEnergy: Float32Array;
  memoDigestion: Float32Array;
  /** Metabolic cost keyed by quantised speed fraction; policies use a small fixed menu of speeds. */
  memoCostKey: Float32Array;
  memoCostValue: Float32Array;
}

/**
 * Get the runtime for `state`, building or rebuilding it when the world it was
 * derived from has changed. Called at the top of every `EcologyApi` method, so
 * a restored snapshot repopulates it lazily without `initFields` running again.
 */
export function ensureRuntime(current: EcologyRuntime | undefined, state: SimState): EcologyRuntime {
  const config = state.config;
  const field = state.field;
  const signature = barrierSignature(state);

  if (
    current !== undefined &&
    current.seed === state.seed &&
    current.config === config &&
    current.cols === field.cols &&
    current.rows === field.rows &&
    current.capacity === state.pop.capacity
  ) {
    if (current.barrierSignature !== signature) {
      buildKelpCapacity(current, state);
      current.barrierSignature = signature;
    }
    return current;
  }

  const runtime = buildRuntime(state);
  buildKelpCapacity(runtime, state);
  runtime.barrierSignature = signature;
  return runtime;
}

function buildRuntime(state: SimState): EcologyRuntime {
  const config = state.config;
  const field = state.field;
  const cellCount = field.cols * field.rows;
  const capacity = Math.max(1, state.pop.capacity);
  const rng = new SeededRng(state.seed).fork('ecology:runtime');

  const reefCount = Math.max(0, Math.floor(config.resources.reefCount));
  const reefX = new Float32Array(reefCount);
  const reefY = new Float32Array(reefCount);
  for (let index = 0; index < reefCount; index += 1) {
    reefX[index] = (0.1 + 0.8 * rng.next()) * config.world.widthWu;
    reefY[index] = (0.15 + 0.7 * rng.next()) * config.world.heightWu;
  }

  const hueBins = Math.max(1, Math.floor(config.predation.hueBinCount));
  const hueCellSizeWu = Math.max(config.world.spatialCellSizeWu, 4 * config.predation.attemptRadiusWu);
  const hueCols = Math.max(1, Math.ceil(config.world.widthWu / hueCellSizeWu));
  const hueRows = Math.max(1, Math.ceil(config.world.heightWu / hueCellSizeWu));

  const runtime: EcologyRuntime = {
    config,
    seed: state.seed,
    cols: field.cols,
    rows: field.rows,
    cellCount,
    cellSizeWu: field.cellSizeWu,
    invCellSizeWu: 1 / Math.max(1e-6, field.cellSizeWu),
    baseTempC: new Float32Array(cellCount),
    kBase: new Float32Array(cellCount),
    kelpK: new Float32Array(cellCount),
    scratch: new Float32Array(cellCount),
    advectSrcX: new Float32Array(cellCount),
    advectSrcY: new Float32Array(cellCount),
    reefX,
    reefY,
    barrierSignature: Number.NaN,
    hueCols,
    hueRows,
    hueCellSizeWu,
    hueBins,
    hueCounts: new Float32Array(hueCols * hueRows * hueBins),
    hueTotals: new Float32Array(hueCols * hueRows),
    hueGridTick: -1,
    neighbors: new Int32Array(Math.min(NEIGHBOR_SCRATCH, Math.max(1, state.pop.capacity))),
    capacity,
    temperatureTick: Number.NaN,
    memoId: new Float64Array(capacity).fill(Number.NaN),
    memoSize: new Float32Array(capacity).fill(Number.NaN),
    memoBite: new Float32Array(capacity),
    memoPlantEfficiency: new Float32Array(capacity),
    memoPreyEfficiency: new Float32Array(capacity),
    memoPreyYield: new Float32Array(capacity),
    memoMaxEnergy: new Float32Array(capacity),
    memoDigestion: new Float32Array(capacity),
    memoCostKey: new Float32Array(capacity).fill(Number.NaN),
    memoCostValue: new Float32Array(capacity),
  };

  buildStaticFields(runtime, rng);
  return runtime;
}

/** Static spatial temperature, before the seasonal and climate offsets. */
export function spatialTemperatureC(config: SimConfig, x: number, y: number): number {
  const { northC, southC } = config.thermal;
  const height = Math.max(1e-6, config.world.heightWu);
  const width = Math.max(1e-6, config.world.widthWu);
  const latitude = northC + (southC - northC) * clamp01(y / height);
  const longitudinal =
    LONGITUDINAL_TEMPERATURE_FRACTION * (northC - southC) * Math.sin((2 * Math.PI * x) / width);
  return latitude + longitudinal;
}

/**
 * Spatial SD of {@link spatialTemperatureC} over the world, °C.
 *
 * Analytic rather than measured: the latitudinal ramp is uniform over y
 * (variance `range² / 12`) and the longitudinal sinusoid has variance `amp² / 2`,
 * and the two are independent over the rectangle. `temperatureAnomalyZAt`
 * divides by this, so it has to be exact rather than approximately right.
 */
export function spatialTemperatureSdC(config: SimConfig): number {
  const range = config.thermal.northC - config.thermal.southC;
  const longitudinalAmplitude = LONGITUDINAL_TEMPERATURE_FRACTION * range;
  const variance = (range * range) / 12 + (longitudinalAmplitude * longitudinalAmplitude) / 2;
  return Math.max(1e-6, Math.sqrt(variance));
}

/** World-mean of {@link spatialTemperatureC}, °C. */
export function meanTemperatureC(config: SimConfig): number {
  return (config.thermal.northC + config.thermal.southC) / 2;
}

/** Surface light in [0, 1], falling off with depth (y). */
export function lightAt(config: SimConfig, y: number): number {
  const height = Math.max(1e-6, config.world.heightWu);
  return Math.max(0, 1 - config.resources.lightGradientStrength * clamp01(y / height));
}

/** Eastward component of the authored current, wu/tick. */
export function currentXAt(config: SimConfig, x: number, y: number): number {
  const kx = (2 * Math.PI) / Math.max(1e-6, config.world.widthWu);
  const ky = (2 * Math.PI) / Math.max(1e-6, config.world.heightWu);
  return CURRENT_SPEED_WU_PER_TICK * Math.sin(kx * x) * Math.cos(ky * y);
}

/**
 * Southward component of the authored current, wu/tick.
 *
 * The `height / width` coefficient makes the pair the curl of a stream
 * function, so the flow is divergence-free: advecting the plankton field with
 * it redistributes biomass without creating or destroying any.
 */
export function currentYAt(config: SimConfig, x: number, y: number): number {
  const width = Math.max(1e-6, config.world.widthWu);
  const height = Math.max(1e-6, config.world.heightWu);
  const kx = (2 * Math.PI) / width;
  const ky = (2 * Math.PI) / height;
  return -CURRENT_SPEED_WU_PER_TICK * (height / width) * Math.cos(kx * x) * Math.sin(ky * y);
}

function buildStaticFields(runtime: EcologyRuntime, rng: SeededRng): void {
  const { config, cols, rows, cellSizeWu } = runtime;
  const width = Math.max(1e-6, config.world.widthWu);
  const height = Math.max(1e-6, config.world.heightWu);

  // Two decorrelated sinusoid pairs stand in for low-frequency noise: cheap,
  // seed-derived, and exactly reproducible without storing a noise table.
  const fx1 = (2 * Math.PI * (1 + rng.int(0, 2))) / width;
  const fy1 = (2 * Math.PI * (1 + rng.int(0, 2))) / height;
  const fx2 = (2 * Math.PI * (2 + rng.int(0, 3))) / width;
  const fy2 = (2 * Math.PI * (2 + rng.int(0, 3))) / height;
  const p1 = rng.next() * 2 * Math.PI;
  const p2 = rng.next() * 2 * Math.PI;
  const p3 = rng.next() * 2 * Math.PI;
  const p4 = rng.next() * 2 * Math.PI;

  for (let row = 0; row < rows; row += 1) {
    const y = (row + 0.5) * cellSizeWu;
    const light = lightAt(config, y);
    for (let col = 0; col < cols; col += 1) {
      const x = (col + 0.5) * cellSizeWu;
      const cell = row * cols + col;
      runtime.baseTempC[cell] = spatialTemperatureC(config, x, y);
      const noise =
        (Math.sin(fx1 * x + p1) * Math.sin(fy1 * y + p2) +
          0.6 * Math.sin(fx2 * x + p3) * Math.sin(fy2 * y + p4)) /
        1.6;
      const patch = Math.max(0, 1 + PATCH_AMPLITUDE * noise);
      runtime.kBase[cell] = config.resources.planktonCarryingCapacityBase * light * patch;

      // Semi-Lagrangian back-trace for one resource step. The current is
      // time-invariant, so this table is static and the per-tick advection is
      // reduced to a bilinear sample — four trig calls per cell per step would
      // otherwise cost more than the rest of the ecology put together.
      runtime.advectSrcX[cell] = x - currentXAt(config, x, y) * RESOURCE_UPDATE_INTERVAL;
      runtime.advectSrcY[cell] = y - currentYAt(config, x, y) * RESOURCE_UPDATE_INTERVAL;
    }
  }
}

/**
 * Kelp carrying capacity: a Gaussian halo around each reef, plus a band along
 * anything impassable. Kelp is the predation refuge, so where it can grow is
 * what makes reefs and barriers ecologically interesting rather than decorative.
 */
export function buildKelpCapacity(runtime: EcologyRuntime, state: SimState): void {
  const { config, cols, rows, cellSizeWu, kelpK, reefX, reefY } = runtime;
  const reefRadius = Math.max(1e-6, config.resources.kelpReefRadiusWu);
  const coverMax = config.resources.kelpCoverMax;

  kelpK.fill(0);
  for (let row = 0; row < rows; row += 1) {
    const y = (row + 0.5) * cellSizeWu;
    for (let col = 0; col < cols; col += 1) {
      const x = (col + 0.5) * cellSizeWu;
      let best = 0;
      for (let reef = 0; reef < reefX.length; reef += 1) {
        const dx = x - (reefX[reef] ?? 0);
        const dy = y - (reefY[reef] ?? 0);
        const z = Math.sqrt(dx * dx + dy * dy) / reefRadius;
        const cover = coverMax * Math.exp(-z * z);
        if (cover > best) best = cover;
      }
      kelpK[row * cols + col] = best;
    }
  }

  if (state.barriers.specs.length > 0) {
    addBarrierKelp(runtime, state);
  }
}

function addBarrierKelp(runtime: EcologyRuntime, state: SimState): void {
  const { config, cols, rows, cellSizeWu, kelpK, scratch } = runtime;
  const barriers = state.barriers;
  const coverMax = config.resources.kelpCoverMax;
  const reach = Math.max(
    1,
    Math.ceil((BARRIER_KELP_RADIUS_FRACTION * config.resources.kelpReefRadiusWu) / cellSizeWu),
  );

  // scratch doubles as the impassability mask; it is rebuilt before every use.
  scratch.fill(0);
  for (let row = 0; row < rows; row += 1) {
    const y = (row + 0.5) * cellSizeWu;
    for (let col = 0; col < cols; col += 1) {
      const x = (col + 0.5) * cellSizeWu;
      scratch[row * cols + col] = barrierPermeabilityAt(barriers, x, y) < 0.5 ? 1 : 0;
    }
  }

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const cell = row * cols + col;
      if ((scratch[cell] ?? 0) === 1) {
        // Land itself carries no kelp; the shelter is in the water beside it.
        kelpK[cell] = 0;
        continue;
      }
      let nearest = Number.POSITIVE_INFINITY;
      const rowLo = Math.max(0, row - reach);
      const rowHi = Math.min(rows - 1, row + reach);
      const colLo = Math.max(0, col - reach);
      const colHi = Math.min(cols - 1, col + reach);
      for (let r = rowLo; r <= rowHi; r += 1) {
        for (let c = colLo; c <= colHi; c += 1) {
          if ((scratch[r * cols + c] ?? 0) !== 1) continue;
          const distance = Math.hypot(r - row, c - col);
          if (distance < nearest) nearest = distance;
        }
      }
      if (!Number.isFinite(nearest)) continue;
      const falloff = Math.max(0, 1 - nearest / (reach + 1));
      const cover = coverMax * falloff;
      if (cover > (kelpK[cell] ?? 0)) kelpK[cell] = cover;
    }
  }
  scratch.fill(0);
}

/** Barrier permeability in [0, 1] at a world position; 1 is open water. */
export function barrierPermeabilityAt(barriers: SimState['barriers'], x: number, y: number): number {
  if (barriers.specs.length === 0) return 1;
  const size = Math.max(1e-6, barriers.cellSizeWu);
  const col = clampInt(Math.floor(x / size), 0, barriers.cols - 1);
  const row = clampInt(Math.floor(y / size), 0, barriers.rows - 1);
  return (barriers.mask[row * barriers.cols + col] ?? 255) / 255;
}

function barrierSignature(state: SimState): number {
  const specs = state.barriers.specs;
  let signature = specs.length * 1_000_003;
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    if (spec === undefined) continue;
    signature = signature * 31 + spec.permeability * 977 + spec.raisedTick;
    const shape = spec.shape;
    signature =
      signature * 31 +
      (shape.kind === 'rect'
        ? shape.xWu + shape.yWu * 3 + shape.widthWu * 7 + shape.heightWu * 11
        : shape.kind === 'verticalRidge'
          ? shape.xWu + shape.thicknessWu * 13
          : shape.yWu + shape.thicknessWu * 17);
  }
  return signature;
}

/** Field cell containing a world position. */
export function fieldCellAt(runtime: EcologyRuntime, x: number, y: number): number {
  const col = clampInt(Math.floor(x * runtime.invCellSizeWu), 0, runtime.cols - 1);
  const row = clampInt(Math.floor(y * runtime.invCellSizeWu), 0, runtime.rows - 1);
  return row * runtime.cols + col;
}

export function clamp01(value: number): number {
  if (!(value > 0)) return 0;
  return value > 1 ? 1 : value;
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Bilinear sample of a field array at a world position. Used for kelp cover and
 * for the resource gradient, where nearest-cell sampling would put a staircase
 * in the gradient an organism is trying to climb.
 */
export function sampleField(runtime: EcologyRuntime, field: Float32Array, x: number, y: number): number {
  const inv = runtime.invCellSizeWu;
  const fx = x * inv - 0.5;
  const fy = y * inv - 0.5;
  const col0 = Math.floor(fx);
  const row0 = Math.floor(fy);
  const tx = fx - col0;
  const ty = fy - row0;
  const c0 = clampInt(col0, 0, runtime.cols - 1);
  const c1 = clampInt(col0 + 1, 0, runtime.cols - 1);
  const r0 = clampInt(row0, 0, runtime.rows - 1);
  const r1 = clampInt(row0 + 1, 0, runtime.rows - 1);
  const v00 = field[r0 * runtime.cols + c0] ?? 0;
  const v10 = field[r0 * runtime.cols + c1] ?? 0;
  const v01 = field[r1 * runtime.cols + c0] ?? 0;
  const v11 = field[r1 * runtime.cols + c1] ?? 0;
  const top = v00 + (v10 - v00) * tx;
  const bottom = v01 + (v11 - v01) * tx;
  return top + (bottom - top) * ty;
}
