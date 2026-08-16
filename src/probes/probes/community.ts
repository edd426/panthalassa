/**
 * P9 (coevolution), P10 (sweep visibility) and P11 (speciation smoke) — the
 * three probes about what the population is *doing to itself*, rather than what
 * the environment is doing to it.
 */

import type { ProbeReport, SampleRow } from '../../contracts/stats';
import type { RunResult } from '../harness';
import { comparisonWindows, inGenerations, lastGeneration, mean, postBurnIn } from '../metrics';
import type { ProbeDefinition } from '../probe';
import { breach, makeReport, notEvaluable, statusFor, worstStatus } from '../probe';
import {
  SWEEP_DISCRETE_ALLELE,
  SWEEP_DISCRETE_LOCUS,
  SWEEP_EFFECT_SD,
  SWEEP_QUANT_LOCUS,
} from '../scenarios';

// ---------------------------------------------------------------------------
// P9 — coevolution
// ---------------------------------------------------------------------------

/** Fraction of the population below which a trophic guild counts as gone. */
const GUILD_FLOOR = 0.05;
/** Fraction of samples both guilds must be present in. */
const GUILD_PERSISTENCE = 0.9;
/** Movement in SDs each of `attack` and `defense` must show. */
const ARMS_RACE_MOVEMENT_SD = 0.5;

function coevolutionReport(run: RunResult): ProbeReport {
  const rows = postBurnIn(run);
  const threshold = {
    min: ARMS_RACE_MOVEMENT_SD,
    label: `attack and defense each move ≥${ARMS_RACE_MOVEMENT_SD} SD; both guilds present in ≥${GUILD_PERSISTENCE * 100}% of samples`,
  };
  const shared = {
    probeId: 'P9',
    name: 'Coevolution',
    scenario: run.scenario,
    seed: run.seed,
    severity: 'warn' as const,
    generationsRun: run.generationsRun,
  };

  const windows = comparisonWindows(run);
  const early = inGenerations(run.rows, windows.early[0], windows.early[1]);
  const late = inGenerations(run.rows, windows.late[0], windows.late[1]);
  if (rows.length === 0 || early.length === 0 || late.length === 0) {
    return notEvaluable({
      ...shared,
      threshold,
      detail: `no comparable windows: the run reached generation ${lastGeneration(run).toFixed(1)}${
        run.extinctGeneration === null ? '' : ` (extinct at ${run.extinctGeneration.toFixed(1)})`
      }`,
    });
  }

  const bothPresent = rows.filter(
    (row) => row.guilds.predatorFraction >= GUILD_FLOOR && row.guilds.filtererFraction >= GUILD_FLOOR,
  ).length;
  const persistence = bothPresent / rows.length;

  const movement = (
    pick: (row: SampleRow) => number,
    sd: (row: SampleRow) => number,
  ): number => {
    const spread = mean(early.map(sd));
    if (!(spread > 0)) return Number.NaN;
    return Math.abs(mean(late.map(pick)) - mean(early.map(pick))) / spread;
  };

  const attackMove = movement((row) => row.guilds.meanAttack, (row) => row.traits.attack.sd);
  const defenseMove = movement((row) => row.guilds.meanDefense, (row) => row.traits.defense.sd);
  const value = Math.min(attackMove, defenseMove);

  const status = worstStatus([
    statusFor(value, threshold, 'warn'),
    persistence >= GUILD_PERSISTENCE ? 'pass' : breach('warn'),
  ]);

  const detail = [
    `attack ${Number.isFinite(attackMove) ? attackMove.toFixed(2) : 'n/a'} SD, defense ${Number.isFinite(defenseMove) ? defenseMove.toFixed(2) : 'n/a'} SD`,
    `both guilds present in ${(persistence * 100).toFixed(0)}% of samples (predators ${(mean(rows.map((row) => row.guilds.predatorFraction)) * 100).toFixed(0)}% of the population on average)`,
    windows.canonical ? "the plan's windows" : 'WINDOWS RESCALED — the run was too short for generation 300',
  ].join('; ');

  return makeReport({
    ...shared,
    value,
    threshold,
    status,
    detail,
    series: {
      meanAttack: rows.map((row) => row.guilds.meanAttack),
      meanDefense: rows.map((row) => row.guilds.meanDefense),
      predatorFraction: rows.map((row) => row.guilds.predatorFraction),
    },
  });
}

