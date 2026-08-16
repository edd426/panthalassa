/**
 * P17 (age structure) — the reading taken off the G-A arm.
 *
 * This is the probe that would have caught the defect the wave was built to
 * fix. Before ontogeny, `size` was written once at birth and never moved, so
 * every animal in the ocean was an adult of its final length: the realised
 * length CV sat at 0.06–0.10, which is founder variance and nothing else, and
 * the predation size window — a Gaussian centred on prey/predator ratio
 * `sizeRatioOptimum` — had almost no pairs inside it. A7 papered over that by
 * dragging `sizeRatioOptimum` from 0.55 to 0.88, an emergency move recorded in
 * the tuning log. P17 asserts the three things that were false then: the
 * population has a spread of realised lengths, it has juveniles in it, and its
 * realised length ratios actually land in the kill window.
 */

import type { ProbeReport } from '../../contracts/stats';
import { TRAIT_COUNT, TRAIT_INDEX } from '../../contracts/traits';
import type { SimConfig } from '../../contracts/types';
import type { RunResult } from '../harness';
import { lastGeneration, mean, postBurnIn } from '../metrics';
import type { ProbeDefinition } from '../probe';
import { breach, makeReport, notEvaluable, statusFor, worstStatus } from '../probe';
import { ONTOGENY_SCENARIO } from '../scenarios';

/**
 * The kill window, as a prey/predator realised-length ratio interval.
 *
 * `predationKillProbability` weights the window as
 * `exp(−((ratio − optimum)/width)²)`, a Gaussian with no edges, so "inside the
 * window" needs a definition. One `width` either side of the optimum is the
 * e-fold point: a pair there still collects 37% of `sizeWindowGain`, and
 * everything outside collects less. Derived from config rather than authored,
 * so A7 moving the pair moves the probe with it.
 */
export function killWindowRatios(config: SimConfig): readonly [number, number] {
  const { sizeRatioOptimum, sizeRatioWidth } = config.predation;
  return [Math.max(0, sizeRatioOptimum - sizeRatioWidth), sizeRatioOptimum + sizeRatioWidth];
}

/**
 * Share of ordered (predator, prey) pairs in the final living population whose
 * realised lengths land in the kill window.
 *
 * Every expressed-diet predator is paired against every other living organism —
 * the pair set predation actually draws from, before the spatial index narrows
 * it. Computed by sorting lengths once and binary-searching the window per
 * predator, so it is O(n log n) rather than the O(n²) the definition suggests;
 * `SampleRow` carries only the mean and SD of length, which cannot answer this.
 */
export function killWindowOverlap(run: RunResult): { readonly overlap: number; readonly predators: number } {
  const pop = run.sim.state.pop;
  const dietIndex = TRAIT_INDEX.diet;
  const lengths: number[] = [];
  const predatorLengths: number[] = [];

  for (let slot = 0; slot < pop.capacity; slot += 1) {
    if (pop.alive[slot] !== 1) continue;
    const length = pop.sizeCurrent[slot] ?? 0;
    lengths.push(length);
    if ((pop.traits[slot * TRAIT_COUNT + dietIndex] ?? 0) > 0.5) predatorLengths.push(length);
  }
  if (predatorLengths.length === 0 || lengths.length < 2) {
    return { overlap: Number.NaN, predators: predatorLengths.length };
  }

  lengths.sort((a, b) => a - b);
  const [low, high] = killWindowRatios(run.config);
  let inWindow = 0;
  let pairs = 0;
  for (const predator of predatorLengths) {
    if (!(predator > 0)) continue;
    const count = countBelow(lengths, predator * high) - countBelow(lengths, predator * low);
    // The predator itself sits at ratio 1; subtract it when 1 is inside.
    const selfInside = 1 >= low && 1 <= high ? 1 : 0;
    inWindow += count - selfInside;
    pairs += lengths.length - 1;
  }
  return { overlap: pairs > 0 ? inWindow / pairs : Number.NaN, predators: predatorLengths.length };
}

/** Number of entries strictly below `bound` in an ascending array. */
function countBelow(sorted: readonly number[], bound: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((sorted[middle] ?? 0) < bound) low = middle + 1;
    else high = middle;
  }
  return low;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Realised-length CV floor.
 *
 * The number this separates is not subtle: with ontogeny off the CV is founder
 * variance alone, 0.06–0.10 on every run on file; the G2 cliff runs reached
 * 0.45–0.52; and the ontogeny arm measured for this package (s1/s2/s3, 60
 * generations, post-burn-in) achieved per-seed means of 0.440/0.510/0.471.
 * Ratcheted to sit 4% under the worst of those, which is still four times the
 * off-arm band — a regression to write-once size cannot creep past it.
 */
const LENGTH_CV_FLOOR = 0.42;

/**
 * Juvenile fraction band.
 *
 * Both edges are failure modes rather than tuning preferences: a population
 * with no juveniles has no age structure (the defect), and one that is nearly
 * all juveniles is not recruiting — a nursery that never produces an adult.
 *
 * The floor is **bracketing, not ratcheted**, and knowingly so: the two
 * measurements on file disagree by a factor of two (G2's 45-generation cliff
 * runs 0.305–0.362; this package's 60-generation arm 0.642/0.676/0.661), and
 * ratcheting under the higher pair would fail the lower one. 0.25 sits under
 * both. The ceiling is ratcheted — 15% over the worst arm mean and 4% over the
 * highest single sample seen (0.750). G6 owns tightening the floor once the
 * growth knobs stop moving under it.
 */
