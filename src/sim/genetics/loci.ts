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
import { AUTOSOME_IDS, DISCRETE_LOCI, FOUNDER_FIXED_DISCRETE_KINDS, QUANT_LOCI } from '../../contracts/genome';

function groupBy<T extends { readonly chromosome: AutosomeId }>(
  loci: readonly T[],
): Readonly<Record<AutosomeId, readonly T[]>> {
  const groups = Object.fromEntries(AUTOSOME_IDS.map((id) => [id, [] as T[]])) as Record<AutosomeId, T[]>;
  for (const locus of loci) groups[locus.chromosome].push(locus);
  return Object.freeze(groups);
}

export const QUANT_LOCI_BY_CHROMOSOME: Readonly<Record<AutosomeId, readonly QuantLocus[]>> = groupBy(QUANT_LOCI);

/**
 * Discrete loci founder construction draws uniformly — everything except the
 * `FOUNDER_FIXED_DISCRETE_KINDS`, which start homozygous-ancestral (clade
 * macros gate the radiation; the G-wave strategy macros must be ≈0 at the
 * founding operating point).
 */
export const FOUNDER_SEEDED_DISCRETE_BY_CHROMOSOME: Readonly<Record<AutosomeId, readonly DiscreteLocus[]>> = groupBy(
  DISCRETE_LOCI.filter((locus) => !FOUNDER_FIXED_DISCRETE_KINDS.includes(locus.kind)),
);

/**
 * Discrete loci meiosis mutates by neighbour steps at `discreteMutationRate` —
 * everything except `cladeMacro`, which has its own per-birth roll. The
 * founder-fixed strategy macros ARE here: mutation is how their alternative
 * alleles get discovered.
 */
export const STEP_MUTABLE_DISCRETE_BY_CHROMOSOME: Readonly<Record<AutosomeId, readonly DiscreteLocus[]>> = groupBy(
  DISCRETE_LOCI.filter((locus) => locus.kind !== 'cladeMacro'),
);
