/**
 * Meiosis and mutation: one gamete from each parent, plus new material.
 *
 * ## Recombination
 *
 * Every chromosome is exactly 1 Morgan (`MAP_LENGTH_CM` = 100 cM), so the
 * crossover count is Poisson(1.0) and the positions are uniform on the map.
 * Those two statements together are what make map distance readable straight
 * off `positionCm`: by Poisson thinning, crossovers in an interval of length
 * `d` are Poisson(d/100) independently of the rest of the chromosome, so the
 * recombination fraction is exactly Haldane's `r = (1 − e^(−2d/100))/2`. The
 * recombination probe asserts that against the authored map, which is a real
 * test of the walk rather than a restatement of it.
 *
 * Chromosomes assort freely (each gets its own starting haplotype coin flip),
 * and the sex pair passes intact — Phase A puts no loci on it.
 *
 * ## Mutation — the anti-ceiling engine
 *
 * Quantitative effects are a **90% N(0, σ_m²) / 10% Laplace(0, 2.5·σ_m)
 * mixture**. The Laplace component is the whole point: a pure Gaussian kernel
 * makes large-effect alleles exponentially rare, the population converges on
 * the local optimum, and evolution stops looking like anything (gladiator-
 * genetics, herdloom). A fat tail keeps handing the population material it has
 * never seen, so the response to a moving optimum never runs out.
 *
 * The number of mutated loci per gamete is drawn as Poisson(nLoci · μ) and the
 * loci are then chosen uniformly, rather than rolling `chance(μ)` 48 times for
 * an expected 0.048 events. That is the standard Poisson mutation model and it
 * is the same distribution to within `O(μ²)`; it also keeps a birth at a
 * handful of RNG draws instead of a hundred.
 *
 * Discrete loci take **neighbour steps on a circle**, `±1 mod k`. Wrapping
 * rather than reflecting matters for the four k=8 neutral markers: a reflecting
 * boundary would deplete the end alleles and bias exactly the Fst and
 * temporal-Ne estimates those markers exist to provide.
 *
 * ## Stream layout (G0)
 *
 * `makeOffspringGenome` consumes the caller's stream **exactly once per
 * offspring** (a salt draw that keeps successive offspring distinct). Each
 * (gamete, chromosome) pair then gets its own fork carrying that chromosome's
 * assortment coin, crossover draws and mutation draws, and the karyotype +
 * clade macro roll live on a `meiosis:misc` fork. Consequences, pinned by
 * `g0-streams.test.ts`:
 *
 * - appending a chromosome adds a fork and cannot shift the existing
 *   chromosomes' recombination or mutation, nor the caller's stream — the
 *   genome is growable without re-running history;
 * - mutation lambda is per-chromosome (`lociOnChromosome · μ`), which sums to
 *   the same Poisson(nLoci · μ) total the global draw had;
 * - `enableMutation` off simply truncates each chromosome stream after the
 *   recombination draws, so the toggle is shape-preserving.
 *
 * ## Clade macro-mutation
 *
 * Rolled once per birth at `cladeMacroMutationRate`. When it changes the
 * expressed archetype, the loci that build the three morphology channels are
 * **re-seeded onto the new body plan's schema** — fresh founder-scale draws,
 * then a minimum-norm shift onto the archetype's `typical` values that holds
 * every other trait those loci touch exactly where it was. Without the re-seed
 * a new radial drifter would be born with an undulator's proportions and simply
 * die, and the clade radiation this project is built to show would never
 * happen; without the hold, the body plan's cost would come from a pleiotropy
 * accident rather than from the `traitBaselineShift` the schema authored.
 */

import type { AutosomeId, CladeArchetype, Genome, HaplotypeIndex, Karyotype } from '../../contracts/genome';
import {
  AUTOSOME_IDS,
  CHROMOSOMES,
  CLADE_MACRO_LOCI,
  CLADE_SCHEMA,
  DISCRETE_GENOME_LENGTH,
  DISCRETE_LOCUS_COUNT,
  QUANT_GENOME_LENGTH,
  QUANT_LOCI,
  QUANT_LOCUS_COUNT,
  W_ROWS_BY_TRAIT,
  discreteAlleleIndex,
  expressedCladeArchetype,
  quantAlleleIndex,
} from '../../contracts/genome';
import type { MeiosisResult } from '../../contracts/apis';
import type { MutationRecord } from '../../contracts/events';
import type { TraitKey } from '../../contracts/traits';
import { TRAIT_KEYS, TRAIT_META, invertTraitLink } from '../../contracts/traits';
import type { RandomSource, SimConfig } from '../../contracts/types';
import { resolveBaseline } from './phenotype';
import { NON_MACRO_DISCRETE_BY_CHROMOSOME, QUANT_LOCI_BY_CHROMOSOME } from './loci';

