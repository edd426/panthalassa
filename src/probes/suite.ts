/**
 * Suite composition: which scenarios run, on which seeds, for how many
 * generations, and which probes read the result.
 *
 * Two named suites plus whatever `--scenario` asks for:
 *
 * - **quick** (~4 minutes, every change) — one seed over `baseline`, `barrier`
 *   and `sweep`, plus the three standalone gates. The generation counts in
 *   `Scenario.quickGenerations` are sized against that budget *for a healthy
 *   world*: the budget is spent in organism-ticks, so a run that collapses
 *   early finishes early and the suite comes in well under time.
 * - **full** (`LONG_SIM=1`, gates and nightly) — three seeds over those three
 *   plus `speciation`, at the plan's generation counts. Probes with a declared
 *   cross-seed prevalence emit one additional suite-level row.
 *
 * The six mechanism-toggle scenarios are in neither: they exist for WP-A7's
 * marginal-contribution measurements and are reached with `--scenario=no-…`.
 * Six more long runs would put `probe:full` past its budget for numbers nobody
 * reads on a normal night.
 */

import type { ProbeReport, ProbeSuiteReport } from '../contracts/stats';
import type { RunResult } from './harness';
import { runScenario } from './harness';
import type { ProbeContext } from './probe';
import { kOfNReport } from './probe';
import { PROBES } from './probes/index';
import { scenarioByName } from './scenarios';
import { startStopwatch } from './timing';

export type SuiteName = 'quick' | 'full' | 'custom';

export interface SuiteOptions {
  readonly suite: SuiteName;
  readonly seeds: readonly string[];
  readonly scenarios: readonly string[];
  /** Overrides every scenario's own generation count; only `--generations` sets it. */
  readonly generations?: number;
  /**
   * Probe ids to evaluate, e.g. `['P4', 'P5']`. Everything runs when absent.
   * A7 will want to re-read one probe after a knob change without paying for
   * P1 and P12's own sims.
   */
  readonly probes?: readonly string[];
  /** Progress line per run. Silenced by the vitest wrapper. */
  readonly log?: (message: string) => void;
}

export interface SuiteResult {
  readonly report: ProbeSuiteReport;
  readonly runs: readonly RunResult[];
  /** Probe ids that had no run to read, e.g. P11 in the quick suite. */
  readonly skipped: readonly string[];
}

export const QUICK_SCENARIOS = ['baseline', 'barrier', 'sweep'] as const;
export const FULL_SCENARIOS = ['baseline', 'barrier', 'sweep', 'speciation'] as const;
export const QUICK_SEEDS = ['q1'] as const;
export const FULL_SEEDS = ['s1', 's2', 's3'] as const;

export function defaultSuiteOptions(suite: SuiteName): Pick<SuiteOptions, 'seeds' | 'scenarios'> {
  return suite === 'full'
    ? { seeds: [...FULL_SEEDS], scenarios: [...FULL_SCENARIOS] }
    : { seeds: [...QUICK_SEEDS], scenarios: [...QUICK_SCENARIOS] };
}

function generationsFor(scenarioName: string, options: SuiteOptions): number {
  if (options.generations !== undefined) return options.generations;
  const scenario = scenarioByName(scenarioName);
  return options.suite === 'quick' ? scenario.quickGenerations : scenario.generations;
}

export function runSuite(options: SuiteOptions): SuiteResult {
  const log = options.log ?? ((): void => undefined);
  const stopwatch = startStopwatch();
  const runs: RunResult[] = [];
  const wanted = options.probes;
  const selectedProbes = PROBES.filter((probe) => wanted === undefined || wanted.includes(probe.id));
  const scenarioNames = [...options.scenarios];
  for (const probe of selectedProbes) {
    if (!options.scenarios.includes(probe.scenario)) continue;
    for (const companion of probe.companionScenarios ?? []) {
      if (!scenarioNames.includes(companion)) scenarioNames.push(companion);
    }
  }

  for (const scenarioName of scenarioNames) {
    const scenario = scenarioByName(scenarioName);
    const generations = generationsFor(scenarioName, options);
    for (const seed of options.seeds) {
      log(`  running ${scenarioName} · seed ${seed} · ${generations} generations`);
      const run = runScenario({ scenario, seed, generations });
      runs.push(run);
      log(
        `    → generation ${run.generationsRun.toFixed(1)}, ${run.rows.length} samples, ${run.births} births${
          run.extinctGeneration === null ? '' : `, EXTINCT at generation ${run.extinctGeneration.toFixed(1)}`
        }`,
      );
    }
  }

  const context: ProbeContext = {
    suite: options.suite,
    runs,
    runsFor: (scenario) => runs.filter((run) => run.scenario === scenario),
  };

  const reports: ProbeReport[] = [];
  const skipped: string[] = [];
  for (const probe of PROBES) {
    if (wanted !== undefined && !wanted.includes(probe.id)) {
      skipped.push(`${probe.id} (not selected)`);
      continue;
    }
    if (probe.standalone === true) {
      log(`  probe ${probe.id} (${probe.name})`);
      reports.push(...probe.evaluate([], context));
      continue;
    }
    const forProbe = context.runsFor(probe.scenario);
    if (forProbe.length === 0) {
      skipped.push(`${probe.id} (needs ${probe.scenario})`);
      continue;
    }
    const evaluated = probe.evaluate(forProbe, context);
    reports.push(...evaluated);
    if (probe.aggregate?.kind === 'k-of-n') {
      const aggregate = kOfNReport(
        probe,
        evaluated,
        forProbe,
        probe.aggregate.minPassFraction,
        probe.aggregate.label,
      );
      if (aggregate !== null) reports.push(aggregate);
    } else if (probe.aggregate?.kind === 'custom' && forProbe.length > 1) {
      reports.push(...probe.aggregate.evaluate(forProbe, evaluated, context));
    }
  }

  const status: ProbeSuiteReport['status'] = reports.some((report) => report.status === 'fail')
    ? 'fail'
    : reports.some((report) => report.status === 'warn')
      ? 'warn'
      : 'pass';

  return {
    report: {
      suite: options.suite,
      startedAtTick: 0,
      seeds: [...options.seeds],
      reports,
      status,
      durationMs: stopwatch.stop(),
    },
    runs,
    skipped,
  };
}
