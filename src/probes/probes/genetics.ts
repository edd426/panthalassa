/**
 * P4 (variance maintained), P5 (no flatline), P13 (heritability sane) and
 * P14 (drift real) — the four probes that ask whether evolution is still
 * *possible*, rather than whether the world is merely still populated.
 *
 * These are the herdloom post-mortem turned into assertions. Herdloom's
 * founder variance collapsed, its traits hit a ceiling in four generations and
 * then never moved again, and nothing measured either fact until the project
 * was already dead. P4 and P5 are the two probes that would have caught it.
 */

import type { ProbeReport, SampleRow } from '../../contracts/stats';
import { FOCAL_TRAIT_KEYS } from '../../contracts/traits';
import type { TraitKey } from '../../contracts/traits';
import type { RunResult } from '../harness';
import { comparisonWindows, finite, inGenerations, lastGeneration, median, postBurnIn } from '../metrics';
import type { ProbeDefinition } from '../probe';
import { makeReport, notEvaluable, statusFor, worstStatus } from '../probe';

// ---------------------------------------------------------------------------
// P4 — variance maintained
// ---------------------------------------------------------------------------

const VARIANCE_RATIO_MIN = 0.25;
const VARIANCE_RATIO_MAX = 8;

function meanAdditiveVariance(rows: readonly SampleRow[], trait: TraitKey): number {
  if (rows.length === 0) return Number.NaN;
  let total = 0;
  for (const row of rows) total += row.traits[trait].additiveVariance;
  return total / rows.length;
}

function varianceReport(run: RunResult): ProbeReport {
  const rows = postBurnIn(run);
  const windows = comparisonWindows(run);
  const threshold = {
    min: VARIANCE_RATIO_MIN,
    max: VARIANCE_RATIO_MAX,
    label: `V_A late / V_A early ∈ [${VARIANCE_RATIO_MIN}, ${VARIANCE_RATIO_MAX}]`,
  };
  const shared = {
    probeId: 'P4',
    name: 'Variance maintained',
    scenario: run.scenario,
    seed: run.seed,
    severity: 'warn' as const,
    generationsRun: run.generationsRun,
  };

  const early = inGenerations(run.rows, windows.early[0], windows.early[1]);
  const late = inGenerations(run.rows, windows.late[0], windows.late[1]);
  if (early.length === 0 || late.length === 0 || rows.length === 0) {
    return notEvaluable({
      ...shared,
      threshold,
      detail: `no comparable windows: the run reached generation ${lastGeneration(run).toFixed(1)}${
        run.extinctGeneration === null ? '' : ` (extinct at ${run.extinctGeneration.toFixed(1)})`
      }`,
    });
  }

  const ratios = FOCAL_TRAIT_KEYS.map((trait) => {
    const before = meanAdditiveVariance(early, trait);
    const after = meanAdditiveVariance(late, trait);
    return { trait, ratio: before > 0 ? after / before : Number.NaN };
  });

  const statuses = ratios.map((entry) => statusFor(entry.ratio, threshold, 'warn'));
  // The most extreme ratio in log space is the headline: collapse and runaway
  // are both failures, and the mean of four ratios would hide either.
  const extreme = ratios.reduce((worst, entry) => {
    const distance = Number.isFinite(entry.ratio) ? Math.abs(Math.log(entry.ratio)) : Infinity;
    const best = Number.isFinite(worst.ratio) ? Math.abs(Math.log(worst.ratio)) : Infinity;
    return distance > best ? entry : worst;
  });

  const detail = [
    ratios.map((entry) => `${entry.trait} ${Number.isFinite(entry.ratio) ? entry.ratio.toFixed(2) : 'n/a'}`).join(', '),
    `generations ${windows.early[0].toFixed(0)}–${windows.early[1].toFixed(0)} vs ${windows.late[0].toFixed(0)}–${windows.late[1].toFixed(0)}`,
    windows.canonical ? "the plan's windows" : 'WINDOWS RESCALED — the run was too short for generations 20–50 vs 250–300',
  ].join('; ');

  return makeReport({
    ...shared,
    value: extreme.ratio,
    threshold,
    status: worstStatus(statuses),
    detail,
    series: Object.fromEntries(
      FOCAL_TRAIT_KEYS.map((trait) => [`V_A:${trait}`, rows.map((row) => row.traits[trait].additiveVariance)]),
    ),
  });
}

