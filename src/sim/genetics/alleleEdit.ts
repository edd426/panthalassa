/**
 * External allele edits: the `introduceMutant` god tool and P10's sweep
 * injection.
 *
 * The edit lands on **one allele copy** (the maternal haplotype), which is the
 * whole point: applied to a single organism it puts the new allele at frequency
 * 1/(2N), exactly the starting condition P10 asserts a favourable allele can
 * sweep from. Writing both copies would start the sweep at 1/N and quietly make
 * the probe easier to pass.
 *
 * Nothing else in the genome is touched, and the input genome is not modified —
 * genomes are immutable once constructed.
 */

import type { DiscreteLocusId, Genome, QuantLocusId } from '../../contracts/genome';
import { DISCRETE_LOCUS_BY_ID, QUANT_LOCUS_BY_ID, discreteAlleleIndex, quantAlleleIndex } from '../../contracts/genome';
import type { SimConfig } from '../../contracts/types';
import { cloneGenome } from './founders';

/**
 * Sanity bound on a quantitative injection, in founder SDs.
 *
 * Generous by design — P10 injects 1.5σ and a god tool may want something
 * wild — so this only catches a caller that passed a *trait* value where an
 * allele-unit offset belongs. That mistake is otherwise silent: the organism
 * simply becomes a thousand-SD outlier and drags every population statistic
 * with it for as long as its lineage survives.
 */
const MAX_EDIT_SD = 1000;

/**
 * `value` is an **allele-unit offset** for a quantitative locus and an **allele
 * index** for a discrete one, matching `SimCommand.introduceMutant`.
 */
export function applyAlleleEdit(
  genome: Genome,
  locus: QuantLocusId | DiscreteLocusId,
  value: number,
  config: SimConfig,
): Genome {
  const quantLocus = QUANT_LOCUS_BY_ID[locus as QuantLocusId] as (typeof QUANT_LOCUS_BY_ID)[QuantLocusId] | undefined;
  if (quantLocus !== undefined) {
    const limit = MAX_EDIT_SD * quantLocus.founderSd * config.genetics.founderSdScale;
    if (!Number.isFinite(value) || Math.abs(value) > limit) {
      throw new Error(
        `Allele edit at ${locus} is ${value}; expected an allele-unit offset within ±${limit} (${MAX_EDIT_SD} founder SD).`,
      );
    }
    const edited = cloneGenome(genome);
    const slot = quantAlleleIndex(0, quantLocus.index);
    edited.quant[slot] = (edited.quant[slot] ?? 0) + value;
    return edited;
  }

  const discreteLocus = DISCRETE_LOCUS_BY_ID[locus as DiscreteLocusId] as
    | (typeof DISCRETE_LOCUS_BY_ID)[DiscreteLocusId]
    | undefined;
  if (discreteLocus === undefined) throw new Error(`Allele edit names an unknown locus: ${locus}.`);

  const allele = Math.round(value);
  if (!Number.isFinite(allele) || allele < 0 || allele >= discreteLocus.alleleCount) {
    throw new Error(
      `Allele edit at ${locus} is ${value}; expected an allele index in [0, ${discreteLocus.alleleCount}).`,
    );
  }
  const edited = cloneGenome(genome);
  edited.discrete[discreteAlleleIndex(0, discreteLocus.index)] = allele;
  return edited;
}
