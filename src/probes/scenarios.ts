/**
 * Named scenarios: a config override plus a script of interventions at given
 * generations.
 *
 * A scenario is the *experiment*; the probes in `src/probes/probes/**` are the
 * *readings* taken from it. Keeping them apart is what lets one barrier run
 * feed P8's Fst assertion and P3's viability assertion without either probe
 * knowing the other exists, and what lets WP-A7 add a tuning scenario without
 * touching a probe.
 *
 * Interventions go through `SimHandle.command()` — the same path the eventual
 * god-tool buttons will use, and the same path the worker protocol carries. A
 * probe scenario that reached into `SimState` to raise a ridge would be testing
 * a code path the app never runs.
 *
 * Everything here is a pure function of `(config, seed)`: interventions are
 * scheduled by generation, they read only `SimState` and recorded rows, and
 * they never consult a clock. `src/probes/timing.ts` is the only module in this
 * package that may.
 */

import type { SimHandle } from '../contracts/apis';
import { QUANT_LOCUS_BY_ID, W_ROWS_BY_TRAIT, founderGeneticVariance } from '../contracts/genome';
import type { QuantLocusId } from '../contracts/genome';
import type { SampleRow } from '../contracts/stats';
import { DEFAULT_SIM_CONFIG } from '../contracts/types';
import type { MechanismToggles, SimConfig, SimConfigOverrides } from '../contracts/types';
import type { StatsRecorderApi } from '../stats/recorder';

// ---------------------------------------------------------------------------
// Notes: what a scenario tells the probes about what it did
// ---------------------------------------------------------------------------

export interface NotedSeries {
  readonly ticks: readonly number[];
  readonly values: readonly number[];
}

/**
 * The channel from an intervention to the probe that reads it.
 *
 * P10 cannot recompute the sweep injection's allele-unit size after the fact —
 * it was derived from the population as it stood at the injection tick — so the
 * scenario records it here instead of the probe guessing.
 */
export class ScenarioNotes {
  private readonly numbers = new Map<string, number>();
  private readonly texts = new Map<string, string>();
  private readonly series = new Map<string, { ticks: number[]; values: number[] }>();

  setNumber(key: string, value: number): void {
    this.numbers.set(key, value);
  }

  number(key: string): number | undefined {
    return this.numbers.get(key);
  }

  setText(key: string, value: string): void {
    this.texts.set(key, value);
  }

  text(key: string): string | undefined {
    return this.texts.get(key);
  }

  push(key: string, tick: number, value: number): void {
    let entry = this.series.get(key);
    if (entry === undefined) {
      entry = { ticks: [], values: [] };
      this.series.set(key, entry);
    }
    entry.ticks.push(tick);
    entry.values.push(value);
  }

  seriesFor(key: string): NotedSeries | undefined {
    return this.series.get(key);
  }
}

// ---------------------------------------------------------------------------
// Scenario shape
// ---------------------------------------------------------------------------

export interface ScenarioContext {
  readonly sim: SimHandle;
  readonly config: SimConfig;
  readonly stats: StatsRecorderApi;
  /** Rows recorded so far, oldest first. */
  readonly rows: readonly SampleRow[];
  readonly notes: ScenarioNotes;
}

export interface Intervention {
  /** Scheduled in generations; the harness converts with `config.time.generationTicks`. */
  readonly atGeneration: number;
  readonly label: string;
  apply(context: ScenarioContext): void;
}

export interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly overrides: SimConfigOverrides;
  readonly interventions: readonly Intervention[];
  /** Generations for `probe:full` and for a bare `--scenario=` run. */
  readonly generations: number;
  /** Generations for `probe:quick`, sized against the ~4 minute budget. */
  readonly quickGenerations: number;
  /**
   * Stop as soon as the world empties. False only for the performance harness,
   * where an early stop would shorten the timed window rather than saving time.
   */
  readonly stopOnExtinction: boolean;
  /** Called after every recorded row, for series a probe needs that `SampleRow` has no field for. */
  onSample?: (context: ScenarioContext, row: SampleRow) => void;
}

// ---------------------------------------------------------------------------
// baseline
// ---------------------------------------------------------------------------

const baseline: Scenario = {
  name: 'baseline',
  description: 'Authored defaults, no intervention. Feeds P3–P7, P9, P13, P14.',
  overrides: {},
  interventions: [],
  generations: 300,
  quickGenerations: 60,
  stopOnExtinction: true,
};

