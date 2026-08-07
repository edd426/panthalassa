/**
 * Core sim types and the tuning surface — FROZEN CONTRACT (see CLAUDE.md).
 */

import type { SimEvent } from './events';
import type { CladeArchetype, Genome, Karyotype } from './genome';
import { CLADE_ARCHETYPES } from './genome';
import type { TraitKey } from './traits';
import { TRAIT_COUNT } from './traits';

// ---------------------------------------------------------------------------
// Identity and primitives
// ---------------------------------------------------------------------------

/**
 * A stable, globally unique organism identity. Monotonically increasing and
 * **never reused**.
 *
 * Do not confuse this with a slot index: slots ARE reused the moment an
 * organism dies, so anything that outlives an organism (ancestry records,
 * event payloads, the UI selection, pedigrees) must hold an `OrganismId`, and
 * anything inside a single tick may hold a slot. Mixing them up produces
 * pedigrees that silently point at the wrong animal.
 */
export type OrganismId = number;

/** Index into the SoA pools, `0..capacity-1`. Valid only while `alive[slot] === 1`. */
export type SlotIndex = number;

/** Sentinel for "no organism" in id columns and event payloads. */
export const NO_ORGANISM: OrganismId = 0;

/** Sentinel for "no slot" in target columns and sink arguments. */
export const NO_SLOT: SlotIndex = -1;

/** Index into the deme grid used for Fst; row-major, `demeRow * demeCols + demeCol`. */
export type DemeId = number;

/** Species identity assigned by the detector in `src/stats/species.ts`. */
export type SpeciesTag = number;

/** Body-plan lineage identity, assigned when a macro-mutation founds a clade. */
export type CladeId = number;

export interface Vec2 {
  x: number;
  y: number;
}

export type Sex = 'female' | 'male';

/** Sex is stored as a byte in the pools. */
export const SEX_FEMALE = 0;
export const SEX_MALE = 1;

export function sexFromCode(code: number): Sex {
  return code === SEX_MALE ? 'male' : 'female';
}

export function sexToCode(sex: Sex): number {
  return sex === 'male' ? SEX_MALE : SEX_FEMALE;
}

export function karyotypeToSex(karyotype: Karyotype): Sex {
  return karyotype === 'XY' ? 'male' : 'female';
}

/**
 * The four independent mortality channels. Herdloom had exactly one (old age)
 * and therefore no natural selection at all; probe P7 requires every channel
 * here to carry between 5% and 70% of deaths.
 */
export type DeathCause = 'starvation' | 'predation' | 'temperature' | 'senescence';

export const DEATH_CAUSES = ['starvation', 'predation', 'temperature', 'senescence'] as const satisfies readonly DeathCause[];

/** xoshiro128** state; see `src/sim/rng.ts`. Declared here so contracts stay dependency-free. */
export type RngState = [number, number, number, number];

/**
 * The randomness every sim module is allowed to use.
 *
 * Declared structurally rather than importing `SeededRng`, so that contracts
 * depend on nothing and modules depend only on contracts. `SeededRng` satisfies
 * this interface; `src/sim/rng.test.ts` asserts that it still does.
 *
 * There is no other source of randomness in `src/sim`, `src/stats` or
 * `src/probes` — ESLint enforces it.
 */
export interface RandomSource {
  /** Uniform on [0, 1). */
  next(): number;
  int(min: number, maxInclusive: number): number;
  chance(probability: number): boolean;
  pick<T>(values: readonly T[]): T;
  normal(mean?: number, standardDeviation?: number): number;
  poisson(lambda: number): number;
  /** The fat tail of the mutation kernel. */
  laplace(mean?: number, scale?: number): number;
  /** A labelled sub-stream that does not consume this stream's entropy. */
  fork(label: string): RandomSource;
  getState(): RngState;
  setState(state: RngState): void;
}

// ---------------------------------------------------------------------------
// Structure-of-arrays organism pools
// ---------------------------------------------------------------------------

