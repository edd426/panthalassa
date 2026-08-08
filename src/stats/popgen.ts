/**
 * Population-genetic estimators.
 *
 * Every estimator here is separated into a **pure numeric core** (exported, and
 * what `src/probes/popgen-units.test.ts` exercises against analytic cases) and a
 * thin binding that pulls the numbers out of `SimState` and the recorder's logs.
 * The split exists because an estimator that can only be tested by running the
 * whole simulation is an estimator nobody ever checks: the Fst core is checked
 * against a synthetic island model, the temporal-Ne core against a Wright–Fisher
 * series at known N, and the heritability core against data generated at a known
 * h².
 *
 * ## What each estimator assumes
 *
 * The assumptions are documented on each function rather than in a block here,
 * because the failure mode this project cares about is a number that looks
 * plausible while measuring something else. When an estimator cannot be
 * evaluated it returns NaN or null rather than a neutral-looking zero.
 */

import type { PopgenEstimators, SpeciesDetectionResult } from '../contracts/apis';
import {
  DISCRETE_LOCUS_BY_ID,
  NEUTRAL_MARKER_LOCI,
  QUANT_LOCI,
  QUANT_LOCUS_COUNT,
  discreteGenotype,
} from '../contracts/genome';
import { TRAIT_COUNT, TRAIT_INDEX, applyTraitLink } from '../contracts/traits';
import type { TraitKey } from '../contracts/traits';
import { NO_ORGANISM, SEX_MALE, demeAt, demeCount } from '../contracts/types';
import type { BarrierSpec, OrganismId, Sex, SimConfig, SimState } from '../contracts/types';
import { BirthLog, MatingLog, TraitCache, circularCorrelation, forEachLiveSlot, pearson, regressionSlope } from './shared';
import { SpeciesDetector } from './species';

// ---------------------------------------------------------------------------
// Tunables that the frozen SimConfig has no home for
// ---------------------------------------------------------------------------

/**
 * Midparent–offspring pairs required before a heritability is reported. Below
 * this the standard error on the slope swamps the estimate, and P13's window
 * would be reading noise.
 */
export const MIN_MIDPARENT_PAIRS = 50;

/** Midparent–offspring pairs retained per trait; older pairs fall out of the ring. */
export const MIDPARENT_WINDOW_PAIRS = 4096;

/**
 * Individuals a deme must hold before it can carry an Fst variance component.
 *
 * Two is the arithmetic minimum: Weir & Cockerham's within-group term divides by
 * `n̄ − 1`. Deliberately a local constant rather than `speciation.minSpeciesSize`
 * — an estimator whose estimand moves when an unrelated speciation knob is
 * retuned is an estimator whose series cannot be compared across runs (Gate A-1
 * risk 4). A thin corner deme contributes almost nothing to the summed
 * components either way; what mattered was the coupling, not the threshold.
 */
export const MIN_DEME_ORGANISMS = 2;

/** Everyone who could have bred during a window, for the demographic-Ne denominator. */
export interface BreederSource {
  forEachBreeder(
    windowStart: number,
    endTick: number,
    maturityTicks: number,
    visit: (id: OrganismId, sex: Sex) => void,
  ): void;
}

// ---------------------------------------------------------------------------
// Weir & Cockerham Fst
// ---------------------------------------------------------------------------

/** Allele and heterozygote counts for one group at one locus. */
export interface GroupLocusCounts {
  /** Diploid individuals scored. */
  readonly individuals: number;
  /** Gene copies of each allele; length is the locus's `alleleCount`. */
  readonly alleleCopies: Float64Array;
  /** Individuals carrying exactly one copy of each allele. */
  readonly heterozygotes: Float64Array;
}

/**
 * Weir & Cockerham (1984) θ, summed over alleles and loci.
 *
 * Input is indexed `[locus][group]`. The estimator is the ratio of summed
 * variance components `Σa / Σ(a + b + c)` — summing the components before
 * dividing, not averaging per-locus ratios, which is what keeps a rare allele
 * from dominating the answer.
 *
 * Assumptions and behaviour worth knowing:
 *
 * - The groups are treated as replicate samples from a common ancestral
 *   population, so the among-group variance carries the `1/(r − 1)` divisor.
 *   That makes θ **larger than Nei's G_ST for small r** — with two demes at
 *   p = 0.7 / 0.3, θ → 0.276 while G_ST = 0.16 — and the two converge as r
 *   grows. This is the estimator the contract names; do not read a θ as a G_ST.
 * - Alleles fixed or absent across every group contribute nothing and are
 *   skipped.
 * - A slightly **negative** result is a real and expected outcome when there is
 *   no structure, and is returned rather than clamped: clamping at zero would
 *   turn an unbiased estimator into a biased one and hide a bug where structure
 *   is being invented.
 * - Returns null when no locus was informative.
 */
