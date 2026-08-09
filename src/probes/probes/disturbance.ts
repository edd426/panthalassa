/** P15 disturbance regime and P16 predator re-evolvability. */

import type { ProbeReport, SampleRow } from '../../contracts/stats';
import type { SimEvent } from '../../contracts/events';
import { createSim } from '../../sim/engine';
import { buildModules } from '../harness';
import type { RunResult } from '../harness';
import { breach, makeReport, notEvaluable, statusFor, worstStatus } from '../probe';
import type { ProbeDefinition } from '../probe';
import { mean } from '../metrics';
import { DISTURBANCE_SMOKE_SCENARIO, REEVOLVABILITY_SCENARIO } from '../scenarios';

const SHOCK_KINDS = ['thermalShock', 'planktonCrash', 'kelpStorm'] as const;
type ShockEvent = Extract<SimEvent, { readonly kind: (typeof SHOCK_KINDS)[number] }>;

function isShockEvent(event: SimEvent): event is ShockEvent {
  return SHOCK_KINDS.includes(event.kind as (typeof SHOCK_KINDS)[number]);
}

function recorderSeries(run: RunResult, name: string): number[] {
  return Array.from(run.stats.column(name) ?? []);
}

function activeShockSeries(run: RunResult): number[] {
  const thermal = recorderSeries(run, 'disturbances.thermalCount');
  const plankton = recorderSeries(run, 'disturbances.planktonCrashCount');
  const kelp = recorderSeries(run, 'disturbances.kelpStormCount');
  return thermal.map((value, index) => value + (plankton[index] ?? 0) + (kelp[index] ?? 0));
}

function smokeReport(run: RunResult): ProbeReport {
  const counts = SHOCK_KINDS.map((kind) => run.events.filter((event) => event.kind === kind).length);
  const snapshot = run.sim.snapshot();
  const { modules } = buildModules(run.config);
  const restored = createSim({ seed: run.seed, config: run.overrides, modules, snapshot });
  const snapshotOk =
    run.notes.number('midShockSnapshotMatches') === 1 &&
    snapshot.stateHash === restored.stateHash() &&
    restored.state.disturbance.thermal.length +
      restored.state.disturbance.planktonCrashes.length +
      restored.state.disturbance.kelpStorms.length >
      0;
  const value = counts.filter((count) => count > 0).length;
  const status = worstStatus([
    statusFor(value, { min: 3, label: 'all 3 scripted shock types fire' }, 'warn'),
    run.sim.state.liveCount > 0 ? 'pass' : breach('warn'),
    snapshotOk ? 'pass' : breach('warn'),
  ]);
  return makeReport({
    probeId: 'P15',
    name: 'Disturbance regime (smoke)',
    scenario: run.scenario,
    seed: run.seed,
    severity: 'warn',
    value,
    threshold: { min: 3, label: 'all shocks fire; world survives; active-shock snapshot restores' },
    status,
    generationsRun: run.generationsRun,
    detail: `thermal/crash/kelp ${counts.join('/')}; population ${run.sim.state.liveCount}; snapshot ${snapshotOk ? 'round-tripped mid-shock' : 'FAILED active-shock round-trip'}`,
    series: {
      carrionBiomass: recorderSeries(run, 'resources.carrionTotal'),
      activeShocks: activeShockSeries(run),
    },
  });
}

function nearestRow(rows: readonly SampleRow[], generation: number): SampleRow | undefined {
  let best: SampleRow | undefined;
  let distance = Infinity;
  for (const row of rows) {
    const next = Math.abs(row.generation - generation);
    if (next < distance) {
      best = row;
      distance = next;
    }
  }
  return best;
}

function adaptationRatio(run: RunResult): number {
  const shocks = run.events.filter(isShockEvent).filter(
    (event) => event.tick >= 30 * run.config.time.generationTicks,
  );
  const moves: number[] = [];
  for (const shock of shocks) {
    const generation = shock.tick / run.config.time.generationTicks;
    const before = nearestRow(run.rows, generation);
    const after = nearestRow(run.rows, generation + 50);
    if (before === undefined || after === undefined || after.generation < generation + 45) continue;
    for (const trait of ['tOpt', 'diet', 'attack', 'defense'] as const) {
      const sd = before.traits[trait].sd;
      if (sd > 0) moves.push(Math.abs(after.traits[trait].mean - before.traits[trait].mean) / sd);
    }
  }
  if (moves.length === 0) return Number.NaN;

  const quiet: number[] = [];
  const spanTicks = 50 * run.config.time.generationTicks;
  for (let index = 0; index < run.rows.length; index += 10) {
    const before = run.rows[index];
    if (before === undefined || before.generation < 30) continue;
    const after = nearestRow(run.rows, before.generation + 50);
    if (after === undefined || after.generation < before.generation + 45) continue;
    if (shocks.some((shock) => shock.tick >= before.tick && shock.tick <= before.tick + spanTicks)) continue;
    for (const trait of ['tOpt', 'diet', 'attack', 'defense'] as const) {
      const sd = before.traits[trait].sd;
      if (sd > 0) quiet.push(Math.abs(after.traits[trait].mean - before.traits[trait].mean) / sd);
    }
  }
  const quietBaseline = mean(quiet);
  return mean(moves) / (Number.isFinite(quietBaseline) && quietBaseline > 0 ? quietBaseline : 1e-9);
}