/**
 * Behaviour policy the organism is currently running. Stored as a byte.
 * Parameters of these policies (`wariness`, `forageBoldness`, `givingUpTime`)
 * are genetic traits, so behaviour evolves even though the policy set is fixed.
 */
export const BEHAVIOR_WANDER = 0;
export const BEHAVIOR_FORAGE = 1;
export const BEHAVIOR_FLEE = 2;
export const BEHAVIOR_PURSUE = 3;
export const BEHAVIOR_SEEK_MATE = 4;
export const BEHAVIOR_CLIMB_GRADIENT = 5;

/**
 * Hot columns. Every array has length `capacity` except the trait arrays,
 * which are `capacity * TRAIT_COUNT`.
 *
 * Iteration rule (determinism): always walk slots `0..capacity-1` in ascending
 * order and skip `alive[slot] === 0`. Never iterate a `Set`, a `Map`, or an
 * array of "active slots" whose order depends on death history.
 *
 * WP-A3 owns the construction of this and may add further columns; it may not
 * remove or repurpose the ones declared here.
 */
export interface OrganismPools {
  readonly capacity: number;

  /** 1 = slot holds a living organism, 0 = free. */
  readonly alive: Uint8Array;
  /** `OrganismId`; Float64 because ids outrun Int32 over a long ambient run. */
  readonly id: Float64Array;
  readonly motherId: Float64Array;
  readonly fatherId: Float64Array;

  /** `SEX_FEMALE` / `SEX_MALE`. */
  readonly sex: Uint8Array;
  /** Index into `CLADE_ARCHETYPES`. */
  readonly archetype: Uint8Array;
  readonly cladeId: Int32Array;
  readonly speciesTag: Int32Array;
  readonly demeId: Int32Array;

  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;

  /** Stored energy. Zero means starvation death at the next mortality stage. */
  readonly energy: Float32Array;
  /** Gut contents, for the type-II satiation term. */
  readonly gutFill: Float32Array;
  readonly birthTick: Float64Array;
  readonly ageTicks: Uint32Array;
  readonly lastMatingTick: Float64Array;

  /** One of the `BEHAVIOR_*` constants. */
  readonly behaviorState: Uint8Array;
  /** Ticks spent in the current behaviour; compared against `givingUpTime`. */
  readonly behaviorTimer: Uint16Array;
  /** Slot of the current prey/threat/courtship target, or −1. Valid within a tick only. */
  readonly targetSlot: Int32Array;

  /**
   * Expressed traits, `slot * TRAIT_COUNT + TRAIT_INDEX[key]`. Written once at
   * birth; the tick loop reads this and never the genome.
   */
  readonly traits: Float32Array;
  /**
   * Latent (pre-link) traits, same layout. Written once at birth. Popgen
   * statistics use this scale so that a softplus floor cannot masquerade as
   * lost additive variance.
   */
  readonly traitsLatent: Float32Array;
  /**
   * Pure genotypic contribution per trait (`PhenotypeResult.genotypicValues`),
   * same layout as `traits`. Written once at birth by the engine. This is what
   * the additive-variance estimator consumes; without it V_A cannot be
   * separated from V_E.
   */
  readonly traitsGenotypic: Float32Array;

  /** Cold storage, immutable once written; `undefined` for free slots. */
  readonly genomes: (Genome | undefined)[];
}

/** Byte length of one organism's slice of a packed trait array. */
export const TRAIT_STRIDE = TRAIT_COUNT;

// ---------------------------------------------------------------------------
// Environment state
// ---------------------------------------------------------------------------

