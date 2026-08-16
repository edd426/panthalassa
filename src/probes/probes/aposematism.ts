/**
 * P18 (aposematic coupling) and P19 (mimicry cycle) — the two readings taken
 * off the G-B arm.
 *
 * Both are `warn`. P18 has an analytic null it must clear, which is what makes
 * it a claim about selection rather than about the authored table; P19 ships as
 * a detector with provisional bars and no defensible criterion yet, because per
 * the P16 ruling a signature this rare has to be stated against a base-rate
 * panel and that is G6 campaign work.
 */

import {
  DISCRETE_EFFECTS,
  DISCRETE_LOCI,
  FOUNDER_FIXED_DISCRETE_KINDS,
  PLEIOTROPY,
  QUANT_LOCI,
  chromosomeGate,
} from '../../contracts/genome';
import type { ActiveGates } from '../../contracts/genome';
import type { HueBinSample, ProbeReport, SampleRow } from '../../contracts/stats';
import { TRAIT_COUNT, TRAIT_INDEX } from '../../contracts/traits';
import type { TraitKey } from '../../contracts/traits';
import type { SimConfig } from '../../contracts/types';
import { toxicBinFloor } from '../../stats/detection';
import type { RunResult } from '../harness';
import { lastGeneration, postBurnIn } from '../metrics';
import type { ProbeDefinition } from '../probe';
import { makeReport, notEvaluable } from '../probe';
import { APOSEMATISM_SCENARIO } from '../scenarios';

// ---------------------------------------------------------------------------
// The analytic null: what the authored table alone predicts
// ---------------------------------------------------------------------------

/** Which chromosomes express, from a config's toggles. */
export function gatesOf(config: SimConfig): ActiveGates {
  return { ontogeny: config.toggles.enableOntogeny, aposematism: config.toggles.enableAposematism };
}

function gateOpen(gate: 'ontogeny' | 'aposematism' | null, gates: ActiveGates): boolean {
  return gate === null || gates[gate];
}

/**
 * Founder genetic covariance of two traits' latent values, in an unselected
 * population at linkage equilibrium.
 *
 * Same arithmetic `founderGeneticVariance` uses for the diagonal, off the
 * diagonal: a quantitative locus contributes `w_a · w_b · 2σ²` (two independent
 * allele copies, additively, no dominance), and a discrete locus contributes
 * `Cov_a(δ_a(x), δ_b(x)) / 2` over its uniform founder allele draw. Dark
 * chromosomes contribute nothing, so the same function answers for both arms.
 * The discrete half is written out generically even though today no discrete
 * locus loads `conspicuousness` — a table that grows a shared discrete effect
 * must not silently leave the null too low.
 */
export function founderGeneticCovariance(
  first: TraitKey,
  second: TraitKey,
  founderSdScale: number,
  gates: ActiveGates,
): number {
  let covariance = 0;

  for (const entry of PLEIOTROPY) {
    if (entry.trait !== first) continue;
    if (!gateOpen(entry.gate, gates)) continue;
    for (const partner of PLEIOTROPY) {
      if (partner.trait !== second || partner.locusIndex !== entry.locusIndex) continue;
      if (!gateOpen(partner.gate, gates)) continue;
      const sd = (QUANT_LOCI[entry.locusIndex]?.founderSd ?? 0) * founderSdScale;
      covariance += 2 * entry.weight * partner.weight * sd * sd;
    }
  }

  for (const locus of DISCRETE_LOCI) {
    if (FOUNDER_FIXED_DISCRETE_KINDS.includes(locus.kind)) continue;
    if (!gateOpen(chromosomeGate(locus.chromosome), gates)) continue;
    let sumFirst = 0;
    let sumSecond = 0;
    let sumProduct = 0;
    for (let allele = 0; allele < locus.alleleCount; allele += 1) {
      let deltaFirst = 0;
      let deltaSecond = 0;
      for (const effect of DISCRETE_EFFECTS) {
        if (effect.locus !== locus.id || effect.allele !== allele) continue;
        if (effect.trait === first) deltaFirst += effect.delta;
        if (effect.trait === second) deltaSecond += effect.delta;
      }
      sumFirst += deltaFirst;
      sumSecond += deltaSecond;
      sumProduct += deltaFirst * deltaSecond;
    }
    const meanFirst = sumFirst / locus.alleleCount;
    const meanSecond = sumSecond / locus.alleleCount;
    covariance += (sumProduct / locus.alleleCount - meanFirst * meanSecond) / 2;
  }

  return covariance;
}