export const coevolutionProbe: ProbeDefinition = {
  id: 'P9',
  name: 'Coevolution',
  scenario: 'baseline',
  severity: 'warn',
  evaluate: (runs) => runs.map(coevolutionReport),
  aggregate: {
    kind: 'k-of-n',
    minPassFraction: 1,
    label: 'coevolution criterion passes on all seeds',
  },
};

// ---------------------------------------------------------------------------
// P10 — sweep visibility
// ---------------------------------------------------------------------------

const SWEEP_TARGET_FREQUENCY = 0.5;
const SWEEP_DEADLINE_GENERATIONS = 120;

/**
 * Frequency of the injected quantitative allele, differenced against a paired
 * sham-injection control with the same scenario config and seed.
 *
 * `SampleRow` carries allele frequencies for discrete loci only, and the
 * beneficial allele P10 injects is quantitative — a real number, not a
 * countable allele class. Subtracting the control locus mean removes movement
 * caused by mutation, drift and selection in the unedited background.
 */
export function frequencyFromPairedMeans(treatmentMean: number, controlMean: number, offset: number): number {
  if (!(Math.abs(offset) > 0)) return Number.NaN;
  return Math.min(1, Math.max(0, (treatmentMean - controlMean) / offset));
}

/**
 * SD of a neutral allele's frequency change over `generations` at effective
 * size `ne`: `sqrt(f₀(1−f₀)·(1 − exp(−t/2Ne)))`, the standard diffusion result.
 *
 * The exponential form rather than the small-`t` linearisation `f₀(1−f₀)t/2Ne`,
 * because these runs go 120 generations against an Ne in the hundreds and the
 * linearisation runs past `f₀(1−f₀)` — a variance larger than the process can
 * have — well inside that window.
 */
export function driftSd(startFrequency: number, generations: number, ne: number): number {
  if (!(ne > 0) || !(generations > 0)) return Number.NaN;
  const heterozygosity = startFrequency * (1 - startFrequency);
  return Math.sqrt(heterozygosity * (1 - Math.exp(-generations / (2 * ne))));
}

/**
 * The neutral arm's line: how far the tracked marker moved, in drift SDs.
 *
 * Deliberately **reported and not asserted**. It is a crash-neutral fixation
 * read — nothing selects on `neutralD`, so disturbances reach it only through
 * Ne, which is in the denominator rather than able to reverse its sign — but a
 * threshold on it would need a multi-seed base-rate panel to say what |z| is
 * ordinary, and this package has no such panel. TODO(G6), alongside P19's.
 */
function driftReading(run: RunResult, finalFrequency: number): string {
  const start = run.notes.number('trackedAlleleStartFrequency');
  const ne = run.notes.number('trackedAlleleStartNe');
  if (start === undefined || ne === undefined) {
    return `final frequency ${finalFrequency.toFixed(4)}; no pre-injection baseline recorded`;
  }
  const generations = Math.max(0, run.generationsRun - (run.notes.number('sweepInjectionTick') ?? 0) / run.config.time.generationTicks);
  const sd = driftSd(start, generations, ne);
  const z = sd > 0 ? (finalFrequency - start) / sd : Number.NaN;
  return `${start.toFixed(4)} → ${finalFrequency.toFixed(4)} over ${generations.toFixed(0)} generations at Ne ${ne.toFixed(0)} (${Number.isFinite(z) ? `${z.toFixed(2)} drift SD` : 'drift SD not identifiable'})`;
}

