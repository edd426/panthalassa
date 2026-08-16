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
import { TRAIT_COUNT, TRAIT_INDEX } from '../contracts/traits';
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
  onSample({ sim, notes }, row) {
    if (notes.number('barrierXWu') === undefined) return;
    const pop = sim.state.pop;
    const barrierX = notes.number('barrierXWu') ?? 0;
    const diagnostics = [
      { count: 0, hueSin: 0, hueCos: 0, prefSin: 0, prefCos: 0, diet: 0, size: 0 },
      { count: 0, hueSin: 0, hueCos: 0, prefSin: 0, prefCos: 0, diet: 0, size: 0 },
    ];

    for (let slot = 0; slot < pop.capacity; slot += 1) {
      if (pop.alive[slot] !== 1) continue;
      const side = (pop.x[slot] ?? 0) < barrierX ? 0 : 1;
      const sums = diagnostics[side];
      if (sums === undefined) continue;
      const base = slot * TRAIT_COUNT;
      const hue = ((pop.traits[base + TRAIT_INDEX.displayHue] ?? 0) * Math.PI) / 180;
      const pref = ((pop.traits[base + TRAIT_INDEX.prefTarget] ?? 0) * Math.PI) / 180;
      sums.count += 1;
      sums.hueSin += Math.sin(hue);
      sums.hueCos += Math.cos(hue);
      sums.prefSin += Math.sin(pref);
      sums.prefCos += Math.cos(pref);
      sums.diet += pop.traits[base + TRAIT_INDEX.diet] ?? 0;
      sums.size += pop.traits[base + TRAIT_INDEX.size] ?? 0;
    }

    for (const side of [0, 1] as const) {
      const sums = diagnostics[side];
      if (sums === undefined) continue;
      const label = side === 0 ? 'left' : 'right';
      const count = sums.count;
      const circular = (sin: number, cos: number): readonly [number, number] => {
        if (count === 0) return [Number.NaN, Number.NaN];
        const degrees = (Math.atan2(sin, cos) * 180) / Math.PI;
        return [(degrees + 360) % 360, Math.hypot(sin, cos) / count];
      };
      const [hueMean, hueResultant] = circular(sums.hueSin, sums.hueCos);
      const [prefMean, prefResultant] = circular(sums.prefSin, sums.prefCos);
      notes.push(`barrier:${label}:count`, row.tick, count);
      notes.push(`barrier:${label}:displayHue:mean`, row.tick, hueMean);
      notes.push(`barrier:${label}:displayHue:resultant`, row.tick, hueResultant);
      notes.push(`barrier:${label}:prefTarget:mean`, row.tick, prefMean);
      notes.push(`barrier:${label}:prefTarget:resultant`, row.tick, prefResultant);
      notes.push(`barrier:${label}:diet:mean`, row.tick, count > 0 ? sums.diet / count : Number.NaN);
      notes.push(`barrier:${label}:size:mean`, row.tick, count > 0 ? sums.size / count : Number.NaN);
    }
  },
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
 * The tracked discrete companion — **moved to a crash-neutral locus** (G4).
 *
 * It used to be `cladeMacroA:3`, chosen because the clade macro-loci are the
 * only discrete loci where an injected allele genuinely starts at 1/2N, and
 * because allele 3 there founds the armoured-crawler body plan and so was both
 * rare and consequential. Consequential is exactly what broke it: the D-wave
 * disturbance regime selects on body plan and reverses that selection at every
 * crash, so the reported fixation-rate line conflated a 1/2N start, selection
 * on the plan, and the regime undoing it. It read `never raised
 * sweepCrossedHalf; final frequency 0.0000` on all fifteen spec-length seeds on
 * file — a line from which nothing could be inferred.
 *
 * `neutralD` is a k=8 marker with no `DISCRETE_EFFECTS` row and no quantitative
 * load, so nothing selects on it and disturbances can only move it through Ne.
 * The cost of that choice, stated rather than hidden: founders draw neutral
 * markers uniformly, so the tracked allele starts near 1/8 rather than at 1/2N,
 * and the scenario records the **observed** pre-injection frequency below
 * instead of the 1/2N figure, which would now be a lie.
 */
export const SWEEP_DISCRETE_LOCUS = 'neutralD' as const;
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

/**
 * The tracked allele's frequency and the census-based Ne as they stood the
 * sample before the injection.
 *
 * P10 needs both to say anything about the neutral arm: `Δf` is measured from
 * where the marker actually was, and the drift SD it is compared against is
 * `sqrt(f(1−f)·t / (2·Ne))`, which needs an Ne the probe cannot reconstruct
 * after the fact. Recorded rather than recomputed for the same reason
 * `sweepAlleleOffset` is.
 */