export interface ResourceField {
  readonly cols: number;
  readonly rows: number;
  readonly cellSizeWu: number;
  /** Plankton biomass per cell; logistic growth toward `carryingCapacity`. */
  readonly plankton: Float32Array;
  /** Kelp cover per cell in [0,1]; grows near reefs and shelters prey. */
  readonly kelp: Float32Array;
  /** Per-cell K, recomputed when the climate moves. */
  readonly carryingCapacity: Float32Array;
  /**
   * Per-cell water temperature, °C, written by ecology's `updateFields` every
   * tick (gradient + season + OU walk). Consumers — the recorder's
   * `meanTemperatureC`, renderer overlays, organism dumps — read it and never
   * write. Single source of truth for temperature outside `temperatureAt`.
   */
  readonly temperature: Float32Array;
}

/**
 * The climate. The OU red-noise walk on `meanOffsetC` is a standing variance
 * pump: it keeps moving the thermal optimum on a timescale (≈40 generations)
 * long enough for the population to track it and short enough that it never
 * finishes adapting. Toggle with `toggles.enableClimateWalk`.
 */
export interface ClimateState {
  /** OU state: global offset from the latitudinal baseline, °C. */
  meanOffsetC: number;
  /** OU mean-reversion target; god tools retarget this. */
  targetOffsetC: number;
  /** Seasonal phase, ticks. */
  seasonPhaseTicks: number;
}

export type BarrierShape =
  | { readonly kind: 'verticalRidge'; readonly xWu: number; readonly thicknessWu: number }
  | { readonly kind: 'horizontalRidge'; readonly yWu: number; readonly thicknessWu: number }
  | { readonly kind: 'rect'; readonly xWu: number; readonly yWu: number; readonly widthWu: number; readonly heightWu: number };

export interface BarrierSpec {
  readonly id: string;
  readonly shape: BarrierShape;
  /** 0 = impassable land, 1 = open water. P8 raises a ridge at permeability 0. */
  readonly permeability: number;
  /** Tick the barrier came into existence, for the event log. */
  readonly raisedTick: number;
}

export interface BarrierState {
  readonly cols: number;
  readonly rows: number;
  readonly cellSizeWu: number;
  /** Per-cell permeability × 255; 0 = impassable. */
  readonly mask: Uint8Array;
  readonly specs: BarrierSpec[];
}

// ---------------------------------------------------------------------------
// SimState
// ---------------------------------------------------------------------------

/**
 * The whole world. A pure function of `(config, seed)`: given the same pair,
 * every field here is bit-identical at every tick on every machine. That is
 * what P1 asserts and what the ambient-entropy and clock ban protects.
 */
export interface SimState {
  readonly config: SimConfig;
  readonly seed: string;

  tick: number;
  /** Serialised RNG state; the engine holds the live `SeededRng`. */
  rngState: RngState;

  /** Next id to hand out. Never decreases, never reuses. */
  nextOrganismId: OrganismId;
  nextSpeciesTag: SpeciesTag;
  nextCladeId: CladeId;

  liveCount: number;
  readonly pop: OrganismPools;
  readonly field: ResourceField;
  readonly climate: ClimateState;
  readonly barriers: BarrierState;

  /** Events raised during the current tick; drained at the tick boundary. */
  events: SimEvent[];
  /** Death tally since the last sample row, reset by the recorder. */
  deathCounts: Record<DeathCause, number>;
  /** Successful matings since the last sample row. */
  matingCount: number;
  /** Matings whose partners carried different species tags. */
  crossSpeciesMatingCount: number;
}

/**
 * A snapshot that round-trips exactly.
 *
 * **Slot layout is preserved verbatim, dead slots included, along with the
 * free list.** Compacting to live organisms would renumber slots, which
 * changes iteration order, which changes the trajectory — P1's
 * snapshot→restore→continue assertion would fail for a reason that has nothing
 * to do with a real bug. WP-A3 owns the serialiser; `formatVersion` gates any
 * later change.
 */
