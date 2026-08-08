/**
 * Internal helpers for `src/stats`. Nothing here crosses a contract seam — the
 * engine sees only `StatsApi` — so these shapes are free to change.
 *
 * Everything is deterministic: no clock, no ambient entropy, and no iteration
 * over a container whose order depends on death history. Where an ordering
 * reaches an output it is produced by an explicit sort.
 */

import { TRAIT_COUNT } from '../contracts/traits';
import type { OrganismId, SimState, SlotIndex } from '../contracts/types';

// ---------------------------------------------------------------------------
// Pool access
// ---------------------------------------------------------------------------

/** Walk live slots in ascending order — the determinism rule from CLAUDE.md. */
export function forEachLiveSlot(state: SimState, visit: (slot: SlotIndex, id: OrganismId) => void): void {
  const { alive, id, capacity } = state.pop;
  for (let slot = 0; slot < capacity; slot += 1) {
    if (alive[slot] !== 1) continue;
    visit(slot, id[slot] ?? 0);
  }
}

// ---------------------------------------------------------------------------
// Moments
// ---------------------------------------------------------------------------

/**
 * Streaming mean and variance. Welford rather than Σx² because a trait like
 * `wariness` sits around 40 with an SD near 1, where the naive sum-of-squares
 * loses most of its significant digits.
 */
export class Welford {
  count = 0;
  private meanValue = 0;
  private sumSquares = 0;

  push(value: number): void {
    this.count += 1;
    const delta = value - this.meanValue;
    this.meanValue += delta / this.count;
    this.sumSquares += delta * (value - this.meanValue);
  }

  get mean(): number {
    return this.count > 0 ? this.meanValue : 0;
  }

  /** Unbiased (n − 1) variance; 0 with fewer than two observations. */
  get variance(): number {
    return this.count > 1 ? this.sumSquares / (this.count - 1) : 0;
  }

  get sd(): number {
    return Math.sqrt(this.variance);
  }

  reset(): void {
    this.count = 0;
    this.meanValue = 0;
    this.sumSquares = 0;
  }
}

/** Pearson correlation of the first `count` entries; 0 when either side is constant. */
export function pearson(xs: ArrayLike<number>, ys: ArrayLike<number>, count: number): number {
  if (count < 2) return 0;
  let meanX = 0;
  let meanY = 0;
  for (let index = 0; index < count; index += 1) {
    meanX += xs[index] ?? 0;
    meanY += ys[index] ?? 0;
  }
  meanX /= count;
  meanY /= count;

  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let index = 0; index < count; index += 1) {
    const dx = (xs[index] ?? 0) - meanX;
    const dy = (ys[index] ?? 0) - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }
  const denominator = Math.sqrt(varianceX * varianceY);
  return denominator > 0 ? covariance / denominator : 0;
}

/** Ordinary-least-squares slope of y on x over the first `count` entries; NaN when x is constant. */
export function regressionSlope(xs: ArrayLike<number>, ys: ArrayLike<number>, count: number): number {
  if (count < 2) return Number.NaN;
  let meanX = 0;
  let meanY = 0;
  for (let index = 0; index < count; index += 1) {
    meanX += xs[index] ?? 0;
    meanY += ys[index] ?? 0;
  }
  meanX /= count;
  meanY /= count;

  let covariance = 0;
  let varianceX = 0;
  for (let index = 0; index < count; index += 1) {
    const dx = (xs[index] ?? 0) - meanX;
    covariance += dx * ((ys[index] ?? 0) - meanY);
    varianceX += dx * dx;
  }
  return varianceX > 0 ? covariance / varianceX : Number.NaN;
}

/** Mean direction of angles in radians. */
export function circularMean(angles: ArrayLike<number>, count: number): number {
  let sine = 0;
  let cosine = 0;
  for (let index = 0; index < count; index += 1) {
    const angle = angles[index] ?? 0;
    sine += Math.sin(angle);
    cosine += Math.cos(angle);
  }
  return Math.atan2(sine, cosine);
}

/**
 * Jammalamadaka–SenGupta circular correlation of two angle series (radians).
 *
 * `Σ sin(αᵢ − ᾱ)·sin(βᵢ − β̄) / √(Σ sin²(αᵢ − ᾱ) · Σ sin²(βᵢ − β̄))`
 *
 * 1 for a perfectly matched pairing, ≈ 0 for independent angles. Used for
 * `SampleRow.hueAssortment`, where a plain Pearson would report nonsense for a
 * pair straddling 0°/360°.
 */
