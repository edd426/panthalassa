/**
 * The pedigree and the true phylogeny.
 *
 * Two stores that share a lifetime but not a shape:
 *
 * - `AncestryStore` is the append-only individual pedigree, kept bounded by a
 *   mark-and-sweep collection that preserves every ancestral *path* while
 *   discarding the individuals nobody can reach. Everything it drops is folded
 *   into per-lineage counts, so a total taken over the store plus the summaries
 *   is the same number before and after a collection.
 * - `PhylogenyStore` is the species tree, built from `speciesSplit`,
 *   `speciesExtinction` and `cladeFounding` events as they happen. The tree is
 *   *recorded*, not reconstructed from present-day distances — having the true
 *   topology to compare a reconstruction against is the reason splits are
 *   events at all.
 */

import type { CladeArchetype } from '../contracts/genome';
import { ANCESTRAL_ARCHETYPE } from '../contracts/genome';
import type { SimEvent } from '../contracts/events';
import type { AncestryRecord, PhylogenyNode } from '../contracts/stats';
import { DEATH_CAUSES, NO_ORGANISM } from '../contracts/types';
import type { CladeId, DeathCause, OrganismId, Sex, SimConfig, SimState, SpeciesTag } from '../contracts/types';
import { forEachLiveSlot } from './shared';

// ---------------------------------------------------------------------------
// Lineage summaries
// ---------------------------------------------------------------------------

/**
 * What survives of the individuals a collection dropped: how many there were and
 * how they died, per species tag. This is the ledger that makes the GC auditable
 * — `totalRecorded` always equals `store.size + Σ summary.records`.
 */
export interface LineageSummary {
  readonly tag: SpeciesTag;
  /** Individual records folded into this summary. */
  records: number;
  /** Of those, how many were still alive when they were compacted. */
  living: number;
  deaths: Record<DeathCause, number>;
}

function emptyDeathCounts(): Record<DeathCause, number> {
  const counts = {} as Record<DeathCause, number>;
  for (const cause of DEATH_CAUSES) counts[cause] = 0;
  return counts;
}

/** Totals a caller can check a collection against. */
export interface AncestryTotals {
  /** Every record ever passed to `onBirth`. */
  readonly recorded: number;
  /** Records still held individually. */
  readonly retained: number;
  /** Records folded into lineage summaries. */
  readonly compacted: number;
  /** Deaths ever passed to `onDeath`. */
  readonly deaths: number;
  /** Deaths still visible on a retained record. */
  readonly retainedDeaths: number;
  /** Deaths that survive only as a lineage count. */
  readonly compactedDeaths: number;
}

// ---------------------------------------------------------------------------
// Ancestry store
// ---------------------------------------------------------------------------

export class AncestryStore {
  private readonly records = new Map<OrganismId, AncestryRecord>();
  private readonly summaries = new Map<SpeciesTag, LineageSummary>();
  /** Ids a retained event points at; roots of the GC alongside the living and the founders. */
  private readonly eventNamed = new Set<OrganismId>();

  private recorded = 0;
  private deaths = 0;
  private compacted = 0;
  private compactedDeaths = 0;

  constructor(private readonly config: SimConfig) {}

  // -- ingest ---------------------------------------------------------------

  record(entry: AncestryRecord): void {
    if (this.records.has(entry.id)) return;
    this.records.set(entry.id, entry);
    this.recorded += 1;
  }

  /**
   * Close a record out. `AncestryRecord` is readonly, so this replaces the entry
   * rather than mutating it; a death for an id that has already been collected
   * is counted against its lineage instead of resurrecting the record.
   */
  markDead(id: OrganismId, tick: number, cause: DeathCause): void {
    this.deaths += 1;
    const existing = this.records.get(id);
    if (existing === undefined) {
      this.compactedDeaths += 1;
      return;
    }
    if (existing.deathTick !== null) {
      // Already closed; keep the first report and do not double-count it.
      this.deaths -= 1;
      return;
    }
    this.records.set(id, { ...existing, deathTick: tick, deathCause: cause });
  }

  /** Pin an id named by a narrative event so the GC keeps it and its ancestors. */
  pin(id: OrganismId): void {
    if (id !== NO_ORGANISM) this.eventNamed.add(id);
  }

  // -- queries --------------------------------------------------------------

  get(id: OrganismId): AncestryRecord | undefined {
    return this.records.get(id);
  }

  has(id: OrganismId): boolean {
    return this.records.has(id);
  }

  get size(): number {
    return this.records.size;
  }

  /**
   * The ancestral path from `id` upward, mother before father at each level,
   * breadth-first and capped at `maxRecords`. Feeds `OrganismDump.ancestors`.
   */
  lineage(id: OrganismId, maxRecords = 32): readonly AncestryRecord[] {
    const out: AncestryRecord[] = [];
    const seen = new Set<OrganismId>();
    let frontier: OrganismId[] = [id];
    while (frontier.length > 0 && out.length < maxRecords) {
      const next: OrganismId[] = [];
      for (const current of frontier) {
        if (current === NO_ORGANISM || seen.has(current)) continue;
        seen.add(current);
        const entry = this.records.get(current);
        if (entry === undefined) continue;
        if (current !== id) out.push(entry);
        if (out.length >= maxRecords) break;
        next.push(entry.motherId, entry.fatherId);
      }
      frontier = next;
    }
    return out;
  }

