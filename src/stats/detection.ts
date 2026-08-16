/**
 * The G-wave detection accumulators: everything `SampleRow.lifeHistory`,
 * `hueBins`, `mimicryIndex` and `traitsByDeme` are built from.
 *
 * They live here rather than inside `StatsRecorder.sample` because they are
 * **arm-gated** and the recorder's hot pass is not: with both G-wave toggles
 * off none of the gated work runs, none of these fields appear on the row, and
 * the off-arm JSONL is byte-identical to the pre-wave recorder's. A missing
 * field means "not instrumented on this arm", never "measured zero" — the rule
 * `stats.ts` states for the optional shapes.
 *
 * The accumulator is allocated once per recorder and reset per sample, because
 * `sample()` already runs at 256× on the ambient path and a per-sample
 * allocation proportional to the deme grid would show up there.
 *
 * Nothing here consumes RNG and nothing reads a clock; every walk is over pool
 * slots `0..capacity-1` ascending, so two runs of a seed agree bit for bit.
 */

import type { HueBinSample, LifeHistorySample, TraitSample } from '../contracts/stats';
import { HUE_PERIOD_DEG, TRAIT_INDEX, applyTraitLink } from '../contracts/traits';
import type { TraitKey } from '../contracts/traits';
import { demeCount } from '../contracts/types';
import type { OrganismId, SimConfig, SimState } from '../contracts/types';
import { isMature } from '../sim/organisms';
import { GrowableColumn, Welford } from './shared';

/**
 * Traits `traitsByDeme` reports.
 *
 * `speciation.clusterTraits` is the authored list the species detector already
 * clusters on; the two G-wave axes ride along because a global mean over a
 * mimicry ring hides exactly the structure P18/P19 look for. Held as a module
 * constant rather than read from config so a row's column layout cannot change
 * mid-run when A7 swaps the config object.
 */
export const DEME_TRAIT_KEYS = [
  'diet',
  'displayHue',
  'size',
  'tOpt',
  'toxicity',
  'conspicuousness',
] as const satisfies readonly TraitKey[];

/** Trait-array offsets for {@link DEME_TRAIT_KEYS}, resolved once. */
const DEME_TRAIT_INDICES: readonly number[] = DEME_TRAIT_KEYS.map((key) => TRAIT_INDEX[key]);

/**
 * A hue bin counts as toxic when its mean expressed toxicity clears twice what
 * a latent-zero animal expresses.
 *
 * `toxicity` is softplus-linked with `baseline: 0`, so `applyTraitLink` at zero
 * is the floor the link itself puts under an untoxic population — and the link's
 * convexity lifts a *founding* population's mean above that (0.25–0.27 measured
 * in the G3 cliff runs against `applyTraitLink('toxicity', 0) ≈ 0.104`). Doubling
 * it puts the bar above founding noise without authoring a magic number in
 * toxin units.
 */
const TOXIC_BIN_FLOOR_FACTOR = 2;

/**
 * Recorder column names for the realised-length series.
 *
 * They are columns rather than `SampleRow` fields because `SampleRow` is frozen
 * and because the off-arm JSONL has to stay byte-identical; `column()` is the
 * recorder's own surface and is not serialised. `BIOMASS_COLUMN` is Σ realised
 * length over the living population — the quantity P3's band is stated in.
 */
export const BIOMASS_COLUMN = 'biomass.totalCm';
export const LENGTH_MEAN_COLUMN = 'length.meanCm';
export const LENGTH_SD_COLUMN = 'length.sdCm';

/** Which G-wave fields a config asks for. Read fresh from `state.config` every sample. */
export interface DetectionArms {
  readonly ontogeny: boolean;
  readonly aposematism: boolean;
  /** True when either arm is on: `traitsByDeme` is instrumentation both want. */
  readonly any: boolean;
}

export function detectionArms(config: SimConfig): DetectionArms {
  const ontogeny = config.toggles.enableOntogeny;
  const aposematism = config.toggles.enableAposematism;
  return { ontogeny, aposematism, any: ontogeny || aposematism };
}

/** `hueBinOf` as `src/sim/ecology/predation.ts` computes it, re-derived rather than imported. */
export function hueBinOf(hueDeg: number, bins: number): number {
  const wrapped = ((hueDeg % HUE_PERIOD_DEG) + HUE_PERIOD_DEG) % HUE_PERIOD_DEG;
  const bin = Math.floor((wrapped / HUE_PERIOD_DEG) * bins);
  return bin < 0 ? 0 : bin > bins - 1 ? bins - 1 : bin;
}

