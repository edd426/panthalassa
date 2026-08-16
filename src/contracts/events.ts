/**
 * The event log — FROZEN CONTRACT (see CLAUDE.md).
 *
 * Events are the sim's narration: the event feed reads them, the phylogeny view
 * is built from `speciesSplit`/`cladeFounding`, the sweep chart from
 * `sweepCrossedHalf`, and probes assert on them. They are produced during a
 * tick and drained at the tick boundary, in slot order, so the sequence is a
 * deterministic function of (config, seed).
 *
 * Every event carries the `tick` it happened on. Payloads reference organisms
 * by `OrganismId`, never by slot — a slot is recycled within a tick of a death,
 * and an event outlives the organism it describes.
 */

import type { CladeArchetype } from './genome';
import type { DiscreteLocusId, QuantLocusId } from './genome';
import type { BarrierSpec, CladeId, DeathCause, DemeId, DisturbanceRegion, OrganismId, SpeciesTag } from './types';

interface EventBase {
  readonly tick: number;
}

export interface BirthEvent extends EventBase {
  readonly kind: 'birth';
  readonly id: OrganismId;
  readonly motherId: OrganismId;
  readonly fatherId: OrganismId;
  readonly x: number;
  readonly y: number;
  readonly speciesTag: SpeciesTag;
  readonly cladeId: CladeId;
  /** Mutations that landed in this individual's gametes; empty is the normal case. */
  readonly mutations: readonly MutationRecord[];
}

export interface MutationRecord {
  readonly locus: QuantLocusId | DiscreteLocusId;
  /** Allele-unit step for quantitative loci; the new allele index for discrete loci. */
  readonly delta: number;
  /** Fat-tail draws are the ones worth showing in the feed. */
  readonly fatTail: boolean;
}

export interface DeathEvent extends EventBase {
  readonly kind: 'death';
  readonly id: OrganismId;
  readonly cause: DeathCause;
  readonly x: number;
  readonly y: number;
  readonly ageTicks: number;
  readonly speciesTag: SpeciesTag;
  /**
   * Who killed this animal. Set when `cause` is `'predation'` (the predator)
   * or, since v1.7.2, `'toxin'` (the victim whose flesh poisoned the predator
   * — the same relation, pointing the other way along the same meal).
   */
  readonly killerId?: OrganismId;
}

/**
 * The species detector split a lineage in two. This is the edge that builds the
 * true phylogeny — the tree is recorded, not reconstructed.
 */
export interface SpeciesSplitEvent extends EventBase {
  readonly kind: 'speciesSplit';
  readonly parentTag: SpeciesTag;
  readonly childTags: readonly [SpeciesTag, SpeciesTag];
  /** Realized cross-mating rate as a fraction of the within-group rate at the moment of the split. */
  readonly crossMatingRate: number;
  readonly sizes: readonly [number, number];
}

export interface SpeciesExtinctionEvent extends EventBase {
  readonly kind: 'speciesExtinction';
  readonly tag: SpeciesTag;
  readonly lifetimeTicks: number;
  readonly peakPopulation: number;
}

/** A clade macro-mutation produced a body plan that differs from its parent's. */
export interface CladeFoundingEvent extends EventBase {
  readonly kind: 'cladeFounding';
  readonly cladeId: CladeId;
  readonly parentCladeId: CladeId;
  readonly archetype: CladeArchetype;
  readonly parentArchetype: CladeArchetype;
  readonly founderId: OrganismId;
  readonly x: number;
  readonly y: number;
}

/**
 * A tracked allele crossed 50% frequency — the visible half of a selective
 * sweep, and the assertion P10 hangs on.
 */
export interface SweepCrossedHalfEvent extends EventBase {
  readonly kind: 'sweepCrossedHalf';
  readonly locus: DiscreteLocusId;
  readonly allele: number;
  readonly frequency: number;
  readonly introducedTick: number;
  readonly generationsElapsed: number;
}

