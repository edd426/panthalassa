/**
 * The integration point: the five work packages assembled into one running sim.
 *
 * `createSim` is written against the interfaces in `contracts/apis.ts` and
 * nothing else, which is what let A1–A4 build concurrently. This module is the
 * only place the real implementations are named, so if the parallel-build seam
 * ever leaks — the engine importing a sibling module directly — the failure
 * shows up here rather than silently working.
 *
 * A run is stepped in chunks that land exactly on the boundaries that matter:
 * an intervention's tick, a sampling tick. Stepping in round numbers and
 * checking afterwards would mean a ridge raised "at generation 50" actually
 * went up somewhere in generation 50, and two runs that disagreed about where
 * would be indistinguishable from a determinism bug.
 */

import type { SimModules } from '../contracts/apis';
import { isNarrativeEvent } from '../contracts/events';
import type { SimEvent } from '../contracts/events';
import type { SampleRow } from '../contracts/stats';
import type { DeathCause, SimConfig, SimConfigOverrides } from '../contracts/types';
import { DEATH_CAUSES, resolveSimConfig } from '../contracts/types';
import { createEcology } from '../sim/ecology/index';
import { createSim } from '../sim/engine';
import type { SimDiagnostics, SimHandleInternal } from '../sim/engine';
import { createGenetics } from '../sim/genetics/index';
import { createMating } from '../sim/mating';
import { createSpatialIndex } from '../sim/spatial';
import { createStats } from '../stats/factory';
import type { StatsRecorderApi } from '../stats/recorder';
import type { Scenario } from './scenarios';
import { ScenarioNotes } from './scenarios';

/** Everything `createSim` needs, plus the recorder typed as its own richer surface. */
export interface BuiltModules {
  readonly modules: SimModules;
  readonly stats: StatsRecorderApi;
}

/**
 * Fresh instances every time.
 *
 * Genetics and ecology both own scratch buffers and a lazily-derived runtime
 * keyed to one `SimState`; sharing a module set between two concurrently
 * stepping sims — which is exactly what P1's paired runs are — would have them
 * fight over that scratch and produce a "determinism failure" that is really an
 * aliasing bug in the harness.
 */
export function buildModules(config: SimConfig): BuiltModules {
  const stats = createStats({ config });
  return {
    stats,
    modules: {
      genetics: createGenetics(),
      ecology: createEcology(),
      spatial: createSpatialIndex(config),
      mating: createMating(),
      stats,
    },
  };
}

export interface RunOptions {
  readonly scenario: Scenario;
  readonly seed: string;
  readonly generations: number;
}

export interface RunResult {
  readonly scenario: string;
  readonly seed: string;
  readonly config: SimConfig;
  readonly overrides: SimConfigOverrides;
  /** Generations asked for. */
  readonly generationsRequested: number;
  /** Generations actually simulated; lower than requested when the world emptied. */
  readonly generationsRun: number;
  /** Generation the population hit zero, or null if it never did. */
  readonly extinctGeneration: number | null;
  readonly rows: readonly SampleRow[];
  /** Narrative events only. Births and deaths run to millions and are already summarised per row. */
  readonly events: readonly SimEvent[];
  readonly births: number;
  readonly deaths: Readonly<Record<DeathCause, number>>;
  readonly notes: ScenarioNotes;
  readonly diagnostics: Readonly<SimDiagnostics>;
  /** Kept live so probes can interrogate the final population (P8 measures mate acceptance across the ridge). */
  readonly sim: SimHandleInternal;
  readonly modules: SimModules;
  readonly stats: StatsRecorderApi;
}

export function runScenario(options: RunOptions): RunResult {
  const { scenario, seed, generations } = options;
  const config = resolveSimConfig(scenario.overrides);
  const { modules, stats } = buildModules(config);
  const sim = createSim({ seed, config: scenario.overrides, modules });

  const generationTicks = Math.max(1, config.time.generationTicks);
  const sampleInterval = Math.max(1, config.sampling.sampleIntervalTicks);
  const totalTicks = Math.max(0, Math.round(generations * generationTicks));

  const notes = new ScenarioNotes();
  const rows: SampleRow[] = [];
  const events: SimEvent[] = [];
  const deaths: Record<DeathCause, number> = {} as Record<DeathCause, number>;
  for (const cause of DEATH_CAUSES) deaths[cause] = 0;
  let births = 0;
  let extinctGeneration: number | null = null;

  const context = {
    sim,
    config,
    stats,
    get rows(): readonly SampleRow[] {
      return rows;
    },
    notes,
  };

  const pending = [...scenario.interventions]
    .map((intervention) => ({ tick: Math.round(intervention.atGeneration * generationTicks), intervention }))
    .sort((a, b) => a.tick - b.tick);
  let nextIntervention = 0;

  const drainRows = (): void => {
    const since = rows.length === 0 ? -1 : (rows[rows.length - 1]?.tick ?? -1);
    for (const row of stats.series(since)) {
      rows.push(row);
      scenario.onSample?.(context, row);
    }
  };

  const applyDueInterventions = (): void => {
    while (nextIntervention < pending.length && (pending[nextIntervention]?.tick ?? Infinity) <= sim.state.tick) {
      const entry = pending[nextIntervention];
      nextIntervention += 1;
      if (entry === undefined) continue;
      entry.intervention.apply(context);
      notes.setNumber(`intervention:${entry.intervention.label}`, sim.state.tick);
      // The events a command raises are deliberately left on `state.events`.
      // The engine's next tick forwards everything queued there to
      // `stats.onEvent` before draining it, and that is what pins the injected
      // organism's ancestry record (`mutantIntroduced`) and feeds the
      // phylogeny. Draining them here to get them into the report early would
      // take them away from the recorder instead.
    }
  };

  applyDueInterventions();

  while (sim.state.tick < totalTicks) {
    const tick = sim.state.tick;
    const nextSample = Math.floor(tick / sampleInterval + 1) * sampleInterval;
    const nextCommand = pending[nextIntervention]?.tick ?? Infinity;
    const boundary = Math.min(totalTicks, nextSample, nextCommand > tick ? nextCommand : Infinity);

    for (const event of sim.step(boundary - tick)) {
      if (event.kind === 'birth') births += 1;
      else if (event.kind === 'death') deaths[event.cause] += 1;
      if (isNarrativeEvent(event)) events.push(event);
    }

    drainRows();
    applyDueInterventions();

    if (sim.state.liveCount === 0) {
      extinctGeneration ??= sim.state.tick / generationTicks;
      if (scenario.stopOnExtinction) break;
    }
  }

  drainRows();
  // An intervention scheduled on the final tick leaves its events queued with
  // no tick left to forward them. They still belong in the report.
  for (const event of sim.state.events) {
    if (isNarrativeEvent(event)) events.push(event);
  }

  return {
    scenario: scenario.name,
    seed,
    config,
    overrides: scenario.overrides,
    generationsRequested: generations,
    generationsRun: sim.state.tick / generationTicks,
    extinctGeneration,
    rows,
    events,
    births,
    deaths,
    notes,
    diagnostics: { ...sim.diagnostics },
    sim,
    modules,
    stats,
  };
}
