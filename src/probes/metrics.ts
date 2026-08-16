/**
 * Window arithmetic and the small statistics every probe repeats.
 *
 * All of it is denominated in **generations**, because that is the unit the
 * plan's probe table is written in and the only unit that stays meaningful when
 * A7 retunes `generationTicks`. A threshold expressed in ticks would silently
 * change meaning the moment generation length moved.
 */

import type { SampleRow } from '../contracts/stats';
import type { DeathCause } from '../contracts/types';
import { BIOMASS_COLUMN } from '../stats/detection';
import type { RunResult } from './harness';

/**
 * The four channels P7 asserts over.
 *
 * `catastrophe` is excluded by design: it is the meteor god-tool, the user's
 * hand rather than selection, and a probe that counted it would report a
 * healthy mortality mix for a world where the user had just killed everything.
 */
export const ENDOGENOUS_DEATH_CAUSES = [
  'starvation',
  'predation',
  'temperature',
  'senescence',
] as const satisfies readonly DeathCause[];

/** Rows after the configured burn-in. Every probe window starts here. */
export function postBurnIn(run: RunResult): readonly SampleRow[] {
  const burnIn = run.config.sampling.burnInGenerations;
  return run.rows.filter((row) => row.generation >= burnIn);
}

/**
 * Σ realised length over the living population, post-burn-in, cm — the series
 * P3's band is stated in.
 *
 * It comes off the recorder's scalar columns rather than `SampleRow` because
 * `SampleRow` is a frozen contract and because a serialised field would break
 * the off-arm JSONL's byte-identity. That makes the alignment between the
 * column and `run.rows` load-bearing: the recorder appends exactly one column
 * entry per appended row, and the harness drains every row, so the two are
 * parallel. **Null** rather than a guess when they are not, or when the run
 * carries no recorder at all — a viability gate that quietly evaluated a
 * misaligned series would be worse than one that says it could not measure.
 */
export function postBurnInBiomass(run: RunResult): readonly number[] | null {
  const column = run.stats?.column(BIOMASS_COLUMN) ?? null;
  if (column === null || column.length !== run.rows.length) return null;
  const burnIn = run.config.sampling.burnInGenerations;
  const series: number[] = [];
  for (let index = 0; index < run.rows.length; index += 1) {
    if ((run.rows[index]?.generation ?? -1) < burnIn) continue;
    series.push(column[index] ?? Number.NaN);
  }
  return series;
}

/** Rows whose generation falls in `[from, to)`. */
export function inGenerations(
  rows: readonly SampleRow[],
  from: number,
  to: number,
): readonly SampleRow[] {
  return rows.filter((row) => row.generation >= from && row.generation < to);
}

/** The last `span` generations of `rows`. */
export function lastGenerations(rows: readonly SampleRow[], span: number): readonly SampleRow[] {
  const final = rows[rows.length - 1];
  if (final === undefined) return [];
  return inGenerations(rows, final.generation - span, final.generation + 1);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[middle] ?? Number.NaN;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Finite entries only — an estimator that returned null or NaN must not poison a mean. */
export function finite(values: readonly (number | null)[]): number[] {
  const out: number[] = [];
  for (const value of values) {
    if (value !== null && Number.isFinite(value)) out.push(value);
  }
  return out;
}

/**
 * Deaths per endogenous channel over `rows`, as fractions of the endogenous
 * total. Returns null when nothing died, which is a different statement from
 * "every channel was at zero percent".
 */
export function endogenousDeathShares(
  rows: readonly SampleRow[],
): Readonly<Record<(typeof ENDOGENOUS_DEATH_CAUSES)[number], number>> | null {
  const totals = { starvation: 0, predation: 0, temperature: 0, senescence: 0 };
  let sum = 0;
  for (const row of rows) {
    for (const cause of ENDOGENOUS_DEATH_CAUSES) {
      totals[cause] += row.deaths[cause];
      sum += row.deaths[cause];
    }
  }
  if (sum <= 0) return null;
  return {
    starvation: totals.starvation / sum,
    predation: totals.predation / sum,
    temperature: totals.temperature / sum,
    senescence: totals.senescence / sum,
  };
}

/**
 * The early and late comparison windows for P4 and P9.
 *
 * The plan writes them as generations 20–50 against 250–300, which presumes a
 * run that reaches 300. A shorter run gets proportionally placed windows
 * instead of no answer at all — but the probe says which it used in its detail
 * line, because "V_A held between generation 32 and generation 55" is a much
 * weaker statement than the plan's and must not be read as the same one.
 */
export interface ComparisonWindows {
  readonly early: readonly [number, number];
  readonly late: readonly [number, number];
  /** True when the plan's authored windows were used verbatim. */
  readonly canonical: boolean;
}

const CANONICAL_EARLY: readonly [number, number] = [20, 50];
const CANONICAL_LATE: readonly [number, number] = [250, 300];

export function comparisonWindows(run: RunResult): ComparisonWindows {
  const end = lastGeneration(run);
  if (end >= CANONICAL_LATE[1]) {
    return { early: CANONICAL_EARLY, late: CANONICAL_LATE, canonical: true };
  }
  // The plan's windows as fractions of a 300-generation run, so a short run
  // compares the same *relative* places rather than an arbitrary pair. Note
  // that the early window deliberately sits inside the burn-in: P4 wants the
  // population's founding variance as its reference, which is the one quantity
  // the burn-in exclusion must not hide.
  const scale = end / CANONICAL_LATE[1];
  return {
    early: [CANONICAL_EARLY[0] * scale, Math.max(CANONICAL_EARLY[1] * scale, CANONICAL_EARLY[0] * scale + 1)],
    late: [CANONICAL_LATE[0] * scale, end + 1],
    canonical: false,
  };
}

/** Generation of the last recorded row, or 0 for an empty run. */
export function lastGeneration(run: RunResult): number {
  return run.rows[run.rows.length - 1]?.generation ?? 0;
}

/** `1.23` / `0.0041` / `1.4e+6` — table cells, sized so a column stays readable. */
export function formatValue(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude >= 1e5 || magnitude < 1e-3)) return value.toExponential(2);
  if (magnitude >= 100) return value.toFixed(0);
  if (magnitude >= 1) return value.toFixed(2);
  return value.toFixed(3);
}
