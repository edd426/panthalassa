/**
 * Uniform-grid neighbour index (WP-A2).
 *
 * Rebuilt from scratch every tick by a two-pass counting sort into preallocated
 * flat arrays, so the steady state allocates nothing: the only allocation
 * happens when the world dimensions or the slot capacity change.
 *
 * Two properties are load-bearing for determinism:
 *
 * - `build` scatters in ascending slot order, so the entries inside any one
 *   bucket are ascending. Bucket *order* still depends on geometry, so
 *   `queryNeighbors` sorts the merged result before returning — an unsorted
 *   neighbour list is the classic determinism leak.
 * - Nothing here reads a clock or ambient entropy. The index is a pure function
 *   of the pool columns.
 *
 * The cell size is a performance knob only. `queryNeighbors` derives its cell
 * window from the radius it was handed, so a query wider than
 * `maxQueryRadiusWu` is still exact — that field reports the largest radius the
 * model actually asks for, not a correctness limit.
 */

import type { SpatialIndex } from '../contracts/apis';
import type { SimConfig, SimState } from '../contracts/types';
import { DEFAULT_SIM_CONFIG } from '../contracts/types';

/** Below this many hits, insertion sort beats heapsort and branches less. */
const INSERTION_SORT_MAX = 24;

const EMPTY_F32 = new Float32Array(0);

/** The largest radius any stage queries with; advisory, see the file comment. */
export function maxInteractionRadiusWu(config: SimConfig): number {
  return Math.max(
    config.behavior.neighborScanRadiusWu,
    config.predation.attemptRadiusWu,
    config.mating.surveyRadiusWu,
  );
}

class UniformGridIndex implements SpatialIndex {
  maxQueryRadiusWu: number;

  private cellSizeWu = 1;
  private invCellSizeWu = 1;
  private cols = 1;
  private rows = 1;
  private cellCount = 1;
  private capacity = 0;

  /** Prefix offsets, length `cellCount + 1`; bucket c spans `[cellStart[c], cellStart[c + 1])`. */
  private cellStart = new Int32Array(2);
  /** Scatter cursors, length `cellCount`. */
  private cursor = new Int32Array(1);
  /** Slot indices grouped by bucket, length `capacity`. */
  private entries = new Int32Array(0);
  private entryCount = 0;

  private posX: Float32Array = EMPTY_F32;
  private posY: Float32Array = EMPTY_F32;

  constructor(config: SimConfig = DEFAULT_SIM_CONFIG) {
    this.maxQueryRadiusWu = maxInteractionRadiusWu(config);
    this.resize(config);
  }

  build(state: SimState): void {
    this.resize(state.config);
    this.maxQueryRadiusWu = maxInteractionRadiusWu(state.config);

    const pop = state.pop;
    if (pop.capacity !== this.capacity) {
      this.capacity = pop.capacity;
      this.entries = new Int32Array(pop.capacity);
    }
    this.posX = pop.x;
    this.posY = pop.y;

    const { cellStart, cursor, entries, cellCount } = this;
    const alive = pop.alive;

    cellStart.fill(0);
    for (let slot = 0; slot < pop.capacity; slot += 1) {
      if (alive[slot] !== 1) continue;
      const bucket = this.cellOf(pop.x[slot] ?? 0, pop.y[slot] ?? 0) + 1;
      cellStart[bucket] = (cellStart[bucket] ?? 0) + 1;
    }
    for (let cell = 1; cell <= cellCount; cell += 1) {
      cellStart[cell] = (cellStart[cell] as number) + (cellStart[cell - 1] as number);
    }
    for (let cell = 0; cell < cellCount; cell += 1) {
      cursor[cell] = cellStart[cell] as number;
    }

    let written = 0;
    for (let slot = 0; slot < pop.capacity; slot += 1) {
      if (alive[slot] !== 1) continue;
      const cell = this.cellOf(pop.x[slot] ?? 0, pop.y[slot] ?? 0);
      entries[cursor[cell] as number] = slot;
      cursor[cell] = (cursor[cell] as number) + 1;
      written += 1;
    }
    this.entryCount = written;
  }