export function weirCockerhamFst(loci: readonly (readonly GroupLocusCounts[])[]): number | null {
  let sumA = 0;
  let sumAbc = 0;
  let informative = 0;

  for (const groups of loci) {
    const r = groups.length;
    if (r < 2) continue;

    let sumIndividuals = 0;
    let sumSquaredIndividuals = 0;
    for (const group of groups) {
      sumIndividuals += group.individuals;
      sumSquaredIndividuals += group.individuals * group.individuals;
    }
    const nBar = sumIndividuals / r;
    if (!(nBar > 1)) continue;

    const nc = (r * nBar - sumSquaredIndividuals / (r * nBar)) / (r - 1);
    if (!(nc > 0)) continue;

    const alleleCount = groups[0]?.alleleCopies.length ?? 0;
    for (let allele = 0; allele < alleleCount; allele += 1) {
      let weightedP = 0;
      let heterozygotes = 0;
      for (const group of groups) {
        if (group.individuals <= 0) continue;
        weightedP += (group.alleleCopies[allele] ?? 0) / 2;
        heterozygotes += group.heterozygotes[allele] ?? 0;
      }
      const pBar = weightedP / sumIndividuals;
      const hBar = heterozygotes / sumIndividuals;
      if (!(pBar > 0) || pBar >= 1) continue;

      let s2 = 0;
      for (const group of groups) {
        if (group.individuals <= 0) continue;
        const p = (group.alleleCopies[allele] ?? 0) / (2 * group.individuals);
        s2 += group.individuals * (p - pBar) * (p - pBar);
      }
      s2 /= (r - 1) * nBar;

      const shared = pBar * (1 - pBar) - ((r - 1) / r) * s2;
      const a = (nBar / nc) * (s2 - (1 / (nBar - 1)) * (shared - hBar / 4));
      const b = (nBar / (nBar - 1)) * (shared - ((2 * nBar - 1) / (4 * nBar)) * hBar);
      const c = hBar / 2;

      sumA += a;
      sumAbc += a + b + c;
      informative += 1;
    }
  }

  if (informative === 0 || !(Math.abs(sumAbc) > 1e-12)) return null;
  return sumA / sumAbc;
}

// ---------------------------------------------------------------------------
// Temporal-method Ne
// ---------------------------------------------------------------------------

/**
 * Nei & Tajima's standardised variance of allele-frequency change, F_c.
 *
 * `F_c = mean over alleles of (x − y)² / ((x + y)/2 − xy)`, where x and y are
 * the frequencies at the two time points. The mean is taken over the alleles
 * with a positive denominator — alleles absent at both times carry no
 * information, and dividing by the locus's nominal k instead would deflate F
 * every time a k = 8 marker lost alleles to drift.
 *
 * Frequencies are indexed `[locus][allele]`; loci are weighted equally.
 * Returns NaN when nothing was informative.
 */
export function neiTajimaF(
  earlier: readonly (readonly number[])[],
  later: readonly (readonly number[])[],
): number {
  let total = 0;
  let loci = 0;
  const locusCount = Math.min(earlier.length, later.length);

  for (let locus = 0; locus < locusCount; locus += 1) {
    const before = earlier[locus] ?? [];
    const after = later[locus] ?? [];
    const alleleCount = Math.min(before.length, after.length);
    let locusSum = 0;
    let used = 0;
    for (let allele = 0; allele < alleleCount; allele += 1) {
      const x = before[allele] ?? 0;
      const y = after[allele] ?? 0;
      const denominator = (x + y) / 2 - x * y;
      if (!(denominator > 1e-12)) continue;
      const delta = x - y;
      locusSum += (delta * delta) / denominator;
      used += 1;
    }
    if (used === 0) continue;
    total += locusSum / used;
    loci += 1;
  }

  return loci > 0 ? total / loci : Number.NaN;
}

/**
 * Effective size from F_c over `generationsElapsed` generations, or **null when
 * the estimate is not identifiable**.
 *
 * Under drift alone, `E[F_c] = 1 − (1 − 1/(2Ne))^t`, so inverting gives
 * `Ne = 1 / (2·(1 − (1 − F)^(1/t)))`, which reduces to the familiar
 * `Ne ≈ t/(2F)` for small F. No sampling correction is applied: the recorder
 * scores **every** living organism, so the frequencies are a complete
 * enumeration and carry no binomial sampling error of their own.
 *
 * Null in three cases, all of them "this window cannot answer the question"
 * rather than "the answer is small" (Gate A-1 defect 5):
 *
 * - `F ≤ 0` — no frequency change was observed, so Ne is unbounded above. The
 *   previous version reported `10 × census`, a number that plots nicely, fails
 *   P14 loudly, and is entirely fabricated: a right-censored reading is not a
 *   measurement, and P14 now excludes these instead of averaging them in.
 * - `F ≥ 1` — more change than drift from any finite Ne can produce in `t`
 *   generations, i.e. the drift model does not fit. Substituting `Ne = 0.5`
 *   turned a model violation into the smallest imaginable population.
 * - No informative locus (`F` is NaN), or a non-positive elapsed time.
 *
 * Assumes the neutral markers really are neutral (the genome contract enforces
 * that they appear in no effect table), that the two time points are separated
 * by whole generations of the same population, and that migration is not
 * reintroducing variation from outside — the last is why the estimate reads low
 * under strong spatial structure.
 *
 * **Overlapping generations.** Panthalassa's organisms breed repeatedly across
 * an age-structured life history, while the temporal method assumes discrete
 * Wright–Fisher generations. Age structure inflates F_c at short separations, so
 * what this returns is best read as a **drift index** — a quantity that tracks
 * the rate of neutral variance loss and is comparable across runs of the same
 * config — rather than a strict Ne with a demographic interpretation. P14's
 * thresholds are broad for exactly this reason (adjudicated at Gate A-1:
 * document, do not correct).
 */