// ---------------------------------------------------------------------------
// barrier (P8)
// ---------------------------------------------------------------------------

/** Ridge thickness in field cells. Thinner than this and a fast swimmer steps over it in one tick. */
const RIDGE_CELLS = 3;

export const BARRIER_ID = 'p8-ridge';

const barrier: Scenario = {
  name: 'barrier',
  description: 'Vertical ridge raised at generation 50, splitting the world in two. Feeds P8.',
  overrides: {},
  interventions: [
    {
      atGeneration: 50,
      label: 'raise impassable vertical ridge at mid-world',
      apply({ sim, config, notes }) {
        const xWu = config.world.widthWu / 2;
        const thicknessWu = RIDGE_CELLS * config.world.fieldCellSizeWu;
        sim.command({
          kind: 'raiseBarrier',
          barrierId: BARRIER_ID,
          shape: { kind: 'verticalRidge', xWu, thicknessWu },
          permeability: 0,
        });
        notes.setNumber('barrierXWu', xWu);
        notes.setNumber('barrierThicknessWu', thicknessWu);
        notes.setNumber('barrierRaisedTick', sim.state.tick);
      },
    },
  ],
  generations: 300,
  quickGenerations: 60,
  stopOnExtinction: true,
};

// ---------------------------------------------------------------------------
// sweep (P10)
// ---------------------------------------------------------------------------

/**
 * The quantitative locus P10 injects into.
 *
 * `q21` (lipid reserve) loads `size` +0.40 and `metabolicEff` +0.04 and nothing
 * negatively — the only kind of locus where "a bigger allele is better" is a
 * statement about the model rather than a guess about which side of a tradeoff
 * currently pays. It is deliberately not one of `ANTAGONISTIC_LOCI`.
 */
export const SWEEP_QUANT_LOCUS: QuantLocusId = 'q21';

/** The trait `SWEEP_QUANT_LOCUS` loads most heavily; the σ in "+1.5σ" is this trait's. */
export const SWEEP_TRAIT = 'size' as const;

/** Effect size of the injected allele, in population SDs of {@link SWEEP_TRAIT}. */
export const SWEEP_EFFECT_SD = 1.5;

/**
 * The discrete companion.
 *
 * `trackSweep` and `SweepCrossedHalfEvent` are typed to `DiscreteLocusId`, and
 * the clade macro-loci are the only discrete loci where an injected allele
 * genuinely starts at 1/2N: founders are uniform over every other discrete
 * allele set, so "injecting" a pigment allele would drop it into a population
 * that already carries it at ~25%. Allele 3 at `cladeMacroA` also founds the
 * armoured-crawler body plan (see `CLADE_MACRO_TABLE`), so the contract's
 * sweep-visibility path is exercised on an allele that is both rare and
 * consequential.
 */
export const SWEEP_DISCRETE_LOCUS = 'cladeMacroA' as const;
export const SWEEP_DISCRETE_ALLELE = 3;

/** Generation the injection happens at; comfortably past the 30-generation burn-in. */
const SWEEP_INJECTION_GENERATION = 40;

/**
 * Allele-unit offset that moves {@link SWEEP_TRAIT} by {@link SWEEP_EFFECT_SD}
 * population SDs.
 *
 * Measured against the population as it actually stands at the injection tick,
 * falling back to the analytic founder value before any row exists. Both paths
 * are pure functions of `(config, seed)`, so the injected allele is identical
 * across two runs of the same seed — which P1 would otherwise catch.
 */
function sweepAlleleOffset(config: SimConfig, rows: readonly SampleRow[]): number {
  const latest = rows[rows.length - 1];
  const populationSd =
    latest !== undefined && latest.traits[SWEEP_TRAIT].sd > 0
      ? latest.traits[SWEEP_TRAIT].sd
      : Math.sqrt(
          founderGeneticVariance(SWEEP_TRAIT, config.genetics.founderSdScale) /
            Math.max(1e-6, config.genetics.targetFounderHeritability),
        );
  return (SWEEP_EFFECT_SD * populationSd) / Math.max(1e-6, SWEEP_LOCUS_WEIGHT);
}