  queryNeighbors(x: number, y: number, radiusWu: number, out: Int32Array): number {
    const limit = out.length;
    if (limit === 0 || this.entryCount === 0) return 0;

    const radius = Math.max(0, radiusWu);
    const radiusSq = radius * radius;
    const inv = this.invCellSizeWu;
    const minCol = clampInt(Math.floor((x - radius) * inv), 0, this.cols - 1);
    const maxCol = clampInt(Math.floor((x + radius) * inv), 0, this.cols - 1);
    const minRow = clampInt(Math.floor((y - radius) * inv), 0, this.rows - 1);
    const maxRow = clampInt(Math.floor((y + radius) * inv), 0, this.rows - 1);

    const { cellStart, entries, posX, posY } = this;
    let count = 0;

    for (let row = minRow; row <= maxRow; row += 1) {
      const rowBase = row * this.cols;
      for (let col = minCol; col <= maxCol; col += 1) {
        const cell = rowBase + col;
        const end = cellStart[cell + 1] as number;
        for (let index = cellStart[cell] as number; index < end; index += 1) {
          const slot = entries[index] as number;
          const dx = (posX[slot] ?? 0) - x;
          const dy = (posY[slot] ?? 0) - y;
          if (dx * dx + dy * dy > radiusSq) continue;
          out[count] = slot;
          count += 1;
          if (count === limit) {
            sortAscending(out, count);
            return count;
          }
        }
      }
    }

    sortAscending(out, count);
    return count;
  }

  private cellOf(x: number, y: number): number {
    const col = clampInt(Math.floor(x * this.invCellSizeWu), 0, this.cols - 1);
    const row = clampInt(Math.floor(y * this.invCellSizeWu), 0, this.rows - 1);
    return row * this.cols + col;
  }

  private resize(config: SimConfig): void {
    const size = Math.max(1, config.world.spatialCellSizeWu);
    const cols = Math.max(1, Math.ceil(config.world.widthWu / size));
    const rows = Math.max(1, Math.ceil(config.world.heightWu / size));
    if (size === this.cellSizeWu && cols === this.cols && rows === this.rows) return;

    this.cellSizeWu = size;
    this.invCellSizeWu = 1 / size;
    this.cols = cols;
    this.rows = rows;
    this.cellCount = cols * rows;
    this.cellStart = new Int32Array(this.cellCount + 1);
    this.cursor = new Int32Array(this.cellCount);
  }
}

/** The `SpatialIndex` factory the engine is wired with (WP-A5 injects it). */
export function createSpatialIndex(config?: SimConfig): SpatialIndex {
  return new UniformGridIndex(config ?? DEFAULT_SIM_CONFIG);
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** In-place ascending sort of `out[0..count)`. Allocation-free by construction. */
export function sortAscending(out: Int32Array, count: number): void {
  if (count < 2) return;
  if (count <= INSERTION_SORT_MAX) {
    for (let i = 1; i < count; i += 1) {
      const value = out[i] as number;
      let j = i - 1;
      while (j >= 0 && (out[j] as number) > value) {
        out[j + 1] = out[j] as number;
        j -= 1;
      }
      out[j + 1] = value;
    }
    return;
  }
  for (let start = (count >> 1) - 1; start >= 0; start -= 1) siftDown(out, start, count);
  for (let end = count - 1; end > 0; end -= 1) {
    const top = out[0] as number;
    out[0] = out[end] as number;
    out[end] = top;
    siftDown(out, 0, end);
  }
}

function siftDown(out: Int32Array, root: number, count: number): void {
  let parent = root;
  for (;;) {
    let child = parent * 2 + 1;
    if (child >= count) return;
    if (child + 1 < count && (out[child + 1] as number) > (out[child] as number)) child += 1;
    if ((out[child] as number) <= (out[parent] as number)) return;
    const swap = out[parent] as number;
    out[parent] = out[child] as number;
    out[child] = swap;
    parent = child;
  }
}