export function temporalNeFromF(fStatistic: number, generationsElapsed: number): number | null {
  if (!(generationsElapsed > 0) || Number.isNaN(fStatistic)) return null;
  if (!(fStatistic > 0) || fStatistic >= 1) return null;
  const perGeneration = 1 - Math.pow(1 - fStatistic, 1 / generationsElapsed);
  if (!(perGeneration > 0)) return null;
  return 1 / (2 * perGeneration);
}

// ---------------------------------------------------------------------------
// Demographic Ne
// ---------------------------------------------------------------------------

/**
 * Wright's sex-ratio effective size, `4·Nm·Nf/(Nm + Nf)`. Equals N when the
 * sexes are even.
 *
 * Kept as the **reference limit**, not as a correction factor: it is what
 * {@link combineSexNe} returns when offspring numbers are Poisson within each
 * sex, so a run whose breeding is otherwise unremarkable should reproduce it.
 * It is no longer multiplied into the estimate (Gate A-1 defect 6).
 */
export function sexRatioNe(males: number, females: number): number {
  const total = males + females;
  return total > 0 ? (4 * males * females) / total : Number.NaN;
}

/**
 * Kimura & Crow (1963) variance effective size for a stationary population,
 * `(4N − 2)/(Vk + 2)`. Equals ≈ N when offspring numbers are Poisson (Vk = 2).
 */
export function varianceNeStationary(breeders: number, varianceOffspring: number): number {
  if (breeders < 2) return Number.NaN;
  const denominator = varianceOffspring + 2;
  return denominator > 0 ? (4 * breeders - 2) / denominator : Number.NaN;
}

/**
 * Crow & Denniston (1988) variance effective size when mean offspring number is
 * not 2, `(k̄N − 2)/(k̄ − 1 + Vk/k̄)`.
 *
 * The generalisation matters here because Panthalassa's population is not held
 * at a fixed size: k̄ drifts above 2 while the population grows into a good
 * climate and below 2 while it crashes, and pinning k̄ = 2 would attribute that
 * demography to breeding structure.
 *
 * Applied **per sex** by {@link PopgenEngine.demographicNe}, where `breeders` is
 * the number of one sex and `k̄` its gametes per parent (each offspring takes
 * exactly one gamete from each sex, so k̄ is that sex's offspring-per-parent).
 * A single breeder of a sex is a meaningful input — it is the case that drives
 * Ne toward 4 — so one, not two, is the floor.
 *
 * Note the denominator is a co-parentage term: at k̄ far from 2 it measures how
 * often two gametes drawn from the pool share a parent, and it can exceed 2N
 * for a sex whose parents each contributed about one gamete with little
 * variance. That inflated sex never drives the combined answer, which
 * {@link combineSexNe} pins near four times the *smaller* of the two.
 */
export function varianceNeGeneral(breeders: number, meanOffspring: number, varianceOffspring: number): number {
  if (breeders < 1 || !(meanOffspring > 0)) return Number.NaN;
  // With two gametes or fewer from this sex the numerator is zero or negative
  // and the formula reports a zero or *negative* effective size — arithmetic
  // running out of data in a window that held almost no reproduction, not a
  // measurement of a tiny population. A collapsing run reaches this.
  const gametes = meanOffspring * breeders;
  if (!(gametes > 2)) return Number.NaN;
  const denominator = meanOffspring - 1 + varianceOffspring / meanOffspring;
  return denominator > 0 ? (gametes - 2) / denominator : Number.NaN;
}

/**
 * Combine sex-specific effective sizes, `Ne = 4·Ne_m·Ne_f/(Ne_m + Ne_f)`.
 *
 * Each offspring draws one gamete from each sex, so the two gamete pools drift
 * independently and their variances average with weight ½ each:
 * `Var(Δp) = ¼[Var(Δp_m) + Var(Δp_f)]`, which is `1/Ne = ¼(1/Ne_m + 1/Ne_f)`.
 * That is the whole derivation, and it is also where Wright's sex-ratio formula
 * comes from — {@link sexRatioNe} is this expression evaluated at `Ne_s = N_s`,
 * which is what Poisson offspring numbers within each sex give.
 *
 * This **replaces** the previous multiplicative composition of a sex-ratio
 * correction with a combined-sex offspring-variance correction (Gate A-1 defect
 * 6). Pooling both sexes into one Vk counts the between-sex disparity twice:
 * once as the sex ratio, and again as the variance the disparity creates in the
 * pooled offspring distribution. On a 4-male / 36-female window with every male
 * fathering ten offspring, that double count reported Ne ≈ 6 against a true
 * value near 17 — it read a *deficit* of males as if it were also a lottery
 * among them, when the males in fact contributed perfectly evenly.
 */
