/**
 * WP-A1: the genetics package, assembled behind `GeneticsApi`.
 *
 * The engine only ever sees this interface — `src/sim/engine.ts` must not name
 * `../genetics/meiosis` — so the module seam in `contracts/apis.ts` stays the
 * single point of contact. `createGenetics()` owns the scratch buffers that
 * keep a birth allocation-light; call it once per sim rather than sharing the
 * convenience singleton between two concurrently-stepping sims.
 */

import type { GeneticsApi, MeiosisResult, PhenotypeContext, PhenotypeResult } from '../../contracts/apis';
import type { Genome } from '../../contracts/genome';
import type { RandomSource, SimConfig } from '../../contracts/types';

import { buildFounderGenome } from './founders';
import { createMeiosisScratch, makeOffspringGenome } from './meiosis';
import { createPhenotypeScratch, computePhenotype } from './phenotype';
import { applyAlleleEdit } from './alleleEdit';

export function createGenetics(): GeneticsApi {
  const meiosisScratch = createMeiosisScratch();
  const phenotypeScratch = createPhenotypeScratch();

  return {
    buildFounderGenome,
    applyAlleleEdit,

    makeOffspringGenome(rng: RandomSource, mother: Genome, father: Genome, config: SimConfig): MeiosisResult {
      return makeOffspringGenome(meiosisScratch, rng, mother, father, config);
    },

    computePhenotype(
      genome: Genome,
      rng: RandomSource,
      config: SimConfig,
      context: PhenotypeContext,
    ): PhenotypeResult {
      return computePhenotype(phenotypeScratch, genome, rng, config, context);
    },
  };
}

/** Convenience instance for single-sim callers. Its scratch buffers are shared. */
export const genetics: GeneticsApi = createGenetics();

export { buildFounderGenome, cloneGenome } from './founders';
export { makeOffspringGenome, createMeiosisScratch } from './meiosis';
export type { MeiosisScratch } from './meiosis';
export { computePhenotype, createPhenotypeScratch, accumulateGenotypicValues, resolveBaseline } from './phenotype';
export type { PhenotypeScratch } from './phenotype';
export { applyAlleleEdit } from './alleleEdit';
