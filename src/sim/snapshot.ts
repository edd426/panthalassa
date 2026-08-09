/**
 * Snapshot serialisation and the world hash (WP-A3).
 *
 * Two rules shape this file:
 *
 * 1. **Slot layout is preserved verbatim**, dead slots and free list included.
 *    Compacting to live organisms would renumber slots, which changes iteration
 *    order, which changes the trajectory — P1's snapshot→restore→continue
 *    assertion would then fail for a reason unrelated to any real bug.
 * 2. **The hash covers exactly what the snapshot round-trips**, and nothing
 *    else. A quantity that is hashed but not serialised makes restore look
 *    broken; a quantity that is serialised but not hashed lets a real
 *    divergence through. Free slots hold stale column data that a restore
 *    reproduces byte for byte but that no future tick can read, so the hash
 *    covers the `alive` flags and the free list rather than dead-slot contents.
 *
 * Everything produced here is structured-clone-safe: plain objects, arrays,
 * strings, numbers and typed arrays only.
 */

import type { Genome } from '../contracts/genome';
import { TRAIT_COUNT } from '../contracts/traits';
import type {
  BarrierSpec,
  ClimateState,
  DeathCause,
  SerializedGenome,
  SimConfigOverrides,
  DisturbanceState,
  SimSnapshot,
  SimState,
  SlotIndex,
  SpeciesBookkeeping,
} from '../contracts/types';
import { DEATH_CAUSES, SNAPSHOT_FORMAT_VERSION } from '../contracts/types';
import type { EnginePools, PoolColumnName } from './organisms';
import { POOL_COLUMN_NAMES, SCALAR_COLUMN_NAMES, poolColumn } from './organisms';
import type { OrganismStore } from './organisms';

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

const FNV_PRIME = 16_777_619;
const FNV_OFFSET = 2_166_136_261;

/**
 * Two independent FNV-1a lanes over one byte stream, concatenated to 64 bits of
 * hex. One 32-bit lane would collide often enough to be noticed across a probe
 * suite that compares thousands of hashes; two lanes with different mixing make
 * an accidental match vanishingly unlikely without pulling in a real digest.
 */
class WorldHasher {
  private laneA = FNV_OFFSET;
  private laneB = FNV_OFFSET ^ 0x9e37_79b9;
  private readonly scratch = new Float64Array(1);
  private readonly scratchBytes = new Uint8Array(this.scratch.buffer);

  byte(value: number): void {
    this.laneA = Math.imul(this.laneA ^ value, FNV_PRIME) >>> 0;
    const mixed = Math.imul(this.laneB ^ value, 2_246_822_519) >>> 0;
    this.laneB = ((mixed << 13) | (mixed >>> 19)) >>> 0;
  }

  bytes(view: ArrayBufferView): void {
    const raw = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (let index = 0; index < raw.length; index += 1) this.byte(raw[index] ?? 0);
  }

  /** Every numeric quantity goes through the same float64 encoding so int and float columns cannot alias. */
  number(value: number): void {
    this.scratch[0] = value;
    for (let index = 0; index < 8; index += 1) this.byte(this.scratchBytes[index] ?? 0);
  }

  numbers(values: ArrayLike<number>, start: number, count: number): void {
    for (let index = 0; index < count; index += 1) this.number(values[start + index] ?? 0);
  }

  text(value: string): void {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      this.byte(code & 0xff);
      this.byte((code >>> 8) & 0xff);
    }
    this.byte(0);
  }

  digest(): string {
    return (this.laneA >>> 0).toString(16).padStart(8, '0') + (this.laneB >>> 0).toString(16).padStart(8, '0');
  }
}

/**
 * Order-independent in the sense that matters: the walk is canonical (slots
 * ascending, columns in declaration order, loci in genome layout order), so the
 * digest depends on the world's contents and never on the order in which the
 * engine happened to touch them.
 */
