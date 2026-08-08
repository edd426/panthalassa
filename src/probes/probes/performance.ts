/**
 * P12 — throughput. `warn` severity, pending Gate A-2.
 *
 * The plan's target is "500 organisms × 20k ticks in under 5 s in Node", i.e.
 * ≥2×10⁶ organism-ticks per second. That number is not arbitrary: the watch
 * speeds go to 256×, which is 256 ticks per 1/30 s frame, so a 600-organism
 * world at top speed needs ~4.6×10⁶ organism-ticks/s to keep up. 2×10⁶ is the
 * relaxed version.
 *
 * It gated from the first integrated build, and it was demoted to `warn` by
 * WP-A7 because **the number predates the model it is measuring**. The F4
 * campaign (DESIGN.md, "Fix wave F0–F4") took the engine 1.37× to ~1.05×10⁶
 * against a flat ~950 ns/organism-tick profile; the remaining 2× is not
 * optimisation but three model decisions — field-grid resolution, one shared
 * neighbour query instead of three, and whether 2×10⁶ is the right gate for
 * this model at all. **Gate A-2 adjudicates that last question**, and a red
 * gate that nobody can act on without a model change is a red gate everyone
 * learns to ignore. A7 tunes `fieldCellSizeWu`, which moves this number and the
 * ecology probes together; the severity goes back to `gate` when Gate A-2 has
 * settled a threshold the model can actually meet.
 *
 * The measurement is **organism-ticks per second**, not wall time for a fixed
 * tick count, because the two only agree while the population sits at its
 * target. Reporting wall time alone would let a run that lost half its
 * population look twice as fast. Both numbers appear in the detail line.
 */

import type { ProbeReport } from '../../contracts/stats';
import { resolveSimConfig } from '../../contracts/types';
import { createSim } from '../../sim/engine';
import { buildModules } from '../harness';
import type { ProbeDefinition } from '../probe';
import { makeReport } from '../probe';
import { PERF_POPULATION, PERF_TICKS, scenarioByName } from '../scenarios';
import { formatDuration, startStopwatch } from '../timing';

/** Organism-ticks per second the engine must sustain. */
export const THROUGHPUT_TARGET = 2e6;

/**
 * Ticks run before the clock starts.
 *
 * Steady-state throughput is what matters — the worker runs for minutes — and
 * the first few hundred ticks are spent in the interpreter before V8 has
 * optimised the tick stages. Timing those would measure the JIT.
 */
const WARMUP_TICKS = 600;

/** Ticks per timed chunk. Matches the sampling cadence so the recorder's real cost lands inside the window. */
const CHUNK_TICKS = 200;

export function evaluatePerformance(seed: string): ProbeReport {
  const scenario = scenarioByName('perf');
  const config = resolveSimConfig(scenario.overrides);
  const { modules } = buildModules(config);
  const sim = createSim({ seed, config: scenario.overrides, modules });

  sim.step(WARMUP_TICKS);

  let organismTicks = 0;
  let previous = sim.state.liveCount;
  let minimum = previous;
  let maximum = previous;
  let peakChunkRate = 0;

  const stopwatch = startStopwatch();
  let chunkStart = 0;
  for (let done = 0; done < PERF_TICKS; done += CHUNK_TICKS) {
    const ticks = Math.min(CHUNK_TICKS, PERF_TICKS - done);
    sim.step(ticks);
    const current = sim.state.liveCount;
    // Trapezoid: the population moves within a chunk, and taking either
    // endpoint alone biases the count in a direction that depends on whether
    // the run is growing or shrinking.
    const chunkOrganismTicks = ((previous + current) / 2) * ticks;
    organismTicks += chunkOrganismTicks;

    const chunkEnd = stopwatch.elapsedMs();
    const chunkMs = chunkEnd - chunkStart;
    chunkStart = chunkEnd;
    if (chunkMs > 0) peakChunkRate = Math.max(peakChunkRate, chunkOrganismTicks / (chunkMs / 1000));

    previous = current;
    if (current < minimum) minimum = current;
    if (current > maximum) maximum = current;
  }
  const elapsedMs = stopwatch.stop();

  const perSecond = elapsedMs > 0 ? organismTicks / (elapsedMs / 1000) : Number.NaN;
  const meanPopulation = organismTicks / PERF_TICKS;
  const budgetMs = (PERF_POPULATION * PERF_TICKS * 1000) / THROUGHPUT_TARGET;

  const detail = [
    `${PERF_TICKS} ticks in ${formatDuration(elapsedMs)} (budget ${formatDuration(budgetMs)} at ${PERF_POPULATION} organisms)`,
    `population ${minimum}–${maximum}, mean ${meanPopulation.toFixed(0)}`,
    `${(organismTicks / 1e6).toFixed(2)}M organism-ticks at ${((elapsedMs * 1000) / PERF_TICKS).toFixed(0)}µs/tick`,
    // The gate reads the aggregate, which is the conservative number. The best
    // 200-tick window sits next to it so that a reader comparing two report
    // tables can tell a real regression from a host that stalled: if the
    // aggregate drops but the best window holds, the machine was busy, not the
    // engine slower. Benchmark this through `npm run probe` and nothing else —
    // a script run from outside the project is transpiled against a different
    // tsconfig and measures roughly half this throughput.
    `best ${CHUNK_TICKS}-tick window ${peakChunkRate.toExponential(2)}/s`,
  ].join('; ');

  return makeReport({
    probeId: 'P12',
    name: 'Performance',
    scenario: 'perf',
    seed,
    severity: 'warn',
    value: perSecond,
    threshold: { min: THROUGHPUT_TARGET, label: '≥2e6 organism-ticks/s' },
    generationsRun: PERF_TICKS / config.time.generationTicks,
    detail,
  });
}

export const performanceProbe: ProbeDefinition = {
  id: 'P12',
  name: 'Performance',
  scenario: 'perf',
  severity: 'warn',
  standalone: true,
  evaluate(_runs, context) {
    // One timing run regardless of seed count: three replicates of a wall-clock
    // measurement on one machine measure the machine, not the engine.
    return [evaluatePerformance(context.runs[0]?.seed ?? 'perf')];
  },
};