export const varianceProbe: ProbeDefinition = {
  id: 'P4',
  name: 'Variance maintained',
  scenario: 'baseline',
  severity: 'warn',
  evaluate: (runs) => runs.map(varianceReport),
};

// ---------------------------------------------------------------------------
// P5 — no flatline
// ---------------------------------------------------------------------------

/** Movement, in population SDs, that counts as a trait still going somewhere. */
const FLATLINE_MOVEMENT_SD = 0.3;
/** Focal traits that must clear it. */
const FLATLINE_TRAITS_REQUIRED = 2;
const FLATLINE_WINDOW_GENERATIONS = 50;

/** Largest |Δmean| in SD units over any window of up to `span` generations. */
function largestMove(rows: readonly SampleRow[], trait: TraitKey, span: number): number {
  let best = 0;
  for (let start = 0; start < rows.length; start += 1) {
    const from = rows[start];
    if (from === undefined) continue;
    for (let end = start + 1; end < rows.length; end += 1) {
      const to = rows[end];
      if (to === undefined) break;
      if (to.generation - from.generation > span) break;
      let sdTotal = 0;
      let sdCount = 0;
      for (let index = start; index <= end; index += 1) {
        const sd = rows[index]?.traits[trait].sd ?? 0;
        if (sd > 0) {
          sdTotal += sd;
          sdCount += 1;
        }
      }
      if (sdCount === 0) continue;
      const move = Math.abs(to.traits[trait].mean - from.traits[trait].mean) / (sdTotal / sdCount);
      if (move > best) best = move;
    }
  }
  return best;
}

function flatlineReport(run: RunResult): ProbeReport {
  const rows = postBurnIn(run);
  const threshold = {
    min: FLATLINE_TRAITS_REQUIRED,
    label: `≥${FLATLINE_TRAITS_REQUIRED} of 4 focal traits move ≥${FLATLINE_MOVEMENT_SD} SD in a ${FLATLINE_WINDOW_GENERATIONS}-generation window`,
  };
  const shared = {
    probeId: 'P5',
    name: 'No flatline',
    scenario: run.scenario,
    seed: run.seed,
    severity: 'warn' as const,
    generationsRun: run.generationsRun,
  };

  if (rows.length < 3) {
    return notEvaluable({
      ...shared,
      threshold,
      detail: `only ${rows.length} samples past the burn-in; the run reached generation ${lastGeneration(run).toFixed(1)}`,
    });
  }

  const first = rows[0] as SampleRow;
  const last = rows[rows.length - 1] as SampleRow;
  const finalThird = inGenerations(
    rows,
    first.generation + ((last.generation - first.generation) * 2) / 3,
    last.generation + 1,
  );
  const window = finalThird.length >= 2 ? finalThird : rows;
  const span = Math.min(
    FLATLINE_WINDOW_GENERATIONS,
    (window[window.length - 1]?.generation ?? 0) - (window[0]?.generation ?? 0),
  );

  const moves = FOCAL_TRAIT_KEYS.map((trait) => ({
    trait,
    move: largestMove(window, trait, Math.max(span, 1e-9)),
  }));
  const moving = moves.filter((entry) => entry.move >= FLATLINE_MOVEMENT_SD).length;

  const detail = [
    moves.map((entry) => `${entry.trait} ${entry.move.toFixed(2)}`).join(', '),
    `last third = generations ${(window[0]?.generation ?? 0).toFixed(0)}–${(window[window.length - 1]?.generation ?? 0).toFixed(0)}`,
    span < FLATLINE_WINDOW_GENERATIONS
      ? `WINDOW SHORT — ${span.toFixed(0)} generations, not ${FLATLINE_WINDOW_GENERATIONS}`
      : `${FLATLINE_WINDOW_GENERATIONS}-generation windows`,
  ].join('; ');

  return makeReport({ ...shared, value: moving, threshold, detail });
}