/** Natural (non-scripted) shock counts per type, in {@link SHOCK_KINDS} order. */
function naturalShockCounts(run: RunResult): number[] {
  const scripted = [
    run.notes.number('scriptedThermal') ?? 0,
    run.notes.number('scriptedPlankton') ?? 0,
    run.notes.number('scriptedKelp') ?? 0,
  ];
  return SHOCK_KINDS.map(
    (kind, index) => Math.max(0, run.events.filter((event) => event.kind === kind).length - (scripted[index] ?? 0)),
  );
}

/** Poisson-expected shock counts per type over the run's actual length. */
function expectedShockCounts(run: RunResult): number[] {
  return [
    run.config.disturbance.thermalRatePerGeneration,
    run.config.disturbance.planktonCrashRatePerGeneration,
    run.config.disturbance.kelpStormRatePerGeneration,
  ].map((rate) => rate * run.generationsRun);
}

function regimeReport(run: RunResult): ProbeReport {
  const observed = naturalShockCounts(run);
  const expected = expectedShockCounts(run);
  const ratios = observed.map((count, index) => count / Math.max(1e-9, expected[index] ?? 0));
  const shocks = run.events.filter(isShockEvent);
  const extinctionTick = run.extinctGeneration === null
    ? Infinity
    : run.extinctGeneration * run.config.time.generationTicks;
  const survival = shocks.length === 0
    ? Number.NaN
    : shocks.filter((shock) => shock.tick + shock.durationTicks < extinctionTick).length / shocks.length;
  const adaptation = adaptationRatio(run);
  // Expected counts per seed are only ~2–4 events, where a ±40% band sits
  // inside one standard deviation of Poisson shot noise — the 2026-08-10 spec
  // run put in-rate seeds outside it. Rates are asserted pooled across seeds
  // (see pooledRateReport); the per-seed ratios stay in the detail line.
  const status = worstStatus([
    statusFor(survival, { min: 0.95, label: 'world survives ≥95% of shocks' }, 'warn'),
    statusFor(adaptation, { min: 1, label: 'post-shock movement exceeds quiet baseline' }, 'warn'),
  ]);
  return makeReport({
    probeId: 'P15',
    name: 'Disturbance regime',
    scenario: run.scenario,
    seed: run.seed,
    severity: 'warn',
    value: adaptation,
    threshold: { min: 1, label: 'survival ≥95%; post-shock movement > quiet baseline; rates pooled cross-seed' },
    status,
    generationsRun: run.generationsRun,
    detail: `natural thermal/crash/kelp ${observed.join('/')} (rate ratios ${ratios.map((value) => value.toFixed(2)).join('/')}); survival ${(survival * 100).toFixed(0)}%; adaptation ${Number.isFinite(adaptation) ? adaptation.toFixed(2) : 'n/a'}× quiet`,
    series: {
      carrionBiomass: recorderSeries(run, 'resources.carrionTotal'),
      thermalOffsetC: recorderSeries(run, 'disturbances.thermalOffsetC'),
      activeShocks: activeShockSeries(run),
    },
  });
}

/**
 * The cross-seed half of P15's rate criterion. A per-seed ±40% band over ~2–4
 * expected events is a coin flip on shot noise; pooled over the panel there
 * are enough events for the band to test the scheduler rather than the dice.
 */
export function pooledRateReport(runs: readonly RunResult[]): ProbeReport | null {
  const regime = runs.filter((run) => run.generationsRequested > 10);
  if (regime.length < 2) return null;
  const observed = [0, 0, 0];
  const expected = [0, 0, 0];
  for (const run of regime) {
    naturalShockCounts(run).forEach((count, index) => {
      observed[index] = (observed[index] ?? 0) + count;
    });
    expectedShockCounts(run).forEach((count, index) => {
      expected[index] = (expected[index] ?? 0) + count;
    });
  }
  const ratios = observed.map((count, index) => count / Math.max(1e-9, expected[index] ?? 0));
  const worst = ratios.reduce(
    (acc, ratio) =>
      Math.abs(Math.log(Math.max(ratio, 1e-9))) > Math.abs(Math.log(Math.max(acc, 1e-9))) ? ratio : acc,
    1,
  );
  return makeReport({
    probeId: 'P15',
    name: 'Disturbance regime (pooled rates)',
    scenario: regime[0]?.scenario ?? DISTURBANCE_SMOKE_SCENARIO,
    seed: `${regime.length} seeds`,
    severity: 'warn',
    value: worst,
    threshold: { min: 0.6, max: 1.4, label: 'pooled natural-shock rate ratio per type within ±40%' },
    generationsRun: regime.reduce((total, run) => total + run.generationsRun, 0),
    detail: `pooled thermal/crash/kelp ${observed.join('/')} observed vs ${expected
      .map((value) => value.toFixed(1))
      .join('/')} expected (ratios ${ratios.map((value) => value.toFixed(2)).join('/')})`,
  });
}

