/**
 * The probe suite's own tests.
 *
 * These check the *instrument*, not the simulation: that every probe in the
 * plan's table is registered, that a probe reports rather than throws when its
 * window is empty, that the CLI parses what the docs say it parses, and that
 * the report shapes match the frozen contract. Whether the world is alive is
 * what `npm run probe:quick` answers, and it is not a unit test's job.
 *
 * The one simulation assertion here is a short determinism check, because a
 * determinism break is the one failure that makes every other measurement in
 * the project meaningless, and it should surface on `npm test` rather than
 * waiting for a probe run.
 */

import { describe, expect, it } from 'vitest';

import { resolveSimConfig } from '../contracts/types';
import { createSim } from '../sim/engine';
import { parseArguments } from './cli';
import { buildModules, runScenario } from './harness';
import { scanForBannedEntropy } from './probes/hygiene';
import { PROBES } from './probes/index';
import { BARRIER_ID, SCENARIOS, ScenarioNotes, TOGGLE_KEYS, scenarioByName, toggleScenarioName } from './scenarios';
import { defaultSuiteOptions, runSuite } from './suite';
import { formatDuration, startStopwatch } from './timing';

describe('probe registry', () => {
  it('covers P1 through P14 exactly once, in the plan’s order', () => {
    expect(PROBES.map((probe) => probe.id)).toEqual([
      'P1',
      'P2',
      'P3',
      'P4',
      'P5',
      'P6',
      'P7',
      'P8',
      'P9',
      'P10',
      'P11',
      'P12',
      'P13',
      'P14',
    ]);
  });

  it('gates exactly the three code-property probes', () => {
    const gates = PROBES.filter((probe) => probe.severity === 'gate').map((probe) => probe.id);
    expect(gates).toEqual(['P1', 'P2', 'P12']);
  });

  it('names a scenario that exists, or builds its own', () => {
    for (const probe of PROBES) {
      if (probe.standalone === true && !SCENARIOS.has(probe.scenario)) continue;
      expect(SCENARIOS.has(probe.scenario), `${probe.id} reads '${probe.scenario}'`).toBe(true);
    }
  });
});

describe('scenarios', () => {
  it('offers a toggle-off variant for every mechanism toggle', () => {
    for (const toggle of TOGGLE_KEYS) {
      const scenario = scenarioByName(toggleScenarioName(toggle));
      expect(scenario.overrides.toggles?.[toggle]).toBe(false);
    }
  });

  it('raises the P8 ridge through the command path, and evicts anyone standing in it', () => {
    const scenario = scenarioByName('barrier');
    const config = resolveSimConfig(scenario.overrides);
    const { modules, stats } = buildModules(config);
    const sim = createSim({ seed: 'barrier-test', config: scenario.overrides, modules });
    const notes = new ScenarioNotes();

    expect(sim.state.barriers.specs).toHaveLength(0);
    const intervention = scenario.interventions[0];
    expect(intervention?.atGeneration).toBe(50);

    intervention?.apply({ sim, config, stats, rows: [], notes });

    expect(sim.state.barriers.specs.map((spec) => spec.id)).toEqual([BARRIER_ID]);
    expect(notes.number('barrierXWu')).toBe(config.world.widthWu / 2);
    expect(sim.state.events.some((event) => event.kind === 'barrierChange')).toBe(true);

    const half = config.world.widthWu / 2;
    const thickness = notes.number('barrierThicknessWu') ?? 0;
    for (let slot = 0; slot < sim.pools.capacity; slot += 1) {
      if (sim.pools.alive[slot] !== 1) continue;
      const x = sim.pools.x[slot] ?? 0;
      expect(Math.abs(x - half) >= thickness / 2 - config.world.fieldCellSizeWu).toBe(true);
    }
  });
});

describe('RNG hygiene (P2)', () => {
  it('finds no banned entropy or clock reference outside src/probes/timing.ts', () => {
    expect(scanForBannedEntropy()).toEqual([]);
  });
});

describe('runner arguments', () => {
  it('defaults to the quick suite', () => {
    const { options } = parseArguments([]);
    expect(options.suite).toBe('quick');
    expect(options.seeds).toEqual(defaultSuiteOptions('quick').seeds);
  });

  it('treats a bare --scenario as a custom suite', () => {
    const { options } = parseArguments(['--scenario=barrier', '--seed=s1']);
    expect(options.suite).toBe('custom');
    expect(options.scenarios).toEqual(['barrier']);
    expect(options.seeds).toEqual(['s1']);
  });

  it('accepts lists and a generation override', () => {
    const { options } = parseArguments(['--scenario=baseline,sweep', '--seeds=a,b', '--generations=42']);
    expect(options.scenarios).toEqual(['baseline', 'sweep']);
    expect(options.seeds).toEqual(['a', 'b']);
    expect(options.generations).toBe(42);
  });

  it('keeps an explicit --suite=full', () => {
    expect(parseArguments(['--suite=full']).options.suite).toBe('full');
  });
});