function sweepReport(run: RunResult, control: RunResult | undefined): ProbeReport {
  const threshold = {
    min: SWEEP_TARGET_FREQUENCY,
    label: `injected +${SWEEP_EFFECT_SD}σ allele reaches ${SWEEP_TARGET_FREQUENCY} within ${SWEEP_DEADLINE_GENERATIONS} generations`,
  };
  const shared = {
    probeId: 'P10',
    name: 'Sweep visibility',
    scenario: run.scenario,
    seed: run.seed,
    severity: 'warn' as const,
    generationsRun: run.generationsRun,
  };

  const injectionTick = run.notes.number('sweepInjectionTick');
  const offset = run.notes.number('sweepAlleleOffset');
  const series = run.notes.seriesFor('sweepLocusMean');
  const controlTick = control?.notes.number('sweepControlTick');
  const controlSeries = control?.notes.seriesFor('sweepControlLocusMean');

  if (
    injectionTick === undefined ||
    offset === undefined ||
    series === undefined ||
    control === undefined ||
    controlTick !== injectionTick ||
    controlSeries === undefined
  ) {
    return notEvaluable({
      ...shared,
      threshold,
      detail:
        run.extinctGeneration === null
          ? `the paired treatment/control intervention or locus series was unavailable; treatment reached generation ${run.generationsRun.toFixed(1)}`
          : `the paired treatment/control intervention was unavailable; treatment reached zero at generation ${run.extinctGeneration.toFixed(1)}`,
    });
  }

  const generationTicks = run.config.time.generationTicks;
  const trajectory: { generation: number; frequency: number }[] = [];
  const controlByTick = new Map(
    controlSeries.ticks.map((tick, index) => [tick, controlSeries.values[index] ?? Number.NaN]),
  );
  for (let index = 0; index < series.ticks.length; index += 1) {
    const tick = series.ticks[index] ?? 0;
    if (tick <= injectionTick) continue;
    const generation = (tick - injectionTick) / generationTicks;
    if (generation > SWEEP_DEADLINE_GENERATIONS) break;
    const controlMean = controlByTick.get(tick);
    if (controlMean === undefined) continue;
    trajectory.push({
      generation,
      frequency: frequencyFromPairedMeans(series.values[index] ?? Number.NaN, controlMean, offset),
    });
  }

  if (trajectory.length === 0) {
    return notEvaluable({
      ...shared,
      threshold,
      detail: `no samples after the injection at generation ${(injectionTick / generationTicks).toFixed(0)}${
        run.extinctGeneration === null ? '' : `; population reached zero at generation ${run.extinctGeneration.toFixed(1)}`
      }`,
    });
  }

  const peak = trajectory.reduce((best, point) => Math.max(best, point.frequency), 0);
  const crossing = trajectory.find((point) => point.frequency >= SWEEP_TARGET_FREQUENCY);

  // The tracked discrete companion: the only path the frozen contract can raise
  // `sweepCrossedHalf` on, since `trackSweep` is typed to `DiscreteLocusId`.
  const crossedEvent = run.events.find((event) => event.kind === 'sweepCrossedHalf');
  const finalRow: SampleRow | undefined = run.rows[run.rows.length - 1];
  const discreteFrequency = finalRow?.discreteAlleleFreq[SWEEP_DISCRETE_LOCUS][SWEEP_DISCRETE_ALLELE] ?? 0;
  const drift = driftReading(run, discreteFrequency);

  const detail = [
    `${SWEEP_QUANT_LOCUS} peaked at ${peak.toFixed(3)}${
      crossing === undefined ? ' (never crossed 0.5)' : `, crossing 0.5 after ${crossing.generation.toFixed(1)} generations`
    }`,
    `injected at generation ${(injectionTick / generationTicks).toFixed(0)}, offset ${offset.toFixed(3)} allele units, start frequency ${(run.notes.number('sweepStartFrequency') ?? 0).toExponential(1)}`,
    `${SWEEP_DISCRETE_LOCUS}:${SWEEP_DISCRETE_ALLELE} (neutral) ${
      crossedEvent === undefined
        ? `never raised sweepCrossedHalf; ${drift}`
        : `raised sweepCrossedHalf at tick ${crossedEvent.tick}; ${drift}`
    }`,
    `${trajectory.length} samples over ${trajectory[trajectory.length - 1]?.generation.toFixed(0) ?? 0} of the ${SWEEP_DEADLINE_GENERATIONS}-generation window`,
    `paired control added ${control.generationsRun.toFixed(1)} simulated generations (one extra run for this seed)`,
  ].join('; ');

  return makeReport({
    ...shared,
    value: peak,
    threshold,
    detail,
    series: {
      sweepFrequency: trajectory.map((point) => point.frequency),
      sweepGeneration: trajectory.map((point) => point.generation),
      sweepLocusMean: [...series.values],
      sweepControlLocusMean: [...controlSeries.values],
    },
  });
}

