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
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';

import type { SimEvent } from '../contracts/events';
import type { ProbeReport, ProbeSuiteReport, SampleRow } from '../contracts/stats';
import { DEFAULT_SIM_CONFIG, resolveSimConfig } from '../contracts/types';
import { createSim } from '../sim/engine';
import { parseArguments } from './cli';
import type { RunResult } from './harness';
import { buildModules, runScenario } from './harness';
import { kOfNReport, makeReport } from './probe';
import type { ProbeDefinition } from './probe';
import { deterministicIdSample, fstCriterionMargin } from './probes/barrier';
import { frequencyFromPairedMeans, sweepProbe } from './probes/community';
import { pooledRateReport } from './probes/disturbance';
import { snapshotCensusDetail } from './probes/determinism';
import { temporalCensusMean } from './probes/genetics';
import { scanForBannedEntropy, scanSourceForBannedEntropy } from './probes/hygiene';
import { PROBES } from './probes/index';
import { THROUGHPUT_TARGET } from './probes/performance';
import { droppedBirthFraction, viabilityReport } from './probes/population';
import { BIOMASS_COLUMN } from '../stats/detection';
import { resolvedConfigHash, sourceCommitSha, writeArtifacts } from './report';
import { ageStructureProbe } from './probes/lifehistory';
import { couplingProbe, mimicryProbe } from './probes/aposematism';
import {
  APOSEMATISM_SCENARIO,
  BARRIER_ID,
  ONTOGENY_SCENARIO,
  SCENARIOS,
  ScenarioNotes,
  TOGGLE_KEYS,
  scenarioByName,
  toggleScenarioName,
} from './scenarios';
import { FULL_SCENARIOS, QUICK_SCENARIOS, defaultSuiteOptions, runSuite } from './suite';
import { formatDuration, startStopwatch } from './timing';

function minimalRow(generation: number, population: number, neTemporal: number | null = null): SampleRow {
  return {
    tick: generation * 900,
    generation,
    population,
    popgen: { neTemporal },
  } as SampleRow;
}

function minimalRun(overrides: Partial<RunResult> = {}): RunResult {
  const config = resolveSimConfig();
  return {
    scenario: 'baseline',
    seed: 'test-seed',
    config,
    rows: [],
    births: 0,
    generationsRun: 300,
    extinctGeneration: null,
    diagnostics: { birthsDropped: 0 },
    notes: new ScenarioNotes(),
    ...overrides,
  } as RunResult;
}

/**
 * A run whose recorder reports one biomass reading per row. P3 reads the
 * series off `stats.column`, so a synthetic run has to carry one; a stub that
 * returned null would exercise the not-evaluable path instead of the band.
 */
function runWithBiomass(rows: readonly SampleRow[], biomassCm: readonly number[], overrides: Partial<RunResult> = {}): RunResult {
  return minimalRun({
    rows,
    stats: {
      column: (name: string) => (name === BIOMASS_COLUMN ? Float64Array.from(biomassCm) : null),
    } as RunResult['stats'],
    ...overrides,
  });
}

