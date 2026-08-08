/**
 * Module API interfaces — FROZEN CONTRACT (see CLAUDE.md).
 *
 * This is the seam that lets WP-A1…A4 build concurrently in one tree. The
 * engine (A3) is written against these interfaces and tested with its own
 * internal stubs; the integration package (A5) injects the real
 * implementations into `createSim`. Nothing in `src/sim/engine.ts` may import a
 * sibling module path — if the engine names `../genetics/meiosis`, the parallel
 * build is over.
 *
 * | Interface | Implemented by | Consumed by |
 * |---|---|---|
 * | `GeneticsApi` | A1 (`src/sim/genetics/**`) | engine at birth |
 * | `EcologyApi` | A2 (`src/sim/ecology/**`) | engine tick stages |
 * | `SpatialIndex` | A2 (`src/sim/spatial.ts`) | engine, ecology, mating |
 * | `MatingApi` | A3 (`src/sim/mating.ts`) | engine mating stage |
 * | `StatsApi` | A4 (`src/stats/**`) | engine hooks + sampling |
 *
 * ## Allocation discipline
 *
 * P12 asks for 2×10⁶ organism-ticks/s, so anything called once per organism per
 * tick takes an out-parameter or a sink instead of returning a fresh object.
 * Things called once per birth or once per sample may allocate. Where a method
 * returns typed arrays, the implementation is allowed to hand back views into
 * an internal scratch buffer that the next call invalidates — the caller must
 * copy immediately, and each such method says so.
 */

import type { SimEvent } from './events';
import type { CladeArchetype, DiscreteLocusId, Genome, QuantLocusId } from './genome';
import type { MutationRecord } from './events';
import type { OrganismDump, SampleSlice, SimCommand } from './protocol';
import type { AncestryRecord, PhylogenyNode, SampleRow } from './stats';
import type { TraitKey } from './traits';
import type {
  DeathCause,
  DemeId,
  OrganismId,
  RandomSource,
  SimConfig,
  SimConfigOverrides,
  SimSnapshot,
  SimState,
  SlotIndex,
  SpeciesTag,
} from './types';

// ---------------------------------------------------------------------------
// Genetics (WP-A1)
// ---------------------------------------------------------------------------

/** What the phenotype step needs to know about the world at the moment of birth. */
export interface PhenotypeContext {
  /**
   * Standardised local temperature anomaly at the birth position. Drives the
   * spatial environment-of-birth effect: for `config.genetics.gxeTraits` the
   * latent value is shifted **additively** by `gxeSensitivity · z` (see
   * `GeneticsConfig.gxeTraits` — the multiplicative form was Gate A-1
   * defect 1). Pass 0 when `toggles.enableSpatialGxE` is off.
   */
  readonly localTemperatureAnomalyZ: number;
  /** The mother's expressed archetype; the engine compares it against the result to detect a clade founding. */
  readonly parentArchetype: CladeArchetype;
}

/**
 * Output of the once-per-birth phenotype computation.
 *
 * All three arrays are `TRAIT_COUNT` long and indexed by `TRAIT_INDEX[key]`.
 * They may be scratch views invalidated by the next `computePhenotype` call —
 * the engine copies them straight into the pool columns.
 */
export interface PhenotypeResult {
  /** Expressed traits, post-link. Goes to `pools.traits`. */
  readonly traits: Float32Array;
  /** Latent traits, pre-link. Goes to `pools.traitsLatent`. */
  readonly traitsLatent: Float32Array;
  /**
   * Pure genotypic contribution per trait, with the environmental deviation and
   * the clade baseline shift excluded. This is what A4's additive-variance
   * estimator consumes; without it V_A cannot be separated from V_E.
   */
  readonly genotypicValues: Float32Array;
  /**
   * The body plan this genome expresses. Note that the **`cladeId` is allocated
   * by the engine**, not here: a founding is "archetype differs from the
   * mother's", and only the engine owns `nextCladeId`.
   */
  readonly archetype: CladeArchetype;
}

/** Result of one meiosis. `mutations` feeds the `birth` event payload. */
export interface MeiosisResult {
  readonly genome: Genome;
  /** Empty in the overwhelming majority of births. May be a scratch array; copy if retained. */
  readonly mutations: readonly MutationRecord[];
  /** True when a clade macro-locus mutated, whether or not the archetype changed. */
  readonly macroMutated: boolean;
}

