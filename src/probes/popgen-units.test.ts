/**
 * WP-A4 acceptance probes — the estimators, checked against analytic cases.
 *
 * Everything here runs on **synthetic data built in this file**: no engine, no
 * genetics module, no ecology. That is the point. An Fst that is only ever
 * exercised by a full simulation run is an Fst nobody has checked, because a
 * simulation gives you no independently known answer to compare against. Here
 * the truth is constructed first — two demes at frequencies we chose, a
 * Wright–Fisher population at an N we set, offspring generated at an h² we
 * picked — and the estimator has to find it.
 *
 * Where an estimator's own convention matters (Weir–Cockerham θ is not Nei's
 * G_ST for small numbers of demes; the temporal method has a known variance),
 * the expected value is derived in a comment next to the assertion rather than
 * copied from a run of the code under test.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { PopgenEstimators } from '../contracts/apis';
import type { AncestryRecord } from '../contracts/stats';
import {
  DISCRETE_LOCUS_BY_ID,
  DISCRETE_LOCUS_COUNT,
  NEUTRAL_MARKER_LOCI,
  createEmptyGenome,
} from '../contracts/genome';
import type { Genome } from '../contracts/genome';
import { TRAIT_COUNT, TRAIT_INDEX } from '../contracts/traits';
import {
  NO_ORGANISM,
  SEX_FEMALE,
  SEX_MALE,
  resolveSimConfig,
} from '../contracts/types';
import type {
  OrganismId,
  OrganismPools,
  ResourceField,
  Sex,
  SimConfig,
  SimConfigOverrides,
  SimState,
} from '../contracts/types';
import { SeededRng } from '../sim/rng';
import {
  MIN_DEME_ORGANISMS,
  MIN_INFORMATIVE_MATINGS,
  PopgenEngine,
  StatsRecorder,
  combineSexNe,
  neiTajimaF,
  sexRatioNe,
  temporalNeFromF,
  varianceNeGeneral,
  varianceNeStationary,
} from '../stats';

// ---------------------------------------------------------------------------
// Synthetic world construction
// ---------------------------------------------------------------------------

function makeConfig(overrides: SimConfigOverrides = {}): SimConfig {
  return resolveSimConfig(overrides);
}

function makePools(capacity: number): OrganismPools {
  return {
    capacity,
    alive: new Uint8Array(capacity),
    id: new Float64Array(capacity),
    motherId: new Float64Array(capacity),
    fatherId: new Float64Array(capacity),
    sex: new Uint8Array(capacity),
    archetype: new Uint8Array(capacity),
    cladeId: new Int32Array(capacity),
    speciesTag: new Int32Array(capacity),
    demeId: new Int32Array(capacity),
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    vx: new Float32Array(capacity),
    vy: new Float32Array(capacity),
    energy: new Float32Array(capacity),
    sizeCurrent: new Float32Array(capacity),
    gutFill: new Float32Array(capacity),
    birthTick: new Float64Array(capacity),
    ageTicks: new Uint32Array(capacity),
    lastMatingTick: new Float64Array(capacity),
    behaviorState: new Uint8Array(capacity),
    behaviorTimer: new Uint16Array(capacity),
    targetSlot: new Int32Array(capacity),
    traits: new Float32Array(capacity * TRAIT_COUNT),
    traitsLatent: new Float32Array(capacity * TRAIT_COUNT),
    traitsGenotypic: new Float32Array(capacity * TRAIT_COUNT),
    genomes: new Array<Genome | undefined>(capacity).fill(undefined),
  };
}

function makeField(config: SimConfig): ResourceField {
  const cols = Math.max(1, Math.round(config.world.widthWu / config.world.fieldCellSizeWu));
  const rows = Math.max(1, Math.round(config.world.heightWu / config.world.fieldCellSizeWu));
  const cells = cols * rows;
  return {
    cols,
    rows,
    cellSizeWu: config.world.fieldCellSizeWu,
    plankton: new Float32Array(cells).fill(4),
    carrion: new Float32Array(cells),
    kelp: new Float32Array(cells).fill(0.1),
    carryingCapacity: new Float32Array(cells).fill(12),
    temperature: new Float32Array(cells).fill(17),
  };
}

function makeState(config: SimConfig, capacity: number, tick = 0): SimState {
  return {
    config,
    seed: 'synthetic',
    tick,
    rngState: [1, 2, 3, 4],
    nextOrganismId: 1,
    nextSpeciesTag: 1,
    nextCladeId: 1,
    liveCount: 0,
    pop: makePools(capacity),
    field: makeField(config),
    climate: { meanOffsetC: 0, targetOffsetC: 0, seasonPhaseTicks: 0 },
    disturbance: { thermal: [], planktonCrashes: [], kelpStorms: [] },
    barriers: { cols: 1, rows: 1, cellSizeWu: config.world.widthWu, mask: new Uint8Array(1), specs: [] },
    artificialSelection: { terms: [] },
    events: [],
    deathCounts: { starvation: 0, predation: 0, temperature: 0, senescence: 0, catastrophe: 0, toxin: 0 },
    matingCount: 0,
    crossSpeciesMatingCount: 0,
  };
}

/** A genome carrying the given genotype at each neutral marker; everything else zero. */
function genomeWithMarkers(genotypes: readonly (readonly [number, number])[]): Genome {
  const genome = createEmptyGenome('XX');
  for (let index = 0; index < NEUTRAL_MARKER_LOCI.length; index += 1) {
    const locus = NEUTRAL_MARKER_LOCI[index];
    const pair = genotypes[index];
    if (locus === undefined || pair === undefined) continue;
    genome.discrete[locus.index] = pair[0];
    genome.discrete[DISCRETE_LOCUS_COUNT + locus.index] = pair[1];
  }
  return genome;
}

interface OrganismSpec {
  readonly id: OrganismId;
  readonly x: number;
  readonly y: number;
  readonly genome: Genome;
  readonly sex?: Sex;
  readonly speciesTag?: number;
  readonly latent?: Readonly<Partial<Record<keyof typeof TRAIT_INDEX, number>>>;
  readonly genotypic?: Readonly<Partial<Record<keyof typeof TRAIT_INDEX, number>>>;
  readonly motherId?: OrganismId;
  readonly fatherId?: OrganismId;
  readonly ageTicks?: number;
}

function place(state: SimState, specs: readonly OrganismSpec[]): void {
  const pop = state.pop;
  for (let slot = 0; slot < specs.length; slot += 1) {
    const spec = specs[slot];
    if (spec === undefined) continue;
    pop.alive[slot] = 1;
    pop.id[slot] = spec.id;
    pop.x[slot] = spec.x;
    pop.y[slot] = spec.y;
    pop.genomes[slot] = spec.genome;
    pop.sex[slot] = spec.sex === 'male' ? SEX_MALE : SEX_FEMALE;
    pop.speciesTag[slot] = spec.speciesTag ?? 0;
    pop.ageTicks[slot] = spec.ageTicks ?? 1000;
    pop.motherId[slot] = spec.motherId ?? NO_ORGANISM;
    pop.fatherId[slot] = spec.fatherId ?? NO_ORGANISM;
    for (const [key, value] of Object.entries(spec.latent ?? {})) {
      const traitIndex = TRAIT_INDEX[key as keyof typeof TRAIT_INDEX];
      pop.traitsLatent[slot * TRAIT_COUNT + traitIndex] = value;
    }
    for (const [key, value] of Object.entries(spec.genotypic ?? {})) {
      const traitIndex = TRAIT_INDEX[key as keyof typeof TRAIT_INDEX];
      pop.traitsGenotypic[slot * TRAIT_COUNT + traitIndex] = value;
    }
  }
  state.liveCount = specs.length;
}

// ---------------------------------------------------------------------------
// 1. Weir–Cockerham Fst
// ---------------------------------------------------------------------------

/**
 * The large-sample limit of Weir & Cockerham's θ for `r` equal-sized groups at
 * a biallelic locus with known frequencies.
 *
 * As n → ∞ the components go to `a → s²`, `b + c → p̄(1−p̄) − ((r−1)/r)s²`,
 * where `s² = Σ(pᵢ − p̄)²/(r − 1)` is the among-group variance with WC's
 * `r − 1` divisor. Hence `θ → s² / (p̄(1−p̄) + s²/r)`.
 *
 * Note this is deliberately **not** Nei's `G_ST = Var(p)/(p̄(1−p̄))`: with two
 * demes at 0.7/0.3 this returns 0.276 where G_ST would be 0.16. Both are 1 at a
 * fixed difference and 0 with no structure; they differ in between because WC
 * treats the demes as replicates from a common ancestor. The contract asks for
 * Weir–Cockerham, so this is what the estimator must reproduce.
 */
function analyticWeirCockerham(frequencies: readonly number[]): number {
  const r = frequencies.length;
  const pBar = frequencies.reduce((sum, p) => sum + p, 0) / r;
  const s2 = frequencies.reduce((sum, p) => sum + (p - pBar) ** 2, 0) / (r - 1);
  return s2 / (pBar * (1 - pBar) + s2 / r);
}

/** Exact HWE genotype counts for `n` individuals at frequency `p`, and the realized frequency. */
function hweCounts(n: number, p: number): { homA: number; het: number; homB: number; realized: number } {
  const homA = Math.round(n * p * p);
  const het = Math.round(n * 2 * p * (1 - p));
  const homB = n - homA - het;
  return { homA, het, homB, realized: (2 * homA + het) / (2 * n) };
}

/** Two demes side by side, each in HWE at its own frequency for allele 0 of neutral marker A. */
function buildTwoDemes(
  config: SimConfig,
  perDeme: number,
  frequencies: readonly [number, number],
): { state: SimState; realized: [number, number] } {
  const state = makeState(config, perDeme * 2 + 8);
  const specs: OrganismSpec[] = [];
  const realized: [number, number] = [0, 0];
  let nextId = 1;

  for (let deme = 0; deme < 2; deme += 1) {
    const counts = hweCounts(perDeme, frequencies[deme] ?? 0);
    realized[deme] = counts.realized;
    // Deme 0 occupies the left half, deme 1 the right, matching `demeAt` with
    // demeCols = 2.
    const x = deme === 0 ? config.world.widthWu * 0.25 : config.world.widthWu * 0.75;
    const genotypes: [number, number][] = [
      ...Array.from({ length: counts.homA }, () => [0, 0] as [number, number]),
      ...Array.from({ length: counts.het }, () => [0, 1] as [number, number]),
      ...Array.from({ length: counts.homB }, () => [1, 1] as [number, number]),
    ];
    for (const genotype of genotypes) {
      specs.push({
        id: nextId,
        x,
        y: config.world.heightWu * 0.5,
        genome: genomeWithMarkers([genotype]),
      });
      nextId += 1;
    }
  }
  place(state, specs);
  return { state, realized };
}

