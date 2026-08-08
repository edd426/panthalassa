/**
 * Turning measurements into the two artifacts a probe run leaves behind: a
 * table on stdout and files under `runs/`.
 *
 * The table is deliberately plain text with no colour. It gets pasted into
 * work-package reports, DESIGN.md's tuning log and review threads, and escape
 * codes survive none of those.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import type { ProbeReport, ProbeSuiteReport } from '../contracts/stats';
import type { RunResult } from './harness';
import { formatValue } from './metrics';
import { formatDuration } from './timing';

/** `runs/`, resolved from this module rather than from the working directory. */
export function runsDirectory(): string {
  return fileURLToPath(new URL('../../runs/', import.meta.url));
}

export function suiteStatus(reports: readonly ProbeReport[]): ProbeSuiteReport['status'] {
  if (reports.some((report) => report.status === 'fail')) return 'fail';
  if (reports.some((report) => report.status === 'warn')) return 'warn';
  return 'pass';
}

function column(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

/** Threshold in the form the plan's probe table uses, e.g. `∈ [0.25, 8]`. */
function formatThreshold(report: ProbeReport): string {
  const { min, max } = report.threshold;
  if (min !== undefined && max !== undefined) return `[${formatValue(min)}, ${formatValue(max)}]`;
  if (min !== undefined) return `≥ ${formatValue(min)}`;
  if (max !== undefined) return `≤ ${formatValue(max)}`;
  return '—';
}

export function renderTable(suite: ProbeSuiteReport, skipped: readonly string[]): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`Panthalassa probe suite — ${suite.suite}`);
  lines.push(
    `seeds: ${suite.seeds.join(', ') || 'none'} · ${suite.reports.length} probe readings · ${formatDuration(suite.durationMs)}`,
  );
  lines.push('');
  lines.push(
    `${column('ID', 5)}${column('PROBE', 24)}${column('SCENARIO', 14)}${column('SEED', 10)}${column('VALUE', 11)}${column('THRESHOLD', 16)}${column('SEV', 6)}STATUS`,
  );
  lines.push('-'.repeat(92));

  for (const report of suite.reports) {
    lines.push(
      `${column(report.probeId, 5)}${column(report.name, 24)}${column(report.scenario, 14)}${column(report.seed, 10)}${column(
        formatValue(report.value),
        11,
      )}${column(formatThreshold(report), 16)}${column(report.severity, 6)}${report.status.toUpperCase()}`,
    );
    if (report.detail !== undefined) lines.push(`     └ ${report.detail}`);
  }

  lines.push('-'.repeat(92));
  lines.push(`suite: ${suite.status.toUpperCase()}`);
  if (skipped.length > 0) {
    lines.push(`not run in this suite: ${skipped.join(', ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

export interface WrittenArtifacts {
  readonly seriesFiles: readonly string[];
  readonly reportFile: string;
}

/**
 * One JSONL of `ProbeSeriesLine` per run plus the suite report as JSON.
 *
 * The JSONL is the eyeball format: `npm run probe -- --scenario=barrier` and
 * then plot `popgen.fstBarrier` against `generation` from the file. `runs/` is
 * gitignored.
 */
export function writeArtifacts(suite: ProbeSuiteReport, runs: readonly RunResult[]): WrittenArtifacts {
  const directory = runsDirectory();
  mkdirSync(directory, { recursive: true });

  const seriesFiles: string[] = [];
  for (const run of runs) {
    const path = join(directory, `${run.scenario}-${run.seed}.jsonl`);
    writeFileSync(path, run.stats.toJsonl(run.scenario, run.seed), 'utf8');
    seriesFiles.push(path);
  }

  const reportFile = join(directory, `${suite.suite}-report.json`);
  writeFileSync(reportFile, `${JSON.stringify(suite, null, 2)}\n`, 'utf8');
  return { seriesFiles, reportFile };
}
