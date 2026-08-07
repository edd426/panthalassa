/**
 * WP-A1 acceptance probes: the genetics package against the population-genetic
 * facts it claims to implement.
 *
 * These are not smoke tests. Each one asserts a quantity with an independently
 * known value — Mendelian 1/2, Haldane's mapping function, the moments of the
 * authored mutation kernel, the analytic founder genetic variance — so a
 * plausible-looking implementation that is quietly wrong (one haplotype
 * dropped, crossovers drawn on the wrong interval, a Gaussian-only mutation
 * kernel, GxE shrinking variance) fails rather than passes.
 *
 * Two of them exist specifically because of how the previous project died:
 * `founder variance` (herdloom's generation 0 had almost nothing to select on)
 * and `GxE shifts expression` (herdloom multiplied deviation-from-mean and bled
 * variance every generation).
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { PhenotypeContext, PhenotypeResult } from '../contracts/apis';
import type { CladeArchetype, DiscreteLocusId, Genome, QuantLocusId } from '../contracts/genome';
import {
  CLADE_SCHEMA,
  DISCRETE_EFFECTS,
  DISCRETE_GENOME_LENGTH,
  DISCRETE_LOCI,
  DISCRETE_LOCUS_BY_ID,
  MAP_LENGTH_CM,
  QUANT_GENOME_LENGTH,
  QUANT_LOCUS_BY_ID,
  QUANT_LOCUS_COUNT,
  discreteAlleleIndex,
  expressedCladeArchetype,
  founderGeneticVariance,
  quantAlleleIndex,
} from '../contracts/genome';
import type { TraitKey } from '../contracts/traits';
import { TRAIT_COUNT, TRAIT_INDEX, TRAIT_KEYS } from '../contracts/traits';
import type { SimConfig } from '../contracts/types';
import { resolveSimConfig } from '../contracts/types';
import { createGenetics } from '../sim/genetics';
import { SeededRng } from '../sim/rng';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFIG = resolveSimConfig();

/** Mutation off, so segregation and recombination are measured without noise. */
const NO_MUTATION = resolveSimConfig({ toggles: { enableMutation: false } });

const CONTEXT: PhenotypeContext = { localTemperatureAnomalyZ: 0, parentArchetype: 'undulator' };

function emptyGenome(karyotype: 'XX' | 'XY' = 'XX'): Genome {
  return {
    quant: new Float32Array(QUANT_GENOME_LENGTH),
    discrete: new Uint8Array(DISCRETE_GENOME_LENGTH),
    karyotype,
  };
}

/**
 * A parent whose two haplotypes are distinguishable at every quantitative
 * locus: maternal alleles are 0, paternal are 1. A gamete from it is therefore
 * a direct readout of which haplotype each locus came from, which is what makes
 * the recombination fractions measurable.
 */
function markerGenome(): Genome {
  const genome = emptyGenome();
  for (let index = 0; index < QUANT_LOCUS_COUNT; index += 1) {
    genome.quant[quantAlleleIndex(0, index)] = 0;
    genome.quant[quantAlleleIndex(1, index)] = 1;
  }
  return genome;
}

/** The maternal haplotype of the offspring is the mother's gamete. */
function maternalGametes(mother: Genome, count: number, seed: string, config: SimConfig): Genome[] {
  const genetics = createGenetics();
  const rng = new SeededRng(seed);
  const father = emptyGenome('XY');
  return Array.from({ length: count }, () => genetics.makeOffspringGenome(rng, mother, father, config).genome);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: readonly number[]): number {
  const m = mean(values);
  return values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
}

/** `PhenotypeResult` hands back scratch views the next call invalidates. */
function copyPhenotype(result: PhenotypeResult): {
  traits: number[];
  traitsLatent: number[];
  genotypicValues: number[];
  archetype: CladeArchetype;
} {
  return {
    traits: [...result.traits],
    traitsLatent: [...result.traitsLatent],
    genotypicValues: [...result.genotypicValues],
    archetype: result.archetype,
  };
}