export const flatlineProbe: ProbeDefinition = {
  id: 'P5',
  name: 'No flatline',
  scenario: 'baseline',
  severity: 'warn',
  evaluate: (runs) => runs.map(flatlineReport),
};

// ---------------------------------------------------------------------------
// P13 — heritability sane
// ---------------------------------------------------------------------------

const H2_MIN = 0.2;
const H2_MAX = 0.8;

function heritabilityReport(run: RunResult): ProbeReport {
  const rows = postBurnIn(run);
  const slopes = finite(rows.map((row) => row.popgen.midparentH2Size));
  const threshold = { min: H2_MIN, max: H2_MAX, label: `midparent h²(size) ∈ [${H2_MIN}, ${H2_MAX}]` };
  const shared = {
    probeId: 'P13',
    name: 'Heritability sane',
    scenario: run.scenario,
    seed: run.seed,
    severity: 'warn' as const,
    generationsRun: run.generationsRun,
  };

  if (slopes.length === 0) {
    return notEvaluable({
      ...shared,
      threshold,
      detail: `no midparent regression available in ${rows.length} post-burn-in samples — not enough mated pairs accumulated`,
    });
  }

  const value = median(slopes);
  const variance = median(rows.map((row) => row.traits.size.heritability));
  return makeReport({
    ...shared,
    value,
    threshold,
    detail: `median of ${slopes.length} samples; V_A/V_P for size reads ${Number.isFinite(variance) ? variance.toFixed(2) : 'n/a'}`,
    series: { midparentH2Size: slopes },
  });
}

export const heritabilityProbe: ProbeDefinition = {
  id: 'P13',
  name: 'Heritability sane',
  scenario: 'baseline',
  severity: 'warn',
  evaluate: (runs) => runs.map(heritabilityReport),
};

// ---------------------------------------------------------------------------
// P14 — drift real
// ---------------------------------------------------------------------------

const NE_RATIO_MIN = 0.1;
const NE_RATIO_MAX = 1.2;

function driftReport(run: RunResult): ProbeReport {
  const rows = postBurnIn(run);
  // `neTemporal` is null until a full temporal window exists and for
  // non-identifiable estimates (no observed frequency change, or F ≥ 1). Those
  // are right-censored readings, not small ones: folding them in as a number
  // would drag the median toward whatever sentinel was chosen and let P14 pass
  // on samples that never measured drift at all.
  const ratios = finite(
    rows.map((row) => {
      const ne = row.popgen.neTemporal;
      return ne !== null && row.population > 0 ? ne / row.population : null;
    }),
  );
  const censored = rows.length - ratios.length;
  const threshold = { min: NE_RATIO_MIN, max: NE_RATIO_MAX, label: `temporal Ne ∈ [${NE_RATIO_MIN}N, ${NE_RATIO_MAX}N]` };
  const shared = {
    probeId: 'P14',
    name: 'Drift real',
    scenario: run.scenario,
    seed: run.seed,
    severity: 'warn' as const,
    generationsRun: run.generationsRun,
  };

  if (ratios.length === 0) {
    return notEvaluable({
      ...shared,
      threshold,
      detail: `temporal Ne needs neutral-marker frequencies ${run.config.sampling.temporalNeWindowGenerations} generations apart; all ${rows.length} post-burn-in samples were null (no baseline yet, or a non-identifiable estimate)`,
    });
  }

  const demographic = finite(rows.map((row) => row.popgen.neDemographic));
  return makeReport({
    ...shared,
    value: median(ratios),
    threshold,
    detail: `median of ${ratios.length} identifiable samples${
      censored > 0 ? ` (${censored} of ${rows.length} right-censored, excluded)` : ''
    }; demographic Ne reads ${demographic.length > 0 ? median(demographic).toFixed(0) : 'n/a'}`,
    series: { neTemporalOverN: ratios },
  });
}

export const driftProbe: ProbeDefinition = {
  id: 'P14',
  name: 'Drift real',
  scenario: 'baseline',
  severity: 'warn',
  evaluate: (runs) => runs.map(driftReport),
};
