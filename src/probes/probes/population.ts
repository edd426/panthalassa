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
import { BIOMASS_COLUMN } from '../../stats/detection';
import {
  ENDOGENOUS_DEATH_CAUSES,
  endogenousDeathShares,
  lastGeneration,
  lastGenerations,
  postBurnIn,
  postBurnInBiomass,
} from '../metrics';

// ---------------------------------------------------------------------------
// P3 — viability
// ---------------------------------------------------------------------------

/**
 * The band, in **biomass** — Σ realised length over the living population, cm.
 *
 * P3 used to bound head count, `pop ∈ [100, 3500]`. The G0 spec run broke that
 * statement rather than the world it describes: baseline-s3 evolved small
 * bodies (late mean 14.9 cm against 21.5 in the maxIntake-0.5 baseline), so the
 * same energy carried ~24% more heads, the census grazed the 4096-slot cap, and
 * P3 went red at 0.954 — while the standing crop sat *below* the reference
 * envelope. Biomass is the conserved quantity the band was always trying to
 * bound, and it stops meaning what it meant the moment an age structure exists
 * (DESIGN.md "G0 spec-length adjudication"; g-wave-design §4 G-A).
 *
 * Derivation of the two numbers, from the post-burn-in windows of the six
 * baseline seeds on file at the shipped config (`runs/full-4f54b9db-*` = the G0
 * spec run, `runs/full-c2fb508e-*` = the maxIntake-0.5 baseline; 1216 samples
 * each, config hash `5f6c53df8e063099`). Their biomass envelope is
 * [3493, 69301] cm. The floor sits at 4000 — **above** the lowest reading any
 * reference seed produced, so it genuinely bites; the single seed that dips
 * under it (c2fb508e-s1, minimum 3493) spends 0.41% of its window there, which
 * the ≥99% allowance absorbs. The ceiling sits at 62000 — **below** the highest
 * reading, for the same reason; it costs 4f54b9db-s1 0.25% of its window and
 * c2fb508e-s3 0.08%. Achieved in-band fraction over the six seeds: 0.9959 worst
 * (c2fb508e-s1), 1.0000 on three of them. Historical biomass is reconstructed
 * as census × softplus(latent mean size), which is Σ realised length exactly
 * with ontogeny off and differs from it by under 1e-6 cm at these operating
 * points, because `size` runs far above its 0.8 cm link scale.
 */
const BIOMASS_FLOOR_CM = 4_000;
const BIOMASS_CEILING_CM = 62_000;
/** Fraction of samples allowed to sit against the slot cap before the cap counts as an ecological limit. */
const CAP_BOUND_ALLOWANCE = 0.05;
/**
 * Attempted births the slot container is allowed to swallow.
 *
 * The G0 adjudication's explicit watch item: restating P3 in biomass must not
 * silently bless cap-and-starve, because the band exists to force density
 * dependence through resources. A hard `= 0` cannot survive the restatement —
 * it is a criterion about the container's size rather than about the world —
 * but the cap did *real regulation* on the artifact seed, so the replacement is
 * a bounded tolerance rather than nothing.
 *
 * Derived from the five spec-length seeds on file with nonzero drops. The
 * archive records drops only as a whole-run counter (`SimDiagnostics.
 * birthsDropped`) and carries no birth series, so matings are its only
 * denominator; converting needs a births-per-mating ratio, measured here as
 * 2.90/2.88/2.83 (baseline s1/s2/s3, 100 generations, zero drops, so every
 * attempted birth landed). At 2.87 the archive reads:
 *
 * - 4f54b9db-s3, the G0 artifact seed the adjudication says must pass: 10,843
 *   drops on 318,504 matings → **1.19%** of attempted births.
 * - ceefcd9e-s3, a seed where the cap did sustained regulation (10.6% of its
 *   late samples pressed against 4096): 32,405 on 355,961 → **3.17%**.
 * - 2199312f-s2 2.10%, 2199312f-s3 1.51%, ceefcd9e-s2 0.36%.
 *
 * 2% separates the artifact from sustained regulation with the artifact at
 * roughly half the bar, and the separation survives the conversion being wrong:
 * anywhere in a 2.5–3.5 births-per-mating range the artifact stays under 1.4%
 * and the regulated seed stays over 2.6%.
 */