export function combineSexNe(neMale: number, neFemale: number): number {
  const total = neMale + neFemale;
  if (!Number.isFinite(total) || !(total > 0)) return Number.NaN;
  return (4 * neMale * neFemale) / total;
}

/**
 * Mean and variance of offspring number over one sex's breeders.
 *
 * Vk carries the `N − 1` divisor, and the choice is load-bearing rather than
 * cosmetic. Substituting the population variance `Σ(k − k̄)²/N` makes
 * {@link varianceNeGeneral} collapse to `T(T − 2)/(Σk² − T)` in the window's
 * total offspring `T` — the breeder count cancels *exactly*, and the estimator
 * stops being able to see childless adults at all. That would quietly make the
 * whole pedigree-backed breeder set inert, along with the maturity eligibility
 * this package just tightened: two organisms that never bred would read the
 * same as twenty. With `N − 1` the denominator keeps its say.
 *
 * A single breeder of a sex has no dispersion to estimate, so Vk is zero there
 * rather than `0/0`; that is the one-male case, and it lands where it should
 * (`Ne_m → 1`, combined `Ne → 4`).
 *
 * Iterates the id set in insertion order, which is pedigree birth order
 * followed by parentage-log order — both deterministic functions of
 * (config, seed).
 */
function offspringMoments(
  ids: ReadonlySet<OrganismId>,
  offspring: ReadonlyMap<OrganismId, number>,
): { mean: number; variance: number } {
  const count = ids.size;
  if (count === 0) return { mean: Number.NaN, variance: Number.NaN };

  let total = 0;
  for (const id of ids) total += offspring.get(id) ?? 0;
  const mean = total / count;

  let sumSquares = 0;
  for (const id of ids) {
    const delta = (offspring.get(id) ?? 0) - mean;
    sumSquares += delta * delta;
  }
  return { mean, variance: count > 1 ? sumSquares / (count - 1) : 0 };
}

// ---------------------------------------------------------------------------
// Neutral-marker frequencies
// ---------------------------------------------------------------------------

/**
 * Allele frequencies at the four neutral markers, indexed `[locus][allele]`.
 * Counted over both haplotypes of every living organism, in ascending slot
 * order. This is the input to both the temporal-Ne series and Fst.
 */
export function neutralAlleleFrequencies(state: SimState): number[][] {
  const frequencies = NEUTRAL_MARKER_LOCI.map((locus) => new Array<number>(locus.alleleCount).fill(0));
  let copies = 0;

  forEachLiveSlot(state, (slot) => {
    const genome = state.pop.genomes[slot];
    if (genome === undefined) return;
    copies += 2;
    for (let index = 0; index < NEUTRAL_MARKER_LOCI.length; index += 1) {
      const locus = NEUTRAL_MARKER_LOCI[index];
      if (locus === undefined) continue;
      const row = frequencies[index];
      if (row === undefined) continue;
      const [first, second] = discreteGenotype(genome, locus.index);
      if (first < row.length) row[first] = (row[first] ?? 0) + 1;
      if (second < row.length) row[second] = (row[second] ?? 0) + 1;
    }
  });

  if (copies === 0) return frequencies;
  for (const row of frequencies) {
    for (let allele = 0; allele < row.length; allele += 1) row[allele] = (row[allele] ?? 0) / copies;
  }
  return frequencies;
}

/**
 * Mean expected heterozygosity `1 − Σp²` over the neutral markers.
 *
 * Loci whose frequencies do not sum to 1 are skipped, and an empty population
 * gives NaN rather than 1 — with nobody scored every frequency is zero, and
 * `1 − 0` would report perfect heterozygosity for an extinct population.
 */
export function meanExpectedHeterozygosity(frequencies: readonly (readonly number[])[]): number {
  let total = 0;
  let scored = 0;
  for (const row of frequencies) {
    let sum = 0;
    let sumSquares = 0;
    for (const p of row) {
      sum += p;
      sumSquares += p * p;
    }
    if (sum < 0.5) continue;
    total += 1 - sumSquares;
    scored += 1;
  }
  return scored > 0 ? total / scored : Number.NaN;
}

// ---------------------------------------------------------------------------
// Midparent regression store
// ---------------------------------------------------------------------------

/**
 * A ring of midparent/offspring latent trait pairs, one lane per trait.
 *
 * Kept in typed arrays rather than objects because the ring holds a few thousand
 * pairs across eighteen traits and is refilled every generation for the whole
 * run.
 */
export class MidparentRegressions {
  private readonly midparent: Float32Array;
  private readonly offspring: Float32Array;
  private readonly scratchX: Float64Array;
  private readonly scratchY: Float64Array;
  private writeIndex = 0;
  private filled = 0;

  constructor(readonly capacity = MIDPARENT_WINDOW_PAIRS) {
    this.midparent = new Float32Array(capacity * TRAIT_COUNT);
    this.offspring = new Float32Array(capacity * TRAIT_COUNT);
    this.scratchX = new Float64Array(capacity);
    this.scratchY = new Float64Array(capacity);
  }