export interface SimSnapshot {
  readonly formatVersion: number;
  readonly seed: string;
  readonly configOverrides: SimConfigOverrides;
  readonly tick: number;
  readonly rngState: RngState;
  readonly nextOrganismId: OrganismId;
  readonly nextSpeciesTag: SpeciesTag;
  readonly nextCladeId: CladeId;
  readonly liveCount: number;
  readonly capacity: number;
  /** Free slots, in the exact order the allocator will hand them back out. */
  readonly freeSlots: readonly SlotIndex[];
  /** Pool columns, full capacity, keyed by the `OrganismPools` field names. */
  readonly columns: Readonly<Record<string, ArrayBufferView>>;
  /** Length `capacity`; `null` for free slots. */
  readonly genomes: readonly (SerializedGenome | null)[];
  readonly plankton: Float32Array;
  readonly kelp: Float32Array;
  readonly climate: ClimateState;
  readonly barriers: readonly BarrierSpec[];
  readonly deathCounts: Record<DeathCause, number>;
  /** `stateHash()` at the moment of capture; restore must reproduce it. */
  readonly stateHash: string;
}

export interface SerializedGenome {
  readonly quant: Float32Array;
  readonly discrete: Uint8Array;
  readonly karyotype: Karyotype;
}

/** Current snapshot format. Bump on any layout change. */
export const SNAPSHOT_FORMAT_VERSION = 1;

// ---------------------------------------------------------------------------
// SimConfig — the tuning surface
// ---------------------------------------------------------------------------

export interface WorldConfig {
  /** Bounded plane, world units. */
  widthWu: number;
  heightWu: number;
  /** Hard ceiling on simultaneous organisms. Density dependence must come from resources, not from this; P3 fails if the cap binds for more than 5% of samples. */
  slotCapacity: number;
  initialPopulation: number;
  /** Uniform spatial-hash cell size; should exceed the largest interaction radius. */
  spatialCellSizeWu: number;
  /** Resource/temperature field cell size. */
  fieldCellSizeWu: number;
  /** Deme grid for Fst and spatial structure. */
  demeCols: number;
  demeRows: number;
  /** Hedge against predator–prey crashes; 0 = off (default). Organisms per generation entering at the world edge. */
  edgeImmigrationPerGeneration: number;
}

export interface TimeConfig {
  /** Wall-clock ticks per second at 1× speed. Presentation only; the sim is tick-driven. */
  ticksPerSecond: number;
  /** Age at which an organism can mate. ~20 s of watching at 1×. */
  maturityTicks: number;
  /** Nominal generation length; every probe threshold is denominated in these. */
  generationTicks: number;
  /** Ticks between conception and birth. */
  gestationTicks: number;
  /** Organisms re-evaluate their behaviour policy every N ticks, staggered by slot so the cost is spread. */
  decisionStaggerTicks: number;
}

export interface GeneticsConfig {
  /** Expected crossovers per chromosome per meiosis. 1.0 because a chromosome is 1 Morgan. */
  crossoverLambda: number;
  /** Quantitative mutation rate, per locus per gamete. The primary anti-ceiling knob. */
  quantMutationRate: number;
  /** Discrete mutation rate, per locus per gamete. */
  discreteMutationRate: number;
  /** Clade macro-mutation rate, per birth. Founding a new body plan should be rare and memorable. */
  cladeMacroMutationRate: number;
  /** Fraction of mutation steps drawn from the Laplace fat tail instead of the Gaussian. */
  mutationFatTailFraction: number;
  /** Laplace scale as a multiple of the locus `mutSigma`. */
  mutationFatTailScaleRatio: number;
  /** Global multiplier on every locus `founderSd`. */
  founderSdScale: number;
  /** Global multiplier on every locus `mutSigma`. */
  mutationSigmaScale: number;
  /** Founder heritability target; sets the birth environmental deviation via `founderGeneticVariance`. */
  targetFounderHeritability: number;
  /** Multiplier on that deviation once derived. */
  environmentDeviationScale: number;
  /**
   * Spatial GxE: for these traits the genotypic value is scaled by
   * `1 + gxeSensitivity · z` where `z` is the standardised local temperature
   * anomaly at the birth location. Genuine genotype×environment interaction —
   * different alleles are best in different places, which is what maintains
   * variance. It is a multiplier on the *genotypic* value, never on the
   * deviation from the population mean (that was herdloom's
   * variance-shrinking bug).
   */
  gxeTraits: readonly TraitKey[];
  gxeSensitivity: number;
  /** Retunes `TRAIT_META[key].baseline` without editing the frozen trait table. */
  traitBaselineOverrides: Partial<Record<TraitKey, number>>;
}