export interface GeneticsApi {
  /**
   * A founder genome. Alleles are drawn from N(0, `founderSd · founderSdScale`)
   * — the same family mutation feeds. There is no zero-effect "null" allele:
   * that is what collapsed herdloom's founder variance.
   */
  buildFounderGenome(rng: RandomSource, config: SimConfig, sex?: 'female' | 'male'): Genome;

  /** Meiosis (Poisson crossovers on the cM map) plus mutation, in one step. */
  makeOffspringGenome(rng: RandomSource, mother: Genome, father: Genome, config: SimConfig): MeiosisResult;

  /**
   * Genotype → phenotype, computed **once at birth**. The tick loop reads the
   * cached pool columns and never a genome.
   */
  computePhenotype(
    genome: Genome,
    rng: RandomSource,
    config: SimConfig,
    context: PhenotypeContext,
  ): PhenotypeResult;

  /**
   * Apply an external allele edit, for the `introduceMutant` command and P10's
   * sweep injection. Returns a new genome; the input is not modified.
   */
  applyAlleleEdit(
    genome: Genome,
    locus: QuantLocusId | DiscreteLocusId,
    value: number,
    config: SimConfig,
  ): Genome;
}

// ---------------------------------------------------------------------------
// Spatial index (WP-A2)
// ---------------------------------------------------------------------------

/**
 * Uniform-grid neighbour lookup.
 *
 * `queryNeighbors` writes into a caller-owned buffer rather than returning an
 * array, because it runs several times per organism per tick. Results **must be
 * in ascending slot order** — an unsorted neighbour list is the classic
 * determinism leak, since grid bucket order depends on insertion history.
 */
export interface SpatialIndex {
  /** Rebuild from the live pools. Called once per tick, after movement. */
  build(state: SimState): void;

  /**
   * Slots within `radiusWu` of (x, y), written to `out` in ascending order.
   * Returns the count written, capped at `out.length`.
   */
  queryNeighbors(x: number, y: number, radiusWu: number, out: Int32Array): number;

  /** Largest radius `build` prepared for; querying beyond it may miss neighbours. */
  readonly maxQueryRadiusWu: number;
}

// ---------------------------------------------------------------------------
// Ecology (WP-A2)
// ---------------------------------------------------------------------------

/**
 * A behaviour decision, written into a caller-owned scratch object. Policies are
 * fixed (flee / pursue / forage / gradient-climb / seek-mate / wander); their
 * parameters (`wariness`, `forageBoldness`, `givingUpTime`) are genetic, which
 * is how behaviour evolves without evolving a network.
 */
export interface BehaviorDecision {
  /** One of the `BEHAVIOR_*` constants in `types.ts`. */
  mode: number;
  /** Unit-ish steering direction. The engine applies `speedFraction * speedCap`. */
  steerX: number;
  steerY: number;
  /** Fraction of `speedCap` to swim at, 0..1. Squared into the metabolic cost. */
  speedFraction: number;
  /** Prey/threat/courtship target, or `NO_SLOT`. */
  targetSlot: SlotIndex;
}

/** Sink for predation outcomes. The engine drains it in insertion order. */
export interface KillSink {
  push(predatorSlot: SlotIndex, victimSlot: SlotIndex, energyYield: number): void;
}

/** Sink for deaths. `killerSlot` is `NO_SLOT` for everything but predation. */
export interface DeathSink {
  push(slot: SlotIndex, cause: DeathCause, killerSlot: SlotIndex): void;
}

/**
 * Ecology stage functions, listed in the order the engine calls them. Each
 * per-organism stage takes a slot and touches only that organism's columns plus
 * read-only neighbour/field data, so the engine can iterate slots in ascending
 * order and stay deterministic.
 */
export interface EcologyApi {
  /**
   * Seed reefs, kelp and the initial resource field. Called once at init.
   * Must be a pure function of `(state.config, rng)` — no module-level state —
   * so a restore can rebuild the derived fields a snapshot does not carry.
   */
  initFields(state: SimState, rng: RandomSource): void;

  /** Advance temperature: latitudinal gradient, season, OU climate walk. Whole-field, once per tick. */
  updateFields(state: SimState, rng: RandomSource): void;

  /** Logistic plankton regrowth toward K, plus kelp growth. Whole-field, once per tick. */
  regrowResources(state: SimState): void;

  /** Choose a policy and a heading for one organism. Staggered by `time.decisionStaggerTicks`. */
  decideBehavior(
    state: SimState,
    slot: SlotIndex,
    spatial: SpatialIndex,
    rng: RandomSource,
    out: BehaviorDecision,
  ): void;