describe('Weir–Cockerham Fst', () => {
  const config = makeConfig({ world: { demeCols: 2, demeRows: 1 }, speciation: { minSpeciesSize: 25 } });

  it('recovers the analytic value for two demes at known frequencies', () => {
    const { state, realized } = buildTwoDemes(config, 400, [0.7, 0.3]);
    const engine = new PopgenEngine(config);
    const fst = engine.fst(state, 'deme');
    const expected = analyticWeirCockerham(realized);

    expect(expected).toBeCloseTo(0.2759, 3);
    expect(fst).not.toBeNull();
    expect(Math.abs((fst ?? 0) - expected)).toBeLessThan(0.02);
  });

  it('returns ~0 for a panmictic population arbitrarily partitioned into demes', () => {
    // The strong version of the test: alleles are drawn independently of
    // position, so every apparent difference between demes is sampling noise.
    // WC subtracts exactly that, which is the whole reason to prefer it to a raw
    // variance ratio.
    const panmictic = makeConfig({ world: { demeCols: 4, demeRows: 3 }, speciation: { minSpeciesSize: 25 } });
    const rng = new SeededRng('panmictic-fst');
    const state = makeState(panmictic, 1400);
    const specs: OrganismSpec[] = [];
    for (let index = 0; index < 1200; index += 1) {
      const genotypes = NEUTRAL_MARKER_LOCI.map(
        (locus) => [rng.int(0, locus.alleleCount - 1), rng.int(0, locus.alleleCount - 1)] as [number, number],
      );
      specs.push({
        id: index + 1,
        x: rng.next() * panmictic.world.widthWu,
        y: rng.next() * panmictic.world.heightWu,
        genome: genomeWithMarkers(genotypes),
      });
    }
    place(state, specs);

    const fst = new PopgenEngine(panmictic).fst(state, 'deme');
    expect(fst).not.toBeNull();
    expect(Math.abs(fst ?? 1)).toBeLessThan(0.02);
  });

  it('returns 1 for a fixed difference between demes', () => {
    const { state } = buildTwoDemes(config, 300, [1, 0]);
    const fst = new PopgenEngine(config).fst(state, 'deme');
    expect(fst).toBeCloseTo(1, 6);
  });

  it('rises monotonically with the frequency difference between demes', () => {
    const engine = new PopgenEngine(config);
    const values = [0.5, 0.6, 0.7, 0.85, 1].map((p) => {
      const { state } = buildTwoDemes(config, 400, [p, 1 - p]);
      return engine.fst(state, 'deme') ?? Number.NaN;
    });
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index] ?? 0).toBeGreaterThan(values[index - 1] ?? 0);
    }
  });

  it('is null for barrier grouping with no barrier up, and a number once one is raised', () => {
    const { state } = buildTwoDemes(config, 400, [0.7, 0.3]);
    const engine = new PopgenEngine(config);
    expect(engine.fst(state, 'barrier')).toBeNull();

    state.barriers.specs.push({
      id: 'p8-ridge',
      shape: { kind: 'verticalRidge', xWu: config.world.widthWu / 2, thicknessWu: 30 },
      permeability: 0,
      raisedTick: 0,
    });
    const barrierFst = engine.fst(state, 'barrier');
    expect(barrierFst).not.toBeNull();
    // The ridge sits exactly on the deme boundary, so the two groupings see the
    // same partition and must agree.
    expect(Math.abs((barrierFst ?? 0) - (engine.fst(state, 'deme') ?? 0))).toBeLessThan(1e-9);
  });

  /** 400 organisms on the left of a mid-world ridge, `thinSide` on the right. */
  function buildLopsidedBarrier(sizeConfig: SimConfig, thinSide: number): SimState {
    const state = makeState(sizeConfig, 500);
    const specs: OrganismSpec[] = [];
    for (let index = 0; index < 400; index += 1) {
      specs.push({ id: index + 1, x: 100, y: 600, genome: genomeWithMarkers([[index % 2, 0]]) });
    }
    for (let index = 0; index < thinSide; index += 1) {
      specs.push({ id: 500 + index, x: 1900, y: 600, genome: genomeWithMarkers([[1, 1]]) });
    }
    place(state, specs);
    state.barriers.specs.push({
      id: 'thin-side',
      shape: { kind: 'verticalRidge', xWu: 1000, thicknessWu: 30 },
      permeability: 0,
      raisedTick: 0,
    });
    return state;
  }

  it('is null only when a group falls below the estimator’s own minimum, not the speciation knob', () => {
    // Gate A-1 risk 4: the group filter used to be `speciation.minSpeciesSize`,
    // so retuning an unrelated speciation knob silently changed what Fst was
    // measured over. Five organisms is far below the configured minSpeciesSize
    // of 25 and still carries a variance component, so it is kept.
    expect(config.speciation.minSpeciesSize).toBeGreaterThan(MIN_DEME_ORGANISMS);
    const thin = new PopgenEngine(config).fst(buildLopsidedBarrier(config, 5), 'barrier');
    expect(thin).not.toBeNull();

    // And the answer must not move when the speciation knob does.
    const retuned = makeConfig({ world: { demeCols: 2, demeRows: 1 }, speciation: { minSpeciesSize: 4 } });
    const sameFst = new PopgenEngine(retuned).fst(buildLopsidedBarrier(retuned, 5), 'barrier');
    expect(sameFst).toBeCloseTo(thin ?? Number.NaN, 12);

    // One organism cannot carry Weir–Cockerham's within-group term, which
    // divides by n̄ − 1. That is the estimator's own arithmetic floor.
    expect(MIN_DEME_ORGANISMS).toBe(2);
    expect(new PopgenEngine(config).fst(buildLopsidedBarrier(config, 1), 'barrier')).toBeNull();
    expect(new PopgenEngine(config).fst(buildLopsidedBarrier(config, 0), 'barrier')).toBeNull();
  });

  it('refuses a rect barrier, which has no two sides to compare', () => {
    // Gate A-1 defect 9. A rect gives an interior and an exterior, and the
    // exterior is one connected region wrapping the block: the two populations
    // the reef actually separates land in the *same* group, while the handful
    // of stragglers inside it become the other. Here that partition is not
    // empty — it would happily return a number — and the number would answer a
    // question nobody asked.
    const state = makeState(config, 500);
    const specs: OrganismSpec[] = [];
    for (let index = 0; index < 200; index += 1) {
      // West of the reef, fixed for allele 0.
      specs.push({ id: index + 1, x: config.world.widthWu * 0.1, y: 600, genome: genomeWithMarkers([[0, 0]]) });
      // East of it, fixed for allele 1 — a total divergence the estimator will
      // never see, because both sides are "exterior".
      specs.push({ id: 300 + index, x: config.world.widthWu * 0.9, y: 600, genome: genomeWithMarkers([[1, 1]]) });
    }
    for (let index = 0; index < 20; index += 1) {
      specs.push({
        id: 900 + index,
        x: config.world.widthWu * 0.5,
        y: 600,
        genome: genomeWithMarkers([[index % 2, 0]]),
      });
    }
    place(state, specs);
    state.barriers.specs.push({
      id: 'reef',
      shape: {
        kind: 'rect',
        xWu: config.world.widthWu * 0.4,
        yWu: 0,
        widthWu: config.world.widthWu * 0.2,
        heightWu: config.world.heightWu,
      },
      permeability: 0,
      raisedTick: 0,
    });
    expect(new PopgenEngine(config).fst(state, 'barrier')).toBeNull();

    // The deme grouping still works, and shows what the barrier partition threw
    // away: west and east are fixed for different alleles.
    expect(new PopgenEngine(config).fst(state, 'deme') ?? 0).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// 2. Temporal-method Ne on a Wright–Fisher series
// ---------------------------------------------------------------------------

/**
 * One generation of Wright–Fisher multinomial sampling: draw `2N` gene copies
 * from the current frequencies at each locus, independently across loci.
 */
function wrightFisherStep(frequencies: readonly number[][], populationSize: number, rng: SeededRng): number[][] {
  return frequencies.map((locus) => {
    const counts = new Array<number>(locus.length).fill(0);
    for (let copy = 0; copy < 2 * populationSize; copy += 1) {
      const draw = rng.next();
      let cumulative = 0;
      for (let allele = 0; allele < locus.length; allele += 1) {
        cumulative += locus[allele] ?? 0;
        if (draw < cumulative) {
          counts[allele] = (counts[allele] ?? 0) + 1;
          break;
        }
      }
    }
    const total = 2 * populationSize;
    return counts.map((count) => count / total);
  });
}

describe('temporal-method Ne', () => {
  const config = makeConfig();

  it('recovers a known Wright–Fisher N to within ×[0.7, 1.4]', () => {
    const populationSize = 200;
    const generations = 20;
    const lociCount = 60;
    const alleleCount = 8;

    for (const seed of ['wf-a', 'wf-b', 'wf-c']) {
      const rng = new SeededRng(seed);
      let frequencies: number[][] = Array.from({ length: lociCount }, () =>
        new Array<number>(alleleCount).fill(1 / alleleCount),
      );
      const earlier = frequencies.map((locus) => [...locus]);
      for (let generation = 0; generation < generations; generation += 1) {
        frequencies = wrightFisherStep(frequencies, populationSize, rng);
      }

      const estimate = new PopgenEngine(config).temporalNe(earlier, frequencies, generations);
      expect(estimate).toBeGreaterThan(0.7 * populationSize);
      expect(estimate).toBeLessThan(1.4 * populationSize);
    }
  });

  it('reports a larger Ne for a larger population at the same elapsed time', () => {
    const generations = 15;
    const estimates = [100, 400].map((populationSize) => {
      const rng = new SeededRng(`wf-scale-${populationSize}`);
      let frequencies: number[][] = Array.from({ length: 60 }, () => new Array<number>(8).fill(1 / 8));
      const earlier = frequencies.map((locus) => [...locus]);
      for (let generation = 0; generation < generations; generation += 1) {
        frequencies = wrightFisherStep(frequencies, populationSize, rng);
      }
      return new PopgenEngine(config).temporalNe(earlier, frequencies, generations);
    });
    expect(estimates[1] ?? 0).toBeGreaterThan(2 * (estimates[0] ?? 0));
  });

  it('inverts F exactly at the defining relation', () => {
    // F = 1 − (1 − 1/2N)^t is the drift accumulated over t generations, so
    // feeding it back must return N.
    const populationSize = 250;
    const generations = 30;
    const f = 1 - Math.pow(1 - 1 / (2 * populationSize), generations);
    expect(temporalNeFromF(f, generations)).toBeCloseTo(populationSize, 6);
  });

  it('is null for every reading it cannot identify, rather than a fabricated number', () => {
    // Gate A-1 defect 5. Identical frequencies: no drift was observed, so Ne is
    // unbounded above. The old code answered `10 × census` — a number that
    // plots, fails P14's Ne ≤ 1.2N loudly, and was never measured. P14 now
    // excludes these instead of folding them into a median.
    const still = [[0.5, 0.5]];
    expect(neiTajimaF(still, still)).toBe(0);
    expect(temporalNeFromF(neiTajimaF(still, still), 10)).toBeNull();

    // F ≥ 1 is more change than drift from any finite Ne produces in t
    // generations: the model does not fit the data. The old code answered
    // Ne = 0.5, turning a model violation into the smallest possible population.
    expect(temporalNeFromF(1, 10)).toBeNull();
    expect(temporalNeFromF(1.4, 10)).toBeNull();

    // No informative locus, and no elapsed time.
    expect(temporalNeFromF(neiTajimaF([[1, 0]], [[1, 0]]), 10)).toBeNull();
    expect(temporalNeFromF(0.2, 0)).toBeNull();

    // The frozen `PopgenEstimators.temporalNe` signature cannot return null, so
    // a caller holding the interface — census-size argument and all — gets the
    // same verdict as NaN. The recorder reads the nullable core instead.
    const engine = new PopgenEngine(config);
    expect(engine.temporalNeOrNull(still, still, 10)).toBeNull();
    const throughContract: PopgenEstimators = engine;
    expect(Number.isNaN(throughContract.temporalNe(still, still, 10, 100))).toBe(true);
  });

  it('reports nothing until a full window of history exists', () => {
    // Gate A-1 defect 5, the recorder half: the baseline used to fall back to
    // the oldest snapshot held, which measures drift over whatever span exists
    // while labelling it with the configured window — a wildly low Ne for the
    // first generations of every run, then a silent change of estimand once
    // history catches up.
    const windowed = makeConfig({ sampling: { temporalNeWindowGenerations: 2 } });
    const generationTicks = windowed.time.generationTicks;
    const recorder = new StatsRecorder({ config: windowed });
    const state = makeState(windowed, 220);
    place(
      state,
      Array.from({ length: 200 }, (_value, index) => ({
        id: index + 1,
        x: 500,
        y: 500,
        genome: genomeWithMarkers([[index % 2, index % 2]]),
      })),
    );

    expect(recorder.sample(state, 0).popgen.neTemporal).toBeNull();

    // Move twenty of the two hundred onto the other allele, so a fallback
    // baseline would have something to report: 0.50 → 0.45 over one generation
    // gives F = 0.01 and an Ne near 50. It must still be null — one generation
    // of history is not the two the config asked for.
    for (let slot = 0; slot < 20; slot += 1) state.pop.genomes[slot] = genomeWithMarkers([[1, 1]]);
    expect(recorder.sample(state, generationTicks).popgen.neTemporal).toBeNull();

    // Two generations on, the tick-0 snapshot is a full window back and the
    // same F = 0.01 is now spread over t = 2: Ne = 1/(2(1 − √0.99)) ≈ 99.7.
    const full = recorder.sample(state, 2 * generationTicks).popgen.neTemporal;
    expect(full).not.toBeNull();
    expect(full ?? 0).toBeCloseTo(1 / (2 * (1 - Math.sqrt(0.99))), 3);
  });

  it('gives the same F for a biallelic locus from either allele', () => {
    const fromBoth = neiTajimaF([[0.6, 0.4]], [[0.5, 0.5]]);
    const expected = 0.01 / ((0.6 + 0.5) / 2 - 0.6 * 0.5);
    expect(fromBoth).toBeCloseTo(expected, 12);
  });
});

// ---------------------------------------------------------------------------
// 3. Midparent-regression heritability
// ---------------------------------------------------------------------------

/**
 * Feed the engine a population generated at a known narrow-sense heritability.
 *
 * Breeding values are additive with Mendelian sampling variance `V_A/2`, the
 * environment is independent of the parents, and mating is at random — the
 * three conditions under which the offspring-on-midparent slope estimates h².
 */
function feedKnownHeritability(engine: PopgenEngine, heritability: number, pairs: number, seed: string): void {
  const rng = new SeededRng(seed);
  const additiveVariance = heritability;
  const environmentVariance = 1 - heritability;
  const traitIndex = TRAIT_INDEX.size;
  const scratch = new Float32Array(TRAIT_COUNT);

  const store = (id: OrganismId, motherId: OrganismId, fatherId: OrganismId, phenotype: number): void => {
    scratch.fill(0);
    scratch[traitIndex] = phenotype;
    engine.observe(id, motherId, fatherId, scratch, 0);
  };

  let nextId = 1;
  for (let pair = 0; pair < pairs; pair += 1) {
    const motherBreeding = rng.normal(0, Math.sqrt(additiveVariance));
    const fatherBreeding = rng.normal(0, Math.sqrt(additiveVariance));
    const motherId = nextId;
    const fatherId = nextId + 1;
    const childId = nextId + 2;
    nextId += 3;

    store(motherId, NO_ORGANISM, NO_ORGANISM, motherBreeding + rng.normal(0, Math.sqrt(environmentVariance)));
    store(fatherId, NO_ORGANISM, NO_ORGANISM, fatherBreeding + rng.normal(0, Math.sqrt(environmentVariance)));

    const childBreeding = (motherBreeding + fatherBreeding) / 2 + rng.normal(0, Math.sqrt(additiveVariance / 2));
    store(childId, motherId, fatherId, childBreeding + rng.normal(0, Math.sqrt(environmentVariance)));
  }
}

describe('midparent heritability', () => {
  const config = makeConfig();

  it.each([0.3, 0.5, 0.8])('recovers a configured h² of %s to within ±0.15', (heritability) => {
    const engine = new PopgenEngine(config);
    feedKnownHeritability(engine, heritability, 2000, `h2-${heritability}`);
    const estimate = engine.midparentHeritability('size');
    expect(estimate).not.toBeNull();
    expect(Math.abs((estimate ?? 0) - heritability)).toBeLessThan(0.15);
  });

  it('is null until enough pairs have accumulated', () => {
    const engine = new PopgenEngine(config);
    feedKnownHeritability(engine, 0.5, 10, 'h2-thin');
    expect(engine.midparentHeritability('size')).toBeNull();
  });

  it('reports ~0 when the trait is purely environmental', () => {
    const engine = new PopgenEngine(config);
    feedKnownHeritability(engine, 0, 1500, 'h2-zero');
    expect(Math.abs(engine.midparentHeritability('size') ?? 1)).toBeLessThan(0.15);
  });
});

// ---------------------------------------------------------------------------
// 4. Demographic Ne
// ---------------------------------------------------------------------------

interface BreederWindow {
  readonly recorder: StatsRecorder;
  readonly state: SimState;
  readonly males: OrganismId[];
  readonly females: OrganismId[];
  /** One birth inside the window, from a named mother and father. */
  beget(motherId: OrganismId, fatherId: OrganismId): void;
  /** One more founder-generation individual, born and (optionally) dead when asked. */
  add(sex: Sex, birthTick: number, deathTick: number | null): OrganismId;
}

describe('demographic Ne', () => {
  const config = makeConfig({ time: { generationTicks: 900, maturityTicks: 600 } });
  const tick = 10_000;

  /**
   * Mature males and females born at tick 0, and a birth clock inside the
   * window that opens at 9100.
   *
   * Offspring are born from 9500 on, which is late enough that none of them has
   * matured by `tick` — so the breeder denominator is exactly the founders the
   * test named, and nothing else has to be reasoned about.
   */
  function openWindow(maleCount: number, femaleCount: number): BreederWindow {
    const recorder = new StatsRecorder({ config });
    const state = makeState(config, 16, tick);
    let nextId = 1;
    let birthTick = 9500;

    const add = (sex: Sex, born: number, died: number | null): OrganismId => {
      const id = nextId;
      nextId += 1;
      recorder.onBirth(makeRecord(id, NO_ORGANISM, NO_ORGANISM, born, sex));
      if (died !== null) recorder.onDeath(id, died, 'senescence');
      return id;
    };

    const males = Array.from({ length: maleCount }, () => add('male', 0, null));
    const females = Array.from({ length: femaleCount }, () => add('female', 0, null));

    const beget = (motherId: OrganismId, fatherId: OrganismId): void => {
      recorder.onBirth(makeRecord(nextId, motherId, fatherId, birthTick, nextId % 2 === 0 ? 'female' : 'male'));
      nextId += 1;
      birthTick += 2;
    };

    return { recorder, state, males, females, beget, add };
  }

  /** Four males against thirty-six females, every male fathering ten offspring. */
  function skewedWindow(): BreederWindow {
    const world = openWindow(4, 36);
    for (let index = 0; index < 40; index += 1) {
      world.beget(world.females[index % 36] ?? 0, world.males[index % 4] ?? 0);
    }
    return world;
  }

  // Thirty-six mothers share forty offspring — four with two and thirty-two
  // with one — so k̄_f = 10/9 and Vk_f = (4·(8/9)² + 32·(1/9)²)/35 = 32/315.
  const skewedNeFemale = varianceNeGeneral(36, 10 / 9, 32 / 315);

  it('matches Wright and Kimura–Crow on textbook inputs', () => {
    // Wright: 4·Nm·Nf/(Nm+Nf). Ten males to ninety females costs almost two
    // thirds of the census.
    expect(sexRatioNe(10, 90)).toBeCloseTo(36, 10);
    expect(sexRatioNe(50, 50)).toBeCloseTo(100, 10);

    // Kimura & Crow (4N−2)/(Vk+2): Poisson offspring numbers give back ~N.
    expect(varianceNeStationary(100, 2)).toBeCloseTo(99.5, 10);
    // Doubling the offspring variance roughly halves the effective size.
    expect(varianceNeStationary(100, 6)).toBeCloseTo(49.75, 10);

    // Crow & Denniston at k̄ = 2 differs from Kimura–Crow by one gene copy.
    expect(varianceNeGeneral(100, 2, 2)).toBeCloseTo(99, 10);

    // The sexes combine harmonically, 4·Ne_m·Ne_f/(Ne_m + Ne_f) — the same
    // shape as Wright's formula, because Wright's formula *is* this expression
    // evaluated at Ne_s = N_s, which is what Poisson breeding within each sex
    // gives.
    expect(combineSexNe(50, 50)).toBeCloseTo(100, 10);
    expect(combineSexNe(10, 90)).toBeCloseTo(36, 10);
    // One male pins Ne near four however many females he is offered.
    expect(combineSexNe(1, 500)).toBeCloseTo(2000 / 501, 10);
    expect(combineSexNe(1, 500)).toBeLessThan(4);
  });

  it('reduces to ≈ N with symmetric sexes and Poisson offspring numbers', () => {
    // Analytically: N/2 breeders of each sex in a stationary population give
    // k̄ = 2, Poisson numbers give Vk = 2, so per sex
    //   Ne_s = (2·(N/2) − 2)/(2 − 1 + 2/2) = (N − 2)/2,
    // and two equal sexes combine to 4·Ne_s²/(2·Ne_s) = 2·Ne_s = N − 2.
    for (const census of [200, 1000]) {
      const perSex = varianceNeGeneral(census / 2, 2, 2);
      expect(combineSexNe(perSex, perSex)).toBeCloseTo(census - 2, 10);
    }

    // End to end, with each birth drawing its parents uniformly — the random
    // union of gametes that makes offspring numbers Poisson. Nothing about the
    // breeding is unusual, so the estimator must hand back the census.
    for (const seed of ['poisson-a', 'poisson-b', 'poisson-c']) {
      const rng = new SeededRng(seed);
      const world = openWindow(100, 100);
      for (let birth = 0; birth < 200; birth += 1) {
        world.beget(world.females[rng.int(0, 99)] ?? 0, world.males[rng.int(0, 99)] ?? 0);
      }
      const ne = world.recorder.estimators.demographicNe(world.state);
      expect(ne).toBeGreaterThan(0.8 * 200);
      expect(ne).toBeLessThan(1.2 * 200);
    }
  });

  it('reports nothing, not a negative size, for a window that held almost no births', () => {
    // Seen on a real collapsing run: forty breeders and a single birth give
    // k̄ = 1/40 and Vk ≈ 1/40, so the denominator stays positive while the
    // numerator k̄N − 2 goes to −1 and the formula answers Ne = −40.
    const meanOffspring = 1 / 40;
    const varianceOffspring = 0.025;
    const denominator = meanOffspring - 1 + varianceOffspring / meanOffspring;
    expect(denominator).toBeGreaterThan(0);
    expect((meanOffspring * 40 - 2) / denominator).toBeCloseTo(-40, 6);
    expect(Number.isNaN(varianceNeGeneral(40, meanOffspring, varianceOffspring))).toBe(true);

    const world = openWindow(4, 36);
    world.beget(world.females[0] ?? 0, world.males[0] ?? 0);
    expect(Number.isNaN(world.recorder.estimators.demographicNe(world.state))).toBe(true);
  });

  it('reads sex ratio and offspring variance off a constructed parentage table', () => {
    // Every female leaves exactly two offspring; the first ten males leave four
    // each and the other ten leave none — a deliberately lopsided male
    // distribution, which is the whole reason variance effective size is not
    // the census.
    const world = openWindow(20, 20);
    for (let index = 0; index < 40; index += 1) {
      world.beget(world.females[index % 20] ?? 0, world.males[Math.floor(index / 4)] ?? 0);
    }

    // Males: k̄ = 40/20 = 2 and Vk = (10·2² + 10·2²)/19 = 80/19, so
    //   Ne_m = (2·20 − 2)/(2 − 1 + (80/19)/2) = 38·19/59 = 722/59 ≈ 12.24.
    // Females: k̄ = 2 with no variance at all, so Ne_f = 38/(2 − 1) = 38.
    const neMale = varianceNeGeneral(20, 2, 80 / 19);
    const neFemale = varianceNeGeneral(20, 2, 0);
    expect(neMale).toBeCloseTo(722 / 59, 10);
    expect(neFemale).toBeCloseTo(38, 10);

    // 4·(722/59)·38/((722/59) + 38) = 109744/2964 ≈ 37.03.
    const expected = combineSexNe(neMale, neFemale);
    expect(expected).toBeCloseTo(109_744 / 2964, 10);
    expect(world.recorder.estimators.demographicNe(world.state)).toBeCloseTo(expected, 6);
  });

  it('falls below the census when the sex ratio is skewed, without counting the skew twice', () => {
    const world = skewedWindow();

    // Males: four of them, ten offspring each, so k̄_m = 10 and Vk_m = 0 —
    //   Ne_m = (10·4 − 2)/(10 − 1 + 0) = 38/9 ≈ 4.22.
    // Females: k̄_f = 10/9 and Vk_f = 32/315, so the denominator is
    //   10/9 − 1 + (32/315)/(10/9) = 1/9 + 16/175 = 319/1575 and
    //   Ne_f = (36·10/9 − 2)·1575/319 = 38·1575/319 ≈ 187.6.
    const neMale = varianceNeGeneral(4, 10, 0);
    expect(neMale).toBeCloseTo(38 / 9, 10);
    expect(skewedNeFemale).toBeCloseTo((38 * 1575) / 319, 10);

    // Combined: 4·(38/9)·(59850/319)/((38/9) + (59850/319)) ≈ 16.52. Forty
    // breeders behave like seventeen.
    const expected = combineSexNe(neMale, skewedNeFemale);
    expect(expected).toBeCloseTo(16.517, 3);
    expect(expected).toBeLessThan(40);
    expect(world.recorder.estimators.demographicNe(world.state)).toBeCloseTo(expected, 6);

    // Gate A-1 defect 6. The old estimator multiplied Wright's sex-ratio
    // correction by an offspring-variance correction taken over both sexes
    // pooled, so the male deficit was charged twice — once as the sex ratio,
    // and again as the variance that same deficit creates in the pooled
    // offspring distribution. It reported 5.98 for this window. The honest
    // answer is *above* Wright's 14.4, not a third of it: these four males
    // contributed perfectly evenly, which is better breeding structure than the
    // Poisson lottery Wright's formula assumes.
    expect(sexRatioNe(4, 36)).toBeCloseTo(14.4, 10);
    expect(expected).toBeGreaterThan(sexRatioNe(4, 36));
    expect(expected).toBeGreaterThan(2 * 5.984);
  });

  it('counts adults that bred nothing, and not juveniles that never could', () => {
    // Gate A-1 defect 7. Six males born at 9000 and dead at 9300, three hundred
    // ticks short of the six-hundred-tick maturity. The old window rule asked
    // only whether they would have matured by its end and whether they were
    // still alive when it opened, so all six entered the denominator as
    // breeders who happened to leave no offspring.
    const withJuveniles = skewedWindow();
    for (let index = 0; index < 6; index += 1) withJuveniles.add('male', 9000, 9300);

    const expected = combineSexNe(varianceNeGeneral(4, 10, 0), skewedNeFemale);
    expect(withJuveniles.recorder.estimators.demographicNe(withJuveniles.state)).toBeCloseTo(expected, 6);

    // Miscounted, the male side would be ten breeders with k̄ = 4 and
    // Vk = (4·6² + 6·4²)/9 = 240/9, giving Ne_m = 38/(3 + (240/9)/4) ≈ 3.93 and
    // a combined 15.40: juvenile mortality wearing breeding structure's clothes.
    const miscounted = combineSexNe(varianceNeGeneral(10, 4, 240 / 9), skewedNeFemale);
    expect(miscounted).toBeCloseTo(15.401, 3);
    expect(Math.abs(expected - miscounted)).toBeGreaterThan(1);

    // The converse has to keep holding: an adult that matured, lived through
    // the window and left nothing is a real zero and belongs in Vk. Five males
    // with k̄ = 8 and Vk = (4·2² + 8²)/4 = 20 give Ne_m = 38/9.5 = 4 and 15.67.
    const withChildlessAdult = skewedWindow();
    withChildlessAdult.add('male', 0, 9500);
    expect(withChildlessAdult.recorder.estimators.demographicNe(withChildlessAdult.state)).toBeCloseTo(
      combineSexNe(varianceNeGeneral(5, 8, 20), skewedNeFemale),
      6,
    );
    expect(combineSexNe(varianceNeGeneral(5, 8, 20), skewedNeFemale)).toBeCloseTo(15.666, 3);
  });
});

function makeRecord(
  id: OrganismId,
  motherId: OrganismId,
  fatherId: OrganismId,
  birthTick: number,
  sex: Sex,
  speciesTag = 0,
): AncestryRecord {
  return {
    id,
    motherId,
    fatherId,
    birthTick,
    deathTick: null,
    deathCause: null,
    birthX: 0,
    birthY: 0,
    speciesTag,
    cladeId: 0,
    sex,
  };
}

// ---------------------------------------------------------------------------
// 5. Ancestry GC
// ---------------------------------------------------------------------------

interface Pedigree {
  readonly records: readonly AncestryRecord[];
  readonly living: readonly OrganismId[];
}

/**
 * A random pedigree: `generations` cohorts of `cohortSize`, each individual
 * picking two parents from the previous cohort. Only the last cohort is alive;
 * everyone else has a death record, so the GC has to keep the dead that are
 * ancestors and drop the dead that are not.
 */
function buildPedigree(seed: string, generations: number, cohortSize: number, generationTicks: number): Pedigree {
  const rng = new SeededRng(seed);
  const records: AncestryRecord[] = [];
  let previous: OrganismId[] = [];
  let nextId = 1;

  for (let generation = 0; generation < generations; generation += 1) {
    const cohort: OrganismId[] = [];
    for (let index = 0; index < cohortSize; index += 1) {
      const id = nextId;
      nextId += 1;
      const isFounder = generation === 0;
      const mother = isFounder ? NO_ORGANISM : (previous[rng.int(0, previous.length - 1)] ?? NO_ORGANISM);
      let father = isFounder ? NO_ORGANISM : (previous[rng.int(0, previous.length - 1)] ?? NO_ORGANISM);
      if (!isFounder && father === mother) father = previous[(previous.indexOf(mother) + 1) % previous.length] ?? mother;
      const record = makeRecord(id, mother, father, generation * generationTicks, index % 2 === 0 ? 'female' : 'male');
      records.push(
        generation === generations - 1
          ? record
          : { ...record, deathTick: (generation + 1) * generationTicks, deathCause: 'senescence' },
      );
      cohort.push(id);
    }
    previous = cohort;
  }
  return { records, living: previous };
}

function loadPedigree(recorder: StatsRecorder, pedigree: Pedigree, config: SimConfig, tick: number): SimState {
  for (const record of pedigree.records) {
    recorder.onBirth(record);
    if (record.deathTick !== null && record.deathCause !== null) {
      recorder.onDeath(record.id, record.deathTick, record.deathCause);
    }
  }
  const state = makeState(config, pedigree.living.length + 4, tick);
  for (let slot = 0; slot < pedigree.living.length; slot += 1) {
    state.pop.alive[slot] = 1;
    state.pop.id[slot] = pedigree.living[slot] ?? 0;
  }
  state.liveCount = pedigree.living.length;
  return state;
}

describe('ancestry collection', () => {
  it('preserves every living individual’s full ancestor path and conserves totals', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: 9 }),
        fc.integer({ min: 6, max: 16 }),
        fc.integer({ min: 0, max: 9999 }),
        (generations, cohortSize, seedNumber) => {
          const config = makeConfig({ sampling: { ancestryRetentionGenerations: 1 } });
          const generationTicks = config.time.generationTicks;
          const pedigree = buildPedigree(`ped-${seedNumber}`, generations, cohortSize, generationTicks);
          const recorder = new StatsRecorder({ config });
          const state = loadPedigree(recorder, pedigree, config, (generations - 1) * generationTicks);

          recorder.collectAncestry(state);

          for (const id of pedigree.living) {
            expect(recorder.hasCompleteAncestry(id)).toBe(true);
          }

          const summarySum = recorder
            .lineageSummaries()
            .reduce((sum, summary) => sum + summary.records, 0);
          expect(summarySum + countRetained(recorder, pedigree)).toBe(pedigree.records.length);
        },
      ),
      { seed: 20_260_807, numRuns: 40 },
    );
  });

  it('actually compacts the unreachable dead, and conserves their death counts', () => {
    const config = makeConfig({ sampling: { ancestryRetentionGenerations: 1 } });
    const generationTicks = config.time.generationTicks;
    const recorder = new StatsRecorder({ config });

    // Two founders, one child of theirs, and four childless dead-ends born in
    // the same old cohort as the child. Only the child's line reaches the
    // living, so the four dead-ends are exactly what the GC should fold away.
    recorder.onBirth(makeRecord(1, NO_ORGANISM, NO_ORGANISM, 0, 'female'));
    recorder.onBirth(makeRecord(2, NO_ORGANISM, NO_ORGANISM, 0, 'male'));
    recorder.onBirth(makeRecord(3, 1, 2, generationTicks, 'female'));
    for (let index = 0; index < 4; index += 1) {
      recorder.onBirth(makeRecord(10 + index, 1, 2, generationTicks, 'male'));
      recorder.onDeath(10 + index, generationTicks * 2, 'predation');
    }
    recorder.onDeath(1, generationTicks, 'senescence');
    recorder.onDeath(2, generationTicks, 'senescence');
    recorder.onDeath(3, generationTicks * 4, 'starvation');
    recorder.onBirth(makeRecord(20, 3, 2, generationTicks * 3, 'female'));

    const state = makeState(config, 8, generationTicks * 6);
    state.pop.alive[0] = 1;
    state.pop.id[0] = 20;
    state.liveCount = 1;

    recorder.collectAncestry(state);

    // The living organism, its mother, and both founders survive; the four
    // childless siblings do not.
    expect(recorder.ancestry(20)).toBeDefined();
    expect(recorder.ancestry(3)).toBeDefined();
    expect(recorder.ancestry(1)).toBeDefined();
    expect(recorder.ancestry(2)).toBeDefined();
    for (let index = 0; index < 4; index += 1) {
      expect(recorder.ancestry(10 + index)).toBeUndefined();
    }
    expect(recorder.hasCompleteAncestry(20)).toBe(true);

    const summaries = recorder.lineageSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.records).toBe(4);
    expect(summaries[0]?.deaths.predation).toBe(4);
    expect(summaries[0]?.living).toBe(0);
  });

  it('walks a pedigree back to the founders', () => {
    const config = makeConfig();
    const recorder = new StatsRecorder({ config });
    recorder.onBirth(makeRecord(1, NO_ORGANISM, NO_ORGANISM, 0, 'female'));
    recorder.onBirth(makeRecord(2, NO_ORGANISM, NO_ORGANISM, 0, 'male'));
    recorder.onBirth(makeRecord(3, 1, 2, 900, 'female'));
    recorder.onBirth(makeRecord(4, NO_ORGANISM, NO_ORGANISM, 0, 'male'));
    recorder.onBirth(makeRecord(5, 3, 4, 1800, 'male'));

    const lineage = recorder.lineage(5).map((record) => record.id);
    expect(lineage).toEqual([3, 4, 1, 2]);
  });
});