  /** True when every ancestor of `id` that was ever recorded is still reachable. */
  hasCompleteAncestry(id: OrganismId): boolean {
    const seen = new Set<OrganismId>();
    const stack: OrganismId[] = [id];
    while (stack.length > 0) {
      const current = stack.pop() ?? NO_ORGANISM;
      if (current === NO_ORGANISM || seen.has(current)) continue;
      seen.add(current);
      const entry = this.records.get(current);
      if (entry === undefined) return false;
      stack.push(entry.motherId, entry.fatherId);
    }
    return true;
  }

  /**
   * Visit everyone who was a *potential* breeder during `[windowStart, endTick]`
   * — mature by the end of the window and not already dead when it opened.
   *
   * This is the denominator demographic Ne needs: an adult that lived through
   * the window and left no offspring is as much a part of the offspring-number
   * variance as one that left six, and counting only the individuals who
   * actually appear in the parentage table would understate Vk badly under high
   * mortality. `AncestryRecord.sex` exists for exactly this.
   *
   * Iteration is over the record map, whose order is birth order: a JS `Map`
   * keeps insertion position under both overwrite and delete, so the GC dropping
   * records cannot reorder the survivors and the traversal stays a deterministic
   * function of (config, seed).
   */
  forEachBreeder(
    windowStart: number,
    endTick: number,
    maturityTicks: number,
    visit: (id: OrganismId, sex: Sex) => void,
  ): void {
    for (const entry of this.records.values()) {
      if (entry.birthTick + maturityTicks > endTick) continue;
      if (entry.deathTick !== null && entry.deathTick < windowStart) continue;
      visit(entry.id, entry.sex);
    }
  }

  /** Lineage summaries, ascending by tag. */
  lineageSummaries(): readonly LineageSummary[] {
    return [...this.summaries.values()].sort((a, b) => a.tag - b.tag);
  }

  totals(): AncestryTotals {
    let retainedDeaths = 0;
    for (const entry of this.records.values()) {
      if (entry.deathTick !== null) retainedDeaths += 1;
    }
    return {
      recorded: this.recorded,
      retained: this.records.size,
      compacted: this.compacted,
      deaths: this.deaths,
      retainedDeaths,
      compactedDeaths: this.compactedDeaths,
    };
  }

  // -- collection -----------------------------------------------------------

  /**
   * Mark and sweep.
   *
   * Roots are the living, the founders, the ids narrative events named, and
   * anything born inside the `ancestryRetentionGenerations` window; the mark
   * phase then walks parent edges upward from every root, so an ancestor is
   * retained however far back it sits. Only individuals no root can reach are
   * dropped, which is what makes "walk this organism's pedigree to the founders"
   * an operation that never hits a hole.
   *
   * Returns the number of records dropped.
   */
  collect(state: SimState): number {
    const retained = new Set<OrganismId>();
    const stack: OrganismId[] = [];

    const addRoot = (id: OrganismId): void => {
      if (id === NO_ORGANISM || retained.has(id) || !this.records.has(id)) return;
      retained.add(id);
      stack.push(id);
    };

    forEachLiveSlot(state, (_slot, id) => {
      addRoot(id);
    });
    for (const id of this.eventNamed) addRoot(id);

    const retentionTicks = this.config.sampling.ancestryRetentionGenerations * this.config.time.generationTicks;
    const horizon = state.tick - retentionTicks;
    for (const entry of this.records.values()) {
      const isFounder = entry.motherId === NO_ORGANISM && entry.fatherId === NO_ORGANISM;
      if (isFounder || entry.birthTick >= horizon) addRoot(entry.id);
    }

    while (stack.length > 0) {
      const current = stack.pop() ?? NO_ORGANISM;
      const entry = this.records.get(current);
      if (entry === undefined) continue;
      addRoot(entry.motherId);
      addRoot(entry.fatherId);
    }

    let dropped = 0;
    for (const [id, entry] of this.records) {
      if (retained.has(id)) continue;
      this.fold(entry);
      this.records.delete(id);
      dropped += 1;
    }
    return dropped;
  }