/** Genotypic value of every trait across a founder cohort, one column per trait. */
function founderGenotypicColumns(count: number, seed: string, z: number): number[][] {
  const genetics = createGenetics();
  const rng = new SeededRng(seed);
  const columns: number[][] = TRAIT_KEYS.map(() => []);
  const context: PhenotypeContext = { localTemperatureAnomalyZ: z, parentArchetype: 'undulator' };
  for (let index = 0; index < count; index += 1) {
    const genome = genetics.buildFounderGenome(rng, CONFIG);
    const result = genetics.computePhenotype(genome, rng, CONFIG, context);
    for (let trait = 0; trait < TRAIT_COUNT; trait += 1) {
      (columns[trait] as number[]).push(result.genotypicValues[trait] ?? 0);
    }
  }
  return columns;
}

const TRAITS_WITH_DISCRETE_EFFECTS = new Set<TraitKey>(DISCRETE_EFFECTS.map((effect) => effect.trait));

// ---------------------------------------------------------------------------

describe('segregation', () => {
  it('splits a heterozygous discrete locus 1:1', () => {
    const locus = DISCRETE_LOCUS_BY_ID.neutralA;
    const mother = emptyGenome();
    mother.discrete[discreteAlleleIndex(0, locus.index)] = 0;
    mother.discrete[discreteAlleleIndex(1, locus.index)] = 1;

    const gametes = maternalGametes(mother, 10_000, 'segregation', NO_MUTATION);
    const counts = [0, 0];
    for (const gamete of gametes) {
      const allele = gamete.discrete[discreteAlleleIndex(0, locus.index)] ?? 0;
      expect(allele).toBeLessThan(2);
      counts[allele] = (counts[allele] ?? 0) + 1;
    }

    // ±0.02 is 4 standard errors at 10k gametes; tighter than that fails on
    // honest sampling noise rather than on a segregation bug.
    expect(Math.abs((counts[0] ?? 0) / gametes.length - 0.5)).toBeLessThan(0.02);
    expect(Math.abs((counts[1] ?? 0) / gametes.length - 0.5)).toBeLessThan(0.02);
  });

  it('assorts different chromosomes freely', () => {
    const gametes = maternalGametes(markerGenome(), 20_000, 'assortment', NO_MUTATION);
    const onA1 = QUANT_LOCUS_BY_ID.q01.index;
    const onA2 = QUANT_LOCUS_BY_ID.q13.index;
    let differing = 0;
    for (const gamete of gametes) {
      if (gamete.quant[onA1] !== gamete.quant[onA2]) differing += 1;
    }
    expect(Math.abs(differing / gametes.length - 0.5)).toBeLessThan(0.015);
  });
});

describe('recombination', () => {
  /**
   * Chromosomes are 1 Morgan and crossovers are Poisson(1) at uniform
   * positions, so crossovers in an interval of length d are Poisson(d/100) and
   * the recombination fraction is exactly Haldane's r = (1 − e^(−2d/100))/2.
   * The pairs below span 1.5 cM (the authored armour and predation linkage
   * blocks, which P10's sweep needs in order to drag a hitchhiker) out to
   * 85 cM, near free recombination.
   */
  const PAIRS: readonly (readonly [QuantLocusId, QuantLocusId])[] = [
    ['q07', 'q08'],
    ['q29', 'q30'],
    ['q01', 'q02'],
    ['q02', 'q05'],
    ['q13', 'q19'],
    ['q25', 'q36'],
    ['q37', 'q48'],
  ];

  const gametes = maternalGametes(markerGenome(), 40_000, 'recombination', NO_MUTATION);

  it.each(PAIRS)('%s–%s matches Haldane over the authored map distance', (left, right) => {
    const a = QUANT_LOCUS_BY_ID[left];
    const b = QUANT_LOCUS_BY_ID[right];
    expect(a.chromosome).toBe(b.chromosome);

    const distanceCm = Math.abs(a.positionCm - b.positionCm);
    const expected = (1 - Math.exp((-2 * distanceCm) / MAP_LENGTH_CM)) / 2;

    let recombinant = 0;
    for (const gamete of gametes) {
      if (gamete.quant[a.index] !== gamete.quant[b.index]) recombinant += 1;
    }
    const observed = recombinant / gametes.length;

    const standardError = Math.sqrt((expected * (1 - expected)) / gametes.length);
    expect(Math.abs(observed - expected)).toBeLessThan(Math.max(0.004, 4 * standardError));
  });

  it('never exceeds free recombination on a single chromosome', () => {
    const first = QUANT_LOCUS_BY_ID.q01;
    const last = QUANT_LOCUS_BY_ID.q12;
    let recombinant = 0;
    for (const gamete of gametes) {
      if (gamete.quant[first.index] !== gamete.quant[last.index]) recombinant += 1;
    }
    expect(recombinant / gametes.length).toBeLessThan(0.5);
  });
});