export const sweepProbe: ProbeDefinition = {
  id: 'P10',
  name: 'Sweep visibility',
  scenario: 'sweep',
  severity: 'warn',
  companionScenarios: ['sweep-control'],
  evaluate: (runs, context) =>
    runs.map((run) => sweepReport(run, context.runsFor('sweep-control').find((control) => control.seed === run.seed))),
  aggregate: {
    kind: 'k-of-n',
    minPassFraction: 1 / 3,
    label: 'sweep criterion passes on ≥1/3 of seeds',
  },
};

// ---------------------------------------------------------------------------
// P11 — speciation smoke
// ---------------------------------------------------------------------------

const COEXISTENCE_GENERATIONS = 50;
const COEXISTING_SPECIES = 2;

function speciationReport(run: RunResult): ProbeReport {
  const rows = postBurnIn(run);
  const threshold = {
    min: COEXISTENCE_GENERATIONS,
    label: `≥${COEXISTING_SPECIES} species coexisting ≥${COEXISTENCE_GENERATIONS} consecutive generations`,
  };
  const shared = {
    probeId: 'P11',
    name: 'Speciation smoke',
    scenario: run.scenario,
    seed: run.seed,
    severity: 'warn' as const,
    generationsRun: run.generationsRun,
  };

  if (rows.length === 0) {
    return notEvaluable({
      ...shared,
      threshold,
      detail: `no samples past the burn-in; the run reached generation ${lastGeneration(run).toFixed(1)}`,
    });
  }

  const minimumSize = run.config.speciation.minSpeciesSize;
  let longest = 0;
  let startGeneration: number | null = null;
  let peakSpecies = 0;

  for (const row of rows) {
    const coexisting = row.populationBySpecies.filter((entry) => entry.count >= minimumSize).length;
    if (coexisting > peakSpecies) peakSpecies = coexisting;
    if (coexisting >= COEXISTING_SPECIES) {
      startGeneration ??= row.generation;
      longest = Math.max(longest, row.generation - startGeneration);
    } else {
      startGeneration = null;
    }
  }

  const splits = run.events.filter((event) => event.kind === 'speciesSplit').length;
  const extinctions = run.events.filter((event) => event.kind === 'speciesExtinction').length;
  const foundings = run.events.filter((event) => event.kind === 'cladeFounding').length;

  return makeReport({
    ...shared,
    value: longest,
    threshold,
    detail: [
      `longest coexistence ${longest.toFixed(1)} generations, peak ${peakSpecies} species over ${minimumSize} individuals`,
      `${splits} splits, ${extinctions} species extinctions, ${foundings} clade foundings`,
    ].join('; '),
    series: {
      speciesCount: rows.map((row) => row.populationBySpecies.filter((entry) => entry.count >= minimumSize).length),
    },
  });
}

export const speciationProbe: ProbeDefinition = {
  id: 'P11',
  name: 'Speciation smoke',
  scenario: 'speciation',
  severity: 'warn',
  evaluate: (runs) => runs.map(speciationReport),
};