function recordTrackedAlleleBaseline(rows: readonly SampleRow[], notes: ScenarioNotes): void {
  const latest = rows[rows.length - 1];
  if (latest === undefined) return;
  notes.setNumber(
    'trackedAlleleStartFrequency',
    latest.discreteAlleleFreq[SWEEP_DISCRETE_LOCUS][SWEEP_DISCRETE_ALLELE] ?? 0,
  );
  notes.setNumber('trackedAlleleStartNe', latest.popgen.neDemographic);
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
      apply({ sim, config, rows, notes }) {
        const offset = sweepAlleleOffset(config, rows);

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
        notes.setNumber('sweepStartFrequency', 1 / Math.max(1, 2 * sim.state.liveCount));
        notes.setText('sweepQuantLocus', SWEEP_QUANT_LOCUS);
        recordTrackedAlleleBaseline(rows, notes);
      },
    },
  ],
  generations: 200,
  quickGenerations: 55,
  stopOnExtinction: true,

  /** `SampleRow` has no per-quantitative-locus channel, so P10 records the treatment arm here. */
  onSample({ sim, stats, notes }, row) {
    const index = QUANT_LOCUS_BY_ID[SWEEP_QUANT_LOCUS].index;
    notes.push('sweepLocusMean', row.tick, stats.quantLocusMoments(sim.state).mean[index] ?? 0);
  },
};

/**
 * P10's counterfactual arm. A zero-offset clone preserves the focal command's
 * population and id effects, while the discrete companion is mirrored exactly,
 * leaving the locus-mean difference attributable to the quantitative edit.
 */