export function computeStateHash(state: SimState, store: OrganismStore): string {
  const hasher = new WorldHasher();
  const pools = store;

  hasher.text(state.seed);
  hasher.number(state.tick);
  for (const word of state.rngState) hasher.number(word);
  hasher.number(state.nextOrganismId);
  hasher.number(state.nextSpeciesTag);
  hasher.number(state.nextCladeId);
  hasher.number(state.liveCount);
  hasher.number(pools.capacity);

  for (const slot of store.freeSlotsInHandoutOrder()) hasher.number(slot);

  for (let slot = 0; slot < pools.capacity; slot += 1) {
    const alive = pools.alive[slot] ?? 0;
    hasher.byte(alive);
    if (alive === 0) continue;

    for (const name of SCALAR_COLUMN_NAMES) {
      if (name === 'alive') continue;
      hasher.number(poolColumn(pools, name)[slot] ?? 0);
    }
    hasher.numbers(pools.traits, slot * TRAIT_COUNT, TRAIT_COUNT);
    hasher.numbers(pools.traitsLatent, slot * TRAIT_COUNT, TRAIT_COUNT);
    hasher.numbers(pools.traitsGenotypic, slot * TRAIT_COUNT, TRAIT_COUNT);

    const genome = pools.genomes[slot];
    if (genome === undefined) {
      hasher.byte(0);
      continue;
    }
    hasher.byte(1);
    hasher.text(genome.karyotype);
    hasher.numbers(genome.quant, 0, genome.quant.length);
    hasher.bytes(genome.discrete);
  }

  hasher.bytes(state.field.plankton);
  hasher.bytes(state.field.kelp);

  // The off arm is deliberately byte-for-byte compatible with the pre-D-wave
  // world hash. This makes the scheduler's marginal-contribution control a
  // strict trajectory check, not merely a same-seed comparison.
  if (state.config.toggles.enableDisturbances) {
    hasher.bytes(state.field.carrion);
    for (const shock of state.disturbance.thermal) {
      hasher.text(shock.kind);
      hasher.number(shock.startedTick);
      hasher.number(shock.magnitudeC);
      hasher.number(shock.durationTicks);
      hasher.number(shock.remainingTicks);
    }
    for (const shock of state.disturbance.planktonCrashes) {
      hasher.text(shock.kind);
      hasher.number(shock.startedTick);
      hasher.number(shock.productivityMultiplier);
      hasher.number(shock.durationTicks);
      hasher.number(shock.remainingTicks);
      hashRegion(hasher, shock.region);
    }
    for (const shock of state.disturbance.kelpStorms) {
      hasher.text(shock.kind);
      hasher.number(shock.startedTick);
      hasher.number(shock.clearFraction);
      hasher.number(shock.durationTicks);
      hasher.number(shock.remainingTicks);
      hashRegion(hasher, shock.region);
    }
  }

  hasher.number(state.climate.meanOffsetC);
  hasher.number(state.climate.targetOffsetC);
  hasher.number(state.climate.seasonPhaseTicks);

  for (const spec of state.barriers.specs) {
    hasher.text(spec.id);
    hasher.text(spec.shape.kind);
    hasher.number(spec.permeability);
    hasher.number(spec.raisedTick);
    switch (spec.shape.kind) {
      case 'verticalRidge':
        hasher.number(spec.shape.xWu);
        hasher.number(spec.shape.thicknessWu);
        break;
      case 'horizontalRidge':
        hasher.number(spec.shape.yWu);
        hasher.number(spec.shape.thicknessWu);
        break;
      case 'rect':
        hasher.number(spec.shape.xWu);
        hasher.number(spec.shape.yWu);
        hasher.number(spec.shape.widthWu);
        hasher.number(spec.shape.heightWu);
        break;
    }
  }

  for (const cause of DEATH_CAUSES) hasher.number(state.deathCounts[cause]);

  return hasher.digest();
}

function hashRegion(hasher: WorldHasher, region: import('../contracts/types').DisturbanceRegion | null): void {
  if (region === null) {
    hasher.byte(0);
    return;
  }
  hasher.byte(1);
  hasher.text(region.kind);
  hasher.number(region.xWu);
  hasher.number(region.yWu);
  if (region.kind === 'disc') hasher.number(region.radiusWu);
  else {
    hasher.number(region.widthWu);
    hasher.number(region.heightWu);
  }
}

// ---------------------------------------------------------------------------
// Serialise
// ---------------------------------------------------------------------------

/** Typed arrays are the only view kind the pools hold, so a `slice` is a deep copy. */
function copyColumn(column: EnginePools[PoolColumnName]): ArrayBufferView {
  return column.slice();
}

/**
 * Typed views come back from a structured clone as the exact type they went in
 * as, so the numeric read is safe; the assertion only tells the compiler what
 * `ArrayBufferView` cannot express.
 */
function asNumbers(view: ArrayBufferView): ArrayLike<number> {
  return view as unknown as ArrayLike<number>;
}

function copyClimate(climate: ClimateState): ClimateState {
  return {
    meanOffsetC: climate.meanOffsetC,
    targetOffsetC: climate.targetOffsetC,
    seasonPhaseTicks: climate.seasonPhaseTicks,
  };
}

function copyDisturbance(disturbance: DisturbanceState): DisturbanceState {
  return {
    thermal: disturbance.thermal.map((shock) => ({ ...shock })),
    planktonCrashes: disturbance.planktonCrashes.map((shock) => ({
      ...shock,
      region: shock.region === null ? null : { ...shock.region },
    })),
    kelpStorms: disturbance.kelpStorms.map((shock) => ({ ...shock, region: { ...shock.region } })),
  };
}

function copyDeathCounts(counts: Record<DeathCause, number>): Record<DeathCause, number> {
  const out = {} as Record<DeathCause, number>;
  for (const cause of DEATH_CAUSES) out[cause] = counts[cause];
  return out;
}

function serializeGenome(genome: Genome): SerializedGenome {
  return { quant: genome.quant.slice(), discrete: genome.discrete.slice(), karyotype: genome.karyotype };
}

