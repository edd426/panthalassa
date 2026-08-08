/**
 * What a probe is, and how a measurement becomes a `ProbeReport`.
 *
 * The severity split is the orchestrator's ruling and it is deliberate: **P1
 * and P2 gate from day one** because determinism and RNG hygiene are properties
 * of the *code*, and a regression in either is a bug no amount of tuning fixes.
 * Every other probe starts at `warn`, because the simulation is untuned and the
 * aliveness thresholds describe where WP-A7 has to get it to — not where an
 * untuned model is expected to be. Turning those into gates now would only
 * teach everyone to ignore a red suite.
 *
 * P12 (throughput) gated from day one on the same code-property argument and
 * was demoted to `warn` by A7: its 2×10⁶ target was authored before the model
 * existed and the remaining gap is model decisions rather than optimisation.
 * See `probes/performance.ts` and DESIGN.md's "Fix wave F0–F4"; Gate A-2 owns
 * the threshold.
 *
 * A7 flips each one to `gate` as it demonstrably passes on three seeds. Until
 * then a warn-severity breach reports yellow and the suite still exits 0.
 */

import type { ProbeReport, ProbeSeverity, ProbeStatus, ProbeThreshold } from '../contracts/stats';
import type { RunResult } from './harness';

export interface ProbeContext {
  readonly suite: 'quick' | 'full' | 'custom';
  /** Every run in the suite, so a probe that needs replicates can find its own. */
  readonly runs: readonly RunResult[];
  runsFor(scenario: string): readonly RunResult[];
}

export interface ProbeDefinition {
  /** `P1`…`P14`, matching the plan's probe table. */
  readonly id: string;
  readonly name: string;
  /** Scenario whose runs this probe reads. */
  readonly scenario: string;
  readonly severity: ProbeSeverity;
  /**
   * Probes that build their own sims (P1 needs a snapshot round-trip, P2 reads
   * source files, P12 owns its timing loop) rather than reading a scenario run.
   */
  readonly standalone?: boolean;
  evaluate(runs: readonly RunResult[], context: ProbeContext): readonly ProbeReport[];
}

/**
 * Threshold verdict.
 *
 * A breach is `fail` for a gate and `warn` for a warn-severity probe, so the
 * suite rule stays "fail if any report says fail" and a reader of the table
 * never has to cross-reference the severity column to know whether a red cell
 * mattered. A value that could not be measured at all is a breach too — a probe
 * that quietly passes because its window was empty is worse than one that fails.
 */
export function statusFor(value: number, threshold: ProbeThreshold, severity: ProbeSeverity): ProbeStatus {
  const breached = severity === 'gate' ? 'fail' : 'warn';
  if (!Number.isFinite(value)) return breached;
  if (threshold.min !== undefined && value < threshold.min) return breached;
  if (threshold.max !== undefined && value > threshold.max) return breached;
  return 'pass';
}

export interface ReportInput {
  readonly probeId: string;
  readonly name: string;
  readonly scenario: string;
  readonly seed: string;
  readonly severity: ProbeSeverity;
  readonly value: number;
  readonly threshold: ProbeThreshold;
  readonly generationsRun: number;
  /** Set when the verdict is not a plain band check on `value` — a probe with several sub-assertions. */
  readonly status?: ProbeStatus;
  readonly detail?: string;
  readonly series?: Readonly<Record<string, readonly number[]>>;
}

export function makeReport(input: ReportInput): ProbeReport {
  const status = input.status ?? statusFor(input.value, input.threshold, input.severity);
  const base = {
    probeId: input.probeId,
    name: input.name,
    scenario: input.scenario,
    seed: input.seed,
    value: input.value,
    threshold: input.threshold,
    status,
    severity: input.severity,
    generationsRun: input.generationsRun,
  };
  // `exactOptionalPropertyTypes` makes an explicit `undefined` a different
  // thing from an absent key, so the optional fields are spread in only when
  // they exist.
  return {
    ...base,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    ...(input.series === undefined ? {} : { series: input.series }),
  };
}

/**
 * Combine several sub-assertion verdicts.
 *
 * The worst one wins, so a probe whose headline number sits inside its band but
 * whose secondary assertion failed still reports red.
 */
export function worstStatus(statuses: readonly ProbeStatus[]): ProbeStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

/** A breach of this probe's severity: `fail` for a gate, `warn` otherwise. */
export function breach(severity: ProbeSeverity): ProbeStatus {
  return severity === 'gate' ? 'fail' : 'warn';
}

/**
 * The report a probe files when its scenario never reached the state it
 * measures — an extinct world, a window with no rows, an intervention that
 * never fired. NaN is the contract's "could not be evaluated" value.
 */
export function notEvaluable(
  input: Omit<ReportInput, 'value' | 'status'> & { readonly detail: string },
): ProbeReport {
  return makeReport({ ...input, value: Number.NaN, status: breach(input.severity) });
}