export const disturbanceProbe: ProbeDefinition = {
  id: 'P15',
  name: 'Disturbance regime',
  scenario: DISTURBANCE_SMOKE_SCENARIO,
  severity: 'warn',
  evaluate: (runs) => runs.map((run) => (run.generationsRequested <= 10 ? smokeReport(run) : regimeReport(run))),
  aggregate: {
    kind: 'custom',
    evaluate(runs) {
      const pooled = pooledRateReport(runs);
      return pooled === null ? [] : [pooled];
    },
  },
};

function persistentGuild(rows: readonly SampleRow[], crashGeneration: number): boolean {
  let start: number | undefined;
  for (const row of rows) {
    if (row.generation < crashGeneration) continue;
    if (row.guilds.predatorFraction <= 0) {
      start = undefined;
      continue;
    }
    start ??= row.generation;
    if (row.generation - start >= 50) return true;
  }
  return false;
}

function reEvolvabilityReport(run: RunResult): ProbeReport {
  const crashTick = run.notes.number('p16CrashTick');
  const shared = {
    probeId: 'P16',
    name: 'Predator re-evolvability',
    scenario: run.scenario,
    seed: run.seed,
    severity: 'warn' as const,
    generationsRun: run.generationsRun,
    threshold: { min: 1, label: 'diet and attack SD rise; predator guild persists 50 generations' },
  };
  if (crashTick === undefined) {
    return notEvaluable({ ...shared, detail: `scripted crash not reached in ${run.generationsRun.toFixed(1)} generations` });
  }
  const crashGeneration = crashTick / run.config.time.generationTicks;
  const meanDiet = recorderSeries(run, 'guilds.meanDiet');
  const pre = run.rows
    .map((row, index) => ({ row, meanDiet: meanDiet[index] ?? Number.NaN }))
    .filter(({ row }) => row.generation >= crashGeneration - 30 && row.generation < crashGeneration);
  const post = run.rows
    .map((row, index) => ({ row, meanDiet: meanDiet[index] ?? Number.NaN }))
    .filter(({ row }) => row.generation >= crashGeneration + 15 && row.generation < crashGeneration + 60);
  if (pre.length === 0 || post.length === 0) {
    return notEvaluable({ ...shared, detail: 'pre/post crash sample windows were incomplete' });
  }
  const dietRise = mean(post.map((entry) => entry.meanDiet)) - mean(pre.map((entry) => entry.meanDiet));
  const attackSdRatio = mean(post.map((entry) => entry.row.traits.attack.sd)) /
    Math.max(1e-9, mean(pre.map((entry) => entry.row.traits.attack.sd)));
  const persists = persistentGuild(run.rows, crashGeneration);
  const dietOk = dietRise >= 0.02;
  const attackOk = attackSdRatio >= 1.1;
  const status = worstStatus([
    dietOk ? 'pass' : breach('warn'),
    attackOk ? 'pass' : breach('warn'),
    persists ? 'pass' : breach('warn'),
  ]);
  return makeReport({
    ...shared,
    value: Math.min(dietRise / 0.02, attackSdRatio / 1.1, persists ? 1 : 0),
    status,
    detail: `expressed diet Δ${dietRise.toFixed(3)}; attack SD ×${attackSdRatio.toFixed(2)}; predator guild ${persists ? 'persisted' : 'did not persist'} 50 generations`,
    series: {
      meanDiet,
      attackSd: run.rows.map((row) => row.traits.attack.sd),
      predatorFraction: run.rows.map((row) => row.guilds.predatorFraction),
      carrionBiomass: recorderSeries(run, 'resources.carrionTotal'),
    },
  });
}

export const reEvolvabilityProbe: ProbeDefinition = {
  id: 'P16',
  name: 'Predator re-evolvability',
  scenario: REEVOLVABILITY_SCENARIO,
  severity: 'warn',
  evaluate: (runs) => runs.map(reEvolvabilityReport),
  aggregate: { kind: 'k-of-n', minPassFraction: 1 / 3, label: 're-evolvability criterion passes on ≥1/3 seeds' },
};