export interface ThermalConfig {
  /** Temperature at y = 0 and y = height, °C: the latitudinal gradient. */
  northC: number;
  southC: number;
  seasonAmplitudeC: number;
  seasonPeriodTicks: number;
  /** OU correlation time of the climate walk, ticks (≈40 generations). */
  climateTauTicks: number;
  /** OU stationary SD of the global offset, °C. */
  climateSigmaC: number;
  /** Per-tick hazard coefficient on squared thermal mismatch beyond `tWidth`. */
  hazardCoef: number;
  /**
   * Specialist–generalist tax exponent κ: peak thermal performance is
   * multiplied by `(referenceWidthC / tWidth)^κ`, so a generalist pays for its
   * breadth at the peak. κ = 0 removes the tradeoff entirely and lets `tWidth`
   * run away, which is the failure mode this knob exists to prevent.
   */
  generalistTaxExponent: number;
  referenceWidthC: number;
}

export interface ResourceConfig {
  /** Logistic growth rate per tick. */
  planktonGrowthRate: number;
  planktonCarryingCapacityBase: number;
  /** How strongly K tracks the light gradient (surface/latitude). */
  lightGradientStrength: number;
  /** K falls off as a Gaussian in |localTemp − planktonOptimumC| with this width. */
  thermalSuitabilityWidthC: number;
  planktonOptimumC: number;
  /** Type-II functional response asymptote, energy per tick. */
  grazingMaxIntake: number;
  /** Type-II half-saturation biomass. */
  grazingHalfSaturation: number;
  kelpGrowthRate: number;
  kelpCoverMax: number;
  kelpReefRadiusWu: number;
  reefCount: number;
}

export interface MetabolismConfig {
  /** Baseline energy burn per tick at unit size and zero speed. */
  baseRate: number;
  /** Kleiber-ish exponent on size. */
  sizeExponent: number;
  /** Cost coefficient on speed²; the reason `speedCap` cannot run away. */
  speedCostCoef: number;
  /** Cost coefficient on armour thickness. */
  armorCostCoef: number;
  /** Extra burn per °C² of thermal mismatch. */
  thermalStressCostCoef: number;
  /** Energy an organism is born with. */
  birthEnergy: number;
  /** Storage ceiling, per cm of size. */
  maxEnergyPerSize: number;
  /** Energy a mother spends per offspring. */
  reproductionEnergyCost: number;
  /**
   * Convexity of diet efficiency, q > 1. Efficiency on each food type is
   * `share^q`, so a generalist at 0.5 does worse than either specialist —
   * disruptive selection on the diet continuum, and the strongest known
   * sympatric-speciation fuel in this model.
   */
  dietConvexity: number;
  dietSpecialistBonus: number;
}

export interface PredationConfig {
  /** Radius within which a predator may attempt a kill. */
  attemptRadiusWu: number;
  /** Intercept of the kill logit; sets the base predation pressure. */
  baseLogit: number;
  attackDefenseCoef: number;
  /** Prey/predator size ratio at peak vulnerability, and the width of that window. */
  sizeRatioOptimum: number;
  sizeRatioWidth: number;
  /** Logit gain of the size-window term at its peak. */
  sizeWindowGain: number;
  speedDiffCoef: number;
  /** Negative: kelp cover shelters prey. */
  kelpCoverCoef: number;
  /**
   * Strength of frequency-dependent (search-image) predation: the kill logit
   * is boosted for prey whose display hue falls in the commonest local bin.
   * Rare morphs are protected, which is a variance pump with teeth. Toggle
   * with `toggles.enableFrequencyDependentPredation`.
   */
  frequencyDependenceCoef: number;
  /** Hue bins used to define "commonest morph". */
  hueBinCount: number;
  /** Ticks a predator stays satiated after a kill. */
  satiationTicks: number;
  handlingTicks: number;
  /** Energy yielded per cm of prey. */
  energyPerPreySize: number;
}