export function circularCorrelation(alpha: ArrayLike<number>, beta: ArrayLike<number>, count: number): number {
  if (count < 2) return 0;
  const meanAlpha = circularMean(alpha, count);
  const meanBeta = circularMean(beta, count);
  let covariance = 0;
  let varianceAlpha = 0;
  let varianceBeta = 0;
  for (let index = 0; index < count; index += 1) {
    const da = Math.sin((alpha[index] ?? 0) - meanAlpha);
    const db = Math.sin((beta[index] ?? 0) - meanBeta);
    covariance += da * db;
    varianceAlpha += da * da;
    varianceBeta += db * db;
  }
  const denominator = Math.sqrt(varianceAlpha * varianceBeta);
  return denominator > 0 ? covariance / denominator : 0;
}

// ---------------------------------------------------------------------------
// Event logs
// ---------------------------------------------------------------------------

/**
 * A fixed-capacity ring of recent matings.
 *
 * Bounded because an ambient run is expected to go for days: the estimators
 * that read it (assortment index, the species detector's realized cross-mating
 * rate) only ever look back a window of a generation or two, so anything older
 * than the ring is already outside every window that consults it.
 */
export class MatingLog {
  private readonly motherIds: Float64Array;
  private readonly fatherIds: Float64Array;
  private readonly ticks: Float64Array;
  private writeIndex = 0;
  private filled = 0;

  constructor(readonly capacity = 1 << 16) {
    this.motherIds = new Float64Array(capacity);
    this.fatherIds = new Float64Array(capacity);
    this.ticks = new Float64Array(capacity);
  }

  push(motherId: OrganismId, fatherId: OrganismId, tick: number): void {
    this.motherIds[this.writeIndex] = motherId;
    this.fatherIds[this.writeIndex] = fatherId;
    this.ticks[this.writeIndex] = tick;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled += 1;
  }

  get size(): number {
    return this.filled;
  }

  /**
   * Visit matings recorded at or after `sinceTick`, oldest first. Insertion
   * order is the sim's mating order, which is itself a deterministic function of
   * (config, seed), so this iteration is safe to let reach an output.
   */
  forEachSince(sinceTick: number, visit: (motherId: OrganismId, fatherId: OrganismId, tick: number) => void): void {
    const start = this.filled < this.capacity ? 0 : this.writeIndex;
    for (let offset = 0; offset < this.filled; offset += 1) {
      const index = (start + offset) % this.capacity;
      const tick = this.ticks[index] ?? 0;
      if (tick < sinceTick) continue;
      visit(this.motherIds[index] ?? 0, this.fatherIds[index] ?? 0, tick);
    }
  }

  clear(): void {
    this.writeIndex = 0;
    this.filled = 0;
  }
}

/** A fixed-capacity ring of recent births, for the demographic-Ne parentage window. */
export class BirthLog {
  private readonly ids: Float64Array;
  private readonly motherIds: Float64Array;
  private readonly fatherIds: Float64Array;
  private readonly ticks: Float64Array;
  private writeIndex = 0;
  private filled = 0;

  constructor(readonly capacity = 1 << 16) {
    this.ids = new Float64Array(capacity);
    this.motherIds = new Float64Array(capacity);
    this.fatherIds = new Float64Array(capacity);
    this.ticks = new Float64Array(capacity);
  }

  push(id: OrganismId, motherId: OrganismId, fatherId: OrganismId, tick: number): void {
    this.ids[this.writeIndex] = id;
    this.motherIds[this.writeIndex] = motherId;
    this.fatherIds[this.writeIndex] = fatherId;
    this.ticks[this.writeIndex] = tick;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled += 1;
  }

  get size(): number {
    return this.filled;
  }

  forEachSince(
    sinceTick: number,
    visit: (id: OrganismId, motherId: OrganismId, fatherId: OrganismId, tick: number) => void,
  ): void {
    const start = this.filled < this.capacity ? 0 : this.writeIndex;
    for (let offset = 0; offset < this.filled; offset += 1) {
      const index = (start + offset) % this.capacity;
      const tick = this.ticks[index] ?? 0;
      if (tick < sinceTick) continue;
      visit(this.ids[index] ?? 0, this.motherIds[index] ?? 0, this.fatherIds[index] ?? 0, tick);
    }
  }

  clear(): void {
    this.writeIndex = 0;
    this.filled = 0;
  }
}

// ---------------------------------------------------------------------------
// Trait cache
// ---------------------------------------------------------------------------

