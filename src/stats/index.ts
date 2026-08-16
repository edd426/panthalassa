/**
 * WP-A4 — measurement.
 *
 * The recorder, the pedigree, the popgen estimators and the species detector.
 * The engine sees only `StatsApi` (`src/contracts/apis.ts`); everything else
 * exported here is for the probe runner, the unit tests and the Phase B panels.
 *
 * ```ts
 * const stats = createStats({ config });
 * const sim = createSim({ seed, config, modules: { ...others, stats } });
 * ```
 *
 * Two obligations on the engine side, both documented on the methods: call
 * `drainRaisedEvents()` immediately after each `sample()` and merge the result
 * into that tick's events without feeding them back through `onEvent`, and
 * expect `sample()` to zero `deathCounts`, `matingCount` and
 * `crossSpeciesMatingCount` as `types.ts` specifies.
 */

export { createStats } from './factory';
export { StatsRecorder } from './recorder';
export type { StatsOptions, StatsRecorderApi } from './recorder';

export {
  BIOMASS_COLUMN,
  DEME_TRAIT_KEYS,
  DetectionAccumulator,
  LENGTH_MEAN_COLUMN,
  LENGTH_SD_COLUMN,
  detectionArms,
  hueBinOf,
  toxicBinFloor,
} from './detection';
export type { DetectionArms } from './detection';

export { AncestryStore, PhylogenyStore, speciesLabel } from './ancestry';
export type { AncestryTotals, LineageSummary, SpeciesObservation } from './ancestry';

export {
  MIDPARENT_WINDOW_PAIRS,
  MIN_DEME_ORGANISMS,
  MIN_MIDPARENT_PAIRS,
  MidparentRegressions,
  PopgenEngine,
  combineSexNe,
  discreteAlleleFrequencies,
  meanExpectedHeterozygosity,
  neiTajimaF,
  neutralAlleleFrequencies,
  sexRatioNe,
  temporalNeFromF,
  varianceNeGeneral,
  varianceNeStationary,
  weirCockerhamFst,
} from './popgen';
export type { BreederSource, GroupLocusCounts } from './popgen';

export { MIN_INFORMATIVE_MATINGS, NEUTRAL_MARKER_FEATURE_WEIGHT, SpeciesDetector } from './species';
export type { CrossMatingEvidence } from './species';

export {
  BirthLog,
  GrowableColumn,
  MatingLog,
  TraitCache,
  Welford,
  circularCorrelation,
  circularMean,
  forEachLiveSlot,
  pearson,
  regressionSlope,
} from './shared';