  get size(): number {
    return this.filled;
  }

  /** Record one offspring against the mean of its parents, for every trait at once. */
  push(read: (traitIndex: number) => { mother: number; father: number; offspring: number }): void {
    const base = this.writeIndex * TRAIT_COUNT;
    for (let traitIndex = 0; traitIndex < TRAIT_COUNT; traitIndex += 1) {
      const values = read(traitIndex);
      this.midparent[base + traitIndex] = (values.mother + values.father) / 2;
      this.offspring[base + traitIndex] = values.offspring;
    }
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled += 1;
  }

  /**
   * Slope of offspring on midparent — the classic h² estimate.
   *
   * Unbiased for narrow-sense heritability only under the usual assumptions:
   * no shared parent–offspring environment, no dominance or epistasis
   * contributing to the parent–offspring covariance, and random mating. The
   * third is precisely what this model breaks on purpose — assortative mating on
   * `displayHue` inflates the midparent variance and therefore **deflates** the
   * slope — which is why P13 cross-checks it against `V_A/V_P` from the
   * genotypic values rather than trusting either alone.
   *
   * Returns null before {@link MIN_MIDPARENT_PAIRS} pairs have accumulated.
   */
  slope(traitIndex: number): number | null {
    if (this.filled < MIN_MIDPARENT_PAIRS) return null;
    for (let pair = 0; pair < this.filled; pair += 1) {
      this.scratchX[pair] = this.midparent[pair * TRAIT_COUNT + traitIndex] ?? 0;
      this.scratchY[pair] = this.offspring[pair * TRAIT_COUNT + traitIndex] ?? 0;
    }
    const slope = regressionSlope(this.scratchX, this.scratchY, this.filled);
    return Number.isNaN(slope) ? null : slope;
  }

  clear(): void {
    this.writeIndex = 0;
    this.filled = 0;
  }
}

// ---------------------------------------------------------------------------
// The estimator bundle
// ---------------------------------------------------------------------------

/**
 * `PopgenEstimators` over the recorder's logs.
 *
 * Owns the mating log, the birth log, the latent-trait cache and the species
 * detector, because every estimator that is not a pure function of `SimState`
 * needs at least one of them and splitting the ownership would mean four
 * objects agreeing on a window definition.
 */
export class PopgenEngine implements PopgenEstimators {
  readonly matings: MatingLog;
  readonly births: BirthLog;
  readonly traits: TraitCache;
  readonly regressions: MidparentRegressions;
  readonly detector: SpeciesDetector;

  /**
   * Where the demographic-Ne denominator comes from. The recorder supplies its
   * ancestry store; without one the breeder set falls back to the living mature
   * census, which misses adults that died in the window without reproducing.
   */
  private breeders: BreederSource | null = null;

  constructor(private readonly config: SimConfig) {
    this.matings = new MatingLog();
    this.births = new BirthLog();
    this.traits = new TraitCache();
    this.regressions = new MidparentRegressions();
    this.detector = new SpeciesDetector(config, this.matings);
  }

  useBreederSource(source: BreederSource): void {
    this.breeders = source;
  }

  // -- ingest ---------------------------------------------------------------

  recordMating(motherId: OrganismId, fatherId: OrganismId, tick: number): void {
    this.matings.push(motherId, fatherId, tick);
  }

  recordBirth(id: OrganismId, motherId: OrganismId, fatherId: OrganismId, tick: number): void {
    this.births.push(id, motherId, fatherId, tick);
  }

  /**
   * Cache one organism's latent phenotype the first time it is seen, and form a
   * midparent–offspring pair if both its parents are already cached. `latent` is
   * a packed pool column and `offset` the organism's base index; the values are
   * copied, so a borrowed view of a recycling slot is safe to pass.
   *
   * Driven from two places, and the order matters. `StatsRecorder.onBirth` calls
   * it as each organism is born — the path that keeps offspring dying before
   * their first census in the regression — and the sample walk calls it for
   * everyone alive, which catches anyone introduced without a latent view. The
   * first-seen guard makes the second call a no-op for ids already held, so no
   * pair is counted twice.
   */
  observe(id: OrganismId, motherId: OrganismId, fatherId: OrganismId, latent: Float32Array, offset: number): void {
    if (this.traits.has(id)) return;
    this.traits.store(id, latent, offset);
    if (motherId === NO_ORGANISM || fatherId === NO_ORGANISM) return;
    if (!this.traits.has(motherId) || !this.traits.has(fatherId)) return;
    this.regressions.push((traitIndex) => ({
      mother: this.traits.get(motherId, traitIndex),
      father: this.traits.get(fatherId, traitIndex),
      offspring: latent[offset + traitIndex] ?? 0,
    }));
  }

  // -- PopgenEstimators -----------------------------------------------------