describe('mutation', () => {
  // Cranked ~100× so a quarter of a million effects accumulate in a few seconds;
  // the kernel's shape does not depend on the rate.
  const config = resolveSimConfig({ genetics: { quantMutationRate: 0.1 } });
  const genetics = createGenetics();
  const rng = new SeededRng('mutation');
  const mother = genetics.buildFounderGenome(rng, config, 'female');
  const father = genetics.buildFounderGenome(rng, config, 'male');

  const BIRTHS = 25_000;
  /** Effects in units of their own locus `mutSigma`, so all 48 loci pool. */
  const standardized: number[] = [];
  const perBirth: number[] = [];
  let fatTailCount = 0;

  for (let index = 0; index < BIRTHS; index += 1) {
    const result = genetics.makeOffspringGenome(rng, mother, father, config);
    let quantitative = 0;
    for (const record of result.mutations) {
      const locus = QUANT_LOCUS_BY_ID[record.locus as QuantLocusId] as
        | (typeof QUANT_LOCUS_BY_ID)[QuantLocusId]
        | undefined;
      if (locus === undefined) continue;
      quantitative += 1;
      standardized.push(record.delta / (locus.mutSigma * config.genetics.mutationSigmaScale));
      if (record.fatTail) fatTailCount += 1;
    }
    perBirth.push(quantitative);
  }

  const fatTailFraction = config.genetics.mutationFatTailFraction;
  const tailRatio = config.genetics.mutationFatTailScaleRatio;
  // Mixture of N(0,1) and Laplace(0, b): Var = 2b², E[X⁴] = 24b⁴.
  const expectedVariance = (1 - fatTailFraction) + fatTailFraction * 2 * tailRatio ** 2;
  const expectedFourthMoment = (1 - fatTailFraction) * 3 + fatTailFraction * 24 * tailRatio ** 4;
  const expectedExcessKurtosis = expectedFourthMoment / expectedVariance ** 2 - 3;

  it('draws effects centred on zero', () => {
    expect(standardized.length).toBeGreaterThan(200_000);
    expect(Math.abs(mean(standardized))).toBeLessThan(0.03);
  });

  it('has the variance of the 90/10 Normal–Laplace mixture', () => {
    expect(variance(standardized)).toBeCloseTo(expectedVariance, 1);
    expect(Math.abs(variance(standardized) / expectedVariance - 1)).toBeLessThan(0.07);
  });

  it('is strongly leptokurtic — the fat tail that keeps the ceiling receding', () => {
    const m = mean(standardized);
    let m2 = 0;
    let m4 = 0;
    for (const value of standardized) {
      const deviation = value - m;
      m2 += deviation * deviation;
      m4 += deviation ** 4;
    }
    m2 /= standardized.length;
    m4 /= standardized.length;
    const excessKurtosis = m4 / (m2 * m2) - 3;

    // A Gaussian-only kernel scores 0 here; theory for the authored mixture is
    // ≈17.9. The band is wide because heavy-tailed kurtosis estimates are noisy,
    // and still far from admitting a kernel without a fat tail.
    expect(excessKurtosis).toBeGreaterThan(expectedExcessKurtosis * 0.6);
    expect(excessKurtosis).toBeLessThan(expectedExcessKurtosis * 1.5);
  });

  it('takes its fat-tail draws at the configured rate', () => {
    expect(fatTailCount / standardized.length).toBeCloseTo(fatTailFraction, 2);
  });

  it('mutates loci at a Poisson rate per gamete', () => {
    // Two gametes per birth, each Poisson(nLoci · μ).
    const expected = 2 * QUANT_LOCUS_COUNT * config.genetics.quantMutationRate;
    expect(mean(perBirth) / expected).toBeCloseTo(1, 1);
    // Poisson's signature: variance equals the mean.
    expect(variance(perBirth) / mean(perBirth)).toBeCloseTo(1, 1);
  });

  it('steps discrete loci to a neighbouring allele and stays in range', () => {
    const discreteConfig = resolveSimConfig({ genetics: { discreteMutationRate: 0.2 } });
    const local = createGenetics();
    const localRng = new SeededRng('discrete-mutation');
    const dam = local.buildFounderGenome(localRng, discreteConfig, 'female');
    const sire = local.buildFounderGenome(localRng, discreteConfig, 'male');

    let observed = 0;
    for (let index = 0; index < 4_000; index += 1) {
      const result = local.makeOffspringGenome(localRng, dam, sire, discreteConfig);
      for (const record of result.mutations) {
        const locus = DISCRETE_LOCUS_BY_ID[record.locus as DiscreteLocusId] as
          | (typeof DISCRETE_LOCUS_BY_ID)[DiscreteLocusId]
          | undefined;
        if (locus === undefined) continue;
        observed += 1;
        expect(Number.isInteger(record.delta)).toBe(true);
        expect(record.delta).toBeGreaterThanOrEqual(0);
        expect(record.delta).toBeLessThan(locus.alleleCount);
        // Clade macro-loci have their own per-birth rate and never appear here.
        expect(locus.kind).not.toBe('cladeMacro');
      }
      for (const locus of DISCRETE_LOCI) {
        expect(result.genome.discrete[discreteAlleleIndex(0, locus.index)] ?? 0).toBeLessThan(locus.alleleCount);
        expect(result.genome.discrete[discreteAlleleIndex(1, locus.index)] ?? 0).toBeLessThan(locus.alleleCount);
      }
    }
    expect(observed).toBeGreaterThan(100);
  });
});