/**
 * The correlation the authored pleiotropy alone produces at founding.
 *
 * For `toxicity`/`conspicuousness` the numerator is one cell: **q63** is the
 * only locus in W that loads both (0.28 and 0.35, founderSd 0.45), which is the
 * authored aposematism bootstrap the design put there on purpose. `founderSdScale`
 * cancels between numerator and denominator, so this number is a property of
 * the table and nothing else — which is what makes it a usable null.
 */
export function authoredTraitCorrelation(
  first: TraitKey,
  second: TraitKey,
  founderSdScale: number,
  gates: ActiveGates,
): number {
  const covariance = founderGeneticCovariance(first, second, founderSdScale, gates);
  const varianceFirst = founderGeneticCovariance(first, first, founderSdScale, gates);
  const varianceSecond = founderGeneticCovariance(second, second, founderSdScale, gates);
  const denominator = Math.sqrt(varianceFirst * varianceSecond);
  return denominator > 0 ? covariance / denominator : Number.NaN;
}

// ---------------------------------------------------------------------------
// P18 — aposematic coupling
// ---------------------------------------------------------------------------

/**
 * How far over the analytic null a reading has to sit, in standard errors of
 * the correlation itself.
 *
 * The null is exact; the measurement is not. `SE(r) ≈ (1 − r²)/√(n − 1)` — 0.025
 * at the ~1,500 animals these arms carry, 0.044 at 500 — so the bar is computed
 * per run rather than authored as a fixed offset, and a thin population has to
 * clear a wider one. This is a statement about the estimator, not a number
 * tuned against a run: it rules out sampling noise. It does **not** rule out
 * drift or transient linkage disequilibrium, which is why P18 is `warn` and why
 * the strong form of "selection did it" waits on the `toxinMacro`-disabled
 * ablation G6 already owns from the G3 report.
 */
const P18_NULL_SIGMAS = 3;

/** Below this many living organisms the correlation is not worth reporting. */
const P18_MIN_POPULATION = 50;

/** The null plus {@link P18_NULL_SIGMAS} standard errors at this population. */
export function couplingBar(authored: number, population: number): number {
  const standardError = (1 - authored * authored) / Math.sqrt(Math.max(2, population - 1));
  return authored + P18_NULL_SIGMAS * standardError;
}

export interface CouplingMeasurement {
  readonly genotypic: number;
  readonly latent: number;
  readonly population: number;
}

/**
 * Correlation of `toxicity` and `conspicuousness` across the living population.
 *
 * Measured on the **genotypic** scale, the same scale the analytic null is
 * derived on: latent values carry the birth environmental deviation, which
 * dilutes the correlation by `√(h²·h²)` and would make the comparison a
 * statement about heritability drift as much as about selection. The latent
 * figure rides along in the detail line so a reader can see both.
 */
export function couplingFromPools(run: RunResult): CouplingMeasurement | null {
  const pop = run.sim.state.pop;
  const toxicityIndex = TRAIT_INDEX.toxicity;
  const conspicuousnessIndex = TRAIT_INDEX.conspicuousness;
  const sums = {
    n: 0,
    gx: 0,
    gy: 0,
    gxx: 0,
    gyy: 0,
    gxy: 0,
    lx: 0,
    ly: 0,
    lxx: 0,
    lyy: 0,
    lxy: 0,
  };

  for (let slot = 0; slot < pop.capacity; slot += 1) {
    if (pop.alive[slot] !== 1) continue;
    const base = slot * TRAIT_COUNT;
    const gx = pop.traitsGenotypic[base + toxicityIndex] ?? 0;
    const gy = pop.traitsGenotypic[base + conspicuousnessIndex] ?? 0;
    const lx = pop.traitsLatent[base + toxicityIndex] ?? 0;
    const ly = pop.traitsLatent[base + conspicuousnessIndex] ?? 0;
    sums.n += 1;
    sums.gx += gx;
    sums.gy += gy;
    sums.gxx += gx * gx;
    sums.gyy += gy * gy;
    sums.gxy += gx * gy;
    sums.lx += lx;
    sums.ly += ly;
    sums.lxx += lx * lx;
    sums.lyy += ly * ly;
    sums.lxy += lx * ly;
  }

  if (sums.n < 2) return null;
  const correlation = (sx: number, sy: number, sxx: number, syy: number, sxy: number): number => {
    const covariance = sxy / sums.n - (sx / sums.n) * (sy / sums.n);
    const varianceX = sxx / sums.n - (sx / sums.n) ** 2;
    const varianceY = syy / sums.n - (sy / sums.n) ** 2;
    const denominator = Math.sqrt(Math.max(0, varianceX) * Math.max(0, varianceY));
    return denominator > 0 ? covariance / denominator : Number.NaN;
  };

  return {
    genotypic: correlation(sums.gx, sums.gy, sums.gxx, sums.gyy, sums.gxy),
    latent: correlation(sums.lx, sums.ly, sums.lxx, sums.lyy, sums.lxy),
    population: sums.n,
  };
}