  /**
   * Weir–Cockerham Fst over the neutral markers.
   *
   * Groups below {@link MIN_DEME_ORGANISMS} are **excluded** rather than
   * nullifying the whole statistic: a nearly empty deme carries no information
   * and blows up the small-sample terms, but on a twelve-deme grid one thin
   * corner would otherwise suppress the series for the whole run. Null comes
   * back only when fewer than two groups survive that filter — which for
   * `'barrier'` means one side of the barrier has emptied out, since there are
   * only ever two.
   *
   * The threshold is the estimator's own constant, not `minSpeciesSize`: the
   * contract's doc-comment still names the speciation knob, and that sentence is
   * stale as of Gate A-1 risk 4.
   */
  fst(state: SimState, grouping: 'deme' | 'barrier'): number | null {
    const assign = grouping === 'deme' ? demeAssigner(this.config) : barrierAssigner(state);
    if (assign === null) return null;
    const groupCount = grouping === 'deme' ? demeCount(this.config) : 2;

    const individuals = new Float64Array(groupCount);
    const copies: Float64Array[][] = [];
    const heterozygotes: Float64Array[][] = [];
    for (let locus = 0; locus < NEUTRAL_MARKER_LOCI.length; locus += 1) {
      const alleleCount = NEUTRAL_MARKER_LOCI[locus]?.alleleCount ?? 0;
      copies.push(Array.from({ length: groupCount }, () => new Float64Array(alleleCount)));
      heterozygotes.push(Array.from({ length: groupCount }, () => new Float64Array(alleleCount)));
    }

    forEachLiveSlot(state, (slot) => {
      const genome = state.pop.genomes[slot];
      if (genome === undefined) return;
      const group = assign(state.pop.x[slot] ?? 0, state.pop.y[slot] ?? 0);
      if (group < 0 || group >= groupCount) return;
      individuals[group] = (individuals[group] ?? 0) + 1;
      for (let locus = 0; locus < NEUTRAL_MARKER_LOCI.length; locus += 1) {
        const spec = NEUTRAL_MARKER_LOCI[locus];
        if (spec === undefined) continue;
        const [first, second] = discreteGenotype(genome, spec.index);
        const copyRow = copies[locus]?.[group];
        const hetRow = heterozygotes[locus]?.[group];
        if (copyRow === undefined || hetRow === undefined) continue;
        if (first < copyRow.length) copyRow[first] = (copyRow[first] ?? 0) + 1;
        if (second < copyRow.length) copyRow[second] = (copyRow[second] ?? 0) + 1;
        if (first !== second) {
          if (first < hetRow.length) hetRow[first] = (hetRow[first] ?? 0) + 1;
          if (second < hetRow.length) hetRow[second] = (hetRow[second] ?? 0) + 1;
        }
      }
    });

    const kept: number[] = [];
    for (let group = 0; group < groupCount; group += 1) {
      if ((individuals[group] ?? 0) >= MIN_DEME_ORGANISMS) kept.push(group);
    }
    if (kept.length < 2) return null;

    const loci = copies.map((byGroup, locus) =>
      kept.map((group) => ({
        individuals: individuals[group] ?? 0,
        alleleCopies: byGroup[group] ?? new Float64Array(0),
        heterozygotes: heterozygotes[locus]?.[group] ?? new Float64Array(0),
      })),
    );
    return weirCockerhamFst(loci);
  }

  midparentHeritability(trait: TraitKey): number | null {
    return this.regressions.slope(TRAIT_INDEX[trait]);
  }

  /**
   * The frozen `PopgenEstimators` entry point, which predates the nullable
   * reading and cannot return null. NaN is the only "not identifiable" value a
   * `number` can carry, so that is what a caller holding the interface gets;
   * {@link temporalNeOrNull} is what the recorder calls, and what the contract's
   * nullable `PopgenSample.neTemporal` is built from.
   *
   * The interface's fourth argument, `censusSize`, is simply not accepted here:
   * nothing is bounded by census size any more now that the fabricated
   * `10 × N` ceiling is gone (Gate A-1 defect 5), and a method that ignores an
   * argument should say so by not taking it. Callers through the interface pass
   * it and TypeScript is satisfied — a shorter parameter list implements a
   * longer one.
   */
  temporalNe(
    earlier: readonly (readonly number[])[],
    later: readonly (readonly number[])[],
    generationsElapsed: number,
  ): number {
    return this.temporalNeOrNull(earlier, later, generationsElapsed) ?? Number.NaN;
  }

  /** Temporal Ne, or null where the window cannot identify one. See {@link temporalNeFromF}. */
  temporalNeOrNull(
    earlier: readonly (readonly number[])[],
    later: readonly (readonly number[])[],
    generationsElapsed: number,
  ): number | null {
    return temporalNeFromF(neiTajimaF(earlier, later), generationsElapsed);
  }