  /** Grazing and scavenging intake for one organism. Returns energy gained and debits the field cell. */
  applyFeeding(state: SimState, slot: SlotIndex, rng: RandomSource): number;

  /** Predation attempts by one organism. Pushes successful kills; does not apply them. */
  tryPredation(state: SimState, slot: SlotIndex, spatial: SpatialIndex, rng: RandomSource, kills: KillSink): void;

  /**
   * Burn metabolism and roll the non-predation hazards (starvation, thermal,
   * senescence) for one organism. Pushes any resulting death.
   */
  metabolismAndHazards(state: SimState, slot: SlotIndex, rng: RandomSource, deaths: DeathSink): void;

  /** Local temperature at a position, °C — needed by the phenotype step for GxE. */
  temperatureAt(state: SimState, x: number, y: number): number;

  /** Standardised temperature anomaly at a position, for `PhenotypeContext`. */
  temperatureAnomalyZAt(state: SimState, x: number, y: number): number;

  /** Kelp cover at a position, 0..1 — the predation kernel's refuge term. */
  kelpCoverAt(state: SimState, x: number, y: number): number;

  /**
   * Local frequency of the victim's hue morph, 0..1, for frequency-dependent
   * predation. Returns `1 / hueBinCount` (the neutral value) when
   * `toggles.enableFrequencyDependentPredation` is off.
   */
  hueMorphFrequencyAt(state: SimState, x: number, y: number, hueDeg: number): number;

  /** Apply a barrier command to the mask. Called from the command path, not the tick loop. */
  rebuildBarrierMask(state: SimState): void;
}

// ---------------------------------------------------------------------------
// Mating (WP-A3)
// ---------------------------------------------------------------------------

export interface MatingApi {
  /**
   * A ready female surveys nearby males and picks one, or returns `NO_SLOT`.
   *
   * Acceptance weight is a Gaussian on the hue difference between his
   * `displayHue` and her `prefTarget`, with width set by her `choosiness`,
   * multiplied by his condition. Both the preference and the display are
   * genetic and genetically correlated (locus q38), which is what makes
   * assortative mating a speciation route rather than decoration.
   */
  findMate(state: SimState, femaleSlot: SlotIndex, spatial: SpatialIndex, rng: RandomSource): SlotIndex;

  /** The acceptance weight itself, exposed so probes can measure cross-side mate acceptance for P8. */
  acceptanceWeight(state: SimState, femaleSlot: SlotIndex, maleSlot: SlotIndex): number;
}

// ---------------------------------------------------------------------------
// Stats (WP-A4)
// ---------------------------------------------------------------------------

/** Outcome of one species-detector pass. The engine turns `splits` into `speciesSplit` events. */
export interface SpeciesDetectionResult {
  /** New species tag per slot, indexed by slot; `-1` for free slots. */
  readonly assignments: Int32Array;
  readonly splits: readonly {
    readonly parentTag: SpeciesTag;
    readonly childTags: readonly [SpeciesTag, SpeciesTag];
    readonly crossMatingRate: number;
    readonly sizes: readonly [number, number];
  }[];
  readonly extinctions: readonly SpeciesTag[];
}

/**
 * Population-genetic estimators, separated from the recorder so they can be
 * unit-tested against analytic cases (Fst on a synthetic island model, temporal
 * Ne on a Wright–Fisher simulation, h² recovery on a known-heritability
 * population) without running the sim.
 */
export interface PopgenEstimators {
  /**
   * Weir–Cockerham Fst from neutral markers only. `grouping` selects the deme
   * grid or the two sides of the active barrier; returns null when the grouping
   * does not apply — no barrier up, a rect barrier (which has no two-sides
   * partition), or too few organisms per group for a variance component (an
   * estimator-local minimum, deliberately NOT `speciation.minSpeciesSize`:
   * an Fst estimand must not move when a species-detector knob does).
   */
  fst(state: SimState, grouping: 'deme' | 'barrier'): number | null;

  /** Midparent-regression heritability over the recorded matings; null until enough pairs accumulate. */
  midparentHeritability(trait: TraitKey): number | null;

  /**
   * Temporal-method effective size from neutral allele frequencies at two time
   * points. Frequencies are indexed `[locusIndex][alleleIndex]`.
   */
  temporalNe(
    earlier: readonly (readonly number[])[],
    later: readonly (readonly number[])[],
    generationsElapsed: number,
    censusSize: number,
  ): number;

  /** Demographic Ne from sex ratio and offspring-number variance over the window. */
  demographicNe(state: SimState): number;