describe('phenotype', () => {
  it('is a pure function of genome, RNG state and context', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.double({ min: -3, max: 3, noNaN: true }),
        (seed, z) => {
          const genetics = createGenetics();
          const genome = genetics.buildFounderGenome(new SeededRng(`genome:${seed}`), CONFIG);
          const context: PhenotypeContext = { localTemperatureAnomalyZ: z, parentArchetype: 'undulator' };

          const first = copyPhenotype(genetics.computePhenotype(genome, new SeededRng(seed), CONFIG, context));
          const second = copyPhenotype(genetics.computePhenotype(genome, new SeededRng(seed), CONFIG, context));

          expect(second).toEqual(first);
          for (const value of first.traitsLatent) expect(Number.isFinite(value)).toBe(true);
          for (const value of first.traits) expect(Number.isFinite(value)).toBe(true);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('leaves the genome untouched', () => {
    const genetics = createGenetics();
    const rng = new SeededRng('phenotype-purity');
    const genome = genetics.buildFounderGenome(rng, CONFIG);
    const quantBefore = Float32Array.from(genome.quant);
    const discreteBefore = Uint8Array.from(genome.discrete);

    genetics.computePhenotype(genome, rng, CONFIG, CONTEXT);

    expect(Array.from(genome.quant)).toEqual(Array.from(quantBefore));
    expect(Array.from(genome.discrete)).toEqual(Array.from(discreteBefore));
  });

  it('expresses non-negative traits through the softplus link, never a clamp', () => {
    const genetics = createGenetics();
    const rng = new SeededRng('softplus');
    // A genome pushed far below the floor still has to produce distinguishable,
    // strictly increasing expressed values — a Math.max(0, …) would tie them.
    const low = emptyGenome();
    const lower = emptyGenome();
    for (let index = 0; index < QUANT_LOCUS_COUNT; index += 1) {
      low.quant[quantAlleleIndex(0, index)] = -8;
      low.quant[quantAlleleIndex(1, index)] = -8;
      lower.quant[quantAlleleIndex(0, index)] = -9;
      lower.quant[quantAlleleIndex(1, index)] = -9;
    }
    const noEnvironment = resolveSimConfig({ genetics: { targetFounderHeritability: 1 } });

    const a = copyPhenotype(genetics.computePhenotype(low, rng, noEnvironment, CONTEXT));
    const b = copyPhenotype(genetics.computePhenotype(lower, rng, noEnvironment, CONTEXT));

    const size = TRAIT_INDEX.size;
    expect(a.traits[size]).toBeGreaterThan(0);
    expect(b.traits[size]).toBeGreaterThan(0);
    expect(b.traits[size]).toBeLessThan(a.traits[size] as number);
    expect(b.traitsLatent[size]).toBeLessThan(a.traitsLatent[size] as number);
  });
});

describe('founders', () => {
  it('gives every trait strictly positive genotypic variance at generation 0', () => {
    const columns = founderGenotypicColumns(500, 'founder-variance', 0);
    for (const [index, key] of TRAIT_KEYS.entries()) {
      const observed = variance(columns[index] as number[]);
      expect(observed, `trait ${key} has no founder variance`).toBeGreaterThan(0);
    }
  });

  it('reproduces the analytic founder genetic variance', () => {
    const columns = founderGenotypicColumns(2_000, 'founder-analytic', 0);
    for (const [index, key] of TRAIT_KEYS.entries()) {
      // `founderGeneticVariance` counts quantitative loci only, so traits that
      // also carry authored discrete effects (hue, preference) sit above it.
      if (TRAITS_WITH_DISCRETE_EFFECTS.has(key)) continue;
      const analytic = founderGeneticVariance(key, CONFIG.genetics.founderSdScale);
      const observed = variance(columns[index] as number[]);
      expect(observed / analytic, `trait ${key}`).toBeGreaterThan(0.85);
      expect(observed / analytic, `trait ${key}`).toBeLessThan(1.15);
    }
  });

  it('starts every founder as the ancestral undulator', () => {
    const genetics = createGenetics();
    const rng = new SeededRng('founder-archetype');
    for (let index = 0; index < 400; index += 1) {
      const genome = genetics.buildFounderGenome(rng, CONFIG);
      expect(expressedCladeArchetype(genome)).toBe('undulator');
    }
  });

  it('honours the requested sex and coin-flips it otherwise', () => {
    const genetics = createGenetics();
    const rng = new SeededRng('founder-sex');
    expect(genetics.buildFounderGenome(rng, CONFIG, 'female').karyotype).toBe('XX');
    expect(genetics.buildFounderGenome(rng, CONFIG, 'male').karyotype).toBe('XY');

    let males = 0;
    const draws = 4_000;
    for (let index = 0; index < draws; index += 1) {
      if (genetics.buildFounderGenome(rng, CONFIG).karyotype === 'XY') males += 1;
    }
    expect(males / draws).toBeCloseTo(0.5, 1);
  });
});

describe('GxE', () => {
  /**
   * The axiom herdloom broke. The environment scales the *genotypic value* — a
   * fixed function of the genome — so a population spread across warm and cold
   * water carries **more** genetic variance than one held at a single
   * temperature. Multiplying deviation-from-the-population-mean instead would
   * shrink variance every generation, which is exactly what happened before.
   */
  const sensitivity = CONFIG.genetics.gxeSensitivity;
  const gxeTraits = new Set<TraitKey>(CONFIG.genetics.gxeTraits);

  it('scales genotypic variance by (1 + s·z)² for GxE traits and leaves the rest alone', () => {
    const neutral = founderGenotypicColumns(3_000, 'gxe', 0);
    const warm = founderGenotypicColumns(3_000, 'gxe', 1);

    for (const [index, key] of TRAIT_KEYS.entries()) {
      const base = variance(neutral[index] as number[]);
      const shifted = variance(warm[index] as number[]);
      const expected = gxeTraits.has(key) ? (1 + sensitivity) ** 2 : 1;
      expect(shifted / base, `trait ${key}`).toBeCloseTo(expected, 1);
    }
  });

  it('makes a mixed-temperature population more variable than a uniform one', () => {
    const uniform = founderGenotypicColumns(4_000, 'gxe-mix', 0);
    const warm = founderGenotypicColumns(2_000, 'gxe-mix-warm', 1);
    const cold = founderGenotypicColumns(2_000, 'gxe-mix-cold', -1);

    for (const [index, key] of TRAIT_KEYS.entries()) {
      if (!gxeTraits.has(key)) continue;
      const mixed = variance([...(warm[index] as number[]), ...(cold[index] as number[])]);
      expect(mixed, `trait ${key}`).toBeGreaterThan(variance(uniform[index] as number[]));
    }
  });

  it('is off when the mechanism toggle is off', () => {
    const off = resolveSimConfig({ toggles: { enableSpatialGxE: false } });
    const genetics = createGenetics();
    const genome = genetics.buildFounderGenome(new SeededRng('gxe-toggle'), CONFIG);

    const neutral = copyPhenotype(
      genetics.computePhenotype(genome, new SeededRng('e'), off, {
        localTemperatureAnomalyZ: 0,
        parentArchetype: 'undulator',
      }),
    );
    const warm = copyPhenotype(
      genetics.computePhenotype(genome, new SeededRng('e'), off, {
        localTemperatureAnomalyZ: 2,
        parentArchetype: 'undulator',
      }),
    );
    expect(warm.genotypicValues).toEqual(neutral.genotypicValues);
  });
});

describe('determinism', () => {
  it('produces byte-identical offspring from the same seed', () => {
    const build = (): Genome[] => {
      const genetics = createGenetics();
      const rng = new SeededRng('determinism');
      const mother = genetics.buildFounderGenome(rng, CONFIG, 'female');
      const father = genetics.buildFounderGenome(rng, CONFIG, 'male');
      return Array.from(
        { length: 200 },
        () => genetics.makeOffspringGenome(rng, mother, father, CONFIG).genome,
      );
    };

    const first = build();
    const second = build();
    expect(second).toHaveLength(first.length);
    for (let index = 0; index < first.length; index += 1) {
      const a = first[index] as Genome;
      const b = second[index] as Genome;
      expect(Array.from(b.quant)).toEqual(Array.from(a.quant));
      expect(Array.from(b.discrete)).toEqual(Array.from(a.discrete));
      expect(b.karyotype).toBe(a.karyotype);
    }
  });

  it('inherits sex from the father at 1:1', () => {
    const genetics = createGenetics();
    const rng = new SeededRng('sex-ratio');
    const mother = genetics.buildFounderGenome(rng, CONFIG, 'female');
    const father = genetics.buildFounderGenome(rng, CONFIG, 'male');
    let males = 0;
    const births = 8_000;
    for (let index = 0; index < births; index += 1) {
      if (genetics.makeOffspringGenome(rng, mother, father, CONFIG).genome.karyotype === 'XY') males += 1;
    }
    expect(males / births).toBeCloseTo(0.5, 1);
  });
});

describe('clade macro-mutation', () => {
  // Forced to fire on every birth; the shipped rate is 1e-5 per birth.
  const config = resolveSimConfig({ genetics: { cladeMacroMutationRate: 1 } });

  it('re-seeds a new body plan onto its schema without moving anything else', () => {
    const genetics = createGenetics();
    const rng = new SeededRng('clade');
    const mother = genetics.buildFounderGenome(rng, CONFIG, 'female');
    const father = genetics.buildFounderGenome(rng, CONFIG, 'male');

    const expressed = new Map<CladeArchetype, number[][]>();
    const latent = new Map<CladeArchetype, number[][]>();
    for (let index = 0; index < 6_000; index += 1) {
      const result = genetics.makeOffspringGenome(rng, mother, father, config);
      expect(result.macroMutated).toBe(true);
      const phenotype = genetics.computePhenotype(result.genome, rng, config, CONTEXT);
      const traits = expressed.get(phenotype.archetype) ?? TRAIT_KEYS.map(() => []);
      const traitsLatent = latent.get(phenotype.archetype) ?? TRAIT_KEYS.map(() => []);
      for (let trait = 0; trait < TRAIT_COUNT; trait += 1) {
        (traits[trait] as number[]).push(phenotype.traits[trait] ?? 0);
        (traitsLatent[trait] as number[]).push(phenotype.traitsLatent[trait] ?? 0);
      }
      expressed.set(phenotype.archetype, traits);
      latent.set(phenotype.archetype, traitsLatent);
    }

    // All three body plans are reachable from an ancestral 0/0 founder pair.
    expect([...expressed.keys()].sort()).toEqual(['armoredCrawler', 'radialDrifter', 'undulator']);

    const ancestral = latent.get('undulator') as number[][];
    for (const [archetype, traits] of expressed) {
      const traitsLatent = latent.get(archetype) as number[][];
      const schema = CLADE_SCHEMA[archetype];

      for (const key of ['segmentCount', 'finPairs', 'bodyAspect'] as const) {
        const observed = mean(traits[TRAIT_INDEX[key]] as number[]);
        const [low, high] = schema[key].renderRange;
        expect(observed, `${archetype}.${key}`).toBeGreaterThanOrEqual(low);
        expect(observed, `${archetype}.${key}`).toBeLessThanOrEqual(high);
        // Within a quarter of the channel's render span of the schema's typical.
        expect(Math.abs(observed - schema[key].typical), `${archetype}.${key}`).toBeLessThan((high - low) / 4);

        if (archetype === 'undulator') continue;
        // Convergence check. The projection pins the genotypic value exactly on
        // target, so the only thing left varying on the latent scale is the
        // birth environmental deviation — whose SD is analytic. A projection
        // that stopped short would leave the re-draw scatter behind and come
        // out wider.
        const heritability = CONFIG.genetics.targetFounderHeritability;
        const environmentSd =
          Math.sqrt(
            (founderGeneticVariance(key, CONFIG.genetics.founderSdScale) * (1 - heritability)) / heritability,
          ) * CONFIG.genetics.environmentDeviationScale;
        const spread = Math.sqrt(variance(traitsLatent[TRAIT_INDEX[key]] as number[]));
        expect(spread / environmentSd, `${archetype}.${key} spread`).toBeGreaterThan(0.9);
        expect(spread / environmentSd, `${archetype}.${key} spread`).toBeLessThan(1.1);
      }

      // Everything the re-seeded loci also touch must move only by the amount
      // the clade schema authored, not by a pleiotropy accident. `speedCap`
      // (q04/q46/q47) and `defense` (q09) are the ones genuinely at risk;
      // `size` and `metabolicEff` ride along as controls.
      for (const key of ['speedCap', 'defense', 'size', 'metabolicEff'] as const) {
        const shift = schema.traitBaselineShift[key] ?? 0;
        const clade = traitsLatent[TRAIT_INDEX[key]] as number[];
        const base = ancestral[TRAIT_INDEX[key]] as number[];
        const standardError = Math.sqrt(variance(clade) / clade.length + variance(base) / base.length);
        expect(Math.abs(mean(clade) - mean(base) - shift), `${archetype}.${key}`).toBeLessThan(
          Math.max(0.05, 4 * standardError),
        );
      }
    }
  });

  it('reports the macro-locus mutation and never fires when mutation is off', () => {
    const genetics = createGenetics();
    const rng = new SeededRng('clade-off');
    const mother = genetics.buildFounderGenome(rng, CONFIG, 'female');
    const father = genetics.buildFounderGenome(rng, CONFIG, 'male');
    const off = resolveSimConfig({
      genetics: { cladeMacroMutationRate: 1 },
      toggles: { enableMutation: false },
    });

    for (let index = 0; index < 200; index += 1) {
      const result = genetics.makeOffspringGenome(rng, mother, father, off);
      expect(result.macroMutated).toBe(false);
      expect(result.mutations).toHaveLength(0);
      expect(expressedCladeArchetype(result.genome)).toBe('undulator');
    }
  });
});

describe('applyAlleleEdit', () => {
  it('edits one copy of the named quantitative locus and nothing else', () => {
    const genetics = createGenetics();
    const genome = genetics.buildFounderGenome(new SeededRng('edit'), CONFIG);
    const quantBefore = Float32Array.from(genome.quant);
    const discreteBefore = Uint8Array.from(genome.discrete);

    const locus = QUANT_LOCUS_BY_ID.q07;
    const offset = 1.5 * locus.founderSd;
    const edited = genetics.applyAlleleEdit(genome, 'q07', offset, CONFIG);

    expect(edited).not.toBe(genome);
    expect(Array.from(genome.quant)).toEqual(Array.from(quantBefore));
    expect(Array.from(genome.discrete)).toEqual(Array.from(discreteBefore));

    const edge = quantAlleleIndex(0, locus.index);
    for (let index = 0; index < QUANT_GENOME_LENGTH; index += 1) {
      if (index === edge) continue;
      expect(edited.quant[index], `allele ${index}`).toBe(quantBefore[index]);
    }
    // One copy only: applied to a single organism that is frequency 1/(2N).
    expect(edited.quant[edge]).toBeCloseTo((quantBefore[edge] ?? 0) + offset, 5);
    expect(edited.quant[quantAlleleIndex(1, locus.index)]).toBe(quantBefore[quantAlleleIndex(1, locus.index)]);
    expect(Array.from(edited.discrete)).toEqual(Array.from(discreteBefore));
    expect(edited.karyotype).toBe(genome.karyotype);
  });

  it('sets one copy of the named discrete locus and nothing else', () => {
    const genetics = createGenetics();
    const genome = genetics.buildFounderGenome(new SeededRng('edit-discrete'), CONFIG);
    const discreteBefore = Uint8Array.from(genome.discrete);
    const quantBefore = Float32Array.from(genome.quant);

    const locus = DISCRETE_LOCUS_BY_ID.pigmentB;
    const edited = genetics.applyAlleleEdit(genome, 'pigmentB', 3, CONFIG);

    expect(Array.from(genome.discrete)).toEqual(Array.from(discreteBefore));
    expect(Array.from(edited.quant)).toEqual(Array.from(quantBefore));

    const edge = discreteAlleleIndex(0, locus.index);
    expect(edited.discrete[edge]).toBe(3);
    for (let index = 0; index < DISCRETE_GENOME_LENGTH; index += 1) {
      if (index === edge) continue;
      expect(edited.discrete[index], `allele ${index}`).toBe(discreteBefore[index]);
    }
  });

  it('rejects an out-of-range or non-finite edit rather than poisoning the pool', () => {
    const genetics = createGenetics();
    const genome = genetics.buildFounderGenome(new SeededRng('edit-guard'), CONFIG);
    expect(() => genetics.applyAlleleEdit(genome, 'pigmentB', 9, CONFIG)).toThrow();
    expect(() => genetics.applyAlleleEdit(genome, 'q07', Number.NaN, CONFIG)).toThrow();
    expect(() => genetics.applyAlleleEdit(genome, 'q07' as QuantLocusId, Number.POSITIVE_INFINITY, CONFIG)).toThrow();
  });
});
