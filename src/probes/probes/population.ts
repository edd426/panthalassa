/**
 * P3 (viability), P6 (no dead loci) and P7 (mortality mix) — the three probes
 * that read a baseline run and ask whether the world is a going concern.
 *
 * P3 is a **gate** as of A7's ratchet: the tuned ecology held it at 1.00 on
 * three seeds, and every other reading in the suite is meaningless over an
 * empty ocean. P6 and P7 stay `warn` because they are still red at the tuned
 * config — they are the probes most likely to be red on an untuned model, and
 * that is what they are for.
 */

import { DISCRETE_LOCI, NEUTRAL_MARKER_LOCI } from '../../contracts/genome';
import type { ProbeReport, SampleRow } from '../../contracts/stats';
import type { RunResult } from '../harness';
import type { ProbeDefinition } from '../probe';
import { breach, makeReport, notEvaluable, statusFor, worstStatus } from '../probe';
import {
  ENDOGENOUS_DEATH_CAUSES,
  endogenousDeathShares,
  lastGeneration,
  lastGenerations,
  postBurnIn,
} from '../metrics';

// ---------------------------------------------------------------------------
// P3 — viability
// ---------------------------------------------------------------------------

const POPULATION_FLOOR = 100;
const POPULATION_CEILING = 3500;
/** Fraction of samples allowed to sit against the slot cap before the cap counts as an ecological limit. */
const CAP_BOUND_ALLOWANCE = 0.05;
/**
 * Ratcheted to a gate by A7 once the tuned ecology held 1.00 on three seeds at
 * 300 generations. Viability is the one reading with no interpretation in it:
 * either the world is populated for the whole run or the rest of the suite is
 * measuring an empty ocean.
 */
const P3_SEVERITY = 'gate' as const;
/** Ratcheted from 0.98: three seeds achieved 1.00, so 0.99 sits just below. */
const P3_IN_RANGE_MIN = 0.99;

function p3Threshold(): { min: number; label: string } {
  return {
    min: P3_IN_RANGE_MIN,
    label: `pop ∈ [${POPULATION_FLOOR}, ${POPULATION_CEILING}] ≥${(P3_IN_RANGE_MIN * 100).toFixed(0)}%; never empty; cap <${CAP_BOUND_ALLOWANCE * 100}%; dropped births = 0`,
  };
}

export function viabilityReport(run: RunResult): ProbeReport {
  const rows = postBurnIn(run);
  const shared = {
    probeId: 'P3',
    name: 'Viability',
    scenario: run.scenario,
    seed: run.seed,
    severity: P3_SEVERITY,
    generationsRun: run.generationsRun,
  };
  if (rows.length === 0) {
    return notEvaluable({
      ...shared,
      threshold: p3Threshold(),
      detail:
        run.extinctGeneration === null
          ? `no samples past the ${run.config.sampling.burnInGenerations}-generation burn-in (run reached generation ${lastGeneration(run).toFixed(1)})`
          : `population reached zero at generation ${run.extinctGeneration.toFixed(1)}, before the burn-in ended`,
    });
  }

  const capacity = run.config.world.slotCapacity;
  let inRange = 0;
  let atCap = 0;
  let minimum = Infinity;
  let maximum = 0;
  for (const row of rows) {
    if (row.population >= POPULATION_FLOOR && row.population <= POPULATION_CEILING) inRange += 1;
    if (row.population >= capacity) atCap += 1;
    if (row.population < minimum) minimum = row.population;
    if (row.population > maximum) maximum = row.population;
  }
  const inRangeFraction = inRange / rows.length;
  const capFraction = atCap / rows.length;
  const threshold = p3Threshold();

  const status = worstStatus([
    statusFor(inRangeFraction, threshold, P3_SEVERITY),
    run.extinctGeneration === null ? 'pass' : breach(P3_SEVERITY),
    capFraction < CAP_BOUND_ALLOWANCE ? 'pass' : breach(P3_SEVERITY),
    // Any dropped birth means the container, rather than the modeled density
    // processes, interfered with the trajectory this certificate describes.
    run.diagnostics.birthsDropped === 0 ? 'pass' : breach(P3_SEVERITY),
  ]);

  const detail = [
    `population ${minimum}–${maximum} over ${rows.length} samples`,
    run.extinctGeneration === null
      ? 'never empty'
      : `EMPTY at generation ${run.extinctGeneration.toFixed(1)}`,
    `${(capFraction * 100).toFixed(1)}% of samples at the ${capacity}-slot cap`,
    `${run.diagnostics.birthsDropped} births dropped (required 0)`,
  ].join('; ');

  return makeReport({ ...shared, value: inRangeFraction, threshold, status, detail });
}