describe('suite reports', () => {
  it('produces contract-shaped reports and never throws on an empty window', () => {
    const { report, skipped } = runSuite({
      suite: 'custom',
      seeds: ['probe-test'],
      scenarios: ['baseline'],
      generations: 4,
      // The standalone gates P1 and P12 build their own sims and are far too
      // slow for `npm test`; `probe:quick` is where they belong.
      probes: ['P3', 'P4', 'P5', 'P6', 'P7', 'P9', 'P13', 'P14'],
    });

    expect(report.startedAtTick).toBe(0);
    expect(report.seeds).toEqual(['probe-test']);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(skipped.some((entry) => entry.startsWith('P8'))).toBe(true);
    expect(report.reports.some((probe) => probe.probeId === 'P12')).toBe(false);

    for (const probe of report.reports) {
      expect(['pass', 'warn', 'fail']).toContain(probe.status);
      expect(['gate', 'warn']).toContain(probe.severity);
      expect(typeof probe.value).toBe('number');
      expect(probe.threshold.label.length).toBeGreaterThan(0);
      expect(probe.seed.length).toBeGreaterThan(0);
    }

    // A four-generation run cannot clear a thirty-generation burn-in, so every
    // warn probe must report "could not evaluate" rather than a number.
    const viability = report.reports.find((probe) => probe.probeId === 'P3');
    expect(viability?.status).toBe('warn');
    expect(Number.isNaN(viability?.value ?? 0)).toBe(true);
  });
});

describe('integration determinism', () => {
  const overrides = { world: { initialPopulation: 200 } };
  const config = resolveSimConfig(overrides);
  const build = (): ReturnType<typeof createSim> =>
    createSim({ seed: 'integration', config: overrides, modules: buildModules(config).modules });

  it('gives two sims of the same seed identical hashes', () => {
    const first = build();
    const second = build();
    first.step(1200);
    second.step(1200);
    expect(second.stateHash()).toBe(first.stateHash());
  });

  it('restores a snapshot to the hash it was captured at', () => {
    const source = build();
    source.step(600);
    const snapshot = source.snapshot();
    expect(snapshot.stateHash).toBe(source.stateHash());

    const restored = createSim({ seed: 'integration', config: overrides, modules: buildModules(config).modules, snapshot });
    expect(restored.stateHash()).toBe(snapshot.stateHash);
  });

  /**
   * KNOWN DEFECT, owned by WP-A2 (`src/sim/ecology/**`). `it.fails` passes
   * while the bug is present and turns red the moment it is fixed — delete
   * this test then, and the P1 row in `probe:quick` goes green with it.
   *
   * `contracts/types.ts` promises `ResourceField.carryingCapacity` is
   * "recomputed from scratch every tick by ecology's regrow stage; snapshots do
   * not carry it". `regrowResources` (`src/sim/ecology/resources.ts`) actually
   * recomputes it only when `tick % RESOURCE_UPDATE_INTERVAL === 0`
   * (interval 4, `src/sim/ecology/runtime.ts`). A restore leaves K holding the
   * generation-zero values `initFields` wrote, and `decideBehavior`
   * (`src/sim/ecology/behavior.ts`, `sampleField(runtime, state.field.carryingCapacity, …)`)
   * reads it — so for up to three ticks the restored world makes different
   * behaviour decisions and the trajectory never rejoins.
   */
  it.fails('continues from a restore exactly as an uninterrupted run would', () => {
    const source = build();
    source.step(600);
    const snapshot = source.snapshot();
    const restored = createSim({ seed: 'integration', config: overrides, modules: buildModules(config).modules, snapshot });

    restored.step(600);
    source.step(600);
    expect(restored.stateHash()).toBe(source.stateHash());
  });
});

describe('scenario runs', () => {
  it('records rows, counts deaths by cause, and reports an extinction honestly', () => {
    const run = runScenario({ scenario: scenarioByName('baseline'), seed: 'run-test', generations: 6 });
    expect(run.rows.length).toBeGreaterThan(0);
    expect(run.rows.every((row, index) => index === 0 || row.tick > (run.rows[index - 1]?.tick ?? 0))).toBe(true);
    expect(run.births).toBeGreaterThan(0);
    expect(run.deaths.predation + run.deaths.starvation).toBeGreaterThan(0);
    expect(run.generationsRun).toBeLessThanOrEqual(6);
    if (run.extinctGeneration !== null) {
      expect(run.generationsRun).toBeCloseTo(run.extinctGeneration, 5);
    }
  });
});

describe('timing', () => {
  it('is monotonic and formats durations', () => {
    const stopwatch = startStopwatch();
    const stopped = stopwatch.stop();
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(stopwatch.stop()).toBe(stopped);
    expect(formatDuration(812)).toBe('812ms');
    expect(formatDuration(4310)).toBe('4.31s');
    expect(formatDuration(64_300)).toBe('1m 04.3s');
  });
});