export interface ClimateEvent extends EventBase {
  readonly kind: 'climateEvent';
  /** `walk` is the ordinary OU excursion crossing a reporting threshold; `retarget` is a god tool. */
  readonly cause: 'walk' | 'retarget';
  readonly meanOffsetC: number;
  readonly deltaC: number;
}

export interface BarrierChangeEvent extends EventBase {
  readonly kind: 'barrierChange';
  readonly change: 'raised' | 'lowered';
  readonly barrier: BarrierSpec;
}

export interface MeteorEvent extends EventBase {
  readonly kind: 'meteor';
  readonly x: number;
  readonly y: number;
  readonly radiusWu: number;
  readonly killed: number;
}

/** An organism was inserted from outside the normal birth path: god tool, probe injection, or edge immigration. */
export interface MutantIntroducedEvent extends EventBase {
  readonly kind: 'mutantIntroduced';
  readonly id: OrganismId;
  readonly source: 'god' | 'probe' | 'immigration';
  readonly locus?: QuantLocusId | DiscreteLocusId;
  /** Allele-unit offset for a quantitative injection, allele index for a discrete one. */
  readonly value?: number;
  readonly deme: DemeId;
}

export interface ThermalShockEvent extends EventBase {
  readonly kind: 'thermalShock';
  readonly magnitudeC: number;
  readonly durationTicks: number;
}

export interface PlanktonCrashEvent extends EventBase {
  readonly kind: 'planktonCrash';
  readonly productivityMultiplier: number;
  readonly durationTicks: number;
  readonly region: DisturbanceRegion | null;
}

export interface KelpStormEvent extends EventBase {
  readonly kind: 'kelpStorm';
  readonly clearFraction: number;
  readonly durationTicks: number;
  readonly region: DisturbanceRegion;
}

/**
 * G-wave v1.7: chemical defence was invented — a `toxinMacro` allele appeared
 * or an organism's expressed toxicity first cleared the noteworthy floor.
 * Emitted by G3's aposematism stage; worth a feed line for the same reason
 * clade foundings are.
 */
export interface ToxinInventionEvent extends EventBase {
  readonly kind: 'toxinInvention';
  readonly id: OrganismId;
  readonly x: number;
  readonly y: number;
  readonly toxicity: number;
  /** True when the jump came through the macro-locus rather than the polygenic tail. */
  readonly viaMacroLocus: boolean;
}

export type SimEvent =
  | BirthEvent
  | DeathEvent
  | SpeciesSplitEvent
  | SpeciesExtinctionEvent
  | CladeFoundingEvent
  | SweepCrossedHalfEvent
  | ClimateEvent
  | BarrierChangeEvent
  | MeteorEvent
  | MutantIntroducedEvent
  | ThermalShockEvent
  | PlanktonCrashEvent
  | KelpStormEvent
  | ToxinInventionEvent;

export type SimEventKind = SimEvent['kind'];

export const SIM_EVENT_KINDS = [
  'birth',
  'death',
  'speciesSplit',
  'speciesExtinction',
  'cladeFounding',
  'sweepCrossedHalf',
  'climateEvent',
  'barrierChange',
  'meteor',
  'mutantIntroduced',
  'thermalShock',
  'planktonCrash',
  'kelpStorm',
] as const satisfies readonly SimEventKind[];

/**
 * Events worth surfacing in the UI feed. Births and deaths run at thousands per
 * generation and are for the recorder, not the reader.
 */
export const NARRATIVE_EVENT_KINDS = [
  'speciesSplit',
  'speciesExtinction',
  'cladeFounding',
  'sweepCrossedHalf',
  'climateEvent',
  'barrierChange',
  'meteor',
  'mutantIntroduced',
  'thermalShock',
  'planktonCrash',
  'kelpStorm',
] as const satisfies readonly SimEventKind[];

export function isNarrativeEvent(event: SimEvent): boolean {
  return (NARRATIVE_EVENT_KINDS as readonly SimEventKind[]).includes(event.kind);
}