describe('probe registry', () => {
  it('covers P1 through P19 exactly once, in the plan’s order', () => {
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
      'P15',
      'P16',
      'P17',
      'P18',
      'P19',
    ]);
  });

  it('gates exactly the probes A7 has ratcheted, plus the code-property pair', () => {
    const gates = PROBES.filter((probe) => probe.severity === 'gate').map((probe) => probe.id);
    // P1 and P2 gate from day one; P3 was ratcheted in by A7. Gate A-2
    // demoted A7's other two ratchets — P5 (metric rewards noise) and P13
    // (post-hoc ceiling, unasserted cross-check) — and left P12 at warn.
    // Rulings and re-promotion criteria: briefs/gate-a2-verdict.md.
    expect(gates).toEqual(['P1', 'P2', 'P3']);
  });

  it('names a scenario that exists, or builds its own', () => {
    for (const probe of PROBES) {
      if (probe.standalone === true && !SCENARIOS.has(probe.scenario)) continue;
      expect(SCENARIOS.has(probe.scenario), `${probe.id} reads '${probe.scenario}'`).toBe(true);
    }
  });

  it('declares the documented P9 and P10 cross-seed prevalence rules', () => {
    expect(PROBES.find((probe) => probe.id === 'P6')?.aggregate).toMatchObject({ kind: 'custom' });
    expect(PROBES.find((probe) => probe.id === 'P9')?.aggregate).toMatchObject({
      kind: 'k-of-n',
      minPassFraction: 1,
    });
    // P10's floor was restated against the G6 9-seed base-rate panel
    // (2026-08-17): 2/9 injected sweeps complete, so the bar asserts
    // visibility (≥1/9), not a rate the data cannot support.
    expect(sweepProbe.aggregate).toMatchObject({ kind: 'k-of-n', minPassFraction: 1 / 9 });
    expect(sweepProbe.companionScenarios).toEqual(['sweep-control']);
    expect(PROBES.find((probe) => probe.id === 'P16')?.aggregate).toMatchObject({
      kind: 'k-of-n',
      minPassFraction: 1 / 3,
    });
    expect(PROBES.find((probe) => probe.id === 'P15')?.aggregate).toMatchObject({ kind: 'custom' });
  });

  it('pools P15 rate ratios across seeds instead of judging per-seed shot noise', () => {
    const config = resolveSimConfig();
    const expectedPerRun = [
      config.disturbance.thermalRatePerGeneration,
      config.disturbance.planktonCrashRatePerGeneration,
      config.disturbance.kelpStormRatePerGeneration,
    ].map((rate) => rate * 600);
    const shockEvents = (counts: readonly number[]): SimEvent[] =>
      (['thermalShock', 'planktonCrash', 'kelpStorm'] as const).flatMap((kind, index) =>
        Array.from({ length: counts[index] ?? 0 }, () => ({ kind, tick: 90_000, durationTicks: 900 }) as SimEvent),
      );
    const regimeRun = (seed: string, counts: readonly number[]): RunResult =>
      minimalRun({
        scenario: 'disturbance-smoke',
        seed,
        generationsRun: 600,
        generationsRequested: 600,
        events: shockEvents(counts),
      });

    // Each seed alone sits outside ±40% on at least one type; the pool lands on 1.0.
    const low = regimeRun('a', expectedPerRun.map((value) => Math.round(0.5 * value)));
    const high = regimeRun('b', expectedPerRun.map((value) => Math.round(1.5 * value)));
    const pooled = pooledRateReport([low, high]);
    expect(pooled).toMatchObject({ probeId: 'P15', seed: '2 seeds', status: 'pass' });

    // A pooled deficit is still a breach — the band tests the scheduler, not the dice.
    const silent = pooledRateReport([regimeRun('a', [0, 0, 0]), regimeRun('b', [0, 0, 0])]);
    expect(silent?.status).toBe('warn');

    // Smoke-mode runs (quick suite) carry scripted shocks only and stay out of the pool.
    expect(pooledRateReport([minimalRun({ generationsRequested: 3 }), minimalRun({ generationsRequested: 3 })])).toBeNull();
  });
});