/** How much one allele copy at {@link SWEEP_QUANT_LOCUS} moves {@link SWEEP_TRAIT}. */
const SWEEP_LOCUS_WEIGHT: number =
  W_ROWS_BY_TRAIT[SWEEP_TRAIT].find((entry) => entry.locusIndex === QUANT_LOCUS_BY_ID[SWEEP_QUANT_LOCUS].index)
    ?.weight ?? 0;

const sweep: Scenario = {
  name: 'sweep',
  description: `Injects a +${SWEEP_EFFECT_SD}σ ${SWEEP_QUANT_LOCUS} allele and a rare ${SWEEP_DISCRETE_LOCUS} allele at 1/2N, generation ${SWEEP_INJECTION_GENERATION}. Feeds P10.`,
  overrides: {},
  interventions: [
    {
      atGeneration: SWEEP_INJECTION_GENERATION,
      label: 'inject one heterozygous carrier of each tracked allele',
      apply({ sim, config, stats, rows, notes }) {
        const offset = sweepAlleleOffset(config, rows);
        const before = stats.quantLocusMoments(sim.state).mean[QUANT_LOCUS_BY_ID[SWEEP_QUANT_LOCUS].index] ?? 0;

        // `applyAlleleEdit` writes one haplotype, so one injected individual is
        // exactly one copy in 2N — the starting frequency P10 asserts from.
        sim.command({ kind: 'introduceMutant', count: 1, locus: SWEEP_QUANT_LOCUS, value: offset });
        sim.command({
          kind: 'introduceMutant',
          count: 1,
          locus: SWEEP_DISCRETE_LOCUS,
          value: SWEEP_DISCRETE_ALLELE,
        });
        sim.command({ kind: 'trackSweep', locus: SWEEP_DISCRETE_LOCUS, allele: SWEEP_DISCRETE_ALLELE });

        notes.setNumber('sweepInjectionTick', sim.state.tick);
        notes.setNumber('sweepAlleleOffset', offset);
        notes.setNumber('sweepBackgroundMean', before);
        notes.setNumber('sweepStartFrequency', 1 / Math.max(1, 2 * sim.state.liveCount));
        notes.setText('sweepQuantLocus', SWEEP_QUANT_LOCUS);
      },
    },
  ],
  generations: 200,
  quickGenerations: 55,
  stopOnExtinction: true,

  /**
   * `SampleRow` carries discrete allele frequencies but nothing per
   * quantitative locus, and P10's headline allele is quantitative. The mean
   * allelic value at the injected locus is the frequency proxy: with one
   * injected copy of size `offset` against a background whose mean is
   * `sweepBackgroundMean`, the population mean rises by `p · offset`.
   */
  onSample({ sim, stats, notes }, row) {
    const index = QUANT_LOCUS_BY_ID[SWEEP_QUANT_LOCUS].index;
    notes.push('sweepLocusMean', row.tick, stats.quantLocusMoments(sim.state).mean[index] ?? 0);
  },
};

// ---------------------------------------------------------------------------
// speciation (P11)
// ---------------------------------------------------------------------------

const speciation: Scenario = {
  name: 'speciation',
  description: 'A long baseline run, 600 generations, looking for coexisting species. Feeds P11.',
  overrides: {},
  interventions: [],
  generations: 600,
  quickGenerations: 60,
  stopOnExtinction: true,
};

// ---------------------------------------------------------------------------
// perf (P12)
// ---------------------------------------------------------------------------

/** Ticks the performance harness runs, from the plan's "500 organisms × 20k ticks". */
export const PERF_TICKS = 20_000;
export const PERF_POPULATION = 500;

/**
 * The performance harness.
 *
 * P12 asks how fast the engine runs *at a given population*, so the scenario's
 * job is to hold one: the slot cap sits just above the target so the population
 * saturates there instead of following whatever trajectory the untuned ecology
 * happens to take, and the three hazard channels are turned down rather than
 * off. Turning them down keeps every stage doing its full per-organism work —
 * `tryPredation` still scans neighbours and evaluates the kill kernel, it just
 * rarely wins the roll — so the measurement stays a measurement of the tick
 * loop rather than of a shortened version of it.
 *
 * This is the one scenario whose config is chosen for the measurement rather
 * than for the biology. No aliveness probe reads it.
 */
