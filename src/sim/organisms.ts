/**
 * Structure-of-arrays organism pools and the slot allocator (WP-A3).
 *
 * The tick loop walks slots `0..capacity-1` ascending and skips the dead; it
 * never iterates a container whose order depends on death history. Slots are
 * recycled the moment an organism dies, `OrganismId`s never are.
 *
 * Allocation is a LIFO stack of free slots. The engine releases dead slots in
 * *descending* slot order so the lowest free slot ends up on top and the pools
 * stay compact, and the stack is serialised in hand-out order so a snapshot
 * reproduces the exact allocation sequence.
 */

import type { Genome } from '../contracts/genome';
import { TRAIT_COUNT, TRAIT_INDEX } from '../contracts/traits';
import type { TraitKey } from '../contracts/traits';
import type { OrganismPools, SimConfig, SimState, SlotIndex } from '../contracts/types';
import { NO_SLOT } from '../contracts/types';

/**
 * The contract columns plus the ones the engine needs to carry state between
 * ticks: a staggered behaviour decision, and (G2) realised body length.
 * `OrganismPools` may be extended but never trimmed (CLAUDE.md), and these
 * travel in the snapshot alongside the declared columns so a restore resumes
 * mid-decision.
 */
export interface EnginePools extends OrganismPools {
  /** Unit-ish steering direction from the last decision. */
  readonly steerX: Float32Array;
  readonly steerY: Float32Array;
  /** Fraction of `speedCap` the last decision asked for. */
  readonly speedFraction: Float32Array;
}

/** Every column that is one value per slot; the strided trait blocks are listed separately. */
export const SCALAR_COLUMN_NAMES = [
  'alive',
  'id',
  'motherId',
  'fatherId',
  'sex',
  'archetype',
  'cladeId',
  'speciesTag',
  'demeId',
  'x',
  'y',
  'vx',
  'vy',
  'energy',
  'gutFill',
  'birthTick',
  'ageTicks',
  'lastMatingTick',
  'behaviorState',
  'behaviorTimer',
  'targetSlot',
  'steerX',
  'steerY',
  'speedFraction',
] as const;

/**
 * Scalar columns the ontogeny axis added (G2), kept out of
 * {@link SCALAR_COLUMN_NAMES} because the world hash walks that list and the
 * off arm has to stay byte-identical. They are serialised like every other
 * column; `computeStateHash` folds them in only when the toggle is on, where
 * they carry information the `size` trait no longer does.
 */
export const ONTOGENY_COLUMN_NAMES = ['sizeCurrent'] as const;

/** Per-organism blocks of `TRAIT_COUNT` values each. */
export const STRIDED_COLUMN_NAMES = ['traits', 'traitsLatent', 'traitsGenotypic'] as const;

/** Column names the snapshot serialises, scalar columns first then the strided trait blocks. */
export const POOL_COLUMN_NAMES = [
  ...SCALAR_COLUMN_NAMES,
  ...ONTOGENY_COLUMN_NAMES,
  ...STRIDED_COLUMN_NAMES,
] as const;

export type PoolColumnName = (typeof POOL_COLUMN_NAMES)[number];

/** Packed-trait offsets resolved once; the tick loop indexes with these rather than through `TRAIT_INDEX`. */
export const T = Object.freeze({
  size: TRAIT_INDEX.size,
  speedCap: TRAIT_INDEX.speedCap,
  tOpt: TRAIT_INDEX.tOpt,
  tWidth: TRAIT_INDEX.tWidth,
  prefTarget: TRAIT_INDEX.prefTarget,
  choosiness: TRAIT_INDEX.choosiness,
  displayHue: TRAIT_INDEX.displayHue,
  segmentCount: TRAIT_INDEX.segmentCount,
  finPairs: TRAIT_INDEX.finPairs,
  bodyAspect: TRAIT_INDEX.bodyAspect,
  armorPlating: TRAIT_INDEX.armorPlating,
  diet: TRAIT_INDEX.diet,
  defense: TRAIT_INDEX.defense,
  growthAllocation: TRAIT_INDEX.growthAllocation,
  offspringSize: TRAIT_INDEX.offspringSize,
  fecundity: TRAIT_INDEX.fecundity,
});

export class OrganismStore implements EnginePools {
  readonly capacity: number;

  readonly alive: Uint8Array;
  readonly id: Float64Array;
  readonly motherId: Float64Array;
  readonly fatherId: Float64Array;

  readonly sex: Uint8Array;
  readonly archetype: Uint8Array;
  readonly cladeId: Int32Array;
  readonly speciesTag: Int32Array;
  readonly demeId: Int32Array;

  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;

  readonly energy: Float32Array;
  readonly gutFill: Float32Array;
  readonly birthTick: Float64Array;
  readonly ageTicks: Uint32Array;
  readonly lastMatingTick: Float64Array;

  readonly behaviorState: Uint8Array;
  readonly behaviorTimer: Uint16Array;
  readonly targetSlot: Int32Array;

  readonly steerX: Float32Array;
  readonly steerY: Float32Array;
  readonly speedFraction: Float32Array;
  readonly sizeCurrent: Float32Array;

  readonly traits: Float32Array;
  readonly traitsLatent: Float32Array;
  readonly traitsGenotypic: Float32Array;

  readonly genomes: (Genome | undefined)[];

  /** LIFO stack; `freeStack[freeCount - 1]` is the next slot handed out. */
  private readonly freeStack: Int32Array;
  private freeCount: number;

  constructor(capacity: number) {
    this.capacity = capacity;

    this.alive = new Uint8Array(capacity);
    this.id = new Float64Array(capacity);
    this.motherId = new Float64Array(capacity);
    this.fatherId = new Float64Array(capacity);

    this.sex = new Uint8Array(capacity);
    this.archetype = new Uint8Array(capacity);
    this.cladeId = new Int32Array(capacity);
    this.speciesTag = new Int32Array(capacity);
    this.demeId = new Int32Array(capacity);

    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);