/** The floor a bin's mean expressed toxicity must clear to count as a toxic ring. */
export function toxicBinFloor(): number {
  return TOXIC_BIN_FLOOR_FACTOR * applyTraitLink('toxicity', 0);
}

/** Per-deme, per-trait moments on the latent scale plus the genotypic variance. */
interface DemeTraitAccumulator {
  readonly latent: Welford;
  readonly genotypic: Welford;
}

export class DetectionAccumulator {
  /** Σ realised length over the living population, cm. Always accumulated — P3's band reads it. */
  biomassTotalCm = 0;
  /** Realised length moments over the living population. Always accumulated. */
  readonly length = new Welford();

  private hueBins: number;
  private readonly demes: number;

  private hueCount: Float64Array;
  private hueToxicity: Float64Array;
  private hueConspicuousness: Float64Array;

  private readonly demeTraits: DemeTraitAccumulator[][] = [];

  /** Per-organism scratch for the median pass; grows, never shrinks. */
  private readonly toxicityBuffer = new GrowableColumn();
  private readonly binBuffer = new GrowableColumn();

  private juveniles = 0;
  private matureCount = 0;
  private matureAgeSum = 0;
  /** Age in ticks at which each living organism was **first observed** mature. */
  private maturityAges = new Map<OrganismId, number>();
  private nextMaturityAges = new Map<OrganismId, number>();
  private recruits = 0;

  constructor(config: SimConfig) {
    this.hueBins = Math.max(1, Math.floor(config.predation.hueBinCount));
    this.demes = demeCount(config);
    this.hueCount = new Float64Array(this.hueBins);
    this.hueToxicity = new Float64Array(this.hueBins);
    this.hueConspicuousness = new Float64Array(this.hueBins);
    for (let deme = 0; deme < this.demes; deme += 1) {
      this.demeTraits.push(DEME_TRAIT_KEYS.map(() => ({ latent: new Welford(), genotypic: new Welford() })));
    }
  }

  /**
   * Start a sample.
   *
   * `hueBinCount` is re-read here rather than cached from the constructor's
   * config: `setToggle` and A7's tuning tools swap the config object mid-run,
   * and a stale bin count would silently re-scale the mimicry read.
   */
  begin(config: SimConfig): void {
    const bins = Math.max(1, Math.floor(config.predation.hueBinCount));
    if (bins !== this.hueBins) {
      this.hueBins = bins;
      this.hueCount = new Float64Array(bins);
      this.hueToxicity = new Float64Array(bins);
      this.hueConspicuousness = new Float64Array(bins);
    } else {
      this.hueCount.fill(0);
      this.hueToxicity.fill(0);
      this.hueConspicuousness.fill(0);
    }

    this.biomassTotalCm = 0;
    this.length.reset();
    for (const perDeme of this.demeTraits) {
      for (const accumulator of perDeme) {
        accumulator.latent.reset();
        accumulator.genotypic.reset();
      }
    }
    this.toxicityBuffer.clear();
    this.binBuffer.clear();
    this.juveniles = 0;
    this.matureCount = 0;
    this.matureAgeSum = 0;
    this.recruits = 0;
    this.nextMaturityAges.clear();
  }

  /** Always-on per-organism work: the realised-length series P3 and the plot columns read. */
  observeLength(lengthCm: number): void {
    this.biomassTotalCm += lengthCm;
    this.length.push(lengthCm);
  }

  /**
   * Ontogeny-arm per-organism work.
   *
   * Age at maturity is taken the first sample an organism is *observed* mature,
   * so it is quantised to `sampling.sampleIntervalTicks` and biased upward by
   * up to one interval; an organism that matured and died inside one interval
   * is never counted at all. The exact quantity needs a per-tick maturity hook
   * on the frozen `StatsApi`, which does not exist — see the G4 report.
   */
  observeLifeStage(state: SimState, slot: number, id: OrganismId, ageTicks: number): void {
    if (!isMature(state, slot)) {
      this.juveniles += 1;
      return;
    }
    const recorded = this.maturityAges.get(id);
    if (recorded === undefined) {
      this.recruits += 1;
      this.nextMaturityAges.set(id, ageTicks);
      this.matureAgeSum += ageTicks;
    } else {
      this.nextMaturityAges.set(id, recorded);
      this.matureAgeSum += recorded;
    }
    this.matureCount += 1;
  }

  /** Aposematism-arm per-organism work. Expressed scale, because that is what the mechanism reads. */
  observeHue(displayHueDeg: number, toxicity: number, conspicuousness: number): void {
    const bin = hueBinOf(displayHueDeg, this.hueBins);
    this.hueCount[bin] = (this.hueCount[bin] ?? 0) + 1;
    this.hueToxicity[bin] = (this.hueToxicity[bin] ?? 0) + toxicity;
    this.hueConspicuousness[bin] = (this.hueConspicuousness[bin] ?? 0) + conspicuousness;
    this.toxicityBuffer.push(toxicity);
    this.binBuffer.push(bin);
  }