/**
 * Latent trait vectors keyed by `OrganismId`, held in one growable arena.
 *
 * The recorder needs the phenotype of organisms that are no longer alive: a
 * midparent regression needs both parents after the offspring is born, and the
 * assortment index needs both partners of a mating that happened a generation
 * ago. `StatsApi.onMating` and `onBirth` carry ids only, and only `sample` is
 * handed a `SimState`, so the cache is filled by walking the living population
 * at each sample boundary.
 *
 * That is exact rather than approximate, because a phenotype is computed once
 * at birth and never changes: whatever is read at any sample during an
 * organism's life is the same vector it was born with. The only individuals
 * missed are those born and dead entirely between two sample rows (200 ticks),
 * which cannot include a breeding adult — maturity is 600 ticks.
 */
export class TraitCache {
  private offsets = new Map<OrganismId, number>();
  private values: Float32Array;
  private used = 0;

  constructor(initialCapacity = 4096) {
    this.values = new Float32Array(Math.max(1, initialCapacity) * TRAIT_COUNT);
  }

  get size(): number {
    return this.offsets.size;
  }

  has(id: OrganismId): boolean {
    return this.offsets.has(id);
  }

  /** Copy `TRAIT_COUNT` latent values starting at `sourceOffset` into the cache. */
  store(id: OrganismId, source: Float32Array, sourceOffset: number): void {
    if (this.offsets.has(id)) return;
    if ((this.used + 1) * TRAIT_COUNT > this.values.length) {
      const grown = new Float32Array(Math.max(this.values.length * 2, TRAIT_COUNT * 64));
      grown.set(this.values);
      this.values = grown;
    }
    const offset = this.used * TRAIT_COUNT;
    for (let index = 0; index < TRAIT_COUNT; index += 1) {
      this.values[offset + index] = source[sourceOffset + index] ?? 0;
    }
    this.offsets.set(id, offset);
    this.used += 1;
  }

  /** One latent trait, or NaN when the organism was never observed at a sample boundary. */
  get(id: OrganismId, traitIndex: number): number {
    const offset = this.offsets.get(id);
    if (offset === undefined) return Number.NaN;
    return this.values[offset + traitIndex] ?? Number.NaN;
  }

  /**
   * Drop everything `keep` rejects, rebuilding the arena around the survivors in
   * ascending id order. Called from `collectAncestry`, so the cache decays on
   * the same schedule as the pedigree it serves; a pass that drops nothing costs
   * one walk of the key set and no allocation.
   */
  prune(keep: (id: OrganismId) => boolean): void {
    const survivors: OrganismId[] = [];
    for (const id of this.offsets.keys()) {
      if (keep(id)) survivors.push(id);
    }
    if (survivors.length === this.offsets.size) return;
    survivors.sort((a, b) => a - b);

    const compacted = new Float32Array(Math.max(survivors.length, 64) * TRAIT_COUNT);
    const offsets = new Map<OrganismId, number>();
    for (let index = 0; index < survivors.length; index += 1) {
      const id = survivors[index] ?? 0;
      const from = this.offsets.get(id) ?? 0;
      const to = index * TRAIT_COUNT;
      compacted.set(this.values.subarray(from, from + TRAIT_COUNT), to);
      offsets.set(id, to);
    }
    this.values = compacted;
    this.offsets = offsets;
    this.used = survivors.length;
  }

  clear(): void {
    this.offsets = new Map();
    this.used = 0;
  }
}

// ---------------------------------------------------------------------------
// Growable typed columns
// ---------------------------------------------------------------------------

/**
 * An append-only Float64 column that doubles when full.
 *
 * The charts (WP-B5) and the probe runner want a scalar series across several
 * hundred generations as a contiguous array, not a field plucked out of a few
 * thousand `SampleRow` objects. Rows remain the contract; these are the same
 * numbers in the shape a plot consumes.
 */
export class GrowableColumn {
  private data: Float64Array;
  private length = 0;

  constructor(initialCapacity = 256) {
    this.data = new Float64Array(Math.max(1, initialCapacity));
  }

  push(value: number): void {
    if (this.length === this.data.length) {
      const grown = new Float64Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.length] = value;
    this.length += 1;
  }

  get size(): number {
    return this.length;
  }

  at(index: number): number {
    return index >= 0 && index < this.length ? (this.data[index] ?? Number.NaN) : Number.NaN;
  }

  /** A view of the filled prefix. Invalidated by the next `push`; copy to retain. */
  view(): Float64Array {
    return this.data.subarray(0, this.length);
  }

  /** Values from `start` onward, copied. */
  slice(start: number): Float64Array {
    return this.data.slice(Math.max(0, start), this.length);
  }

  clear(): void {
    this.length = 0;
  }
}