const JUVENILE_FRACTION_MIN = 0.25;
const JUVENILE_FRACTION_MAX = 0.78;

/**
 * Kill-window overlap band — **two-sided, and the ceiling is the criterion that
 * would have caught the original defect.**
 *
 * A floor alone would not have. With write-once size the population is
 * monomorphic to within its founder CV, so every pair sits near ratio 1 — and
 * at the emergency `sizeRatioOptimum` 0.88 A7 was forced to adopt, ratio 1 is
 * *inside* the window, so the defective world sails past any floor. Measured on
 * an off-arm population: **0.83 at founding**, and higher once the founder
 * spread settles to the 0.06–0.10 CV the archive records. What that world
 * cannot produce is a distribution; the point mass either sits in the window or
 * does not.
 *
 * The ontogeny arm measured 0.378/0.284/0.436 (s1/s2/s3, 60 generations, final
 * population). The floor is 22% under the worst of those — deliberately loose,
 * because those readings rest on 26/8/10 expressed-diet predators and the
 * predator-side sampling error is large. The ceiling sits between the arm's
 * best reading and the off-arm 0.83, so a regression to write-once length
 * breaches it.
 */
const KILL_WINDOW_OVERLAP_FLOOR = 0.22;
const KILL_WINDOW_OVERLAP_CEILING = 0.7;

function ageStructureReport(run: RunResult): ProbeReport {
  const threshold = {
    min: LENGTH_CV_FLOOR,
    label: `realised-length CV ≥${LENGTH_CV_FLOOR}; juvenile fraction ∈ [${JUVENILE_FRACTION_MIN}, ${JUVENILE_FRACTION_MAX}]; kill-window overlap ∈ [${KILL_WINDOW_OVERLAP_FLOOR}, ${KILL_WINDOW_OVERLAP_CEILING}]`,
  };
  const shared = {
    probeId: 'P17',
    name: 'Age structure',
    scenario: run.scenario,
    seed: run.seed,
    severity: 'warn' as const,
    generationsRun: run.generationsRun,
  };

  const rows = postBurnIn(run).filter((row) => row.lifeHistory !== undefined);
  if (rows.length === 0) {
    return notEvaluable({
      ...shared,
      threshold,
      detail: `no life-history samples past the ${run.config.sampling.burnInGenerations}-generation burn-in; the run reached generation ${lastGeneration(run).toFixed(1)}`,
    });
  }

  const coefficients = rows.map((row) => {
    const life = row.lifeHistory;
    return life !== undefined && life.meanLengthCm > 0 ? life.sdLengthCm / life.meanLengthCm : Number.NaN;
  });
  const juvenileFractions = rows.map((row) => row.lifeHistory?.juvenileFraction ?? Number.NaN);
  const recruitment = rows.map((row) => row.lifeHistory?.recruitment ?? Number.NaN);
  const maturityAges = rows
    .map((row) => row.lifeHistory?.meanAgeAtMaturityTicks)
    .filter((value): value is number => value !== undefined && value !== null);

  const lengthCv = mean(coefficients);
  const juvenileFraction = mean(juvenileFractions);
  const { overlap, predators } = killWindowOverlap(run);
  const [low, high] = killWindowRatios(run.config);

  const status = worstStatus([
    statusFor(lengthCv, threshold, 'warn'),
    juvenileFraction >= JUVENILE_FRACTION_MIN && juvenileFraction <= JUVENILE_FRACTION_MAX
      ? 'pass'
      : breach('warn'),
    Number.isFinite(overlap) && overlap >= KILL_WINDOW_OVERLAP_FLOOR && overlap <= KILL_WINDOW_OVERLAP_CEILING
      ? 'pass'
      : breach('warn'),
  ]);

  const detail = [
    `realised-length CV ${lengthCv.toFixed(3)} over ${rows.length} samples`,
    `juvenile fraction ${juvenileFraction.toFixed(3)}, recruitment ${mean(recruitment).toFixed(0)} per sample`,
    maturityAges.length > 0
      ? `mean age at maturity ${mean(maturityAges).toFixed(0)} ticks (quantised to the ${run.config.sampling.sampleIntervalTicks}-tick sample interval)`
      : 'no matured organisms observed',
    `${(overlap * 100).toFixed(1)}% of predator/prey pairs inside the kill window [${low.toFixed(2)}, ${high.toFixed(2)}], from ${predators} expressed-diet predators`,
  ].join('; ');

  return makeReport({
    ...shared,
    value: lengthCv,
    threshold,
    status,
    detail,
    series: { lengthCv: coefficients, juvenileFraction: juvenileFractions, recruitment },
  });
}

export const ageStructureProbe: ProbeDefinition = {
  id: 'P17',
  name: 'Age structure',
  scenario: ONTOGENY_SCENARIO,
  severity: 'warn',
  evaluate: (runs) => runs.map(ageStructureReport),
  aggregate: {
    kind: 'k-of-n',
    minPassFraction: 1,
    label: 'age structure holds on all seeds',
  },
};