  /**
   * Demographic Ne over the last generation of births.
   *
   * The breeder set is everyone who *could* have bred during the window — mature
   * by its end and not already dead when it opened — taken from the pedigree,
   * where `AncestryRecord.sex` records which sex each of them was. Including the
   * adults that died childless is what keeps Vk honest: counting only the
   * individuals who appear in the parentage table would drop every zero from the
   * offspring distribution and report an Ne close to the census under any
   * mortality regime.
   *
   * Anyone who appears as a parent is added regardless, so a run without a
   * pedigree source still produces a defensible (if optimistic) number.
   *
   * The two sexes are then treated **separately** — k̄ and Vk computed within
   * each, a Crow & Denniston effective size per sex, combined by
   * {@link combineSexNe} — rather than pooled and corrected twice. NaN when
   * either sex is empty or nothing bred in the window: with no offspring there
   * was no gamete sampling, so the window measures nothing.
   */
  demographicNe(state: SimState): number {
    const windowStart = state.tick - this.config.time.generationTicks;
    const offspring = new Map<OrganismId, number>();
    const males = new Set<OrganismId>();
    const females = new Set<OrganismId>();

    const source = this.breeders;
    if (source !== null) {
      source.forEachBreeder(windowStart, state.tick, this.config.time.maturityTicks, (id, sex) => {
        if (sex === 'male') males.add(id);
        else females.add(id);
        if (!offspring.has(id)) offspring.set(id, 0);
      });
    } else {
      forEachLiveSlot(state, (slot, id) => {
        if ((state.pop.ageTicks[slot] ?? 0) < this.config.time.maturityTicks) return;
        if ((state.pop.sex[slot] ?? 0) === SEX_MALE) males.add(id);
        else females.add(id);
        if (!offspring.has(id)) offspring.set(id, 0);
      });
    }

    this.births.forEachSince(windowStart, (_id, motherId, fatherId) => {
      if (motherId !== NO_ORGANISM) {
        females.add(motherId);
        offspring.set(motherId, (offspring.get(motherId) ?? 0) + 1);
      }
      if (fatherId !== NO_ORGANISM) {
        males.add(fatherId);
        offspring.set(fatherId, (offspring.get(fatherId) ?? 0) + 1);
      }
    });

    if (males.size < 1 || females.size < 1) return Number.NaN;

    const male = offspringMoments(males, offspring);
    const female = offspringMoments(females, offspring);
    return combineSexNe(
      varianceNeGeneral(males.size, male.mean, male.variance),
      varianceNeGeneral(females.size, female.mean, female.variance),
    );
  }

  detectSpecies(state: SimState): SpeciesDetectionResult {
    return this.detector.detect(state);
  }

  // -- recorder support -----------------------------------------------------

  /**
   * Pearson correlation of latent `diet` between mated partners over the window
   * — the magic trait's assortment signal. 1 when like pairs with like, 0 under
   * random mating. Pairs where either partner was never observed at a sample
   * boundary are skipped.
   *
   * Null when fewer than two resolvable pairs remain or the trait is
   * monomorphic among them: an unmeasurable window and a measured zero are
   * different claims, and `SampleRow.matings` carries the pair count that tells
   * them apart (Gate A-1 defects 10/13).
   */
  assortmentIndex(sinceTick: number, trait: TraitKey = 'diet'): number | null {
    const traitIndex = TRAIT_INDEX[trait];
    const mothers: number[] = [];
    const fathers: number[] = [];
    this.matings.forEachSince(sinceTick, (motherId, fatherId) => {
      const mother = this.traits.get(motherId, traitIndex);
      const father = this.traits.get(fatherId, traitIndex);
      if (Number.isNaN(mother) || Number.isNaN(father)) return;
      mothers.push(mother);
      fathers.push(father);
    });
    return pearson(mothers, fathers, mothers.length);
  }

  /** Circular correlation of expressed `displayHue` between mated partners over the window; null as above. */
  hueAssortment(sinceTick: number): number | null {
    const traitIndex = TRAIT_INDEX.displayHue;
    const mothers: number[] = [];
    const fathers: number[] = [];
    this.matings.forEachSince(sinceTick, (motherId, fatherId) => {
      const mother = this.traits.get(motherId, traitIndex);
      const father = this.traits.get(fatherId, traitIndex);
      if (Number.isNaN(mother) || Number.isNaN(father)) return;
      mothers.push((applyTraitLink('displayHue', mother) * Math.PI) / 180);
      fathers.push((applyTraitLink('displayHue', father) * Math.PI) / 180);
    });
    return circularCorrelation(mothers, fathers, mothers.length);
  }

  /**
   * Fraction of quantitative loci whose allelic variance is still above
   * `sampling.quantVarianceFloorFactor × (founderSd·founderSdScale)²`, measured
   * over every allele copy in the living population. P6's dead-locus statistic.
   */
  quantLociWithVariance(state: SimState): number {
    const sums = new Float64Array(QUANT_LOCUS_COUNT);
    const sumSquares = new Float64Array(QUANT_LOCUS_COUNT);
    let copies = 0;

    forEachLiveSlot(state, (slot) => {
      const genome = state.pop.genomes[slot];
      if (genome === undefined) return;
      copies += 2;
      for (let locus = 0; locus < QUANT_LOCUS_COUNT; locus += 1) {
        const maternal = genome.quant[locus] ?? 0;
        const paternal = genome.quant[QUANT_LOCUS_COUNT + locus] ?? 0;
        sums[locus] = (sums[locus] ?? 0) + maternal + paternal;
        sumSquares[locus] = (sumSquares[locus] ?? 0) + maternal * maternal + paternal * paternal;
      }
    });
    if (copies < 2) return 0;

    const scale = this.config.genetics.founderSdScale;
    const floorFactor = this.config.sampling.quantVarianceFloorFactor;
    let retained = 0;
    for (let locus = 0; locus < QUANT_LOCUS_COUNT; locus += 1) {
      const mean = (sums[locus] ?? 0) / copies;
      const variance = Math.max(0, (sumSquares[locus] ?? 0) / copies - mean * mean);
      const founderSd = (QUANT_LOCI[locus]?.founderSd ?? 0) * scale;
      const floor = floorFactor * founderSd * founderSd;
      if (variance > floor) retained += 1;
    }
    return retained / QUANT_LOCUS_COUNT;
  }