function countRetained(recorder: StatsRecorder, pedigree: Pedigree): number {
  let retained = 0;
  for (const record of pedigree.records) {
    if (recorder.ancestry(record.id) !== undefined) retained += 1;
  }
  return retained;
}

// ---------------------------------------------------------------------------
// 6. Species detector
// ---------------------------------------------------------------------------

interface TwoClusterWorld {
  readonly state: SimState;
  readonly clusterA: OrganismId[];
  readonly clusterB: OrganismId[];
}

/**
 * Two phenotypic clusters, well separated on `diet` and carrying different
 * neutral-marker alleles — the situation where clustering has an easy job and
 * the mating log decides whether the answer means anything.
 */
function buildTwoClusters(config: SimConfig, perCluster: number, seed: string, tagB = 0): TwoClusterWorld {
  const rng = new SeededRng(seed);
  const state = makeState(config, perCluster * 2 + 8, 20_000);
  const specs: OrganismSpec[] = [];
  const clusterA: OrganismId[] = [];
  const clusterB: OrganismId[] = [];
  let nextId = 1;

  for (let cluster = 0; cluster < 2; cluster += 1) {
    for (let index = 0; index < perCluster; index += 1) {
      const id = nextId;
      nextId += 1;
      (cluster === 0 ? clusterA : clusterB).push(id);
      const markerAllele = cluster === 0 ? 0 : 4;
      specs.push({
        id,
        x: rng.next() * config.world.widthWu,
        y: rng.next() * config.world.heightWu,
        speciesTag: cluster === 0 ? 0 : tagB,
        sex: index % 2 === 0 ? 'female' : 'male',
        genome: genomeWithMarkers(
          NEUTRAL_MARKER_LOCI.map(() => [markerAllele, markerAllele] as [number, number]),
        ),
        latent: {
          diet: (cluster === 0 ? -2.5 : 2.5) + rng.normal(0, 0.3),
          size: rng.normal(12, 0.6),
          tOpt: rng.normal(18, 0.8),
          displayHue: (cluster === 0 ? 120 : 300) + rng.normal(0, 12),
        },
      });
    }
  }
  place(state, specs);
  return { state, clusterA, clusterB };
}

