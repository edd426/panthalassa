/**
 * Per-chromosome locus groupings (G0).
 *
 * Founder allele draws and gamete mutation both run on **per-chromosome forked
 * streams**, so these groupings are the unit of iteration everywhere genome
 * material is created. That is what makes the genome growable: appending a new
 * autosome adds a new fork with its own stream and consumes nothing from the
 * chromosomes that already exist, so a run that never expresses the new loci
 * is bit-identical to one built before they were added.
 */

import type { AutosomeId, DiscreteLocus, QuantLocus } from '../../contracts/genome';
import { AUTOSOME_IDS, DISCRETE_LOCI, QUANT_LOCI } from '../../contracts/genome';

function groupBy<T extends { readonly chromosome: AutosomeId }>(
  loci: readonly T[],
): Readonly<Record<AutosomeId, readonly T[]>> {
  const groups = Object.fromEntries(AUTOSOME_IDS.map((id) => [id, [] as T[]])) as Record<AutosomeId, T[]>;
  for (const locus of loci) groups[locus.chromosome].push(locus);
  return Object.freeze(groups);
}

export const QUANT_LOCI_BY_CHROMOSOME: Readonly<Record<AutosomeId, readonly QuantLocus[]>> = groupBy(QUANT_LOCI);

/**
 * Discrete loci that founder construction seeds and meiosis mutates — i.e.
 * everything except the clade macro-loci, which start ancestral 0/0 and change
 * only through their own per-birth macro-mutation roll.
 */
export const NON_MACRO_DISCRETE_BY_CHROMOSOME: Readonly<Record<AutosomeId, readonly DiscreteLocus[]>> = groupBy(
  DISCRETE_LOCI.filter((locus) => locus.kind !== 'cladeMacro'),
);