  /** Cluster on `speciation.clusterTraits` and check realized cross-mating against the threshold. */
  detectSpecies(state: SimState): SpeciesDetectionResult;
}

/**
 * The recorder. The engine calls the `on*` hooks at stage boundaries and
 * `sample` every `sampling.sampleIntervalTicks`.
 */
export interface StatsApi {
  readonly estimators: PopgenEstimators;

  /**
   * Per-birth hook. `traitsLatent` is the pools' latent-trait column and
   * `traitOffset` the newborn's base index into it (stride `TRAIT_COUNT`) —
   * a zero-alloc view valid ONLY for the duration of the call; copy what you
   * keep, the slot recycles. This is how the midparent regression sees
   * offspring that die young: the free list is LIFO, so a juvenile's slot is
   * gone within ticks and sample-boundary recovery selects against exactly
   * the early deaths h² must not be conditioned on (Gate A-1 defect 8).
   */
  onBirth(record: AncestryRecord, traitsLatent: Float32Array, traitOffset: number): void;
  onDeath(id: OrganismId, tick: number, cause: DeathCause): void;
  onMating(motherId: OrganismId, fatherId: OrganismId, tick: number): void;
  /** Lets the recorder maintain the phylogeny and the sweep tracker. */
  onEvent(event: SimEvent): void;

  /** Build one time-series row. Allocates; runs every 200 ticks by default. */
  sample(state: SimState, tick: number): SampleRow;

  /** Rows strictly after `sinceTick`, for the charts and the probe runner. */
  series(sinceTick: number): readonly SampleRow[];

  ancestry(id: OrganismId): AncestryRecord | undefined;
  phylogeny(): readonly PhylogenyNode[];

  /**
   * Drop ancestry records that are not living, founder, event-named, or an
   * ancestor of one of those. Called at sample boundaries so an ambient run
   * does not grow without bound.
   */
  collectAncestry(state: SimState): void;

  /** Register an allele to follow so `sweepCrossedHalf` can fire (the `trackSweep` command). */
  trackSweep(locus: DiscreteLocusId, allele: number, tick: number): void;

  /**
   * Events the stats layer itself raised since the last drain — today that is
   * `sweepCrossedHalf`, detected during `sample()`. The engine calls this right
   * after each `sample()` and merges the result into that tick's returned
   * events. Stats has already recorded them internally; the engine must NOT
   * feed them back through `onEvent`.
   */
  drainRaisedEvents(): readonly SimEvent[];
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** The injected implementations. A5 builds this from the real modules; A3 tests against stubs. */
export interface SimModules {
  readonly genetics: GeneticsApi;
  readonly ecology: EcologyApi;
  readonly spatial: SpatialIndex;
  readonly mating: MatingApi;
  readonly stats: StatsApi;
}

/** Keys of `SimModules`, for wiring checks and error messages. */
export const SIM_MODULE_NAMES = ['genetics', 'ecology', 'spatial', 'mating', 'stats'] as const;

export interface CreateSimOptions {
  readonly seed: string;
  readonly config?: SimConfigOverrides;
  readonly modules: SimModules;
  /** Restore instead of generating founders. */
  readonly snapshot?: SimSnapshot;
}

/**
 * What the engine returns. The worker shell (A6) and the probe runner (A5) both
 * drive the sim exclusively through this; neither reaches into `SimState`
 * except through `state` for read-only assertions in tests.
 */
export interface SimHandle {
  readonly state: SimState;

  /** Advance `ticks` ticks. Returns the events raised, in tick order. */
  step(ticks: number): readonly SimEvent[];

  /** Order-independent hash of the whole world. P1 compares it every 1000 ticks. */
  stateHash(): string;

  snapshot(): SimSnapshot;

  /** Render feed. `recycle` may be reused if it is the right length. */
  sampleSlice(maxOrganisms?: number, recycle?: Float32Array, traitKey?: TraitKey): SampleSlice;

  select(x: number, y: number, radiusWu: number): OrganismDump | null;

  /** God tools and probe perturbations. Recorded as `SimEvent`s. */
  command(command: SimCommand): void;

  series(sinceTick: number): readonly SampleRow[];
  phylogeny(): readonly PhylogenyNode[];

  /** Deme of a position, for probe scenarios that partition the world. */
  demeOf(x: number, y: number): DemeId;
}

/** The engine's entry point (WP-A3, wired by WP-A5). */
export type CreateSim = (options: CreateSimOptions) => SimHandle;
