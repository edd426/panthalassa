/**
 * Generation zero.
 *
 * Every founder allele is a draw from `N(0, founderSd · founderSdScale)` — the
 * *same distribution family mutation feeds*, differing only in scale
 * (`MUT_SIGMA_RATIO`). There is deliberately no zero-effect "null" allele:
 * herdloom seeded most loci with a Balanced allele of effect 0, so generation 0
 * had almost no standing variance and selection had nothing to act on for the
 * first dozen generations. Probe `founder variance` in
 * `src/probes/genetics-units.test.ts` asserts the fix directly — every trait
 * must carry strictly positive genotypic variance at gen 0.
 *
 * Discrete loci are uniform over their allele sets, **except the two clade
 * macro-loci**, which start homozygous for allele 0. That is a contract
 * requirement, not a simplification: `CLADE_MACRO_TABLE` is authored so that
 * 0/0 is the ancestral undulator, and the other two body plans have to be
 * *discovered* by macro-mutation. Seeding them uniformly would hand the player
 * all three archetypes on tick 0 and throw away the clade-founding event.
 */

import type { Genome, Karyotype } from '../../contracts/genome';
import {
  DISCRETE_GENOME_LENGTH,
  DISCRETE_LOCI,
  QUANT_GENOME_LENGTH,
  QUANT_LOCI,
  discreteAlleleIndex,
  quantAlleleIndex,
} from '../../contracts/genome';
import type { RandomSource, Sex, SimConfig } from '../../contracts/types';

/**
 * A founder genome.
 *
 * The karyotype is drawn **last**, and only when `sex` is omitted, so that the
 * allele arrays a given RNG state produces do not depend on whether the caller
 * asked for a particular sex. An engine that builds an exactly balanced founder
 * cohort therefore gets the same genetic material as one that coin-flips.
 */
export function buildFounderGenome(rng: RandomSource, config: SimConfig, sex?: Sex): Genome {
  const { founderSdScale } = config.genetics;

  const quant = new Float32Array(QUANT_GENOME_LENGTH);
  for (const locus of QUANT_LOCI) {
    const sd = locus.founderSd * founderSdScale;
    quant[quantAlleleIndex(0, locus.index)] = rng.normal(0, sd);
    quant[quantAlleleIndex(1, locus.index)] = rng.normal(0, sd);
  }

  const discrete = new Uint8Array(DISCRETE_GENOME_LENGTH);
  for (const locus of DISCRETE_LOCI) {
    if (locus.kind === 'cladeMacro') continue; // ancestral 0/0; see the module note
    discrete[discreteAlleleIndex(0, locus.index)] = rng.int(0, locus.alleleCount - 1);
    discrete[discreteAlleleIndex(1, locus.index)] = rng.int(0, locus.alleleCount - 1);
  }

  const karyotype: Karyotype = sex === undefined ? (rng.chance(0.5) ? 'XY' : 'XX') : sex === 'male' ? 'XY' : 'XX';

  return { quant, discrete, karyotype };
}

/** A detached copy. Genomes are immutable once constructed, so edits go through a clone. */
export function cloneGenome(genome: Genome): Genome {
  return {
    quant: Float32Array.from(genome.quant),
    discrete: Uint8Array.from(genome.discrete),
    karyotype: genome.karyotype,
  };
}