const DROPPED_BIRTH_ALLOWANCE = 0.02;
/**
 * Ratcheted to a gate by A7 once the tuned ecology held 1.00 on three seeds at
 * 300 generations. Viability is the one reading with no interpretation in it:
 * either the world is populated for the whole run or the rest of the suite is
 * measuring an empty ocean.
 */
const P3_SEVERITY = 'gate' as const;
/**
 * Ratcheted from 0.98 by A7 when three seeds achieved 1.00. Carried through the
 * biomass restatement unchanged: the worst of the six reference seeds achieves
 * 0.9959 under the new band, so 0.99 still sits just below achieved.
 */
const P3_IN_RANGE_MIN = 0.99;

function p3Threshold(): { min: number; label: string } {
  return {
    min: P3_IN_RANGE_MIN,
    label: `biomass ∈ [${BIOMASS_FLOOR_CM}, ${BIOMASS_CEILING_CM}] cm ≥${(P3_IN_RANGE_MIN * 100).toFixed(0)}%; never empty; cap <${CAP_BOUND_ALLOWANCE * 100}%; dropped births ≤${(DROPPED_BIRTH_ALLOWANCE * 100).toFixed(0)}%`,
  };
}

/** Drops as a fraction of **attempted** births; 0 when nothing was ever born. */
export function droppedBirthFraction(births: number, dropped: number): number {
  const attempted = births + dropped;
  return attempted > 0 ? dropped / attempted : 0;
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

  const biomass = postBurnInBiomass(run);
  if (biomass === null || biomass.length !== rows.length) {
    return notEvaluable({
      ...shared,
      threshold: p3Threshold(),
      detail: `the recorder's '${BIOMASS_COLUMN}' series was unavailable or did not align with the ${rows.length} post-burn-in samples`,
    });
  }

  const capacity = run.config.world.slotCapacity;
  let inRange = 0;
  let atCap = 0;
  let minimum = Infinity;
  let maximum = 0;
  let biomassMinimum = Infinity;
  let biomassMaximum = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const standing = biomass[index] ?? Number.NaN;
    if (row === undefined) continue;
    if (standing >= BIOMASS_FLOOR_CM && standing <= BIOMASS_CEILING_CM) inRange += 1;
    if (standing < biomassMinimum) biomassMinimum = standing;
    if (standing > biomassMaximum) biomassMaximum = standing;
    if (row.population >= capacity) atCap += 1;
    if (row.population < minimum) minimum = row.population;
    if (row.population > maximum) maximum = row.population;
  }
  const inRangeFraction = inRange / rows.length;
  const capFraction = atCap / rows.length;
  const droppedFraction = droppedBirthFraction(run.births, run.diagnostics.birthsDropped);
  const threshold = p3Threshold();

  const status = worstStatus([
    statusFor(inRangeFraction, threshold, P3_SEVERITY),
    run.extinctGeneration === null ? 'pass' : breach(P3_SEVERITY),
    capFraction < CAP_BOUND_ALLOWANCE ? 'pass' : breach(P3_SEVERITY),
    // Not "the container never interfered" any more, but "the container was not
    // doing the regulating": sustained clipping means density dependence came
    // from the slot array rather than from the modelled resources.
    droppedFraction <= DROPPED_BIRTH_ALLOWANCE ? 'pass' : breach(P3_SEVERITY),
  ]);

  const detail = [
    `biomass ${biomassMinimum.toFixed(0)}–${biomassMaximum.toFixed(0)} cm over ${rows.length} samples (population ${minimum}–${maximum})`,
    run.extinctGeneration === null
      ? 'never empty'
      : `EMPTY at generation ${run.extinctGeneration.toFixed(1)}`,
    `${(capFraction * 100).toFixed(1)}% of samples at the ${capacity}-slot cap`,
    `${run.diagnostics.birthsDropped} of ${run.births + run.diagnostics.birthsDropped} attempted births dropped (${(droppedFraction * 100).toFixed(2)}%, allowed ${(DROPPED_BIRTH_ALLOWANCE * 100).toFixed(0)}%)`,
  ].join('; ');

  return makeReport({ ...shared, value: inRangeFraction, threshold, status, detail, series: { biomassCm: biomass } });
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