export interface SenescenceConfig {
  /** Gompertz hazard = a·exp(b·(age − onset)). Calibrated so senescence takes 15–30% of deaths and never dominates (P7). */
  gompertzA: number;
  gompertzB: number;
  onsetTicks: number;
}

export interface BehaviorConfig {
  fleeSpeedMultiplier: number;
  pursueSpeedMultiplier: number;
  /** Gain on climbing the resource/temperature gradient. */
  gradientClimbGain: number;
  /** SD of the per-decision heading jitter, radians. */
  wanderTurnSd: number;
  /** Energy fraction above which an adult switches from foraging to mate-seeking. */
  matingSeekEnergyFraction: number;
  neighborScanRadiusWu: number;
}

export interface MatingConfig {
  /** Energy fraction a female needs before she will survey suitors. */
  femaleReadyEnergyFraction: number;
  surveyRadiusWu: number;
  /** Nearest-N males considered; bounded so mating cost stays linear. */
  maxSuitorsSurveyed: number;
  /** Poisson mean clutch size. */
  clutchLambda: number;
  /** Preference SD at `choosiness` = 1, degrees of hue. */
  prefSigmaBaseDeg: number;
  choosinessScale: number;
  matingCooldownTicks: number;
  /** Weight of male condition (energy) relative to display match in the acceptance weight. */
  conditionWeight: number;
}

export interface SpeciationConfig {
  /** Realized cross-mating rate below this fraction of within-group mating splits a species. */
  crossMatingThreshold: number;
  minSpeciesSize: number;
  detectorIntervalTicks: number;
  /** Traits the clustering step runs on. */
  clusterTraits: readonly TraitKey[];
}

export interface SamplingConfig {
  /** Time-series row cadence. */
  sampleIntervalTicks: number;
  /** Generations excluded from every probe window. */
  burnInGenerations: number;
  /** P1 compares `stateHash()` at this cadence. */
  stateHashIntervalTicks: number;
  /** Ancestry GC keeps living ∪ founder ∪ event ancestors plus this many generations of the rest. */
  ancestryRetentionGenerations: number;
  /**
   * A quantitative locus counts as "alive" for `quantLociWithVariance` when its
   * allelic variance exceeds this factor × (founderSd·founderSdScale)². P6's
   * dead-locus floor; A7 tunes it.
   */
  quantVarianceFloorFactor: number;
  /**
   * The temporal-Ne estimator compares neutral-marker frequencies this many
   * generations apart. Adjacent 200-tick rows are ~0.2 generations apart, where
   * Δp is pure sampling noise; the window must span real drift.
   */
  temporalNeWindowGenerations: number;
}

/**
 * Variance-maintenance mechanisms, each independently switchable.
 *
 * This is not a debug convenience: WP-A7's tuning campaign measures each
 * mechanism's *marginal* contribution by running with it off and comparing V_A
 * trajectories. A mechanism that cannot be switched off cannot be shown to be
 * doing anything.
 */
export interface MechanismToggles {
  /** Genotype×environment interaction across the spatial gradient. */
  enableSpatialGxE: boolean;
  /** Search-image predation that punishes the commonest morph. */
  enableFrequencyDependentPredation: boolean;
  /** OU red-noise walk on global temperature. */
  enableClimateWalk: boolean;
  /** All mutation: quantitative, discrete and clade macro. Off = a closed gene pool that can only lose variance. */
  enableMutation: boolean;
  /** Seasonal sinusoid on temperature. */
  enableSeasonality: boolean;
  /** Female preference. Off = males are accepted at random, killing the assortative-mating speciation route. */
  enableAssortativeMating: boolean;
}

