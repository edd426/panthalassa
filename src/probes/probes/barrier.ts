/**
 * P8 — divergence under a barrier.
 *
 * The allopatric speciation demo, and the project's hedge against sympatric
 * speciation never firing: raise an impassable ridge down the middle of the
 * world at generation 50 and watch the two halves drift apart. Two readings,
 * because either alone can be produced by something other than divergence:
 *
 * - **Neutral Fst across the ridge** ≥ 0.20, and at least +0.15 above where it
 *   sat at generation 60. The increment matters — a world with strong spatial
 *   structure already has non-zero Fst at the moment the ridge goes up, and
 *   reporting only the level would credit the barrier with structure that
 *   predated it.
 * - **Cross-side mate acceptance** below half the within-side rate, measured
 *   through `MatingApi.acceptanceWeight` on the population that actually
 *   exists at the end of the run. Fst can rise on drift alone; a preference
 *   that has stopped recognising the other side is reproductive isolation.
 */

import { NO_SLOT } from '../../contracts/types';
import type { ProbeReport } from '../../contracts/stats';
import type { RunResult } from '../harness';
import { inGenerations, postBurnIn } from '../metrics';
import type { ProbeDefinition } from '../probe';
import { breach, makeReport, notEvaluable, statusFor, worstStatus } from '../probe';

const FST_TARGET = 0.2;
const FST_INCREMENT = 0.15;
/** Generation the "before" reading is taken at — ten generations after the ridge goes up. */
const FST_BASELINE_GENERATION = 60;
const FST_DEADLINE_GENERATION = 250;
const ACCEPTANCE_RATIO_TARGET = 0.5;
const ACCEPTANCE_DEADLINE_GENERATION = 300;

/**
 * Organisms sampled per sex per side for the acceptance measurement.
 *
 * Every pair would be O(N²) weight evaluations on a population of thousands.
 * Taking the first N in **ascending slot order** keeps the sample a
 * deterministic function of the state — a random subsample would need sim RNG,
 * which a probe must not consume.
 */
const ACCEPTANCE_SAMPLE = 64;

interface AcceptanceReading {
  readonly within: number;
  readonly cross: number;
  readonly pairs: number;
}

function measureAcceptance(run: RunResult, barrierX: number): AcceptanceReading | null {
  const { sim, modules } = run;
  const pop = sim.state.pop;
  const females: [number[], number[]] = [[], []];
  const males: [number[], number[]] = [[], []];

  for (let slot = 0; slot < pop.capacity; slot += 1) {
    if (pop.alive[slot] !== 1) continue;
    const side = (pop.x[slot] ?? 0) < barrierX ? 0 : 1;
    const bucket = pop.sex[slot] === 0 ? females[side] : males[side];
    if (bucket.length < ACCEPTANCE_SAMPLE) bucket.push(slot);
  }

  let withinTotal = 0;
  let withinCount = 0;
  let crossTotal = 0;
  let crossCount = 0;

  for (const side of [0, 1] as const) {
    const other = side === 0 ? 1 : 0;
    for (const female of females[side]) {
      for (const male of males[side]) {
        if (male === NO_SLOT) continue;
        withinTotal += modules.mating.acceptanceWeight(sim.state, female, male);
        withinCount += 1;
      }
      for (const male of males[other]) {
        if (male === NO_SLOT) continue;
        crossTotal += modules.mating.acceptanceWeight(sim.state, female, male);
        crossCount += 1;
      }
    }
  }

  if (withinCount === 0 || crossCount === 0) return null;
  return { within: withinTotal / withinCount, cross: crossTotal / crossCount, pairs: withinCount + crossCount };
}

function barrierReport(run: RunResult): ProbeReport {
  const threshold = {
    min: FST_TARGET,
    label: `barrier Fst ≥ ${FST_TARGET} and +${FST_INCREMENT} over generation ${FST_BASELINE_GENERATION}`,
  };
  const shared = {
    probeId: 'P8',
    name: 'Barrier divergence',
    scenario: run.scenario,
    seed: run.seed,
    severity: 'warn' as const,
    generationsRun: run.generationsRun,
  };

  const barrierX = run.notes.number('barrierXWu');
  if (barrierX === undefined) {
    return notEvaluable({
      ...shared,
      threshold,
      detail:
        run.extinctGeneration === null
          ? `the ridge never went up: the run reached generation ${run.generationsRun.toFixed(1)}`
          : `the ridge never went up: population reached zero at generation ${run.extinctGeneration.toFixed(1)}`,
    });
  }

  const rows = postBurnIn(run).filter((row) => row.popgen.fstBarrier !== null);
  if (rows.length === 0) {
    return notEvaluable({
      ...shared,
      threshold,
      detail: `the ridge went up but no sample carried a barrier Fst — ${
        run.extinctGeneration === null
          ? 'a side may have fallen below minSpeciesSize'
          : `population reached zero at generation ${run.extinctGeneration.toFixed(1)}`
      }`,
    });
  }

  const baselineRows = inGenerations(rows, 0, FST_BASELINE_GENERATION + 1);
  const baseline = baselineRows[baselineRows.length - 1]?.popgen.fstBarrier ?? 0;
  const assessed = inGenerations(rows, 0, FST_DEADLINE_GENERATION + 1);
  const reached = assessed.reduce((best, row) => Math.max(best, row.popgen.fstBarrier ?? 0), 0);

  const acceptance = measureAcceptance(run, barrierX);
  const acceptanceRatio = acceptance === null || acceptance.within <= 0 ? Number.NaN : acceptance.cross / acceptance.within;
  const acceptanceDue = run.generationsRun >= ACCEPTANCE_DEADLINE_GENERATION;

  const status = worstStatus([
    statusFor(reached, threshold, 'warn'),
    reached - baseline >= FST_INCREMENT ? 'pass' : breach('warn'),
    // Only held against the probe once the run is long enough to have earned
    // the assertion; before that it is reported and not judged.
    !acceptanceDue ? 'pass' : Number.isFinite(acceptanceRatio) && acceptanceRatio < ACCEPTANCE_RATIO_TARGET ? 'pass' : breach('warn'),
  ]);

  const detail = [
    `Fst peaked at ${reached.toFixed(3)} by generation ${Math.min(FST_DEADLINE_GENERATION, run.generationsRun).toFixed(0)}, from ${baseline.toFixed(3)} at generation ${FST_BASELINE_GENERATION} (+${(reached - baseline).toFixed(3)})`,
    acceptance === null
      ? 'cross-side acceptance unmeasurable — one side held no females or no males'
      : `cross/within acceptance ${acceptanceRatio.toFixed(2)} over ${acceptance.pairs} pairs${acceptanceDue ? '' : ' (reported only; the run is short of generation 300)'}`,
    `ridge at x=${barrierX.toFixed(0)}wu`,
  ].join('; ');

  return makeReport({
    ...shared,
    value: reached,
    threshold,
    status,
    detail,
    series: { fstBarrier: rows.map((row) => row.popgen.fstBarrier ?? 0), fstDemes: rows.map((row) => row.popgen.fstDemes) },
  });
}

export const barrierProbe: ProbeDefinition = {
  id: 'P8',
  name: 'Barrier divergence',
  scenario: 'barrier',
  severity: 'warn',
  evaluate: (runs) => runs.map(barrierReport),
};