export const viabilityProbe: ProbeDefinition = {
  id: 'P3',
  name: 'Viability',
  scenario: 'baseline',
  severity: P3_SEVERITY,
  evaluate: (runs) => runs.map(viabilityReport),
};

// ---------------------------------------------------------------------------
// P6 — no dead loci
// ---------------------------------------------------------------------------

const QUANT_VARIANCE_FRACTION = 0.8;
const MIN_NEUTRAL_ALLELES = 2;

/** Discrete loci fixed on a single allele in the final sample, as `locus:allele`. */
function fixedDiscreteLoci(row: SampleRow): string[] {
  const fixed: string[] = [];
  for (const locus of DISCRETE_LOCI) {
    const frequencies = row.discreteAlleleFreq[locus.id];
    const carried = frequencies.map((frequency, allele) => ({ frequency, allele })).filter((entry) => entry.frequency > 0);
    if (carried.length === 1) fixed.push(`${locus.id}:${carried[0]?.allele ?? 0}`);
  }
  return fixed;
}

function lociReport(run: RunResult): ProbeReport {
  const rows = postBurnIn(run);
  const final = rows[rows.length - 1];
  const shared = {
    probeId: 'P6',
    name: 'No dead loci',
    scenario: run.scenario,
    seed: run.seed,
    severity: 'warn' as const,
    generationsRun: run.generationsRun,
  };
  const threshold = { min: QUANT_VARIANCE_FRACTION, label: '≥80% of quantitative loci retain variance' };

  if (final === undefined) {
    return notEvaluable({
      ...shared,
      threshold,
      detail: `no samples past the ${run.config.sampling.burnInGenerations}-generation burn-in`,
    });
  }

  const neutralAlleleCounts = NEUTRAL_MARKER_LOCI.map((locus) => ({
    locus: locus.id,
    alleles: final.discreteAlleleFreq[locus.id].filter((frequency) => frequency > 0).length,
  }));
  const starvedMarkers = neutralAlleleCounts.filter((entry) => entry.alleles < MIN_NEUTRAL_ALLELES);
  const fixed = fixedDiscreteLoci(final);

  const status = worstStatus([
    statusFor(final.quantLociWithVariance, threshold, 'warn'),
    starvedMarkers.length === 0 ? 'pass' : breach('warn'),
  ]);

  const detail = [
    `${(final.quantLociWithVariance * 100).toFixed(0)}% of quantitative loci above the variance floor at generation ${final.generation.toFixed(0)}`,
    `neutral markers hold ${neutralAlleleCounts.map((entry) => entry.alleles).join('/')} of 8 alleles`,
    fixed.length === 0 ? 'no discrete locus fixed' : `fixed: ${fixed.join(', ')}`,
  ].join('; ');

  return makeReport({
    ...shared,
    value: final.quantLociWithVariance,
    threshold,
    status,
    detail,
    series: { quantLociWithVariance: rows.map((row) => row.quantLociWithVariance) },
  });
}

/**
 * The cross-replicate half of P6: a discrete locus fixed on the *same* allele
 * in every replicate is a dead locus; one that fixes on different alleles in
 * different runs is drift doing its job.
 */