function couplingReport(run: RunResult): ProbeReport {
  const gates = gatesOf(run.config);
  const authored = authoredTraitCorrelation(
    'toxicity',
    'conspicuousness',
    run.config.genetics.founderSdScale,
    gates,
  );
  const shared = {
    probeId: 'P18',
    name: 'Aposematic coupling',
    scenario: run.scenario,
    seed: run.seed,
    severity: 'warn' as const,
    generationsRun: run.generationsRun,
  };

  const measured = couplingFromPools(run);
  if (measured === null || measured.population < P18_MIN_POPULATION) {
    return notEvaluable({
      ...shared,
      threshold: {
        min: couplingBar(authored, P18_MIN_POPULATION),
        label: `r(toxicity, conspicuousness) > authored q63 null ${authored.toFixed(3)} + ${P18_NULL_SIGMAS} SE`,
      },
      detail: `${measured?.population ?? 0} living organisms at generation ${lastGeneration(run).toFixed(1)}; below the ${P18_MIN_POPULATION} the correlation needs`,
    });
  }

  const bar = couplingBar(authored, measured.population);
  const threshold = {
    min: bar,
    label: `r(toxicity, conspicuousness) > authored q63 null ${authored.toFixed(3)} + ${P18_NULL_SIGMAS} SE (${bar.toFixed(3)} at n=${measured.population})`,
  };

  const rows = postBurnIn(run);
  const finalBins = rows[rows.length - 1]?.hueBins;
  const toxicBins = finalBins?.filter((bin) => bin.count > 0 && bin.meanToxicity > toxicBinFloor()).length ?? 0;

  const detail = [
    `genotypic r ${measured.genotypic.toFixed(3)} against the authored-only null ${authored.toFixed(3)} (q63 is the only cell of W loading both traits)`,
    `latent r ${measured.latent.toFixed(3)} over ${measured.population} living organisms`,
    `${toxicBins} hue bin(s) above the toxic floor ${toxicBinFloor().toFixed(3)} in the final sample`,
  ].join('; ');

  return makeReport({ ...shared, value: measured.genotypic, threshold, detail });
}

export const couplingProbe: ProbeDefinition = {
  id: 'P18',
  name: 'Aposematic coupling',
  scenario: APOSEMATISM_SCENARIO,
  severity: 'warn',
  evaluate: (runs) => runs.map(couplingReport),
  aggregate: {
    kind: 'k-of-n',
    minPassFraction: 1 / 3,
    label: 'coupling exceeds the authored null on ≥1/3 of seeds',
  },
};

// ---------------------------------------------------------------------------
// P19 — mimicry cycle
// ---------------------------------------------------------------------------

/**
 * PROVISIONAL, and deliberately not ratcheted. TODO(G6).
 *
 * Per the P16 ruling, a signature this rare cannot be given a criterion off the
 * runs that motivated it: the final bars have to be stated against a 9-seed
 * base-rate panel, which is G6 campaign work. These three numbers describe the
 * shape of a Batesian fill-and-empty — free riders take most of a toxic ring,
 * the ring's mean defence collapses, then predators clear it — and they are set
 * where the shape is recognisable, **not** where the probe passes.
 */
const MIMICRY_BAR = 0.6;
const TOXICITY_COLLAPSE_FRACTION = 0.5;
const BIN_EMPTY_FRACTION = 0.25;

interface MimicryCycle {
  readonly bin: number;
  readonly peakGeneration: number;
  readonly collapseGeneration: number;
  readonly emptyGeneration: number;
  readonly peakMimicry: number;
}

/** The most-toxic bin above the floor, or −1; the recorder's own rule for `mimicryIndex`. */
export function focalHueBin(bins: readonly HueBinSample[]): number {
  let focal = -1;
  let best = toxicBinFloor();
  for (let bin = 0; bin < bins.length; bin += 1) {
    const sample = bins[bin];
    if (sample === undefined || sample.count === 0) continue;
    if (sample.meanToxicity > best) {
      best = sample.meanToxicity;
      focal = bin;
    }
  }
  return focal;
}

/**
 * Completed fill-and-empty episodes, in row order.
 *
 * One episode is three states reached in sequence *in the same bin*: the free
 * rider fraction clears {@link MIMICRY_BAR} while that bin is the toxic ring;
 * the ring's mean toxicity then falls to {@link TOXICITY_COLLAPSE_FRACTION} of
 * its value at that moment; and the ring's membership then falls to
 * {@link BIN_EMPTY_FRACTION} of its peak count. A bin that refills afterwards
 * can start a fresh episode.
 */