/** The three trait channels `CladeSchema` gives a per-archetype `typical` for. */
const MORPHOLOGY_CHANNELS = ['segmentCount', 'finPairs', 'bodyAspect'] as const;
type MorphologyChannelKey = (typeof MORPHOLOGY_CHANNELS)[number];

/** Union of the loci feeding those channels — what a clade founding re-seeds. */
const MORPHOLOGY_LOCUS_INDICES: readonly number[] = [
  ...new Set(MORPHOLOGY_CHANNELS.flatMap((key) => W_ROWS_BY_TRAIT[key].map((row) => row.locusIndex))),
].sort((a, b) => a - b);

/**
 * One linear constraint on the re-seeded loci. `channelKey` set means "pull
 * this trait to the archetype's typical"; absent means "hold this trait where
 * it was" — see {@link reseedMorphology}.
 */
interface ReseedRow {
  readonly key: TraitKey;
  readonly channelKey: MorphologyChannelKey | undefined;
  readonly entries: readonly { readonly locusIndex: number; readonly weight: number }[];
  readonly squaredNorm: number;
}

const MORPHOLOGY_LOCUS_SET = new Set(MORPHOLOGY_LOCUS_INDICES);

const RESEED_ROWS: readonly ReseedRow[] = TRAIT_KEYS.map((key): ReseedRow => {
  const entries = W_ROWS_BY_TRAIT[key].filter((row) => MORPHOLOGY_LOCUS_SET.has(row.locusIndex));
  return {
    key,
    channelKey: MORPHOLOGY_CHANNELS.find((candidate) => candidate === key),
    entries,
    squaredNorm: entries.reduce((total, row) => total + row.weight * row.weight, 0),
  };
}).filter((row) => row.entries.length > 0);

/** Kaczmarz sweeps are cheap and this runs ~once per 10⁵ births; converges in a handful. */
const RESEED_MAX_SWEEPS = 24;
const RESEED_TOLERANCE = 1e-4;

/** Scratch for one meiosis worker: crossover positions, the mutation log, re-seed targets. */
export interface MeiosisScratch {
  readonly crossovers: number[];
  readonly mutations: MutationRecord[];
  readonly morphologyTargets: Float64Array;
}

export function createMeiosisScratch(): MeiosisScratch {
  return {
    crossovers: [],
    mutations: [],
    morphologyTargets: new Float64Array(RESEED_ROWS.length),
  };
}

function ascending(a: number, b: number): number {
  return a - b;
}

/**
 * One gamete, written into `quant`/`discrete` at the target haplotype's offset.
 *
 * Each chromosome runs on its own fork of `rng` (G0): the assortment coin and
 * crossover draws come first, then — when mutation is on — that chromosome's
 * mutation draws on the same stream. Loci are walked in ascending map order,
 * flipping the source haplotype at every crossover passed.
 */
function buildGamete(
  rng: RandomSource,
  parent: Genome,
  quant: Float32Array,
  discrete: Uint8Array,
  target: HaplotypeIndex,
  crossovers: number[],
  mutations: MutationRecord[],
  config: SimConfig,
): void {
  const quantOffset = target * QUANT_LOCUS_COUNT;
  const discreteOffset = target * DISCRETE_LOCUS_COUNT;
  const mutate = config.toggles.enableMutation;

  for (const chromosome of AUTOSOME_IDS as readonly AutosomeId[]) {
    const chrRng = rng.fork(`gamete:${target}:${chromosome}`);
    const map = CHROMOSOMES[chromosome];
    const crossoverCount = chrRng.poisson(config.genetics.crossoverLambda);

    crossovers.length = 0;
    for (let index = 0; index < crossoverCount; index += 1) crossovers.push(chrRng.next() * map.lengthCm);
    crossovers.sort(ascending);

    let source: HaplotypeIndex = chrRng.chance(0.5) ? 1 : 0;
    let nextCrossover = 0;

    for (const ref of map.loci) {
      while (nextCrossover < crossovers.length && (crossovers[nextCrossover] ?? Infinity) <= ref.positionCm) {
        source = source === 0 ? 1 : 0;
        nextCrossover += 1;
      }
      if (ref.kind === 'quant') {
        quant[quantOffset + ref.index] = parent.quant[quantAlleleIndex(source, ref.index)] ?? 0;
      } else {
        discrete[discreteOffset + ref.index] = parent.discrete[discreteAlleleIndex(source, ref.index)] ?? 0;
      }
    }

    if (mutate) mutateChromosome(chrRng, chromosome, quant, discrete, target, mutations, config);
  }
}