    this.energy = new Float32Array(capacity);
    this.gutFill = new Float32Array(capacity);
    this.birthTick = new Float64Array(capacity);
    this.ageTicks = new Uint32Array(capacity);
    this.lastMatingTick = new Float64Array(capacity);

    this.behaviorState = new Uint8Array(capacity);
    this.behaviorTimer = new Uint16Array(capacity);
    this.targetSlot = new Int32Array(capacity);

    this.steerX = new Float32Array(capacity);
    this.steerY = new Float32Array(capacity);
    this.speedFraction = new Float32Array(capacity);
    this.sizeCurrent = new Float32Array(capacity);

    this.traits = new Float32Array(capacity * TRAIT_COUNT);
    this.traitsLatent = new Float32Array(capacity * TRAIT_COUNT);
    this.traitsGenotypic = new Float32Array(capacity * TRAIT_COUNT);

    this.genomes = new Array<Genome | undefined>(capacity).fill(undefined);

    this.freeStack = new Int32Array(capacity);
    for (let index = 0; index < capacity; index += 1) {
      // Descending, so the first allocation hands out slot 0.
      this.freeStack[index] = capacity - 1 - index;
    }
    this.freeCount = capacity;
  }

  get liveCount(): number {
    return this.capacity - this.freeCount;
  }

  get freeSlotCount(): number {
    return this.freeCount;
  }

  /** Next free slot, or `NO_SLOT` when the pool is full. Marks the slot alive. */
  allocate(): SlotIndex {
    if (this.freeCount === 0) return NO_SLOT;
    this.freeCount -= 1;
    const slot = this.freeStack[this.freeCount] ?? NO_SLOT;
    this.alive[slot] = 1;
    return slot;
  }

  /** Return a slot to the free stack and drop its genome reference. */
  release(slot: SlotIndex): void {
    if ((this.alive[slot] ?? 0) === 0) return;
    this.alive[slot] = 0;
    this.genomes[slot] = undefined;
    this.freeStack[this.freeCount] = slot;
    this.freeCount += 1;
  }

  /** Free slots in the exact order `allocate` will hand them back out. */
  freeSlotsInHandoutOrder(): SlotIndex[] {
    const out: SlotIndex[] = [];
    for (let index = this.freeCount - 1; index >= 0; index -= 1) {
      out.push(this.freeStack[index] ?? 0);
    }
    return out;
  }

  /** Rebuild the free stack from a snapshot's hand-out order. */
  restoreFreeSlots(handoutOrder: readonly SlotIndex[]): void {
    this.freeCount = handoutOrder.length;
    for (let index = 0; index < handoutOrder.length; index += 1) {
      this.freeStack[this.freeCount - 1 - index] = handoutOrder[index] ?? 0;
    }
  }
}

/** One column by name; used by the serialiser and the hash so the column list lives in one place. */
export function poolColumn(pools: EnginePools, name: PoolColumnName): EnginePools[PoolColumnName] {
  return pools[name];
}

/** Expressed trait of one organism. */
export function traitAt(pools: OrganismPools, slot: SlotIndex, traitOffset: number): number {
  return pools.traits[slot * TRAIT_COUNT + traitOffset] ?? 0;
}

/** Latent trait of one organism. */
export function latentTraitAt(pools: OrganismPools, slot: SlotIndex, traitOffset: number): number {
  return pools.traitsLatent[slot * TRAIT_COUNT + traitOffset] ?? 0;
}

/** Expressed trait by key — inspector and test path, not the tick loop. */
export function traitByKey(pools: OrganismPools, slot: SlotIndex, key: TraitKey): number {
  return pools.traits[slot * TRAIT_COUNT + TRAIT_INDEX[key]] ?? 0;
}

/**
 * The realised-length column (`sizeCurrent` joined `OrganismPools` in v1.7.1,
 * closing the G2 report's contract gap; the accessors stay for the call sites).
 */
export function sizeCurrentColumn(pools: OrganismPools): Float32Array {
  return pools.sizeCurrent;
}

/** Realised body length of one organism, cm. */
export function sizeCurrentAt(pools: OrganismPools, slot: SlotIndex): number {
  return pools.sizeCurrent[slot] ?? 0;
}

/**
 * Energy storage ceiling, `maxEnergyPerSize · sizeCurrent`. The floor on length
 * is numerical protection for the ratio, not a bound on the trait: `size` is
 * softplus-linked and can approach zero from above, and a juvenile's realised
 * length is smaller still.
 */
export function energyCapacityOf(pools: OrganismPools, slot: SlotIndex, config: SimConfig): number {
  return config.metabolism.maxEnergyPerSize * Math.max(1e-3, sizeCurrentAt(pools, slot));
}

/**
 * Old enough *and*, with ontogeny on, long enough to breed.
 *
 * `time.maturityTicks` is kept as an age floor and `growth.maturityLengthFraction`
 * adds a length floor against the genetic target, so age at maturity becomes an
 * emergent, food-dependent quantity — a stunted fish stays juvenile — without a
 * config constant naming it. Off the toggle this is the age test alone, which
 * is what every caller used to do inline.
 */
export function isMature(state: SimState, slot: SlotIndex): boolean {
  const config = state.config;
  const pop = state.pop;
  if ((pop.ageTicks[slot] ?? 0) < config.time.maturityTicks) return false;
  if (!config.toggles.enableOntogeny) return true;
  return sizeCurrentAt(pop, slot) >= config.growth.maturityLengthFraction * traitAt(pop, slot, T.size);
}