export interface SimConfig {
  readonly world: WorldConfig;
  readonly time: TimeConfig;
  readonly genetics: GeneticsConfig;
  readonly thermal: ThermalConfig;
  readonly resources: ResourceConfig;
  readonly metabolism: MetabolismConfig;
  readonly predation: PredationConfig;
  readonly senescence: SenescenceConfig;
  readonly behavior: BehaviorConfig;
  readonly mating: MatingConfig;
  readonly speciation: SpeciationConfig;
  readonly sampling: SamplingConfig;
  readonly toggles: MechanismToggles;
}

/** Group-wise partial override, the shape `init` and probe scenarios pass around. */
export type SimConfigOverrides = { readonly [K in keyof SimConfig]?: Partial<SimConfig[K]> };

/**
 * Authored Phase A defaults. Every number here is a starting guess that WP-A7
 * is expected to move; each change gets a line in DESIGN.md's tuning log with
 * the probe numbers before and after.
 */
export const DEFAULT_SIM_CONFIG: SimConfig = Object.freeze({
  world: Object.freeze({
    widthWu: 2000,
    heightWu: 1200,
    slotCapacity: 4096,
    initialPopulation: 600,
    spatialCellSizeWu: 80,
    fieldCellSizeWu: 25,
    demeCols: 4,
    demeRows: 3,
    edgeImmigrationPerGeneration: 0,
  }),
  time: Object.freeze({
    ticksPerSecond: 30,
    maturityTicks: 600,
    generationTicks: 900,
    gestationTicks: 120,
    decisionStaggerTicks: 4,
  }),
  genetics: Object.freeze({
    crossoverLambda: 1,
    quantMutationRate: 1e-3,
    discreteMutationRate: 1e-4,
    cladeMacroMutationRate: 1e-5,
    mutationFatTailFraction: 0.1,
    mutationFatTailScaleRatio: 2.5,
    founderSdScale: 1,
    mutationSigmaScale: 1,
    targetFounderHeritability: 0.5,
    environmentDeviationScale: 1,
    gxeTraits: Object.freeze(['metabolicEff', 'speedCap', 'tWidth'] as const),
    gxeSensitivity: 0.35,
    traitBaselineOverrides: Object.freeze({}),
  }),
  thermal: Object.freeze({
    northC: 26,
    southC: 8,
    seasonAmplitudeC: 3,
    seasonPeriodTicks: 5400,
    climateTauTicks: 36_000,
    climateSigmaC: 2.5,
    hazardCoef: 0.0025,
    generalistTaxExponent: 0.35,
    referenceWidthC: 6,
  }),
  resources: Object.freeze({
    planktonGrowthRate: 0.02,
    planktonCarryingCapacityBase: 12,
    lightGradientStrength: 0.6,
    thermalSuitabilityWidthC: 9,
    planktonOptimumC: 17,
    grazingMaxIntake: 0.55,
    grazingHalfSaturation: 3,
    kelpGrowthRate: 0.004,
    kelpCoverMax: 1,
    kelpReefRadiusWu: 160,
    reefCount: 5,
  }),
  metabolism: Object.freeze({
    baseRate: 0.012,
    sizeExponent: 0.75,
    speedCostCoef: 0.03,
    armorCostCoef: 0.045,
    thermalStressCostCoef: 0.02,
    birthEnergy: 8,
    maxEnergyPerSize: 2.2,
    reproductionEnergyCost: 6,
    dietConvexity: 1.6,
    dietSpecialistBonus: 0.35,
  }),
  predation: Object.freeze({
    attemptRadiusWu: 45,
    baseLogit: -3.2,
    attackDefenseCoef: 1,
    sizeRatioOptimum: 0.55,
    sizeRatioWidth: 0.3,
    sizeWindowGain: 2,
    speedDiffCoef: 0.8,
    kelpCoverCoef: -1.6,
    frequencyDependenceCoef: 1.2,
    hueBinCount: 12,
    satiationTicks: 120,
    handlingTicks: 25,
    energyPerPreySize: 0.9,
  }),
  senescence: Object.freeze({
    gompertzA: 2.2e-5,
    gompertzB: 0.0022,
    onsetTicks: 900,
  }),
  behavior: Object.freeze({
    fleeSpeedMultiplier: 1,
    pursueSpeedMultiplier: 0.95,
    gradientClimbGain: 0.6,
    wanderTurnSd: 0.25,
    matingSeekEnergyFraction: 0.55,
    neighborScanRadiusWu: 90,
  }),
  mating: Object.freeze({
    femaleReadyEnergyFraction: 0.6,
    surveyRadiusWu: 120,
    maxSuitorsSurveyed: 8,
    clutchLambda: 3,
    prefSigmaBaseDeg: 70,
    choosinessScale: 1,
    matingCooldownTicks: 300,
    conditionWeight: 0.5,
  }),
  speciation: Object.freeze({
    crossMatingThreshold: 0.05,
    minSpeciesSize: 25,
    detectorIntervalTicks: 1800,
    clusterTraits: Object.freeze(['diet', 'displayHue', 'size', 'tOpt'] as const),
  }),
  sampling: Object.freeze({
    sampleIntervalTicks: 200,
    burnInGenerations: 30,
    stateHashIntervalTicks: 1000,
    ancestryRetentionGenerations: 12,
    quantVarianceFloorFactor: 0.05,
    temporalNeWindowGenerations: 4,
  }),
  toggles: Object.freeze({
    enableSpatialGxE: true,
    enableFrequencyDependentPredation: true,
    enableClimateWalk: true,
    enableMutation: true,
    enableSeasonality: true,
    enableAssortativeMating: true,
  }),
});