/**
 * Mutation on one chromosome of one finished gamete. The per-chromosome
 * Poisson lambdas sum to the same total the old global draw had, and choosing
 * the locus uniformly *within* the chromosome preserves the uniform choice
 * overall by Poisson thinning.
 */
function mutateChromosome(
  rng: RandomSource,
  chromosome: AutosomeId,
  quant: Float32Array,
  discrete: Uint8Array,
  target: HaplotypeIndex,
  mutations: MutationRecord[],
  config: SimConfig,
): void {
  const genetics = config.genetics;
  const quantOffset = target * QUANT_LOCUS_COUNT;
  const discreteOffset = target * DISCRETE_LOCUS_COUNT;
  const quantLoci = QUANT_LOCI_BY_CHROMOSOME[chromosome];
  const discreteLoci = NON_MACRO_DISCRETE_BY_CHROMOSOME[chromosome];

  const quantCount = rng.poisson(quantLoci.length * genetics.quantMutationRate);
  for (let index = 0; index < quantCount; index += 1) {
    const locus = quantLoci[rng.int(0, quantLoci.length - 1)];
    if (locus === undefined) continue;
    const sigma = locus.mutSigma * genetics.mutationSigmaScale;
    const fatTail = rng.chance(genetics.mutationFatTailFraction);
    const delta = fatTail ? rng.laplace(0, sigma * genetics.mutationFatTailScaleRatio) : rng.normal(0, sigma);
    const slot = quantOffset + locus.index;
    quant[slot] = (quant[slot] ?? 0) + delta;
    mutations.push({ locus: locus.id, delta, fatTail });
  }

  const discreteCount = rng.poisson(discreteLoci.length * genetics.discreteMutationRate);
  for (let index = 0; index < discreteCount; index += 1) {
    const locus = discreteLoci[rng.int(0, discreteLoci.length - 1)];
    if (locus === undefined) continue;
    const slot = discreteOffset + locus.index;
    const step = rng.chance(0.5) ? 1 : locus.alleleCount - 1;
    const allele = ((discrete[slot] ?? 0) + step) % locus.alleleCount;
    discrete[slot] = allele;
    mutations.push({ locus: locus.id, delta: allele, fatTail: false });
  }
}

/** Genotypic value of one re-seed row, i.e. the row's loci only. */
function rowValue(quant: Float32Array, row: ReseedRow): number {
  let value = 0;
  for (const entry of row.entries) {
    value +=
      entry.weight * ((quant[entry.locusIndex] ?? 0) + (quant[QUANT_LOCUS_COUNT + entry.locusIndex] ?? 0));
  }
  return value;
}

/**
 * Move the morphology loci onto `archetype`'s schema, and nothing else with
 * them.
 *
 * Fresh founder-scale draws supply the new clade's variation; a cycled
 * projection (Kaczmarz) then adds the minimum-norm shift that satisfies every
 * `RESEED_ROWS` constraint at once. Two kinds of constraint, and both matter:
 *
 * - the three morphology channels are pulled to the archetype's `typical`. They
 *   share loci (q45 feeds `segmentCount` **and** `bodyAspect`, q48 feeds
 *   `finPairs` **and** `bodyAspect`), so solving them one at a time and
 *   stopping would leave the last one right and the earlier ones wrong.
 * - every other trait those loci touch is **held where it already was**. q47
 *   loads `speedCap` alongside `finPairs`; without the hold row, giving a
 *   radial drifter its zero fins also quietly halves its top speed, and the
 *   body plan's cost would come from a pleiotropy accident rather than from the
 *   authored `traitBaselineShift` that A7 tunes.
 */