describe('scenarios', () => {
  it('offers exactly one arm per mechanism toggle, always flipped away from the default', () => {
    for (const toggle of TOGGLE_KEYS) {
      const scenario = scenarioByName(toggleScenarioName(toggle));
      const shipped = DEFAULT_SIM_CONFIG.toggles[toggle];
      expect(scenario.overrides.toggles?.[toggle]).toBe(!shipped);
      // A default-off mechanism whose arm turned it off again would be
      // `baseline` under another name and would measure nothing.
      expect(toggleScenarioName(toggle).startsWith('no-')).toBe(shipped);
    }
  });

  it('puts the two G-wave arms in both suites, because probes read them', () => {
    expect(QUICK_SCENARIOS).toContain(ONTOGENY_SCENARIO);
    expect(QUICK_SCENARIOS).toContain(APOSEMATISM_SCENARIO);
    expect(FULL_SCENARIOS).toContain(ONTOGENY_SCENARIO);
    expect(FULL_SCENARIOS).toContain(APOSEMATISM_SCENARIO);
    for (const probe of [ageStructureProbe, couplingProbe, mimicryProbe]) {
      expect(QUICK_SCENARIOS).toContain(probe.scenario);
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

    scenario.onSample?.({ sim, config, stats, rows: [], notes }, minimalRow(50, sim.state.liveCount));
    const leftCounts = notes.seriesFor('barrier:left:count')?.values ?? [];
    const rightCounts = notes.seriesFor('barrier:right:count')?.values ?? [];
    expect((leftCounts.at(-1) ?? 0) + (rightCounts.at(-1) ?? 0)).toBe(sim.state.liveCount);
    expect(notes.seriesFor('barrier:left:displayHue:resultant')?.values).toHaveLength(1);
    expect(notes.seriesFor('barrier:right:prefTarget:resultant')?.values).toHaveLength(1);
    expect(notes.seriesFor('barrier:left:diet:mean')?.values).toHaveLength(1);
    expect(notes.seriesFor('barrier:right:size:mean')?.values).toHaveLength(1);
  });
});

describe('fixed probe criteria', () => {
  it('states P3 in biomass, not head count', () => {
    // 4,096 heads is over the retired [100, 3500] head band and would have been
    // a breach; at 5 cm each the standing crop is 20,480 cm, mid-band.
    const report = viabilityReport(runWithBiomass([minimalRow(31, 4_000)], [20_480], { births: 10_000 }));
    expect(report.status).toBe('pass');
    expect(report.threshold.label).toContain('biomass ∈ [4000, 62000]');
    expect(report.detail).toContain('population 4000–4000');
  });

  it('fails P3 when the standing crop leaves the band in either direction', () => {
    const rows = [minimalRow(31, 500), minimalRow(32, 500)];
    expect(viabilityReport(runWithBiomass(rows, [3_000, 3_000], { births: 10_000 })).status).toBe('fail');
    expect(viabilityReport(runWithBiomass(rows, [80_000, 80_000], { births: 10_000 })).status).toBe('fail');
    expect(viabilityReport(runWithBiomass(rows, [20_000, 20_000], { births: 10_000 })).status).toBe('pass');
  });

  it('tolerates bounded cap clipping and fails sustained regulation by the slot array', () => {
    const rows = [minimalRow(31, 500)];
    // The G0 artifact seed's shape: a real but bounded share of attempted
    // births lost to the container.
    const bounded = viabilityReport(
      runWithBiomass(rows, [20_000], { births: 99_000, diagnostics: { birthsDropped: 1_000 } as RunResult['diagnostics'] }),
    );
    expect(bounded.status).toBe('pass');
    expect(bounded.detail).toContain('1.00%');

    const sustained = viabilityReport(
      runWithBiomass(rows, [20_000], { births: 90_000, diagnostics: { birthsDropped: 10_000 } as RunResult['diagnostics'] }),
    );
    expect(sustained.status).toBe('fail');
    expect(sustained.threshold.label).toContain('dropped births ≤2%');
  });

  it('refuses to grade P3 when the biomass series does not line up with the rows', () => {
    const report = viabilityReport(runWithBiomass([minimalRow(31, 500), minimalRow(32, 500)], [20_000]));
    expect(report.status).toBe('fail');
    expect(Number.isNaN(report.value)).toBe(true);
    expect(report.detail).toContain('did not align');
  });

  it('prices dropped births against attempted births, not against survivors', () => {
    expect(droppedBirthFraction(90, 10)).toBeCloseTo(0.1);
    expect(droppedBirthFraction(0, 0)).toBe(0);
  });

  it('gives P8a a negative displayed margin when either Fst criterion fails', () => {
    expect(fstCriterionMargin(0.3, 0.2)).toBeCloseTo(-0.05);
    expect(fstCriterionMargin(0.3, 0.1)).toBeCloseTo(0.05);
  });

  it('samples acceptance candidates by organism id rather than first slot', () => {
    const slots = Array.from({ length: 128 }, (_, index) => index);
    const ids = Float64Array.from(slots, (slot) => 10_000 - slot * 17);
    const sampled = deterministicIdSample(slots, ids, 64);
    expect(sampled).toHaveLength(64);
    expect(sampled.some((slot) => slot >= 64)).toBe(true);
    expect(deterministicIdSample([...slots].reverse(), ids, 64)).toEqual(sampled);
  });

  it('subtracts P10 control-arm movement before estimating sweep frequency', () => {
    expect(frequencyFromPairedMeans(10, 9, 4)).toBe(0.25);
    expect(frequencyFromPairedMeans(10, 10, 4)).toBe(0);
  });

  it('uses the mean census over P14 temporal-Ne windows', () => {
    const rows = [minimalRow(0, 100), minimalRow(3, 200), minimalRow(5, 300, 60)];
    expect(temporalCensusMean(rows, rows[2] as SampleRow, 4)).toBe(200);
  });

  it('uses the Gate A-2 watchability floor for P12', () => {
    expect(THROUGHPUT_TARGET).toBe(900_000);
  });

  it('describes P1 census at the snapshot rather than at the end', () => {
    expect(snapshotCensusDetail(42)).toBe(
      '42 organisms alive at the snapshot (the source handle remains at that tick)',
    );
    expect(snapshotCensusDetail(42)).not.toContain('at the end');
  });
});

describe('RNG hygiene (P2)', () => {
  it('finds no banned entropy or clock reference outside src/probes/timing.ts', () => {
    expect(scanForBannedEntropy()).toEqual([]);
  });

  it('detects aliased crypto randomness and non-Date clock sources', () => {
    const source = [
      "import { randomBytes as entropy } from 'node:crypto';",
      'const clock = process.hrtime;',
      'const { randomUUID: uuid } = crypto;',
      'entropy(8);',
      'clock.bigint();',
      'uuid();',
    ].join('\n');
    const tokens = scanSourceForBannedEntropy(source, 'aliased.ts').map((violation) => violation.token);
    expect(tokens).toContain('crypto.randomBytes');
    expect(tokens).toContain('process.hrtime');
    expect(tokens).toContain('crypto.randomUUID');
  });

  it('detects Date construction, performance time origin and Temporal clocks', () => {
    const source = [
      'const stamp = new globalThis.Date();',
      'const origin = globalThis.performance.timeOrigin;',
      'const instant = Temporal.Now.instant();',
    ].join('\n');
    const tokens = scanSourceForBannedEntropy(source, 'clocks.ts').map((violation) => violation.token);
    expect(tokens).toContain('new Date()');
    expect(tokens).toContain('performance.timeOrigin');
    expect(tokens).toContain('Temporal.Now.instant');
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

describe('cross-seed aggregation', () => {
  const definition: ProbeDefinition = {
    id: 'PX',
    name: 'Example',
    scenario: 'baseline',
    severity: 'warn',
    evaluate: () => [],
  };
  const report = (seed: string, status: ProbeReport['status']): ProbeReport =>
    makeReport({
      probeId: 'PX',
      name: 'Example',
      scenario: 'baseline',
      seed,
      severity: 'warn',
      value: status === 'pass' ? 1 : 0,
      threshold: { min: 1, label: 'pass' },
      status,
      generationsRun: 10,
    });
  const runs = ['a', 'b', 'c'].map((seed) => minimalRun({ seed }));

  it('emits a separately thresholded k-of-n row', () => {
    const aggregate = kOfNReport(
      definition,
      [report('a', 'pass'), report('b', 'warn'), report('c', 'warn')],
      runs,
      1 / 3,
      '≥1/3 seeds',
    );
    expect(aggregate).toMatchObject({
      seed: '1/3 seeds',
      value: 1 / 3,
      status: 'pass',
      threshold: { min: 1 / 3 },
    });
  });

  it('keeps an n-of-n declaration yellow when one seed misses', () => {
    const aggregate = kOfNReport(
      definition,
      [report('a', 'pass'), report('b', 'pass'), report('c', 'warn')],
      runs,
      1,
      'all seeds',
    );
    expect(aggregate?.value).toBe(2 / 3);
    expect(aggregate?.status).toBe('warn');
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
    // probe must report "could not evaluate" rather than a number. P3 breaches
    // at `fail` rather than `warn` since A7 ratcheted it to a gate: an
    // unmeasurable window is a breach at the probe's own severity.
    const viability = report.reports.find((probe) => probe.probeId === 'P3');
    expect(viability?.status).toBe('fail');
    expect(Number.isNaN(viability?.value ?? 0)).toBe(true);
  });

  it('displays P8a and P8b as separate report rows', () => {
    const { report } = runSuite({
      suite: 'custom',
      seeds: ['p8-shape'],
      scenarios: ['barrier'],
      generations: 1,
      probes: ['P8'],
    });
    const p8 = report.reports.filter((probe) => probe.probeId === 'P8');
    expect(p8).toHaveLength(2);
    expect(p8.map((probe) => probe.name)).toEqual([
      'Barrier divergence — P8a neutral Fst',
      'Barrier divergence — P8b mate isolation',
    ]);
    expect(p8.every((probe) => probe.threshold.label.length > 0)).toBe(true);
  });
});

describe('artifact provenance', () => {
  it('hashes resolved configs canonically and changes when the config changes', () => {
    const baseline = minimalRun({ config: resolveSimConfig({}) });
    const same = minimalRun({ config: resolveSimConfig({}) });
    const changed = minimalRun({ config: resolveSimConfig({ world: { initialPopulation: 601 } }) });
    expect(resolvedConfigHash([baseline])).toBe(resolvedConfigHash([same]));
    expect(resolvedConfigHash([baseline, same])).toBe(resolvedConfigHash([baseline]));
    expect(resolvedConfigHash([changed])).not.toBe(resolvedConfigHash([baseline]));
  });

  it('writes identity filenames, clock-free provenance, and a stable latest report', () => {
    const run = minimalRun({
      scenario: 'baseline',
      seed: 'artifact-provenance',
      generationsRequested: 1,
      stats: { toJsonl: () => '' } as unknown as RunResult['stats'],
    });
    const suite: ProbeSuiteReport = {
      suite: 'custom',
      startedAtTick: 0,
      seeds: [run.seed],
      reports: [],
      status: 'pass',
      durationMs: 0,
    };
    const artifacts = writeArtifacts(suite, [run]);
    const sha = sourceCommitSha();
    expect(sha).toMatch(/^(unknown|[0-9a-f]{40})$/);
    expect(basename(artifacts.reportFile)).toMatch(/^custom-(unknown|[0-9a-f]{8})-[0-9a-f]{10}-report\.json$/);
    expect(basename(artifacts.latestReportFile)).toBe('custom-report.json');
    const saved = JSON.parse(readFileSync(artifacts.reportFile, 'utf8')) as {
      readonly provenance: Readonly<Record<string, string>>;
    };
    expect(saved.provenance).toMatchObject({
      sourceCommitSha: sha,
      nodeVersion: process.version,
    });
    expect(typeof saved.provenance.hostname).toBe('string');
    expect(saved.provenance.resolvedConfigHash).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(artifacts.latestReportFile, 'utf8')).toBe(readFileSync(artifacts.reportFile, 'utf8'));
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
   * The regression test for the defect P1 caught at integration: K is derived
   * state a snapshot does not carry, `decideBehavior` reads it, and
   * `regrowResources` used to refresh it only every `RESOURCE_UPDATE_INTERVAL`
   * ticks — so a restore between interval steps ran on generation-zero carrying
   * capacity for up to three ticks and never rejoined the uninterrupted run.
   *
   * The snapshot tick is deliberately one that is *not* followed by an interval
   * step (601 % 4 ≠ 0): the bug was invisible from the one restore point in
   * four where the next tick recomputed K anyway.
   */
  it('continues from a restore exactly as an uninterrupted run would', () => {
    const source = build();
    source.step(600);
    const snapshot = source.snapshot();
    const restored = createSim({ seed: 'integration', config: overrides, modules: buildModules(config).modules, snapshot });

    // The first tick is asserted on its own: a memo that returns full-precision
    // doubles on a miss and float32 on a hit diverges exactly here (the restore
    // runs cold-cache against a warm-cache source) and can re-converge before a
    // later checkpoint — which hid the F4 memo-precision defect on 2 of 3 seeds.
    restored.step(1);
    source.step(1);
    expect(restored.stateHash()).toBe(source.stateHash());

    restored.step(599);
    source.step(599);
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