/** Log `within` matings inside each cluster and `cross` between them. */
function logMatings(
  engine: PopgenEngine,
  world: TwoClusterWorld,
  within: number,
  cross: number,
  seed: string,
  tick: number,
): void {
  const rng = new SeededRng(seed);
  const pick = (ids: readonly OrganismId[]): OrganismId => ids[rng.int(0, ids.length - 1)] ?? 0;
  for (let index = 0; index < within; index += 1) {
    engine.recordMating(pick(world.clusterA), pick(world.clusterA), tick);
    engine.recordMating(pick(world.clusterB), pick(world.clusterB), tick);
  }
  for (let index = 0; index < cross; index += 1) {
    engine.recordMating(pick(world.clusterA), pick(world.clusterB), tick);
  }
}

describe('species detector', () => {
  const config = makeConfig({ speciation: { minSpeciesSize: 25, detectorIntervalTicks: 1800 } });

  it('splits two clusters that barely interbreed, and keeps the tags stable', () => {
    const world = buildTwoClusters(config, 120, 'split-world');
    const engine = new PopgenEngine(config);
    // 400 within-cluster matings against 8 cross — a 2% realized cross rate,
    // comfortably under the 5% threshold.
    logMatings(engine, world, 200, 8, 'split-matings', 19_500);

    const first = engine.detectSpecies(world.state);
    expect(first.splits).toHaveLength(1);
    expect(first.splits[0]?.parentTag).toBe(0);
    expect(first.splits[0]?.crossMatingRate).toBeLessThan(0.05);

    const tags = distinctTags(first.assignments);
    expect(tags).toHaveLength(2);

    // The split must respect the true clusters, not cut across them.
    const slotOf = new Map<OrganismId, number>();
    for (let slot = 0; slot < world.state.pop.capacity; slot += 1) {
      if (world.state.pop.alive[slot] === 1) slotOf.set(world.state.pop.id[slot] ?? 0, slot);
    }
    const tagsInA = new Set(world.clusterA.map((id) => first.assignments[slotOf.get(id) ?? 0]));
    const tagsInB = new Set(world.clusterB.map((id) => first.assignments[slotOf.get(id) ?? 0]));
    expect(tagsInA.size).toBe(1);
    expect(tagsInB.size).toBe(1);

    // Second pass on an unchanged world: no further split, identical tags. The
    // engine has not written the assignments back, which is exactly the case
    // that would break a detector that re-read `pop.speciesTag` every call.
    const second = engine.detectSpecies(world.state);
    expect(second.splits).toHaveLength(0);
    expect([...second.assignments]).toEqual([...first.assignments]);
  });

  it('leaves a freely interbreeding pair of clusters as one species', () => {
    const world = buildTwoClusters(config, 120, 'merge-world');
    const engine = new PopgenEngine(config);
    // Cross-mating at roughly the rate random pairing would produce.
    logMatings(engine, world, 100, 200, 'merge-matings', 19_500);

    const result = engine.detectSpecies(world.state);
    expect(result.splits).toHaveLength(0);
    expect(distinctTags(result.assignments)).toHaveLength(1);
  });

  it('merges two existing tags once they interbreed, and reports the loser extinct', () => {
    const world = buildTwoClusters(config, 120, 'gradual-merge', 1);
    world.state.nextSpeciesTag = 2;
    const engine = new PopgenEngine(config);
    logMatings(engine, world, 100, 200, 'gradual-merge-matings', 19_500);

    const first = engine.detectSpecies(world.state);
    expect(distinctTags(first.assignments)).toEqual([0]);
    // The dissolved tag ceased to exist inside this call, so it has to be
    // reported now — comparing sizes against the previous call would never see
    // it, since it was already gone by the time sizes were taken.
    expect(first.extinctions).toContain(1);

    const second = engine.detectSpecies(world.state);
    expect(distinctTags(second.assignments)).toEqual([0]);
    expect(second.extinctions).toHaveLength(0);
  });

  it('refuses to act on a mating log that is too thin to mean anything', () => {
    const world = buildTwoClusters(config, 120, 'thin-log');
    const engine = new PopgenEngine(config);
    logMatings(engine, world, 4, 0, 'thin-log-matings', 19_500);
    expect(MIN_INFORMATIVE_MATINGS).toBeGreaterThan(8);

    const result = engine.detectSpecies(world.state);
    expect(result.splits).toHaveLength(0);
  });

  /**
   * The expectation the detector used to use: `2f(1 − f)` over a single pooled
   * margin, as if both partners were drawn from the same urn.
   */
  function pooledRatio(within: number, cross: number, inFirst: number, participants: number): number {
    const fraction = inFirst / participants;
    const expectedCross = 2 * fraction * (1 - fraction);
    const expectedWithin = fraction * fraction + (1 - fraction) * (1 - fraction);
    const total = within + cross;
    const withinRate = within / total / expectedWithin;
    return withinRate > 0 ? cross / total / expectedCross / withinRate : Number.POSITIVE_INFINITY;
  }

  it('measures cross-mating against the two sexes’ margins, not one pooled margin', () => {
    // Gate A-1 defect 11. A mating is one female and one male, so the chance a
    // random pairing crosses the boundary is f_f(1 − f_m) + (1 − f_f)f_m. Write
    // the margins as m ± d and that expectation is the pooled `2m(1 − m)` plus
    // 2d²: pooling always *under*-states how much crossing random mating would
    // have produced, so it always over-states panmixia.
    const engine = new PopgenEngine(config);
    const side = new Map<OrganismId, number>();
    for (let index = 0; index < 200; index += 1) side.set(index + 1, 0);
    for (let index = 0; index < 200; index += 1) side.set(1001 + index, 1);
    const inFirst = (id: OrganismId): boolean => (side.get(id) ?? 1) === 0;

    // 100 matings: 10 within the first group, 15 within the second, and 75
    // crossing — 70 of them with the mother in the first group and only 5 the
    // other way. Margins: f_f = 0.80 mothers and f_m = 0.15 fathers in group 0.
    const log = (mother: OrganismId, father: OrganismId, count: number): void => {
      for (let index = 0; index < count; index += 1) engine.recordMating(mother, father, 100 + index);
    };
    log(1, 2, 10);
    log(1001, 1002, 15);
    log(1, 1002, 70);
    log(1001, 2, 5);

    const evidence = engine.detector.crossMatingEvidence(side, 0);
    expect(evidence.within).toBe(25);
    expect(evidence.cross).toBe(75);
    expect([...side.keys()].filter(inFirst)).toHaveLength(200);

    // Directed: expected cross = 0.8·0.85 + 0.2·0.15 = 0.71, expected within =
    // 0.29, so the ratio is (75/100)/0.71 ÷ (25/100)/0.29 = 1.225.
    expect(evidence.ratio).toBeCloseTo((0.75 / 0.71) / (0.25 / 0.29), 10);
    expect(evidence.ratio).toBeCloseTo(1.2254, 4);

    // Pooled, the same log expects only 2·0.475·0.525 = 0.499 cross matings and
    // therefore reads 3.0 — two and a half times as panmictic as the data are.
    const pooled = pooledRatio(25, 75, 80 + 15, 100 + 100);
    expect(pooled).toBeCloseTo(3.015, 3);
    expect(evidence.ratio).toBeLessThan(pooled);
  });

  it('refuses to merge two clusters whose only matings are female-here, male-there', () => {
    // The decision this flips. Every mating pairs a female of cluster A with a
    // male of cluster B — sex-biased dispersal across a ridge produces exactly
    // this log. Random pairing given those margins predicts 100% cross matings,
    // so the observation says nothing at all about reproductive isolation and
    // the detector must abstain.
    const world = buildTwoClusters(config, 120, 'sex-asymmetric', 1);
    world.state.nextSpeciesTag = 2;
    const engine = new PopgenEngine(config);
    const mothers = world.clusterA.filter((_id, index) => index % 2 === 0);
    const fathers = world.clusterB.filter((_id, index) => index % 2 === 1);
    for (let index = 0; index < 40; index += 1) {
      engine.recordMating(mothers[index] ?? 0, fathers[index] ?? 0, 19_500);
    }
    expect(40).toBeGreaterThanOrEqual(MIN_INFORMATIVE_MATINGS);

    // Pooled, half the participants sit in each group, so `2f(1 − f)` expects
    // half the matings to cross, 100% did, and no mating fell inside a group:
    // the ratio is +∞ and the merge pass dissolves cluster B into cluster A.
    expect(pooledRatio(0, 40, 40, 80)).toBe(Number.POSITIVE_INFINITY);
    expect(pooledRatio(0, 40, 40, 80)).toBeGreaterThan(config.speciation.crossMatingThreshold);

    // Directed, the expected within-group fraction is zero, so there is no
    // ratio to compute and no evidence to act on. Both tags survive.
    const result = engine.detectSpecies(world.state);
    expect(distinctTags(result.assignments)).toEqual([0, 1]);
    expect(result.extinctions).toHaveLength(0);
    expect(result.splits).toHaveLength(0);
  });

  it('is deterministic: two engines given identical input agree exactly', () => {
    const build = (): { assignments: Int32Array; splits: number } => {
      const world = buildTwoClusters(config, 120, 'determinism-world');
      const engine = new PopgenEngine(config);
      logMatings(engine, world, 200, 8, 'determinism-matings', 19_500);
      const result = engine.detectSpecies(world.state);
      return { assignments: result.assignments, splits: result.splits.length };
    };
    const first = build();
    const second = build();
    expect([...second.assignments]).toEqual([...first.assignments]);
    expect(second.splits).toBe(first.splits);
  });
});