function reseedMorphology(
  genome: Genome,
  archetype: CladeArchetype,
  rng: RandomSource,
  config: SimConfig,
  targets: Float64Array,
): void {
  const schema = CLADE_SCHEMA[archetype];
  const { quant } = genome;

  for (let index = 0; index < RESEED_ROWS.length; index += 1) {
    const row = RESEED_ROWS[index];
    if (row === undefined) continue;
    if (row.channelKey === undefined) {
      targets[index] = rowValue(quant, row);
      continue;
    }
    // `inverseSoftplus` returns its underflow sentinel (−40·s) at an expressed
    // value of zero, and a radial drifter's `finPairs` typical *is* zero. Aiming
    // at the bend instead of the floor keeps the target a real latent value:
    // asking for exactly 0 fins would demand a ~60 SD genotypic value.
    const reachable = Math.max(schema[row.channelKey].typical, TRAIT_META[row.key].linkScale);
    targets[index] =
      invertTraitLink(row.key, reachable) - resolveBaseline(row.key, config) - (schema.traitBaselineShift[row.key] ?? 0);
  }

  for (const locusIndex of MORPHOLOGY_LOCUS_INDICES) {
    const locus = QUANT_LOCI[locusIndex];
    if (locus === undefined) continue;
    const sd = locus.founderSd * config.genetics.founderSdScale;
    quant[quantAlleleIndex(0, locusIndex)] = rng.normal(0, sd);
    quant[quantAlleleIndex(1, locusIndex)] = rng.normal(0, sd);
  }

  for (let sweep = 0; sweep < RESEED_MAX_SWEEPS; sweep += 1) {
    let worstResidual = 0;
    for (let index = 0; index < RESEED_ROWS.length; index += 1) {
      const row = RESEED_ROWS[index];
      if (row === undefined || row.squaredNorm === 0) continue;
      const residual = (targets[index] ?? 0) - rowValue(quant, row);
      worstResidual = Math.max(worstResidual, Math.abs(residual));
      // Both copies move by `shift`, so the row moves by 2·Σw²·step = residual.
      const step = residual / (2 * row.squaredNorm);
      for (const entry of row.entries) {
        const shift = step * entry.weight;
        const maternal = quantAlleleIndex(0, entry.locusIndex);
        const paternal = quantAlleleIndex(1, entry.locusIndex);
        quant[maternal] = (quant[maternal] ?? 0) + shift;
        quant[paternal] = (quant[paternal] ?? 0) + shift;
      }
    }
    if (worstResidual < RESEED_TOLERANCE) break;
  }
}

/** Rolled once per birth. Returns true when a macro-locus allele actually changed. */
function tryCladeMacroMutation(
  rng: RandomSource,
  genome: Genome,
  mutations: MutationRecord[],
  config: SimConfig,
  targets: Float64Array,
): boolean {
  if (!rng.chance(config.genetics.cladeMacroMutationRate)) return false;

  const locus = CLADE_MACRO_LOCI[rng.int(0, CLADE_MACRO_LOCI.length - 1)];
  if (locus === undefined) return false;

  const before = expressedCladeArchetype(genome);
  const haplotype: HaplotypeIndex = rng.chance(0.5) ? 1 : 0;
  const slot = discreteAlleleIndex(haplotype, locus.index);
  // A macro-mutation is a jump, not a neighbour step: any of the other alleles.
  const allele = ((genome.discrete[slot] ?? 0) + rng.int(1, locus.alleleCount - 1)) % locus.alleleCount;
  genome.discrete[slot] = allele;
  mutations.push({ locus: locus.id, delta: allele, fatTail: false });

  const after = expressedCladeArchetype(genome);
  if (after !== before) reseedMorphology(genome, after, rng, config, targets);
  return true;
}

/**
 * Meiosis in both parents plus mutation, in one step.
 *
 * The returned `mutations` array is scratch owned by the caller's
 * `MeiosisScratch` and is emptied by the next call — the contract says copy if
 * you retain it. The genome itself is freshly allocated and immutable from the
 * moment this returns.
 */
export function makeOffspringGenome(
  scratch: MeiosisScratch,
  rng: RandomSource,
  mother: Genome,
  father: Genome,
  config: SimConfig,
): MeiosisResult {
  const { crossovers, mutations, morphologyTargets } = scratch;
  mutations.length = 0;

  // One parent draw per offspring (G0): successive offspring get distinct
  // forks, and the caller's stream consumption is independent of genome size.
  rng.next();

  const quant = new Float32Array(QUANT_GENOME_LENGTH);
  const discrete = new Uint8Array(DISCRETE_GENOME_LENGTH);
  const mutate = config.toggles.enableMutation;

  buildGamete(rng, mother, quant, discrete, 0, crossovers, mutations, config);
  buildGamete(rng, father, quant, discrete, 1, crossovers, mutations, config);

  const misc = rng.fork('meiosis:misc');
  // The coin is drawn unconditionally so the misc stream's shape does not
  // depend on the father's karyotype; an XX "father" still cannot contribute
  // a Y, whatever the coin says.
  const coin = misc.chance(0.5);
  const karyotype: Karyotype = father.karyotype === 'XY' && coin ? 'XY' : 'XX';
  const genome: Genome = { quant, discrete, karyotype };

  const macroMutated = mutate && tryCladeMacroMutation(misc, genome, mutations, config, morphologyTargets);

  return { genome, mutations, macroMutated };
}
