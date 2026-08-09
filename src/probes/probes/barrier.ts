/**
 * P8 — divergence under a barrier.
 *
 * P8a reports neutral spatial divergence and P8b reports reproductive
 * isolation separately. Per-side signal and ecology diagnostics distinguish a
 * weak between-side signal from a broad within-side distribution.
 */

import type { ProbeReport } from '../../contracts/stats';
import type { RunResult } from '../harness';
import { inGenerations, postBurnIn } from '../metrics';
import type { ProbeDefinition } from '../probe';
import { breach, makeReport, notEvaluable } from '../probe';

const FST_TARGET = 0.2;
const FST_INCREMENT = 0.15;
/** Generation the "before" reading is taken at — ten generations after the ridge goes up. */
const FST_BASELINE_GENERATION = 60;
const FST_DEADLINE_GENERATION = 250;
const ACCEPTANCE_RATIO_TARGET = 0.5;
const ACCEPTANCE_DEADLINE_GENERATION = 300;
const ACCEPTANCE_SAMPLE = 64;

interface AcceptanceReading {
  readonly within: number;
  readonly cross: number;
  readonly pairs: number;
}

/** Stable 32-bit ordering key whose input is the never-reused organism id. */
export function acceptanceSampleKey(id: number): number {
  const low = id >>> 0;
  const high = Math.floor(id / 0x1_0000_0000) >>> 0;
  let hash = Math.imul(low ^ high ^ 0x9e37_79b9, 0x85eb_ca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2_ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** Choose by id hash, never by recycled slot position. */
export function deterministicIdSample(
  slots: readonly number[],
  ids: ArrayLike<number>,
  limit: number,
): number[] {
  return [...slots]
    .sort((left, right) => {
      const leftId = ids[left] ?? 0;
      const rightId = ids[right] ?? 0;
      return acceptanceSampleKey(leftId) - acceptanceSampleKey(rightId) || leftId - rightId || left - right;
    })
    .slice(0, limit);
}

function measureAcceptance(run: RunResult, barrierX: number): AcceptanceReading | null {
  const { sim, modules } = run;
  const pop = sim.state.pop;
  const femaleCandidates: [number[], number[]] = [[], []];
  const maleCandidates: [number[], number[]] = [[], []];

  for (let slot = 0; slot < pop.capacity; slot += 1) {
    if (pop.alive[slot] !== 1) continue;
    const side = (pop.x[slot] ?? 0) < barrierX ? 0 : 1;
    (pop.sex[slot] === 0 ? femaleCandidates[side] : maleCandidates[side]).push(slot);
  }

  const females: [number[], number[]] = [
    deterministicIdSample(femaleCandidates[0], pop.id, ACCEPTANCE_SAMPLE),
    deterministicIdSample(femaleCandidates[1], pop.id, ACCEPTANCE_SAMPLE),
  ];
  const males: [number[], number[]] = [
    deterministicIdSample(maleCandidates[0], pop.id, ACCEPTANCE_SAMPLE),
    deterministicIdSample(maleCandidates[1], pop.id, ACCEPTANCE_SAMPLE),
  ];

  let withinTotal = 0;
  let withinCount = 0;
  let crossTotal = 0;
  let crossCount = 0;

  for (const side of [0, 1] as const) {
    const other = side === 0 ? 1 : 0;
    for (const female of females[side]) {
      for (const male of males[side]) {
        withinTotal += modules.mating.acceptanceWeight(sim.state, female, male);
        withinCount += 1;
      }
      for (const male of males[other]) {
        crossTotal += modules.mating.acceptanceWeight(sim.state, female, male);
        crossCount += 1;
      }
    }
  }

  if (withinCount === 0 || crossCount === 0) return null;
  return { within: withinTotal / withinCount, cross: crossTotal / crossCount, pairs: withinCount + crossCount };
}

function latest(run: RunResult, key: string): number {
  const values = run.notes.seriesFor(key)?.values;
  return values?.[values.length - 1] ?? Number.NaN;
}

function sideDetail(run: RunResult, side: 'left' | 'right'): string {
  const prefix = `barrier:${side}`;
  const count = latest(run, `${prefix}:count`);
  const hueMean = latest(run, `${prefix}:displayHue:mean`);
  const hueR = latest(run, `${prefix}:displayHue:resultant`);
  const prefMean = latest(run, `${prefix}:prefTarget:mean`);
  const prefR = latest(run, `${prefix}:prefTarget:resultant`);
  const diet = latest(run, `${prefix}:diet:mean`);
  const size = latest(run, `${prefix}:size:mean`);
  const show = (value: number, digits: number): string => (Number.isFinite(value) ? value.toFixed(digits) : 'n/a');
  return `${side} n=${show(count, 0)}, hue ${show(hueMean, 1)}° (R=${show(hueR, 2)}), preference ${show(prefMean, 1)}° (R=${show(prefR, 2)}), diet ${show(diet, 3)}, size ${show(size, 2)}`;
}

/** Signed margin shared by P8a's displayed value and its threshold verdict. */
export function fstCriterionMargin(level: number, baseline: number): number {
  return Math.min(level - FST_TARGET, level - baseline - FST_INCREMENT);
}

function unavailableReports(run: RunResult, detail: string): readonly ProbeReport[] {
  const shared = {
    probeId: 'P8',
    scenario: run.scenario,
    seed: run.seed,
    severity: 'warn' as const,
    generationsRun: run.generationsRun,
  };
  return [
    notEvaluable({
      ...shared,
      name: 'Barrier divergence — P8a neutral Fst',
      threshold: { min: 0, label: `Fst ≥${FST_TARGET} and increase ≥${FST_INCREMENT} by generation ${FST_DEADLINE_GENERATION}` },
      detail,
    }),
    notEvaluable({
      ...shared,
      name: 'Barrier divergence — P8b mate isolation',
      threshold: { max: ACCEPTANCE_RATIO_TARGET, label: `cross/within acceptance <${ACCEPTANCE_RATIO_TARGET} by generation ${ACCEPTANCE_DEADLINE_GENERATION}` },
      detail,
    }),
  ];
}

export function barrierReports(run: RunResult): readonly ProbeReport[] {
  const barrierX = run.notes.number('barrierXWu');
  if (barrierX === undefined) {
    return unavailableReports(
      run,
      run.extinctGeneration === null
        ? `the ridge never went up: the run reached generation ${run.generationsRun.toFixed(1)}`
        : `the ridge never went up: population reached zero at generation ${run.extinctGeneration.toFixed(1)}`,
    );
  }

  const rows = postBurnIn(run).filter((row) => row.popgen.fstBarrier !== null);
  if (rows.length === 0) {
    return unavailableReports(
      run,
      `the ridge went up but no sample carried a barrier Fst — ${
        run.extinctGeneration === null
          ? 'a side may have fallen below the estimator minimum'
          : `population reached zero at generation ${run.extinctGeneration.toFixed(1)}`
      }`,
    );
  }

  const baselineRows = inGenerations(rows, 0, FST_BASELINE_GENERATION + 1);
  const baseline = baselineRows[baselineRows.length - 1]?.popgen.fstBarrier ?? 0;
  const assessed = inGenerations(rows, 0, FST_DEADLINE_GENERATION + 1);
  const reached = assessed.reduce((best, row) => Math.max(best, row.popgen.fstBarrier ?? 0), 0);
  const increment = reached - baseline;
  // The minimum signed margin is non-negative iff both displayed raw
  // requirements hold, so P8a has no secondary verdict hidden behind its value.
  const fstMargin = fstCriterionMargin(reached, baseline);
  const fstThreshold = {
    min: 0,
    label: `minimum margin for Fst ≥${FST_TARGET} and increase ≥${FST_INCREMENT} by generation ${FST_DEADLINE_GENERATION}`,
  };

  const acceptance = measureAcceptance(run, barrierX);
  const acceptanceRatio = acceptance === null || acceptance.within <= 0 ? Number.NaN : acceptance.cross / acceptance.within;
  const acceptanceDue = run.generationsRun >= ACCEPTANCE_DEADLINE_GENERATION;
  const acceptanceThreshold = {
    max: ACCEPTANCE_RATIO_TARGET,
    label: `cross/within acceptance <${ACCEPTANCE_RATIO_TARGET} by generation ${ACCEPTANCE_DEADLINE_GENERATION}`,
  };
  const diagnostics = `${sideDetail(run, 'left')}; ${sideDetail(run, 'right')}`;

  return [
    makeReport({
      probeId: 'P8',
      name: 'Barrier divergence — P8a neutral Fst',
      scenario: run.scenario,
      seed: run.seed,
      severity: 'warn',
      value: fstMargin,
      threshold: fstThreshold,
      generationsRun: run.generationsRun,
      detail: `Fst ${reached.toFixed(3)} by generation ${Math.min(FST_DEADLINE_GENERATION, run.generationsRun).toFixed(0)}, from ${baseline.toFixed(3)} at generation ${FST_BASELINE_GENERATION} (increase ${increment.toFixed(3)}); ${diagnostics}`,
      series: {
        fstBarrier: rows.map((row) => row.popgen.fstBarrier ?? 0),
        fstDemes: rows.map((row) => row.popgen.fstDemes),
      },
    }),
    makeReport({
      probeId: 'P8',
      name: 'Barrier divergence — P8b mate isolation',
      scenario: run.scenario,
      seed: run.seed,
      severity: 'warn',
      value: acceptanceRatio,
      threshold: acceptanceThreshold,
      status:
        !acceptanceDue || acceptance === null
          ? breach('warn')
          : acceptanceRatio < ACCEPTANCE_RATIO_TARGET
            ? 'pass'
            : breach('warn'),
      generationsRun: run.generationsRun,
      detail: `${
        acceptance === null
          ? 'cross-side acceptance unmeasurable — one side held no females or no males'
          : `cross/within acceptance ${acceptanceRatio.toFixed(3)} over ${acceptance.pairs} pairs`
      }${acceptanceDue ? '' : `; assessment due at generation ${ACCEPTANCE_DEADLINE_GENERATION}`}; ${diagnostics}`,
    }),
  ];
}

export const barrierProbe: ProbeDefinition = {
  id: 'P8',
  name: 'Barrier divergence',
  scenario: 'barrier',
  severity: 'warn',
  evaluate: (runs) => runs.flatMap(barrierReports),
};