function lociReplicateReport(runs: readonly RunResult[]): ProbeReport | null {
  if (runs.length < 2) return null;
  const perRun = runs.map((run) => {
    const rows = postBurnIn(run);
    const final = rows[rows.length - 1];
    return final === undefined ? null : new Set(fixedDiscreteLoci(final));
  });
  if (perRun.some((entry) => entry === null)) return null;

  const first = perRun[0] as Set<string>;
  const sharedFixations = [...first].filter((entry) => perRun.every((set) => (set as Set<string>).has(entry)));

  return makeReport({
    probeId: 'P6',
    name: 'No dead loci (across replicates)',
    scenario: runs[0]?.scenario ?? 'baseline',
    seed: `${runs.length} seeds`,
    severity: 'warn',
    value: sharedFixations.length,
    threshold: { max: 0, label: 'discrete loci fixed on the same allele in every replicate = 0' },
    generationsRun: Math.min(...runs.map((run) => run.generationsRun)),
    detail:
      sharedFixations.length === 0
        ? 'no discrete locus fixed identically across replicates'
        : `fixed everywhere: ${sharedFixations.join(', ')}`,
  });
}

export const lociProbe: ProbeDefinition = {
  id: 'P6',
  name: 'No dead loci',
  scenario: 'baseline',
  severity: 'warn',
  evaluate: (runs) => runs.map(lociReport),
  aggregate: {
    kind: 'custom',
    evaluate(runs) {
      const replicate = lociReplicateReport(runs);
      return replicate === null ? [] : [replicate];
    },
  },
};

// ---------------------------------------------------------------------------
// P7 — mortality mix
// ---------------------------------------------------------------------------

const MIN_CHANNEL_SHARE = 0.05;
const MAX_CHANNEL_SHARE = 0.7;
/** Generations the mix is assessed over. */
const MORTALITY_WINDOW_GENERATIONS = 100;

function mortalityReport(run: RunResult): ProbeReport {
  const available = postBurnIn(run);
  const rows = lastGenerations(available, MORTALITY_WINDOW_GENERATIONS);
  const shared = {
    probeId: 'P7',
    name: 'Mortality mix',
    scenario: run.scenario,
    seed: run.seed,
    severity: 'warn' as const,
    generationsRun: run.generationsRun,
  };
  const threshold = {
    min: MIN_CHANNEL_SHARE,
    max: MAX_CHANNEL_SHARE,
    label: 'each endogenous channel ∈ [5%, 70%] of deaths',
  };

  const shares = endogenousDeathShares(rows);
  if (shares === null) {
    return notEvaluable({
      ...shared,
      threshold,
      detail:
        available.length === 0
          ? `no samples past the ${run.config.sampling.burnInGenerations}-generation burn-in`
          : 'no endogenous deaths in the assessment window',
    });
  }

  const values = ENDOGENOUS_DEATH_CAUSES.map((cause) => shares[cause]);
  const status = worstStatus(values.map((share) => statusFor(share, threshold, 'warn')));
  const span = rows.length > 0 ? Math.min(MORTALITY_WINDOW_GENERATIONS, run.generationsRun) : 0;

  const detail = [
    ENDOGENOUS_DEATH_CAUSES.map((cause) => `${cause} ${(shares[cause] * 100).toFixed(0)}%`).join(', '),
    `over the last ${span.toFixed(0)} generations; catastrophe excluded by design`,
  ].join('; ');

  return makeReport({
    ...shared,
    // The minimum share is what usually binds: the failure mode is a channel
    // that carries nothing, not one that carries too much.
    value: Math.min(...values),
    threshold,
    status,
    detail,
  });
}

export const mortalityProbe: ProbeDefinition = {
  id: 'P7',
  name: 'Mortality mix',
  scenario: 'baseline',
  severity: 'warn',
  evaluate: (runs) => runs.map(mortalityReport),
};
