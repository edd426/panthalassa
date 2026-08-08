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
  MIN_INFORMATIVE_MATINGS,
  PopgenEngine,
  StatsRecorder,
  combineNe,
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
    barriers: { cols: 1, rows: 1, cellSizeWu: config.world.widthWu, mask: new Uint8Array(1), specs: [] },
    events: [],
    deathCounts: { starvation: 0, predation: 0, temperature: 0, senescence: 0, catastrophe: 0 },
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

  it('is null when one side of the barrier is below minSpeciesSize', () => {
    const state = makeState(config, 500);
    const specs: OrganismSpec[] = [];
    for (let index = 0; index < 400; index += 1) {
      specs.push({ id: index + 1, x: 100, y: 600, genome: genomeWithMarkers([[index % 2, 0]]) });
    }
    for (let index = 0; index < 5; index += 1) {
      specs.push({ id: 500 + index, x: 1900, y: 600, genome: genomeWithMarkers([[1, 1]]) });
    }
    place(state, specs);
    state.barriers.specs.push({
      id: 'thin-side',
      shape: { kind: 'verticalRidge', xWu: 1000, thicknessWu: 30 },
      permeability: 0,
      raisedTick: 0,
    });
    expect(new PopgenEngine(config).fst(state, 'barrier')).toBeNull();
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

      const estimate = new PopgenEngine(config).temporalNe(earlier, frequencies, generations, populationSize);
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
      return new PopgenEngine(config).temporalNe(earlier, frequencies, generations, populationSize);
    });
    expect(estimates[1] ?? 0).toBeGreaterThan(2 * (estimates[0] ?? 0));
  });

  it('inverts F exactly at the defining relation and caps a frozen population', () => {
    // F = 1 − (1 − 1/2N)^t is the drift accumulated over t generations, so
    // feeding it back must return N.
    const populationSize = 250;
    const generations = 30;
    const f = 1 - Math.pow(1 - 1 / (2 * populationSize), generations);
    expect(temporalNeFromF(f, generations, populationSize)).toBeCloseTo(populationSize, 6);

    // Identical frequencies: no drift observed, so Ne is unbounded above and is
    // reported at the documented cap rather than as Infinity.
    const still = [[0.5, 0.5]];
    expect(temporalNeFromF(neiTajimaF(still, still), 10, 100)).toBe(1000);
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

describe('demographic Ne', () => {
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

    // Multiplicative composition of the two proportional reductions.
    expect(combineNe(100, 36, 99)).toBeCloseTo(35.64, 10);
  });

  it('reads sex ratio and offspring variance off a constructed parentage table', () => {
    const config = makeConfig({ time: { generationTicks: 900, maturityTicks: 600 } });
    const tick = 10_000;
    const recorder = new StatsRecorder({ config });
    const state = makeState(config, 16, tick);

    // 20 males and 20 females mature well before the window opens. Every female
    // leaves exactly two offspring; half the males leave four and half leave
    // none — a deliberately lopsided male distribution, which is the whole
    // reason variance effective size is not the census.
    const males: OrganismId[] = [];
    const females: OrganismId[] = [];
    let nextId = 1;
    const founder = (sex: Sex): OrganismId => {
      const id = nextId;
      nextId += 1;
      recorder.onBirth(makeRecord(id, NO_ORGANISM, NO_ORGANISM, 0, sex));
      return id;
    };
    for (let index = 0; index < 20; index += 1) males.push(founder('male'));
    for (let index = 0; index < 20; index += 1) females.push(founder('female'));

    const offspringCount = new Map<OrganismId, number>();
    for (const id of [...males, ...females]) offspringCount.set(id, 0);
    // Inside the window (opens at 9100) but too young to be breeders themselves
    // by `tick`, so the denominator is exactly the 40 founders.
    let birthTick = 9600;
    for (let index = 0; index < 40; index += 1) {
      const mother = females[index % 20] ?? 0;
      // Only the first ten males breed, four times each.
      const father = males[Math.floor(index / 4)] ?? 0;
      recorder.onBirth(makeRecord(nextId, mother, father, birthTick, index % 2 === 0 ? 'female' : 'male'));
      nextId += 1;
      birthTick += 8;
      offspringCount.set(mother, (offspringCount.get(mother) ?? 0) + 1);
      offspringCount.set(father, (offspringCount.get(father) ?? 0) + 1);
    }

    const breeders = males.length + females.length;
    const counts = [...offspringCount.values()];
    const meanOffspring = counts.reduce((sum, value) => sum + value, 0) / breeders;
    const varianceOffspring =
      counts.reduce((sum, value) => sum + (value - meanOffspring) ** 2, 0) / (breeders - 1);

    expect(meanOffspring).toBeCloseTo(2, 10);
    expect(varianceOffspring).toBeCloseTo(80 / 39, 10);

    const expected = combineNe(
      breeders,
      sexRatioNe(males.length, females.length),
      varianceNeGeneral(breeders, meanOffspring, varianceOffspring),
    );
    expect(expected).toBeCloseTo(38.506, 3);
    expect(recorder.estimators.demographicNe(state)).toBeCloseTo(expected, 6);
  });

  it('falls below the census when the sex ratio is skewed', () => {
    const config = makeConfig({ time: { generationTicks: 900, maturityTicks: 600 } });
    const tick = 10_000;
    const recorder = new StatsRecorder({ config });
    const state = makeState(config, 16, tick);

    let nextId = 1;
    const males: OrganismId[] = [];
    const females: OrganismId[] = [];
    for (let index = 0; index < 4; index += 1) {
      recorder.onBirth(makeRecord(nextId, NO_ORGANISM, NO_ORGANISM, 0, 'male'));
      males.push(nextId);
      nextId += 1;
    }
    for (let index = 0; index < 36; index += 1) {
      recorder.onBirth(makeRecord(nextId, NO_ORGANISM, NO_ORGANISM, 0, 'female'));
      females.push(nextId);
      nextId += 1;
    }
    const offspringCount = new Map<OrganismId, number>();
    for (const id of [...males, ...females]) offspringCount.set(id, 0);
    for (let index = 0; index < 40; index += 1) {
      const mother = females[index % 36] ?? 0;
      const father = males[index % 4] ?? 0;
      recorder.onBirth(makeRecord(nextId, mother, father, 9600 + index * 8, 'female'));
      nextId += 1;
      offspringCount.set(mother, (offspringCount.get(mother) ?? 0) + 1);
      offspringCount.set(father, (offspringCount.get(father) ?? 0) + 1);
    }

    const breeders = 40;
    const counts = [...offspringCount.values()];
    const meanOffspring = counts.reduce((sum, value) => sum + value, 0) / breeders;
    const varianceOffspring =
      counts.reduce((sum, value) => sum + (value - meanOffspring) ** 2, 0) / (breeders - 1);
    // Four males fathering ten offspring each against thirty-six females is a
    // brutal variance: Vk = 288/39.
    expect(varianceOffspring).toBeCloseTo(288 / 39, 10);

    const expected = combineNe(
      breeders,
      sexRatioNe(4, 36),
      varianceNeGeneral(breeders, meanOffspring, varianceOffspring),
    );
    expect(sexRatioNe(4, 36)).toBeCloseTo(14.4, 10);
    expect(expected).toBeCloseTo(5.984, 3);
    // Both corrections bite: 40 census breeders behave like six.
    expect(recorder.estimators.demographicNe(state)).toBeCloseTo(expected, 6);
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
    expect(Math.abs(engine.assortmentIndex(0))).toBeLessThan(0.1);
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
    expect(Math.abs(random.hueAssortment(0))).toBeLessThan(0.1);
  });

  it('ignores matings whose partners were never observed', () => {
    const engine = new PopgenEngine(config);
    seedTrait(engine, 1, 'diet', 1);
    seedTrait(engine, 2, 'diet', 1);
    engine.recordMating(1, 2, 10);
    engine.recordMating(1, 999, 10);
    // The unresolvable pair is dropped rather than counted as zero.
    expect(engine.assortmentIndex(0)).toBe(0);
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
