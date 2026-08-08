/**
 * The one file in `src/sim`, `src/stats`, `src/probes` and `src/contracts`
 * allowed to read a wall clock (see CLAUDE.md and the ESLint exemption in
 * `eslint.config.js`).
 *
 * P12 has to measure how long the engine takes, and the suite report carries a
 * `durationMs`. Everything else in the probe suite is denominated in ticks and
 * generations, because a probe whose verdict depended on how fast the machine
 * happened to be would not be a probe.
 *
 * **The rule this file exists to make checkable: a clock reading may be
 * reported and may never flow back into the sim.** Nothing here takes a
 * `SimState`, a `RandomSource` or a `SimConfig`, and nothing here returns a
 * value that any other probe module feeds to `createSim`. If a future change
 * makes a timing value reach a config knob, a seed or an intervention, the
 * determinism invariant is gone and P1 will not catch it — P1 compares two runs
 * inside one process, which would agree on a wrong shared clock reading.
 */

/**
 * Monotonic milliseconds since process start.
 *
 * `performance.now()` rather than `Date.now()` because it is monotonic: a
 * system clock adjustment mid-run must not be able to produce a negative
 * duration in a report.
 */
export function nowMs(): number {
  return performance.now();
}

/** A running measurement. `stop()` is idempotent and returns the same number every time. */
export interface Stopwatch {
  /** Elapsed milliseconds so far; keeps advancing until `stop()`. */
  elapsedMs(): number;
  /** Freeze and return the elapsed milliseconds. */
  stop(): number;
}

export function startStopwatch(): Stopwatch {
  const start = nowMs();
  let stopped: number | null = null;
  return {
    elapsedMs(): number {
      return (stopped ?? nowMs()) - start;
    },
    stop(): number {
      stopped ??= nowMs();
      return stopped - start;
    },
  };
}

/** `1m 04.3s` / `4.31s` / `812ms` — for the report header, never for a threshold. */
export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds - minutes * 60).toFixed(1).padStart(4, '0')}s`;
}
