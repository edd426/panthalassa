/**
 * G0 stream contracts.
 *
 * The property that makes the genome growable: every function that creates
 * genome material consumes its caller's stream **exactly once** (a salt draw),
 * with all size-dependent draws on private forks. These tests pin the exact
 * parent consumption, so any edit that re-couples parent-stream position to
 * genome size — the thing G0 exists to prevent — fails here rather than at the
 * next golden-hash surprise.
 */

import { describe, expect, it } from 'vitest';

import type { PhenotypeContext } from '../../contracts/apis';
import { resolveSimConfig } from '../../contracts/types';
import { SeededRng } from '../rng';
import { buildFounderGenome } from './founders';
import { createMeiosisScratch, makeOffspringGenome } from './meiosis';
import { computePhenotype, createPhenotypeScratch } from './phenotype';

const CONFIG = resolveSimConfig();
const CONTEXT: PhenotypeContext = { localTemperatureAnomalyZ: 0, parentArchetype: 'undulator' };

/** State a twin stream reaches after exactly `draws` next() calls. */
function stateAfterDraws(seed: string, draws: number): readonly number[] {
  const twin = new SeededRng(seed);
  for (let i = 0; i < draws; i += 1) twin.next();
  return twin.getState();
}

describe('G0 parent-stream consumption', () => {
  it('buildFounderGenome consumes exactly one parent draw, with or without a sex argument', () => {
    for (const sex of ['female', undefined] as const) {
      const rng = new SeededRng('g0-founder');
      buildFounderGenome(rng, CONFIG, sex);
      expect(rng.getState()).toEqual(stateAfterDraws('g0-founder', 1));
    }
  });

  it('the sex argument does not change the allele material a parent state produces', () => {
    const sexed = buildFounderGenome(new SeededRng('g0-material'), CONFIG, 'female');
    const coinFlipped = buildFounderGenome(new SeededRng('g0-material'), CONFIG);
    expect(Array.from(coinFlipped.quant)).toEqual(Array.from(sexed.quant));
    expect(Array.from(coinFlipped.discrete)).toEqual(Array.from(sexed.discrete));
  });

  it('successive founders from one stream are distinct but reproducible', () => {
    const rng = new SeededRng('g0-succession');
    const first = buildFounderGenome(rng, CONFIG);
    const second = buildFounderGenome(rng, CONFIG);
    expect(Array.from(second.quant)).not.toEqual(Array.from(first.quant));

    const replay = new SeededRng('g0-succession');
    expect(Array.from(buildFounderGenome(replay, CONFIG).quant)).toEqual(Array.from(first.quant));
    expect(Array.from(buildFounderGenome(replay, CONFIG).quant)).toEqual(Array.from(second.quant));
  });

  it('makeOffspringGenome consumes exactly one parent draw', () => {
    const mother = buildFounderGenome(new SeededRng('g0-mother'), CONFIG, 'female');
    const father = buildFounderGenome(new SeededRng('g0-father'), CONFIG, 'male');
    const scratch = createMeiosisScratch();
    const rng = new SeededRng('g0-meiosis');
    makeOffspringGenome(scratch, rng, mother, father, CONFIG);
    expect(rng.getState()).toEqual(stateAfterDraws('g0-meiosis', 1));
  });

  it('successive offspring from one stream are distinct but reproducible', () => {
    const mother = buildFounderGenome(new SeededRng('g0-mother'), CONFIG, 'female');
    const father = buildFounderGenome(new SeededRng('g0-father'), CONFIG, 'male');
    const scratch = createMeiosisScratch();

    const rng = new SeededRng('g0-clutch');
    const first = makeOffspringGenome(scratch, rng, mother, father, CONFIG);
    const firstQuant = Array.from(first.genome.quant);
    const second = makeOffspringGenome(scratch, rng, mother, father, CONFIG);
    expect(Array.from(second.genome.quant)).not.toEqual(firstQuant);

    const replay = new SeededRng('g0-clutch');
    expect(Array.from(makeOffspringGenome(scratch, replay, mother, father, CONFIG).genome.quant)).toEqual(
      firstQuant,
    );
  });

  it('computePhenotype consumes exactly one parent draw', () => {
    const genome = buildFounderGenome(new SeededRng('g0-pheno-genome'), CONFIG);
    const scratch = createPhenotypeScratch();
    const rng = new SeededRng('g0-pheno');
    computePhenotype(scratch, genome, rng, CONFIG, CONTEXT);
    expect(rng.getState()).toEqual(stateAfterDraws('g0-pheno', 1));
  });

  it('successive phenotype deviations from one stream are distinct but reproducible', () => {
    const genome = buildFounderGenome(new SeededRng('g0-pheno-genome'), CONFIG);
    const scratch = createPhenotypeScratch();

    const rng = new SeededRng('g0-pheno-succession');
    const first = Array.from(computePhenotype(scratch, genome, rng, CONFIG, CONTEXT).traitsLatent);
    const second = Array.from(computePhenotype(scratch, genome, rng, CONFIG, CONTEXT).traitsLatent);
    expect(second).not.toEqual(first);

    const replay = new SeededRng('g0-pheno-succession');
    expect(Array.from(computePhenotype(scratch, genome, replay, CONFIG, CONTEXT).traitsLatent)).toEqual(first);
  });
});