const perf: Scenario = {
  name: 'perf',
  description: `Throughput harness: ${PERF_POPULATION} organisms held for ${PERF_TICKS} ticks. Feeds P12.`,
  overrides: {
    world: { initialPopulation: PERF_POPULATION, slotCapacity: PERF_POPULATION + 12 },
    predation: { baseLogit: -12 },
    senescence: { gompertzA: 0 },
    thermal: { hazardCoef: 0 },
    resources: { planktonCarryingCapacityBase: 60, grazingMaxIntake: 1.2 },
  },
  interventions: [],
  generations: PERF_TICKS / DEFAULT_SIM_CONFIG.time.generationTicks,
  quickGenerations: PERF_TICKS / DEFAULT_SIM_CONFIG.time.generationTicks,
  stopOnExtinction: false,
};

// ---------------------------------------------------------------------------
// determinism (P1)
// ---------------------------------------------------------------------------

/** Ticks each of P1's paired runs covers. */
export const DETERMINISM_TICKS = 2_400;

/**
 * Tick P1 snapshots at, then restores from and continues to
 * {@link DETERMINISM_TICKS}.
 *
 * Early on purpose. A snapshot round-trip over an **empty** world is vacuous —
 * two dead oceans always agree — and the untuned ecology empties this one
 * within a few generations, so a later snapshot tick would turn the strongest
 * assertion in the suite into a formality. P1 reports the census at this tick
 * and treats a restore from an empty world as a breach for exactly that reason.
 */
export const DETERMINISM_SNAPSHOT_TICK = 600;

/**
 * P1's run.
 *
 * The authored default config, because P1 has to assert purity of the
 * configuration the project actually ships — only the founding population is
 * raised, to keep organisms alive across the snapshot tick while the ecology is
 * untuned.
 */
const determinism: Scenario = {
  name: 'determinism',
  description: `Paired runs and a snapshot round-trip over ${DETERMINISM_TICKS} ticks. Feeds P1.`,
  overrides: { world: { initialPopulation: 400 } },
  interventions: [],
  generations: DETERMINISM_TICKS / DEFAULT_SIM_CONFIG.time.generationTicks,
  quickGenerations: DETERMINISM_TICKS / DEFAULT_SIM_CONFIG.time.generationTicks,
  stopOnExtinction: false,
};

// ---------------------------------------------------------------------------
// Mechanism-toggle variants (WP-A7)
// ---------------------------------------------------------------------------

/**
 * One scenario per `MechanismToggles` entry, that entry off and everything else
 * at defaults.
 *
 * These exist so A7 can measure each variance mechanism's *marginal*
 * contribution by differencing a toggle-off run against `baseline`, rather than
 * arguing about which knob mattered. They are reachable through
 * `--scenario=no-mutation` and friends; no suite runs them by default, because
 * six extra long runs would put `probe:full` well past its budget.
 */
export const TOGGLE_KEYS = [
  'enableSpatialGxE',
  'enableFrequencyDependentPredation',
  'enableClimateWalk',
  'enableMutation',
  'enableSeasonality',
  'enableAssortativeMating',
] as const satisfies readonly (keyof MechanismToggles)[];

/** `enableSpatialGxE` → `no-spatialGxE`. */
export function toggleScenarioName(toggle: keyof MechanismToggles): string {
  return `no-${toggle.slice('enable'.length, 'enable'.length + 1).toLowerCase()}${toggle.slice('enable'.length + 1)}`;
}

function toggleScenario(toggle: keyof MechanismToggles): Scenario {
  return {
    name: toggleScenarioName(toggle),
    description: `Baseline with ${toggle} off, for A7's marginal-contribution measurement.`,
    overrides: { toggles: { [toggle]: false } },
    interventions: [],
    generations: 300,
    quickGenerations: 60,
    stopOnExtinction: true,
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const ALL: readonly Scenario[] = [
  baseline,
  barrier,
  sweep,
  speciation,
  perf,
  determinism,
  ...TOGGLE_KEYS.map(toggleScenario),
];

export const SCENARIOS: ReadonlyMap<string, Scenario> = new Map(ALL.map((scenario) => [scenario.name, scenario]));

export function scenarioByName(name: string): Scenario {
  const scenario = SCENARIOS.get(name);
  if (scenario === undefined) {
    throw new Error(`Unknown scenario '${name}'. Known: ${[...SCENARIOS.keys()].join(', ')}.`);
  }
  return scenario;
}

export function scenarioNames(): readonly string[] {
  return [...SCENARIOS.keys()];
}