export function serializeSnapshot(
  state: SimState,
  store: OrganismStore,
  configOverrides: SimConfigOverrides,
  species: readonly SpeciesBookkeeping[],
  stateHash: string,
): SimSnapshot {
  const columns: Record<string, ArrayBufferView> = {};
  for (const name of POOL_COLUMN_NAMES) {
    columns[name] = copyColumn(poolColumn(store, name));
  }

  const genomes: (SerializedGenome | null)[] = new Array<SerializedGenome | null>(store.capacity).fill(null);
  for (let slot = 0; slot < store.capacity; slot += 1) {
    const genome = store.genomes[slot];
    if ((store.alive[slot] ?? 0) === 1 && genome !== undefined) genomes[slot] = serializeGenome(genome);
  }

  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    seed: state.seed,
    configOverrides,
    tick: state.tick,
    rngState: [...state.rngState],
    nextOrganismId: state.nextOrganismId,
    nextSpeciesTag: state.nextSpeciesTag,
    nextCladeId: state.nextCladeId,
    liveCount: state.liveCount,
    capacity: store.capacity,
    freeSlots: store.freeSlotsInHandoutOrder(),
    columns,
    genomes,
    plankton: state.field.plankton.slice(),
    carrion: state.field.carrion.slice(),
    kelp: state.field.kelp.slice(),
    climate: copyClimate(state.climate),
    disturbance: copyDisturbance(state.disturbance),
    barriers: state.barriers.specs.map((spec) => ({ ...spec })),
    deathCounts: copyDeathCounts(state.deathCounts),
    species: species.map((entry) => ({ ...entry })),
    stateHash,
  };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Write a snapshot's pools, fields, climate and counters back into a freshly
 * constructed state. The caller is responsible for the parts that live outside
 * the snapshot format: rebuilding the ecology's derived fields and the barrier
 * mask, and rebuilding the spatial index.
 */
export function applySnapshot(state: SimState, store: OrganismStore, snapshot: SimSnapshot): void {
  if (snapshot.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    throw new Error(
      `Snapshot format ${snapshot.formatVersion} cannot be restored by engine format ${SNAPSHOT_FORMAT_VERSION}.`,
    );
  }
  if (snapshot.capacity !== store.capacity) {
    throw new Error(`Snapshot capacity ${snapshot.capacity} does not match pool capacity ${store.capacity}.`);
  }

  for (const name of POOL_COLUMN_NAMES) {
    const source = snapshot.columns[name];
    if (source === undefined) throw new Error(`Snapshot is missing pool column '${name}'.`);
    poolColumn(store, name).set(asNumbers(source));
  }

  for (let slot = 0; slot < store.capacity; slot += 1) {
    const serialized = snapshot.genomes[slot] ?? null;
    store.genomes[slot] =
      serialized === null
        ? undefined
        : { quant: serialized.quant.slice(), discrete: serialized.discrete.slice(), karyotype: serialized.karyotype };
  }

  store.restoreFreeSlots(snapshot.freeSlots);

  state.tick = snapshot.tick;
  state.rngState = [...snapshot.rngState];
  state.nextOrganismId = snapshot.nextOrganismId;
  state.nextSpeciesTag = snapshot.nextSpeciesTag;
  state.nextCladeId = snapshot.nextCladeId;
  state.liveCount = snapshot.liveCount;

  state.field.plankton.set(snapshot.plankton);
  state.field.carrion.set(snapshot.carrion);
  state.field.kelp.set(snapshot.kelp);

  state.climate.meanOffsetC = snapshot.climate.meanOffsetC;
  state.climate.targetOffsetC = snapshot.climate.targetOffsetC;
  state.climate.seasonPhaseTicks = snapshot.climate.seasonPhaseTicks;

  state.disturbance.thermal.splice(0, state.disturbance.thermal.length, ...snapshot.disturbance.thermal.map((shock) => ({ ...shock })));
  state.disturbance.planktonCrashes.splice(
    0,
    state.disturbance.planktonCrashes.length,
    ...snapshot.disturbance.planktonCrashes.map((shock) => ({
      ...shock,
      region: shock.region === null ? null : { ...shock.region },
    })),
  );
  state.disturbance.kelpStorms.splice(
    0,
    state.disturbance.kelpStorms.length,
    ...snapshot.disturbance.kelpStorms.map((shock) => ({ ...shock, region: { ...shock.region } })),
  );

  state.barriers.specs.length = 0;
  for (const spec of snapshot.barriers) state.barriers.specs.push({ ...spec });

  for (const cause of DEATH_CAUSES) state.deathCounts[cause] = snapshot.deathCounts[cause];

  state.events.length = 0;
  state.matingCount = 0;
  state.crossSpeciesMatingCount = 0;
}

/** Slots the snapshot says are occupied — handy for restore-time assertions. */
export function liveSlotsOf(snapshot: SimSnapshot): SlotIndex[] {
  const alive = snapshot.columns.alive;
  if (alive === undefined) return [];
  const flags = asNumbers(alive);
  const out: SlotIndex[] = [];
  for (let slot = 0; slot < snapshot.capacity; slot += 1) {
    if ((flags[slot] ?? 0) === 1) out.push(slot);
  }
  return out;
}

/** Barrier specs as plain, clone-safe records. */
export function copyBarrierSpecs(specs: readonly BarrierSpec[]): BarrierSpec[] {
  return specs.map((spec) => ({ ...spec }));
}