/** Merge group-wise overrides onto the defaults. Groups merge shallowly; unknown groups are ignored. */
export function resolveSimConfig(overrides: SimConfigOverrides = {}): SimConfig {
  const merged: Record<string, unknown> = {};
  for (const [group, defaults] of Object.entries(DEFAULT_SIM_CONFIG)) {
    const override = (overrides as Record<string, Record<string, unknown> | undefined>)[group];
    merged[group] = Object.freeze({ ...(defaults as Record<string, unknown>), ...(override ?? {}) });
  }
  return Object.freeze(merged) as unknown as SimConfig;
}

/** Ticks → generations, the unit every probe threshold is written in. */
export function ticksToGenerations(ticks: number, config: SimConfig): number {
  return ticks / config.time.generationTicks;
}

/** Which deme a position falls in. */
export function demeAt(x: number, y: number, config: SimConfig): DemeId {
  const { widthWu, heightWu, demeCols, demeRows } = config.world;
  const col = Math.min(demeCols - 1, Math.max(0, Math.floor((x / widthWu) * demeCols)));
  const row = Math.min(demeRows - 1, Math.max(0, Math.floor((y / heightWu) * demeRows)));
  return row * demeCols + col;
}

/** Total demes in the Fst grid. */
export function demeCount(config: SimConfig): number {
  return config.world.demeCols * config.world.demeRows;
}

/** Body-plan archetype → the byte stored in the `archetype` pool column. */
export function archetypeToCode(archetype: CladeArchetype): number {
  const index = CLADE_ARCHETYPES.indexOf(archetype);
  return index < 0 ? 0 : index;
}

/** The byte stored in the `archetype` pool column → body-plan archetype. */
export function archetypeFromCode(code: number): CladeArchetype {
  return CLADE_ARCHETYPES[code] ?? CLADE_ARCHETYPES[0];
}