export function detectMimicryCycles(rows: readonly SampleRow[]): readonly MimicryCycle[] {
  const cycles: MimicryCycle[] = [];
  let bin = -1;
  let peakGeneration = 0;
  let peakMimicry = 0;
  let peakToxicity = 0;
  let peakCount = 0;
  let collapseGeneration: number | null = null;

  for (const row of rows) {
    const bins = row.hueBins;
    if (bins === undefined) continue;

    if (bin < 0) {
      const focal = focalHueBin(bins);
      const mimicry = row.mimicryIndex;
      if (focal < 0 || mimicry === undefined || mimicry === null || mimicry < MIMICRY_BAR) continue;
      const sample = bins[focal];
      if (sample === undefined) continue;
      bin = focal;
      peakGeneration = row.generation;
      peakMimicry = mimicry;
      peakToxicity = sample.meanToxicity;
      peakCount = sample.count;
      collapseGeneration = null;
      continue;
    }

    const sample = bins[bin];
    if (sample === undefined) continue;
    // The peak is the high-water mark of the ring itself, so a ring still
    // filling does not get read as one already collapsing.
    if (collapseGeneration === null && sample.count > peakCount) peakCount = sample.count;
    if (collapseGeneration === null && sample.meanToxicity > peakToxicity) peakToxicity = sample.meanToxicity;

    if (collapseGeneration === null) {
      if (sample.meanToxicity <= peakToxicity * TOXICITY_COLLAPSE_FRACTION) collapseGeneration = row.generation;
      continue;
    }
    if (sample.count <= peakCount * BIN_EMPTY_FRACTION) {
      cycles.push({
        bin,
        peakGeneration,
        collapseGeneration,
        emptyGeneration: row.generation,
        peakMimicry,
      });
      bin = -1;
    }
  }

  return cycles;
}

function mimicryReport(run: RunResult): ProbeReport {
  const threshold = {
    min: 1,
    label: `≥1 completed fill-and-empty cycle (free riders >${MIMICRY_BAR}, ring toxicity ≤${TOXICITY_COLLAPSE_FRACTION}× peak, ring ≤${BIN_EMPTY_FRACTION}× peak) — PROVISIONAL, TODO(G6)`,
  };
  const shared = {
    probeId: 'P19',
    name: 'Mimicry cycle',
    scenario: run.scenario,
    seed: run.seed,
    severity: 'warn' as const,
    generationsRun: run.generationsRun,
  };

  const rows = postBurnIn(run);
  const instrumented = rows.filter((row) => row.hueBins !== undefined);
  if (instrumented.length === 0) {
    return notEvaluable({
      ...shared,
      threshold,
      detail: `no hue-bin samples past the ${run.config.sampling.burnInGenerations}-generation burn-in; the run reached generation ${lastGeneration(run).toFixed(1)}`,
    });
  }

  const cycles = detectMimicryCycles(instrumented);
  const mimicryValues = instrumented
    .map((row) => row.mimicryIndex)
    .filter((value): value is number => value !== undefined && value !== null);
  const peakMimicry = mimicryValues.length > 0 ? Math.max(...mimicryValues) : Number.NaN;
  const toxicSamples = instrumented.filter((row) => focalHueBin(row.hueBins ?? []) >= 0).length;

  const detail = [
    cycles.length === 0
      ? 'no completed cycle'
      : `cycles at generations ${cycles.map((cycle) => `${cycle.peakGeneration.toFixed(0)}→${cycle.emptyGeneration.toFixed(0)} (bin ${cycle.bin})`).join(', ')}`,
    `free-rider fraction peaked at ${Number.isFinite(peakMimicry) ? peakMimicry.toFixed(3) : 'n/a'} over ${mimicryValues.length} measurable samples`,
    `a toxic ring existed in ${toxicSamples} of ${instrumented.length} samples`,
    'thresholds PROVISIONAL — the criterion needs the G6 9-seed base-rate panel',
  ].join('; ');

  return makeReport({
    ...shared,
    value: cycles.length,
    threshold,
    detail,
    series: {
      mimicryIndex: instrumented.map((row) => row.mimicryIndex ?? Number.NaN),
      focalBin: instrumented.map((row) => focalHueBin(row.hueBins ?? [])),
    },
  });
}

export const mimicryProbe: ProbeDefinition = {
  id: 'P19',
  name: 'Mimicry cycle',
  scenario: APOSEMATISM_SCENARIO,
  severity: 'warn',
  evaluate: (runs) => runs.map(mimicryReport),
};
