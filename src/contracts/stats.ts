/**
 * Measurement schemas — FROZEN CONTRACT (see CLAUDE.md).
 *
 * These three shapes are the project's evidence base: `SampleRow` is the
 * time series every probe reads, `AncestryRecord` is the pedigree, and
 * `ProbeReport` is what "done" looks like. If a claim about the simulation
 * cannot be phrased as an assertion over these, it is not a claim the project
 * makes.
 */

import type { DiscreteLocusId } from './genome';
import type { CladeArchetype } from './genome';
import type { TraitKey } from './traits';
import type { CladeId, DeathCause, DemeId, OrganismId, SpeciesTag } from './types';

// ---------------------------------------------------------------------------
// Time series
// ---------------------------------------------------------------------------

/** Per-trait summary in one sample row. All quantities are on the **latent** scale. */
export interface TraitSample {
  readonly mean: number;
  readonly sd: number;
  /**
   * Additive genetic variance V_A, estimated from the genotypic values the
   * phenotype step already computed (not regressed). P4 compares this between
   * generation windows; it is the single number that says whether evolution is
   * still possible.
   */
  readonly additiveVariance: number;
  /** Total phenotypic variance, V_P. */
  readonly phenotypicVariance: number;
  /** V_A / V_P. P13 cross-checks this against a midparent regression. */
  readonly heritability: number;
}

export interface GroupCount {
  readonly tag: number;
  readonly count: number;
}

/**
 * One row of the time series, written every `sampling.sampleIntervalTicks`
 * (200 by default). Arrays are sorted by tag/index so two runs of the same seed
 * produce byte-identical rows.
 */
export interface SampleRow {
  readonly tick: number;
  /** `tick / generationTicks`; every probe threshold is written in these units. */
  readonly generation: number;

  readonly population: number;
  /** Sorted ascending by species tag. */
  readonly populationBySpecies: readonly GroupCount[];
  /** Sorted ascending by clade id. */
  readonly populationByClade: readonly GroupCount[];
  /** Indexed by `DemeId`, length `demeCols * demeRows`. */
  readonly populationByDeme: readonly number[];
  /** Indexed by position in `CLADE_ARCHETYPES`. */
  readonly populationByArchetype: readonly number[];

  /** Every trait, not only the focal four — a probe that only ever looks where it expects trouble finds none. */
  readonly traits: Readonly<Record<TraitKey, TraitSample>>;

  /** Per discrete locus, allele frequencies indexed by allele, length `alleleCount`. */
  readonly discreteAlleleFreq: Readonly<Record<DiscreteLocusId, readonly number[]>>;
  /** Fraction of quantitative loci whose allelic variance is still above the P6 floor. */
  readonly quantLociWithVariance: number;

  /** Deaths since the previous row, by channel. P7 reads this. */
  readonly deaths: Readonly<Record<DeathCause, number>>;
  readonly matings: number;
  readonly crossSpeciesMatings: number;
  /** Pearson correlation of latent `diet` between mated pairs over the window. The magic trait's assortment signal. */
  readonly assortmentIndex: number;
  /** Circular correlation of `displayHue` between mated pairs over the window. */
  readonly hueAssortment: number;

  readonly resources: ResourceSample;
  readonly popgen: PopgenSample;
  /** Fraction of the population above/below the diet midpoint; P9 needs both guilds to persist. */
  readonly guilds: GuildSample;
}

export interface ResourceSample {
  readonly planktonTotal: number;
  readonly kelpTotal: number;
  /** Area-weighted mean water temperature, °C. */
  readonly meanTemperatureC: number;
  /** Current OU offset from the latitudinal baseline. */
  readonly climateOffsetC: number;
}

export interface PopgenSample {
  /** Effective size from the demographic formula (sex ratio and offspring variance). */
  readonly neDemographic: number;
  /** Effective size from allele-frequency change at neutral markers between rows. P14 reads this. */
  readonly neTemporal: number;
  /** Weir–Cockerham Fst across the deme grid, from neutral markers only. */
  readonly fstDemes: number;
  /** Fst between the two sides of the active barrier, or null when no barrier is up. P8 reads this. */
  readonly fstBarrier: number | null;
  /** Mean expected heterozygosity at neutral markers. */
  readonly meanHeterozygosity: number;
  /** Midparent-regression heritability of `size` over the window; null before enough matings accumulate. */
  readonly midparentH2Size: number | null;
}