function distinctTags(assignments: Int32Array): number[] {
  const tags = new Set<number>();
  for (const tag of assignments) {
    if (tag >= 0) tags.add(tag);
  }
  return [...tags].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// 7. Assortment index
// ---------------------------------------------------------------------------

/** Cache a latent value for one trait against an id, so the mating log can resolve it. */
function seedTrait(engine: PopgenEngine, id: OrganismId, trait: 'diet' | 'displayHue', value: number): void {
  const scratch = new Float32Array(TRAIT_COUNT);
  scratch[TRAIT_INDEX[trait]] = value;
  engine.observe(id, NO_ORGANISM, NO_ORGANISM, scratch, 0);
}

describe('assortment index', () => {
  const config = makeConfig();

  it('is ≈1 when every mating pairs identical diets', () => {
    const engine = new PopgenEngine(config);
    const rng = new SeededRng('assort-perfect');
    for (let pair = 0; pair < 500; pair += 1) {
      const diet = rng.normal(0, 1.5);
      const motherId = pair * 2 + 1;
      const fatherId = pair * 2 + 2;
      seedTrait(engine, motherId, 'diet', diet);
      seedTrait(engine, fatherId, 'diet', diet);
      engine.recordMating(motherId, fatherId, 100 + pair);
    }
    expect(engine.assortmentIndex(0)).toBeCloseTo(1, 6);
  });

  it('is ≈0 when mates are drawn independently of diet', () => {
    const engine = new PopgenEngine(config);
    const rng = new SeededRng('assort-random');
    for (let pair = 0; pair < 800; pair += 1) {
      const motherId = pair * 2 + 1;
      const fatherId = pair * 2 + 2;
      seedTrait(engine, motherId, 'diet', rng.normal(0, 1.5));
      seedTrait(engine, fatherId, 'diet', rng.normal(0, 1.5));
      engine.recordMating(motherId, fatherId, 100 + pair);
    }
    // A genuine measurement of random mating: a number near zero, not a null.
    const measured = engine.assortmentIndex(0);
    expect(measured).not.toBeNull();
    expect(Math.abs(measured ?? 1)).toBeLessThan(0.1);
  });

  it('reports negative assortment when opposites pair', () => {
    const engine = new PopgenEngine(config);
    const rng = new SeededRng('assort-negative');
    for (let pair = 0; pair < 500; pair += 1) {
      const diet = rng.normal(0, 1.5);
      const motherId = pair * 2 + 1;
      const fatherId = pair * 2 + 2;
      seedTrait(engine, motherId, 'diet', diet);
      seedTrait(engine, fatherId, 'diet', -diet);
      engine.recordMating(motherId, fatherId, 100 + pair);
    }
    expect(engine.assortmentIndex(0)).toBeCloseTo(-1, 6);
  });

  it('handles hue assortment on the circle, including pairs straddling 0°', () => {
    const engine = new PopgenEngine(config);
    const rng = new SeededRng('hue-assort');
    for (let pair = 0; pair < 500; pair += 1) {
      // Hues concentrated around 0°/360°, where a Pearson correlation on the raw
      // degrees would report noise.
      const hue = rng.normal(360, 40);
      const motherId = pair * 2 + 1;
      const fatherId = pair * 2 + 2;
      seedTrait(engine, motherId, 'displayHue', hue);
      seedTrait(engine, fatherId, 'displayHue', hue);
      engine.recordMating(motherId, fatherId, 100 + pair);
    }
    expect(engine.hueAssortment(0)).toBeCloseTo(1, 6);

    const random = new PopgenEngine(config);
    const rng2 = new SeededRng('hue-random');
    for (let pair = 0; pair < 800; pair += 1) {
      const motherId = pair * 2 + 1;
      const fatherId = pair * 2 + 2;
      seedTrait(random, motherId, 'displayHue', rng2.next() * 360);
      seedTrait(random, fatherId, 'displayHue', rng2.next() * 360);
      random.recordMating(motherId, fatherId, 100 + pair);
    }
    const randomHue = random.hueAssortment(0);
    expect(randomHue).not.toBeNull();
    expect(Math.abs(randomHue ?? 1)).toBeLessThan(0.1);
  });

  it('is null where there is nothing to measure, and zero only where zero was measured', () => {
    // Gate A-1 defects 10/13. Zero is the value assortment takes under measured
    // random mating, so reporting it for an unmeasurable window makes "nobody
    // bred" indistinguishable from "everybody bred at random" in the series.
    const empty = new PopgenEngine(config);
    expect(empty.assortmentIndex(0)).toBeNull();
    expect(empty.hueAssortment(0)).toBeNull();

    // One resolvable pair is not a correlation. Here the second mating names a
    // partner that was never observed, so it is dropped and one pair remains.
    const single = new PopgenEngine(config);
    seedTrait(single, 1, 'diet', 1);
    seedTrait(single, 2, 'diet', 1);
    single.recordMating(1, 2, 10);
    single.recordMating(1, 999, 10);
    expect(single.assortmentIndex(0)).toBeNull();

    // Monomorphic: five hundred pairs, every one of them at the same diet.
    // There is no variance for a correlation to be about.
    const monomorphic = new PopgenEngine(config);
    for (let pair = 0; pair < 500; pair += 1) {
      const motherId = pair * 2 + 1;
      const fatherId = pair * 2 + 2;
      seedTrait(monomorphic, motherId, 'diet', 0.75);
      seedTrait(monomorphic, fatherId, 'diet', 0.75);
      monomorphic.recordMating(motherId, fatherId, 100 + pair);
    }
    expect(monomorphic.assortmentIndex(0)).toBeNull();

    // Two pairs with variance on both sides is the minimum that measures
    // something, and it comes back a number.
    const two = new PopgenEngine(config);
    seedTrait(two, 1, 'diet', -1);
    seedTrait(two, 2, 'diet', 1);
    seedTrait(two, 3, 'diet', 2);
    seedTrait(two, 4, 'diet', -2);
    two.recordMating(1, 2, 10);
    two.recordMating(3, 4, 11);
    expect(typeof two.assortmentIndex(0)).toBe('number');
  });

  it('carries the nulls through to the sample row', () => {
    const recorder = new StatsRecorder({ config });
    const state = makeState(config, 8, 4000);
    place(state, [{ id: 1, x: 100, y: 100, genome: genomeWithMarkers([[0, 0]]), latent: { diet: 0.5 } }]);

    // No matings in the window at all: both assortment columns are null, and
    // `matings` is the count that says why.
    const quiet = recorder.sample(state, 4000);
    expect(quiet.matings).toBe(0);
    expect(quiet.assortmentIndex).toBeNull();
    expect(quiet.hueAssortment).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. The recorder end to end
// ---------------------------------------------------------------------------

/** A genome carrying one genotype at `pigmentA`; markers left at allele 0. */
function genomeWithPigment(first: number, second: number): Genome {
  const genome = createEmptyGenome('XX');
  const locus = DISCRETE_LOCUS_BY_ID.pigmentA;
  genome.discrete[locus.index] = first;
  genome.discrete[DISCRETE_LOCUS_COUNT + locus.index] = second;
  return genome;
}

describe('recorder sampling', () => {
  const config = makeConfig({ world: { demeCols: 2, demeRows: 1 } });

  function populatedState(count: number, seed: string): SimState {
    const rng = new SeededRng(seed);
    const state = makeState(config, count + 4, 4000);
    const specs: OrganismSpec[] = [];
    for (let index = 0; index < count; index += 1) {
      // Latent size = genotypic contribution + an independent environment, so
      // V_A and V_P are separable and their ratio is known by construction.
      const genotypic = rng.normal(0, 2);
      specs.push({
        id: index + 1,
        x: rng.next() * config.world.widthWu,
        y: rng.next() * config.world.heightWu,
        genome: genomeWithMarkers([[index % 8, (index * 3) % 8]]),
        latent: { size: 12 + genotypic + rng.normal(0, 2), diet: rng.normal(0, 1) },
        genotypic: { size: genotypic },
      });
    }
    place(state, specs);
    return state;
  }

  it('separates additive from phenotypic variance using the genotypic column', () => {
    const state = populatedState(2000, 'sample-variance');
    const recorder = new StatsRecorder({ config });
    const row = recorder.sample(state, state.tick);

    expect(row.population).toBe(2000);
    const size = row.traits.size;
    // Both components were drawn at SD 2, so h² should land near a half.
    expect(size.additiveVariance).toBeGreaterThan(3);
    expect(size.additiveVariance).toBeLessThan(5);
    expect(size.phenotypicVariance).toBeGreaterThan(6.5);
    expect(size.phenotypicVariance).toBeLessThan(9.5);
    expect(size.heritability).toBeGreaterThan(0.35);
    expect(size.heritability).toBeLessThan(0.65);
    expect(size.mean).toBeCloseTo(12, 0);
  });

  it('reports population structure sorted and consistent with the census', () => {
    const state = populatedState(600, 'sample-structure');
    const row = new StatsRecorder({ config }).sample(state, state.tick);

    const demeTotal = row.populationByDeme.reduce((sum, value) => sum + value, 0);
    expect(demeTotal).toBe(row.population);
    expect(row.populationByDeme).toHaveLength(2);
    expect(row.populationByArchetype.reduce((sum, value) => sum + value, 0)).toBe(row.population);
    expect(row.populationBySpecies.reduce((sum, group) => sum + group.count, 0)).toBe(row.population);
    expect([...row.populationBySpecies].sort((a, b) => a.tag - b.tag)).toEqual(row.populationBySpecies);

    for (const frequencies of Object.values(row.discreteAlleleFreq)) {
      const total = frequencies.reduce((sum, value) => sum + value, 0);
      expect(total).toBeCloseTo(1, 9);
    }
  });

  it('drains the death, mating and cross-mating tallies it reports', () => {
    const state = populatedState(100, 'sample-drain');
    state.deathCounts.predation = 7;
    state.deathCounts.starvation = 3;
    state.matingCount = 21;
    state.crossSpeciesMatingCount = 2;

    const recorder = new StatsRecorder({ config });
    const first = recorder.sample(state, state.tick);
    expect(first.deaths.predation).toBe(7);
    expect(first.deaths.starvation).toBe(3);
    expect(first.matings).toBe(21);
    expect(first.crossSpeciesMatings).toBe(2);

    const second = recorder.sample(state, state.tick + 200);
    expect(second.deaths.predation).toBe(0);
    expect(second.matings).toBe(0);
  });

  it('builds midparent pairs across sample boundaries', () => {
    // The cache is filled by walking the living population, so a parent seen at
    // one sample is available to its offspring at the next. This is the claim
    // the whole heritability path rests on.
    const state = makeState(config, 8, 4000);
    place(state, [
      { id: 1, x: 100, y: 100, genome: genomeWithMarkers([[0, 0]]), latent: { size: 10 } },
      { id: 2, x: 120, y: 100, genome: genomeWithMarkers([[0, 0]]), latent: { size: 14 } },
    ]);
    const recorder = new StatsRecorder({ config });
    recorder.sample(state, 4000);
    expect(recorder.estimators.regressions.size).toBe(0);

    state.pop.alive[2] = 1;
    state.pop.id[2] = 3;
    state.pop.motherId[2] = 1;
    state.pop.fatherId[2] = 2;
    state.pop.genomes[2] = genomeWithMarkers([[0, 0]]);
    state.pop.traitsLatent[2 * TRAIT_COUNT + TRAIT_INDEX.size] = 13;
    recorder.sample(state, 4200);
    expect(recorder.estimators.regressions.size).toBe(1);
  });

  it('takes the offspring phenotype at birth, so a juvenile death still reaches the regression', () => {
    // Gate A-1 defect 8. An offspring used to enter the midparent regression
    // only if it was still alive at a sample boundary, and it cannot be
    // recovered afterwards: the pool's free list is LIFO, so the slot is
    // overwritten within a tick or two.
    const recorder = new StatsRecorder({ config });
    const state = makeState(config, 8, 4000);
    place(state, [
      { id: 1, x: 100, y: 100, genome: genomeWithMarkers([[0, 0]]), latent: { size: 10 } },
      { id: 2, x: 120, y: 100, genome: genomeWithMarkers([[0, 0]]), latent: { size: 14 } },
    ]);
    recorder.sample(state, 4000);
    expect(recorder.estimators.regressions.size).toBe(0);

    // Born at 4050 into a slot that is never alive at a boundary, dead at 4100,
    // with the next row not due until 4200.
    const base = 2 * TRAIT_COUNT;
    state.pop.traitsLatent[base + TRAIT_INDEX.size] = 13;
    recorder.onBirth(makeRecord(3, 1, 2, 4050, 'female'), state.pop.traitsLatent, base);
    recorder.onDeath(3, 4100, 'predation');
    expect(recorder.estimators.regressions.size).toBe(1);

    // The view is borrowed, so what the cache holds has to be a copy of it.
    state.pop.traitsLatent[base + TRAIT_INDEX.size] = -999;
    expect(recorder.estimators.traits.get(3, TRAIT_INDEX.size)).toBeCloseTo(13, 5);

    // And an organism that does survive to a boundary is not counted twice.
    state.pop.alive[2] = 1;
    state.pop.id[2] = 3;
    state.pop.motherId[2] = 1;
    state.pop.fatherId[2] = 2;
    state.pop.traitsLatent[base + TRAIT_INDEX.size] = 13;
    recorder.sample(state, 4200);
    expect(recorder.estimators.regressions.size).toBe(1);
  });

  it('records no phenotype when the birth hook is called without a latent view', () => {
    // The staged-optional form of the contract. Nothing observed is better than
    // something invented; P13 shows the gap as a missing regression.
    const recorder = new StatsRecorder({ config });
    recorder.onBirth(makeRecord(1, NO_ORGANISM, NO_ORGANISM, 0, 'female'));
    expect(recorder.estimators.traits.size).toBe(0);
    expect(recorder.ancestry(1)).toBeDefined();
  });

  it('recovers the true slope under trait-dependent juvenile mortality; survivors alone do not', () => {
    // Offspring size is the midparent value plus an independent deviation, so
    // the true regression slope is 1 by construction. Then every offspring
    // below the parental mean dies before it could reach a census row —
    // truncation on the *dependent* variable, which attenuates an OLS slope.
    // For these variances (midparent SD √2, deviation SD 0.5, so r = 0.943)
    // truncating y at its mean predicts a slope near 0.77 among survivors.
    const pairs = 400;
    const rng = new SeededRng('juvenile-mortality');
    const atBirth = new StatsRecorder({ config });
    const survivorsOnly = new StatsRecorder({ config });
    const pool = new Float32Array((pairs * 3 + 1) * TRAIT_COUNT);
    const sizeIndex = TRAIT_INDEX.size;
    const write = (id: OrganismId, size: number): number => {
      const offset = (id - 1) * TRAIT_COUNT;
      pool[offset + sizeIndex] = size;
      return offset;
    };

    let nextId = 1;
    let survivors = 0;
    for (let pair = 0; pair < pairs; pair += 1) {
      const motherId = nextId;
      const fatherId = nextId + 1;
      const childId = nextId + 2;
      nextId += 3;

      const motherSize = rng.normal(12, 2);
      const fatherSize = rng.normal(12, 2);
      const childSize = (motherSize + fatherSize) / 2 + rng.normal(0, 0.5);
      const motherBase = write(motherId, motherSize);
      const fatherBase = write(fatherId, fatherSize);
      const childBase = write(childId, childSize);

      for (const recorder of [atBirth, survivorsOnly]) {
        recorder.onBirth(makeRecord(motherId, NO_ORGANISM, NO_ORGANISM, 0, 'female'), pool, motherBase);
        recorder.onBirth(makeRecord(fatherId, NO_ORGANISM, NO_ORGANISM, 0, 'male'), pool, fatherBase);
      }

      const child = makeRecord(childId, motherId, fatherId, 100, 'female');
      atBirth.onBirth(child, pool, childBase);
      // The pre-fix path: the birth is logged, but the phenotype only lands if
      // the offspring is still alive when the sample walk comes round.
      survivorsOnly.onBirth(child);
      if (childSize > 12) {
        survivors += 1;
        survivorsOnly.estimators.observe(childId, motherId, fatherId, pool, childBase);
      }
    }

    expect(atBirth.estimators.regressions.size).toBe(pairs);
    expect(survivorsOnly.estimators.regressions.size).toBe(survivors);
    expect(survivors).toBeLessThan(pairs);

    const honest = atBirth.estimators.midparentHeritability('size') ?? Number.NaN;
    const conditioned = survivorsOnly.estimators.midparentHeritability('size') ?? Number.NaN;
    expect(honest).toBeCloseTo(1, 1);
    expect(conditioned).toBeGreaterThan(0.6);
    expect(conditioned).toBeLessThan(0.9);
    expect(conditioned).toBeLessThan(honest - 0.1);
  });

  it('raises a sweep event once, through drainRaisedEvents rather than SimState', () => {
    const state = makeState(config, 40, 4000);
    const specs: OrganismSpec[] = [];
    for (let index = 0; index < 30; index += 1) {
      // 20 of 30 individuals homozygous for pigmentA allele 1 → frequency 2/3.
      const carrier = index < 20;
      specs.push({
        id: index + 1,
        x: 500,
        y: 500,
        genome: genomeWithPigment(carrier ? 1 : 0, carrier ? 1 : 0),
      });
    }
    place(state, specs);

    const recorder = new StatsRecorder({ config });
    recorder.trackSweep('pigmentA', 1, 3000);
    expect(recorder.drainRaisedEvents()).toHaveLength(0);

    recorder.sample(state, 4000);
    const raised = recorder.drainRaisedEvents();
    expect(raised).toHaveLength(1);
    const event = raised[0];
    expect(event?.kind).toBe('sweepCrossedHalf');
    if (event?.kind === 'sweepCrossedHalf') {
      expect(event.locus).toBe('pigmentA');
      expect(event.allele).toBe(1);
      expect(event.frequency).toBeCloseTo(2 / 3, 6);
      expect(event.introducedTick).toBe(3000);
      expect(event.generationsElapsed).toBeCloseTo(1000 / config.time.generationTicks, 6);
    }
    // The recorder never writes to the sim's own event queue.
    expect(state.events).toHaveLength(0);

    // Fires once: a second sample past the threshold adds nothing.
    recorder.sample(state, 4200);
    expect(recorder.drainRaisedEvents()).toHaveLength(0);
  });

  it('serves series and JSONL strictly after the requested tick', () => {
    const state = populatedState(50, 'sample-series');
    const recorder = new StatsRecorder({ config });
    for (let index = 0; index < 5; index += 1) recorder.sample(state, 4000 + index * 200);

    expect(recorder.series(-1)).toHaveLength(5);
    expect(recorder.series(4000)).toHaveLength(4);
    expect(recorder.series(4400).map((row) => row.tick)).toEqual([4600, 4800]);
    expect(recorder.series(9999)).toHaveLength(0);

    const lines = recorder.toJsonl('baseline', 'seed-1', 4400).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    const parsed: unknown = JSON.parse(lines[0] ?? '{}');
    expect(parsed).toMatchObject({ scenario: 'baseline', seed: 'seed-1', row: { tick: 4600 } });

    const population = recorder.column('population');
    expect(population).not.toBeNull();
    expect(population?.length).toBe(5);
    expect(recorder.columnNames()).toContain('popgen.fstDemes');
  });

  it('builds the phylogeny from split events, with stable deterministic labels', () => {
    const recorder = new StatsRecorder({ config });
    const state = populatedState(60, 'sample-phylo');
    recorder.sample(state, 4000);

    recorder.onEvent({
      kind: 'speciesSplit',
      tick: 4200,
      parentTag: 0,
      childTags: [1, 2],
      crossMatingRate: 0.01,
      sizes: [30, 30],
    });
    recorder.onEvent({ kind: 'speciesExtinction', tick: 5000, tag: 2, lifetimeTicks: 800, peakPopulation: 31 });

    const nodes = recorder.phylogeny();
    expect(nodes.map((node) => node.tag)).toEqual([0, 1, 2]);
    expect(nodes[0]?.parentTag).toBeNull();
    expect(nodes[1]?.parentTag).toBe(0);
    expect(nodes[1]?.birthTick).toBe(4200);
    expect(nodes[2]?.extinctTick).toBe(5000);
    expect(nodes[0]?.peakPopulation).toBe(60);
    expect(nodes[1]?.label).toMatch(/^[A-Z][a-z]+ [a-z]+$/);
    // Labels are a pure function of (tag, founding tick), so a second recorder
    // fed the same history names the same lineages.
    const twin = new StatsRecorder({ config });
    twin.onEvent({
      kind: 'speciesSplit',
      tick: 4200,
      parentTag: 0,
      childTags: [1, 2],
      crossMatingRate: 0.01,
      sizes: [30, 30],
    });
    expect(twin.phylogeny()[1]?.label).toBe(nodes[1]?.label);
  });

  it('reports the mean temperature from ecology’s field rather than recomputing it', () => {
    const state = populatedState(50, 'sample-temperature');
    state.field.temperature.fill(0);
    for (let index = 0; index < state.field.temperature.length; index += 1) {
      state.field.temperature[index] = index % 2 === 0 ? 10 : 20;
    }
    const row = new StatsRecorder({ config }).sample(state, state.tick);
    expect(row.resources.meanTemperatureC).toBeCloseTo(15, 6);
  });
});

describe('recorder degenerate cases', () => {
  const config = makeConfig();

  it('samples an empty world without throwing, and reports nothing as measured', () => {
    const state = makeState(config, 16, 4000);
    const row = new StatsRecorder({ config }).sample(state, 4000);

    expect(row.population).toBe(0);
    expect(row.populationBySpecies).toHaveLength(0);
    expect(row.guilds.predatorFraction).toBe(0);
    // An extinct population has no heterozygosity to report — not perfect
    // heterozygosity, which is what `1 − Σp²` over all-zero frequencies says.
    expect(Number.isNaN(row.popgen.meanHeterozygosity)).toBe(true);
    expect(Number.isNaN(row.popgen.neDemographic)).toBe(true);
    expect(row.popgen.fstBarrier).toBeNull();
    expect(row.popgen.midparentH2Size).toBeNull();
    expect(Number.isNaN(row.popgen.fstDemes)).toBe(true);
  });

  it('keeps the trait cache bounded by the pedigree it serves', () => {
    const config2 = makeConfig({ sampling: { ancestryRetentionGenerations: 1 } });
    const recorder = new StatsRecorder({ config: config2 });
    const generationTicks = config2.time.generationTicks;

    // Two founders and a long tail of childless descendants, none of whom
    // survive the collection.
    recorder.onBirth(makeRecord(1, NO_ORGANISM, NO_ORGANISM, 0, 'female'));
    recorder.onBirth(makeRecord(2, NO_ORGANISM, NO_ORGANISM, 0, 'male'));
    for (let index = 0; index < 50; index += 1) {
      recorder.onBirth(makeRecord(10 + index, 1, 2, generationTicks, 'male'));
      recorder.onDeath(10 + index, generationTicks * 2, 'starvation');
    }

    const state = makeState(config2, 60, generationTicks);
    place(
      state,
      Array.from({ length: 50 }, (_value, index) => ({
        id: 10 + index,
        x: 100,
        y: 100,
        genome: genomeWithMarkers([[0, 0]]),
      })),
    );
    recorder.sample(state, generationTicks);
    expect(recorder.estimators.traits.size).toBe(50);

    // Everyone dies; the pedigree drops them and the phenotype cache follows.
    for (let slot = 0; slot < 50; slot += 1) state.pop.alive[slot] = 0;
    state.liveCount = 0;
    state.tick = generationTicks * 6;
    recorder.collectAncestry(state);
    expect(recorder.estimators.traits.size).toBe(0);
  });
});