  /** Mean allelic value and allelic variance per quantitative locus, for the inspector and JSONL. */
  quantLocusMoments(state: SimState): { readonly mean: Float64Array; readonly variance: Float64Array } {
    const sums = new Float64Array(QUANT_LOCUS_COUNT);
    const sumSquares = new Float64Array(QUANT_LOCUS_COUNT);
    let copies = 0;

    forEachLiveSlot(state, (slot) => {
      const genome = state.pop.genomes[slot];
      if (genome === undefined) return;
      copies += 2;
      for (let locus = 0; locus < QUANT_LOCUS_COUNT; locus += 1) {
        const maternal = genome.quant[locus] ?? 0;
        const paternal = genome.quant[QUANT_LOCUS_COUNT + locus] ?? 0;
        sums[locus] = (sums[locus] ?? 0) + maternal + paternal;
        sumSquares[locus] = (sumSquares[locus] ?? 0) + maternal * maternal + paternal * paternal;
      }
    });

    const mean = new Float64Array(QUANT_LOCUS_COUNT);
    const variance = new Float64Array(QUANT_LOCUS_COUNT);
    if (copies < 2) return { mean, variance };
    for (let locus = 0; locus < QUANT_LOCUS_COUNT; locus += 1) {
      const average = (sums[locus] ?? 0) / copies;
      mean[locus] = average;
      variance[locus] = Math.max(0, (sumSquares[locus] ?? 0) / copies - average * average);
    }
    return { mean, variance };
  }

  /** Drop cached phenotypes for organisms the pedigree no longer keeps. */
  pruneCaches(keep: (id: OrganismId) => boolean): void {
    this.traits.prune(keep);
  }
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function demeAssigner(config: SimConfig): (x: number, y: number) => number {
  return (x, y) => demeAt(x, y, config);
}

/**
 * Sides of the active barrier, or null when none is up.
 *
 * "Active" is the least permeable spec, ties broken by position in
 * `barriers.specs` — deterministic, and it picks the ridge P8 raised rather than
 * some decorative reef if both exist. A fully permeable spec is not a barrier.
 *
 * **Only ridges define sides.** A `rect` has an interior and an exterior, and
 * the exterior is one connected region wrapping the block: two organisms on
 * opposite sides of a rectangular reef are in the same group, and every
 * organism *inside* it — a handful, since the point of a barrier is that few
 * cross it — is the other. "Fst between the two sides of the active barrier" is
 * not a quantity that partition computes, so rect returns null rather than a
 * number measuring something else (Gate A-1 defect 9). P8 raises ridges; if a
 * rect barrier ever needs a divergence statistic it wants a different estimator,
 * not this one with a looser comment.
 */
function barrierAssigner(state: SimState): ((x: number, y: number) => number) | null {
  let active: BarrierSpec | null = null;
  for (const spec of state.barriers.specs) {
    if (spec.permeability >= 1) continue;
    if (active === null || spec.permeability < active.permeability) active = spec;
  }
  if (active === null) return null;

  const shape = active.shape;
  switch (shape.kind) {
    case 'verticalRidge':
      return (x) => (x < shape.xWu ? 0 : 1);
    case 'horizontalRidge':
      return (_x, y) => (y < shape.yWu ? 0 : 1);
    case 'rect':
      return null;
  }
}

/** Allele frequencies at one discrete locus over the living population. */
export function discreteAlleleFrequencies(state: SimState, locusId: keyof typeof DISCRETE_LOCUS_BY_ID): number[] {
  const locus = DISCRETE_LOCUS_BY_ID[locusId];
  const counts = new Array<number>(locus.alleleCount).fill(0);
  let copies = 0;
  forEachLiveSlot(state, (slot) => {
    const genome = state.pop.genomes[slot];
    if (genome === undefined) return;
    copies += 2;
    const [first, second] = discreteGenotype(genome, locus.index);
    if (first < counts.length) counts[first] = (counts[first] ?? 0) + 1;
    if (second < counts.length) counts[second] = (counts[second] ?? 0) + 1;
  });
  if (copies === 0) return counts;
  for (let allele = 0; allele < counts.length; allele += 1) counts[allele] = (counts[allele] ?? 0) / copies;
  return counts;
}