  private fold(entry: AncestryRecord): void {
    let summary = this.summaries.get(entry.speciesTag);
    if (summary === undefined) {
      summary = { tag: entry.speciesTag, records: 0, living: 0, deaths: emptyDeathCounts() };
      this.summaries.set(entry.speciesTag, summary);
    }
    summary.records += 1;
    this.compacted += 1;
    if (entry.deathCause === null) {
      summary.living += 1;
    } else {
      summary.deaths[entry.deathCause] += 1;
      this.compactedDeaths += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Phylogeny
// ---------------------------------------------------------------------------

/** One species observed alive at a sample boundary. */
export interface SpeciesObservation {
  readonly tag: SpeciesTag;
  readonly count: number;
  /** Modal clade of its members, for the node's body-plan attribution. */
  readonly cladeId: CladeId;
  readonly archetype: CladeArchetype;
}

interface MutableNode {
  tag: SpeciesTag;
  parentTag: SpeciesTag | null;
  birthTick: number;
  extinctTick: number | null;
  peakPopulation: number;
  cladeId: CladeId;
  archetype: CladeArchetype;
}

export class PhylogenyStore {
  private readonly nodes = new Map<SpeciesTag, MutableNode>();

  /** Consume a narrative event. Anything that is not a tree edge is ignored. */
  consume(event: SimEvent): void {
    switch (event.kind) {
      case 'speciesSplit': {
        const parent = this.ensure(event.parentTag, event.tick);
        for (const child of event.childTags) {
          const node = this.ensure(child, event.tick);
          node.parentTag = event.parentTag;
          node.birthTick = event.tick;
          node.cladeId = parent.cladeId;
          node.archetype = parent.archetype;
        }
        break;
      }
      case 'speciesExtinction': {
        const node = this.ensure(event.tag, Math.max(0, event.tick - event.lifetimeTicks));
        node.extinctTick = event.tick;
        node.peakPopulation = Math.max(node.peakPopulation, event.peakPopulation);
        break;
      }
      case 'cladeFounding': {
        // A clade founding does not create a species, but it does retag the body
        // plan of whichever lineage the founder belonged to from here on.
        break;
      }
      default:
        break;
    }
  }

  /** Fold one sample's live species counts into the tree. */
  observe(tick: number, observations: readonly SpeciesObservation[]): void {
    for (const observation of observations) {
      const node = this.ensure(observation.tag, tick);
      node.peakPopulation = Math.max(node.peakPopulation, observation.count);
      node.cladeId = observation.cladeId;
      node.archetype = observation.archetype;
      if (observation.count > 0) node.extinctTick = null;
    }
  }

  /** Nodes ascending by tag, which is also their order of creation. */
  snapshot(): readonly PhylogenyNode[] {
    return [...this.nodes.values()]
      .sort((a, b) => a.tag - b.tag)
      .map((node) => ({
        tag: node.tag,
        parentTag: node.parentTag,
        birthTick: node.birthTick,
        extinctTick: node.extinctTick,
        peakPopulation: node.peakPopulation,
        cladeId: node.cladeId,
        archetype: node.archetype,
        label: speciesLabel(node.tag, node.birthTick),
      }));
  }

  private ensure(tag: SpeciesTag, tick: number): MutableNode {
    let node = this.nodes.get(tag);
    if (node === undefined) {
      node = {
        tag,
        parentTag: null,
        birthTick: tick,
        extinctTick: null,
        peakPopulation: 0,
        cladeId: 0,
        archetype: ANCESTRAL_ARCHETYPE,
      };
      this.nodes.set(tag, node);
    }
    return node;
  }
}

// ---------------------------------------------------------------------------
// Deterministic naming
// ---------------------------------------------------------------------------

const NAME_STEMS = [
  'pantha', 'nykta', 'thalass', 'corym', 'veliger', 'draco', 'lyra', 'ostrak',
  'ammon', 'sylla', 'phyco', 'krion', 'meros', 'tethy', 'oreas', 'zephyr',
];

const NAME_ENDINGS = ['a', 'is', 'ora', 'ix', 'ura', 'ea', 'yne', 'ida'];

const NAME_EPITHETS = [
  'abyssalis', 'pelagica', 'cryptica', 'gracilis', 'horrida', 'lucens', 'nivalis', 'obscura',
  'placida', 'rapax', 'serrata', 'tenuis', 'umbrata', 'vagans', 'zonata', 'borealis',
];

/**
 * A stable binomial for a lineage, derived from its tag and founding tick.
 *
 * Pure and deterministic — the same lineage is called the same thing in every
 * replay of a seed, which is what lets an event feed and a phylogeny view agree.
 * WP-B7 owns naming properly and may replace this wholesale.
 */
export function speciesLabel(tag: SpeciesTag, birthTick: number): string {
  const hash = mix(tag * 0x9e3779b1 + birthTick * 0x85ebca6b);
  const stem = NAME_STEMS[hash % NAME_STEMS.length] ?? 'pantha';
  const ending = NAME_ENDINGS[(hash >>> 8) % NAME_ENDINGS.length] ?? 'a';
  const epithet = NAME_EPITHETS[(hash >>> 16) % NAME_EPITHETS.length] ?? 'vagans';
  const genus = stem + ending;
  return `${genus.charAt(0).toUpperCase()}${genus.slice(1)} ${epithet}`;
}

function mix(value: number): number {
  let hash = value >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 2_246_822_507);
  hash = Math.imul(hash ^ (hash >>> 13), 3_266_489_909);
  return (hash ^ (hash >>> 16)) >>> 0;
}
