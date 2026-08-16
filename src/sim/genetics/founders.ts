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
 *
 * ## Stream layout (G0)
 *
 * The parent stream is consumed **exactly once per founder** (a salt draw that
 * keeps successive founders distinct); all allele material comes from
 * per-chromosome forks and the karyotype from its own fork. Two properties
 * follow, and `g0-streams.test.ts` pins both:
 *
 * - appending a chromosome adds a fork and shifts nothing on A1–A4, so the
 *   genome is growable without moving old trajectories;
 * - the allele arrays a given parent state produces do not depend on whether
 *   the caller asked for a particular sex, so an engine that builds an exactly
 *   balanced founder cohort gets the same genetic material as one that
 *   coin-flips.
 */

import type { Genome, Karyotype } from '../../contracts/genome';
import {
  AUTOSOME_IDS,
  DISCRETE_GENOME_LENGTH,
  QUANT_GENOME_LENGTH,
  discreteAlleleIndex,
  quantAlleleIndex,
} from '../../contracts/genome';
import type { RandomSource, Sex, SimConfig } from '../../contracts/types';
import { NON_MACRO_DISCRETE_BY_CHROMOSOME, QUANT_LOCI_BY_CHROMOSOME } from './loci';

/** A founder genome. See the module note for the G0 stream layout. */
export function buildFounderGenome(rng: RandomSource, config: SimConfig, sex?: Sex): Genome {
  const { founderSdScale } = config.genetics;

  // One parent draw per founder, independent of genome size (G0).
  rng.next();

  const quant = new Float32Array(QUANT_GENOME_LENGTH);
  const discrete = new Uint8Array(DISCRETE_GENOME_LENGTH);

  for (const chromosome of AUTOSOME_IDS) {
    const chrRng = rng.fork(`founder:${chromosome}`);
    for (const locus of QUANT_LOCI_BY_CHROMOSOME[chromosome]) {
      const sd = locus.founderSd * founderSdScale;
      quant[quantAlleleIndex(0, locus.index)] = chrRng.normal(0, sd);
      quant[quantAlleleIndex(1, locus.index)] = chrRng.normal(0, sd);
    }
    for (const locus of NON_MACRO_DISCRETE_BY_CHROMOSOME[chromosome]) {
      discrete[discreteAlleleIndex(0, locus.index)] = chrRng.int(0, locus.alleleCount - 1);
      discrete[discreteAlleleIndex(1, locus.index)] = chrRng.int(0, locus.alleleCount - 1);
    }
  }

  const karyotype: Karyotype =
    sex === undefined
      ? rng.fork('founder:karyotype').chance(0.5)
        ? 'XY'
        : 'XX'
      : sex === 'male'
        ? 'XY'
        : 'XX';

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