const sweepControl: Scenario = {
  name: 'sweep-control',
  description: `Sham-injection control paired with sweep at generation ${SWEEP_INJECTION_GENERATION}. Feeds P10.`,
  overrides: {},
  interventions: [
    {
      atGeneration: SWEEP_INJECTION_GENERATION,
      label: 'sham quantitative edit with matched discrete companion',
      apply({ sim, notes }) {
        sim.command({ kind: 'introduceMutant', count: 1, locus: SWEEP_QUANT_LOCUS, value: 0 });
        sim.command({
          kind: 'introduceMutant',
          count: 1,
          locus: SWEEP_DISCRETE_LOCUS,
          value: SWEEP_DISCRETE_ALLELE,
        });
        sim.command({ kind: 'trackSweep', locus: SWEEP_DISCRETE_LOCUS, allele: SWEEP_DISCRETE_ALLELE });
        notes.setNumber('sweepControlTick', sim.state.tick);
      },
    },
  ],
  generations: sweep.generations,
  quickGenerations: sweep.quickGenerations,
  stopOnExtinction: true,
  onSample({ sim, stats, notes }, row) {
    const index = QUANT_LOCUS_BY_ID[SWEEP_QUANT_LOCUS].index;
    notes.push('sweepControlLocusMean', row.tick, stats.quantLocusMoments(sim.state).mean[index] ?? 0);
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
  overrides: { world: { initialPopulation: 400 }, toggles: { enableDisturbances: true } },
  interventions: [],
  generations: DETERMINISM_TICKS / DEFAULT_SIM_CONFIG.time.generationTicks,
  quickGenerations: DETERMINISM_TICKS / DEFAULT_SIM_CONFIG.time.generationTicks,
  stopOnExtinction: false,
};

// ---------------------------------------------------------------------------
// Mechanism-toggle variants (WP-A7)
// ---------------------------------------------------------------------------

/**
 * One scenario per `MechanismToggles` entry, that entry flipped away from its
 * default and everything else left alone.
 *
 * These exist so A7 can measure each variance mechanism's *marginal*
 * contribution by differencing the arm against `baseline`, rather than arguing
 * about which knob mattered. The flip is against the **default**, not
 * unconditionally off: the G-wave mechanisms ship off (`enableOntogeny`,
 * `enableAposematism` are false in `DEFAULT_SIM_CONFIG`), so an off arm for
 * those would be `baseline` under another name and would measure nothing. Each
 * mechanism therefore gets exactly one arm, and it is always the arm where the
 * mechanism differs from the shipped world.
 */
export const TOGGLE_KEYS = [
  'enableSpatialGxE',
  'enableFrequencyDependentPredation',
  'enableClimateWalk',
  'enableMutation',
  'enableSeasonality',
  'enableAssortativeMating',
  'enableDisturbances',
  // v1.7: carrion separated from shocks, so each finally has its own arm.
  'enableCarrion',
  // G-wave v1.7, default-off: these two arms turn the mechanism ON. P17 and P18
  // read them.
  'enableOntogeny',
  'enableAposematism',
] as const satisfies readonly (keyof MechanismToggles)[];

/** The value {@link toggleScenarioName}'s arm sets: the opposite of the shipped default. */
export function toggleArmValue(toggle: keyof MechanismToggles): boolean {
  return !DEFAULT_SIM_CONFIG.toggles[toggle];
}

/** `enableSpatialGxE` → `no-spatialGxE`; a default-off toggle → `ontogeny`. */
export function toggleScenarioName(toggle: keyof MechanismToggles): string {
  const stem = `${toggle.slice('enable'.length, 'enable'.length + 1).toLowerCase()}${toggle.slice('enable'.length + 1)}`;
  return toggleArmValue(toggle) ? stem : `no-${stem}`;
}

function toggleScenario(toggle: keyof MechanismToggles): Scenario {
  const value = toggleArmValue(toggle);
  return {
    name: toggleScenarioName(toggle),
    description: `Baseline with ${toggle} ${value ? 'on' : 'off'}, for the marginal-contribution measurement.`,
    overrides: { toggles: { [toggle]: value } },
    interventions: [],
    generations: 300,
    quickGenerations: 60,
    stopOnExtinction: true,
  };
}

/** The ontogeny arm, named for the probes that read it. */
export const ONTOGENY_SCENARIO = toggleScenarioName('enableOntogeny');
/** The aposematism arm, named for the probes that read it. */
export const APOSEMATISM_SCENARIO = toggleScenarioName('enableAposematism');

// ---------------------------------------------------------------------------
// disturbance smoke / P15
// ---------------------------------------------------------------------------

export const DISTURBANCE_SMOKE_SCENARIO = 'disturbance-smoke';

const disturbanceSmoke: Scenario = {
  name: DISTURBANCE_SMOKE_SCENARIO,
  description: 'Scripted thermal, plankton and kelp shocks; spec runs also measure the natural scheduler. Feeds P15.',
  overrides: {},
  interventions: [
    {
      atGeneration: 0.2,
      label: 'script thermal shock',
      apply({ sim, config, notes }) {
        sim.command({
          kind: 'triggerDisturbance',
          shock: 'thermal',
          magnitude: 3,
          durationTicks: 5 * config.time.generationTicks,
        });
        notes.setNumber('scriptedThermal', 1);
      },
    },
    {
      atGeneration: 0.4,
      label: 'script regional plankton crash',
      apply({ sim, config, notes }) {
        sim.command({
          kind: 'triggerDisturbance',
          shock: 'planktonCrash',
          magnitude: 0.35,
          durationTicks: 5 * config.time.generationTicks,
          region: { kind: 'disc', xWu: config.world.widthWu / 2, yWu: config.world.heightWu / 2, radiusWu: 300 },
        });
        notes.setNumber('scriptedPlankton', 1);
      },
    },
    {
      atGeneration: 0.6,
      label: 'script kelp storm',
      apply({ sim, config, notes }) {
        sim.command({
          kind: 'triggerDisturbance',
          shock: 'kelpStorm',
          magnitude: 0.9,
          durationTicks: 5 * config.time.generationTicks,
          region: {
            kind: 'rect',
            xWu: config.world.widthWu * 0.4,
            yWu: 0,
            widthWu: config.world.widthWu * 0.2,
            heightWu: config.world.heightWu,
          },
        });
        notes.setNumber('scriptedKelp', 1);
      },
    },
    {
      atGeneration: 0.8,
      label: 'capture mid-shock snapshot hash',
      apply({ sim, notes }) {
        const snapshot = sim.snapshot();
        notes.setNumber('midShockSnapshotMatches', snapshot.stateHash === sim.stateHash() ? 1 : 0);
      },
    },
  ],
  generations: 600,
  quickGenerations: 3,
  stopOnExtinction: true,
};

// ---------------------------------------------------------------------------
// predator re-evolvability / P16
// ---------------------------------------------------------------------------

export const REEVOLVABILITY_SCENARIO = 're-evolvability';
export const REEVOLVABILITY_CRASH_GENERATION = 60;

const reEvolvability: Scenario = {
  name: REEVOLVABILITY_SCENARIO,
  description: 'Filterer-side founders run quiet, then a scripted global plankton crash opens the scavenging ramp. Feeds P16.',
  overrides: {
    genetics: { traitBaselineOverrides: { diet: -1.4 }, founderSdScale: 0.1 },
    disturbance: {
      thermalRatePerGeneration: 0,
      planktonCrashRatePerGeneration: 0,
      kelpStormRatePerGeneration: 0,
    },
  },
  interventions: [
    {
      atGeneration: REEVOLVABILITY_CRASH_GENERATION,
      label: 'script P16 global plankton crash',
      apply({ sim, config, notes }) {
        sim.command({
          kind: 'triggerDisturbance',
          shock: 'planktonCrash',
          magnitude: 0.25,
          durationTicks: 15 * config.time.generationTicks,
          region: null,
        });
        notes.setNumber('p16CrashTick', sim.state.tick);
      },
    },
  ],
  generations: 180,
  quickGenerations: 5,
  stopOnExtinction: true,
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const ALL: readonly Scenario[] = [
  baseline,
  barrier,
  sweep,
  sweepControl,
  speciation,
  perf,
  determinism,
  disturbanceSmoke,
  reEvolvability,
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