  /** Either-arm per-organism work: the per-deme moments P8's second criterion wanted. */
  observeDeme(deme: number, traitsLatent: Float32Array, genotypic: Float32Array, base: number): void {
    const perDeme = this.demeTraits[deme];
    if (perDeme === undefined) return;
    for (let index = 0; index < DEME_TRAIT_INDICES.length; index += 1) {
      const accumulator = perDeme[index];
      if (accumulator === undefined) continue;
      const offset = base + (DEME_TRAIT_INDICES[index] ?? 0);
      accumulator.latent.push(traitsLatent[offset] ?? 0);
      accumulator.genotypic.push(genotypic[offset] ?? 0);
    }
  }

  /** Close the sample: maturity records for anyone no longer alive are retired here. */
  end(): void {
    const previous = this.maturityAges;
    this.maturityAges = this.nextMaturityAges;
    previous.clear();
    this.nextMaturityAges = previous;
  }

  lifeHistorySample(): LifeHistorySample {
    const population = this.length.count;
    return {
      meanLengthCm: this.length.mean,
      sdLengthCm: this.length.sd,
      juvenileFraction: population > 0 ? this.juveniles / population : 0,
      meanAgeAtMaturityTicks: this.matureCount > 0 ? this.matureAgeSum / this.matureCount : null,
      recruitment: this.recruits,
    };
  }

  hueBinSamples(): readonly HueBinSample[] {
    const bins: HueBinSample[] = [];
    for (let bin = 0; bin < this.hueBins; bin += 1) {
      const count = this.hueCount[bin] ?? 0;
      bins.push({
        count,
        meanToxicity: count > 0 ? (this.hueToxicity[bin] ?? 0) / count : 0,
        meanConspicuousness: count > 0 ? (this.hueConspicuousness[bin] ?? 0) / count : 0,
      });
    }
    return bins;
  }

  /**
   * Batesian free-rider fraction: within the most-toxic hue bin, the share of
   * members carrying less toxin than the population median.
   *
   * Null when no bin clears {@link toxicBinFloor} — a ring of uniformly clean
   * animals has no mimics to count, and reporting 0 there would read as
   * "measured, and nobody is cheating", which is a different claim.
   */
  mimicryIndex(): number | null {
    const population = this.toxicityBuffer.size;
    if (population === 0) return null;

    const floor = toxicBinFloor();
    let focal = -1;
    let focalMean = floor;
    for (let bin = 0; bin < this.hueBins; bin += 1) {
      const count = this.hueCount[bin] ?? 0;
      if (count === 0) continue;
      const mean = (this.hueToxicity[bin] ?? 0) / count;
      if (mean > focalMean) {
        focalMean = mean;
        focal = bin;
      }
    }
    if (focal < 0) return null;

    const sorted = this.toxicityBuffer.slice(0).sort();
    const middle = sorted.length >> 1;
    const median =
      sorted.length % 2 === 1
        ? (sorted[middle] ?? 0)
        : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;

    let members = 0;
    let below = 0;
    for (let index = 0; index < population; index += 1) {
      if (this.binBuffer.at(index) !== focal) continue;
      members += 1;
      if (this.toxicityBuffer.at(index) < median) below += 1;
    }
    return members > 0 ? below / members : null;
  }

  traitsByDeme(): readonly Readonly<Partial<Record<TraitKey, TraitSample>>>[] {
    const rows: Readonly<Partial<Record<TraitKey, TraitSample>>>[] = [];
    for (let deme = 0; deme < this.demes; deme += 1) {
      const perDeme = this.demeTraits[deme];
      const row: Partial<Record<TraitKey, TraitSample>> = {};
      for (let index = 0; index < DEME_TRAIT_KEYS.length; index += 1) {
        const accumulator = perDeme?.[index];
        const key = DEME_TRAIT_KEYS[index];
        if (accumulator === undefined || key === undefined) continue;
        const phenotypicVariance = accumulator.latent.variance;
        const additiveVariance = accumulator.genotypic.variance;
        row[key] = {
          mean: accumulator.latent.mean,
          sd: accumulator.latent.sd,
          additiveVariance,
          phenotypicVariance,
          heritability: phenotypicVariance > 0 ? additiveVariance / phenotypicVariance : Number.NaN,
        };
      }
      rows.push(row);
    }
    return rows;
  }
}