export interface GuildSample {
  /** Fraction with expressed `diet` > 0.5. */
  readonly predatorFraction: number;
  readonly filtererFraction: number;
  /** Mean latent `attack` and `defense`; P9 needs both to move. */
  readonly meanAttack: number;
  readonly meanDefense: number;
}

// ---------------------------------------------------------------------------
// Ancestry
// ---------------------------------------------------------------------------

/**
 * One pedigree entry. Retained under refcount GC: an organism's record is kept
 * while it is alive, while it is a founder, while it is named by a retained
 * event, or while it is an ancestor of anything else retained. Everything else
 * is dropped, so an ambient run does not grow without bound.
 */
export interface AncestryRecord {
  readonly id: OrganismId;
  /** `NO_ORGANISM` for founders. */
  readonly motherId: OrganismId;
  readonly fatherId: OrganismId;
  readonly birthTick: number;
  /** null while alive. */
  readonly deathTick: number | null;
  readonly deathCause: DeathCause | null;
  readonly birthX: number;
  readonly birthY: number;
  readonly speciesTag: SpeciesTag;
  readonly cladeId: CladeId;
}

/**
 * A node of the **true** phylogeny, built from `speciesSplit` events rather
 * than reconstructed from present-day distances. Having the real tree to
 * compare against is the point of recording splits as events.
 */
export interface PhylogenyNode {
  readonly tag: SpeciesTag;
  /** null for the root lineage. */
  readonly parentTag: SpeciesTag | null;
  readonly birthTick: number;
  readonly extinctTick: number | null;
  readonly peakPopulation: number;
  readonly cladeId: CladeId;
  readonly archetype: CladeArchetype;
  /** Deterministic name from tag + founding tick; see WP-B7. */
  readonly label: string;
}

/** Where a lineage lived, for the barrier and divergence probes. */
export interface LineageOccupancy {
  readonly tag: SpeciesTag;
  readonly byDeme: readonly number[];
  readonly dominantDeme: DemeId;
}

// ---------------------------------------------------------------------------
// Probe reports
// ---------------------------------------------------------------------------

export type ProbeStatus = 'pass' | 'warn' | 'fail';

/**
 * `gate` probes fail the suite. `warn` probes report and go yellow but exit 0 —
 * used for behaviour that is desired but not yet demonstrated (P11 speciation
 * until WP-A7 hardens it).
 */
export type ProbeSeverity = 'gate' | 'warn';

export interface ProbeThreshold {
  readonly min?: number;
  readonly max?: number;
  /** Human-readable form for the report table, e.g. `V_A ratio ∈ [0.25, 8]`. */
  readonly label: string;
}

export interface ProbeReport {
  /** `P1`…`P14`, matching the plan's probe table. */
  readonly probeId: string;
  readonly name: string;
  /** Scenario the run used, e.g. `baseline`, `barrier`, `sweep`. */
  readonly scenario: string;
  readonly seed: string;
  /** The measured quantity the threshold applies to. NaN when the probe could not be evaluated. */
  readonly value: number;
  readonly threshold: ProbeThreshold;
  readonly status: ProbeStatus;
  readonly severity: ProbeSeverity;
  readonly generationsRun: number;
  /** One line for the table when the number alone is not the story. */
  readonly detail?: string;
  /** Extra series the probe wants written to JSONL for eyeballing. */
  readonly series?: Readonly<Record<string, readonly number[]>>;
}

export interface ProbeSuiteReport {
  readonly suite: 'quick' | 'full' | 'custom';
  readonly startedAtTick: 0;
  readonly seeds: readonly string[];
  readonly reports: readonly ProbeReport[];
  /** `fail` if any `gate` probe failed; `warn` if only warn-severity probes did. */
  readonly status: ProbeStatus;
  /** Wall-clock duration, measured in the one file allowed to read a clock (`src/probes/timing.ts`). */
  readonly durationMs: number;
}

/** One line of the JSONL series file a probe run writes to `runs/`. */
export interface ProbeSeriesLine {
  readonly scenario: string;
  readonly seed: string;
  readonly row: SampleRow;
}
