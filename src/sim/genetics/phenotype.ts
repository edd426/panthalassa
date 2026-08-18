/**
 * Genotype → phenotype, computed **once at birth**.
 *
 * ```
 *   genotypic_k = Σ_l w_kl·(a_mat + a_pat)  +  Σ_d discreteEffect_dk
 *   gxeShift_k  = (gxeMask_k && enableSpatialGxE) ? gxeSensitivity·z : 0
 *   latent_k    = baseline_k + cladeShift_k + genotypic_k + gxeShift_k + e_k
 *   expressed_k = applyTraitLink(k, latent_k)
 * ```
 *
 * Four things here are load-bearing and easy to get subtly wrong:
 *
 * 1. **The environmental deviation is derived, not authored.** `e_k` is drawn
 *    once, at birth, from `N(0, σ_e)` with
 *    `σ_e = sqrt(Vg · (1 − h²)/h²) · environmentDeviationScale`, where `Vg` is
 *    the analytic founder genetic variance of the trait — quantitative *and*
 *    discrete-locus effect variance, since v1.3. Authoring per-trait
 *    environment SDs would silently break the h² target the moment A7 retunes
 *    `founderSdScale`; deriving it keeps `targetFounderHeritability` honest.
 *
 * 2. **GxE is an additive expression shift, never a multiply of the genotypic
 *    value.** A GxE-masked trait's latent value moves by `gxeSensitivity·z`
 *    latent units and its stored genotypic value does not move at all. The
 *    multiplicative `G · (1 + s·z)` this file used to carry was Gate A-1
 *    defect 1: it made genetic variance a function of where an organism
 *    happened to be born and, because the scaled value was what got stored,
 *    it contaminated every V_A the recorder reported. True reaction-norm
 *    slope loci — genotypes that differ in how steeply they respond — are
 *    roadmap, not v1; until then the whole population shares one slope.
 *
 * 3. **Latent and expressed are both kept.** Selection and every popgen
 *    estimator read the unbounded latent scale; only the ecology reads the
 *    linked value. Applying the link twice, or storing only the expressed
 *    value, would let a softplus floor masquerade as lost additive variance.
 *
 * 4. **No clamping.** The only bounding anywhere in this file is
 *    `applyTraitLink`, and the links are strictly increasing.
 */

import type { ActiveGates, CladeArchetype, DiscreteEffectsByLocus, Genome, WRowsByTrait } from '../../contracts/genome';
import {
  CLADE_SCHEMA,
  DISCRETE_EFFECTS_BY_LOCUS,
  DISCRETE_LOCI,
  DISCRETE_LOCUS_COUNT,
  QUANT_LOCUS_COUNT,
  W_ROWS_BY_TRAIT,
  activeDiscreteEffectsByLocus,
  activeWRowsByTrait,
  expressedCladeArchetype,
  founderGeneticVariance,
} from '../../contracts/genome';
import type { PhenotypeContext, PhenotypeResult } from '../../contracts/apis';
import type { TraitKey } from '../../contracts/traits';
import { TRAIT_COUNT, TRAIT_INDEX, TRAIT_KEYS, TRAIT_META, applyTraitLink } from '../../contracts/traits';
import type { RandomSource, SimConfig } from '../../contracts/types';

/**
 * Scratch buffers for one phenotype computer. The contract lets
 * `computePhenotype` hand back views the next call invalidates, and the engine
 * copies straight into the pool columns, so a birth allocates nothing.
 */
export interface PhenotypeScratch {
  readonly traits: Float32Array;
  readonly traitsLatent: Float32Array;
  readonly genotypicValues: Float32Array;
  /** Float64 accumulator: the Float32 output column would round mid-computation. */
  readonly genotypicScratch: Float64Array;
}

export function createPhenotypeScratch(): PhenotypeScratch {
  return {
    traits: new Float32Array(TRAIT_COUNT),
    traitsLatent: new Float32Array(TRAIT_COUNT),
    genotypicValues: new Float32Array(TRAIT_COUNT),
    genotypicScratch: new Float64Array(TRAIT_COUNT),
  };
}

/** Per-config constants, derived once and cached against the (frozen) config object. */
interface DerivedConstants {
  readonly baselines: Float64Array;
  readonly environmentSds: Float64Array;
  /** 1 where the trait is subject to spatial GxE. */
  readonly gxeMask: Uint8Array;
  /** Gate-filtered W and discrete-effect views (the dark-chromosome rule). */
  readonly wRows: WRowsByTrait;
  readonly discreteEffects: DiscreteEffectsByLocus;
}

const DERIVED_CACHE = new WeakMap<SimConfig, DerivedConstants>();

/** `TRAIT_META[key].baseline`, retuned by `genetics.traitBaselineOverrides`. */
export function resolveBaseline(key: TraitKey, config: SimConfig): number {
  return config.genetics.traitBaselineOverrides[key] ?? TRAIT_META[key].baseline;
}

function derive(config: SimConfig): DerivedConstants {
  const cached = DERIVED_CACHE.get(config);
  if (cached !== undefined) return cached;

  const { targetFounderHeritability, environmentDeviationScale, founderSdScale, gxeTraits } = config.genetics;
  // Dark-chromosome rule: with a wave's toggle off, its loci contribute
  // neither genotypic value nor founder variance, so the off-arm's
  // environmental SDs — and therefore its every deviation draw — match the
  // pre-wave world exactly.
  const gates: ActiveGates = {
    ontogeny: config.toggles.enableOntogeny,
    aposematism: config.toggles.enableAposematism,
    sexualSelection: config.toggles.enableSexualSelection,
  };
  // Domain guard on the tuning surface, not a trait bound: h² = 0 asks for an
  // infinite environmental deviation and h² > 1 for an imaginary one.
  const heritability = Math.min(1, Math.max(1e-6, targetFounderHeritability));

  const baselines = new Float64Array(TRAIT_COUNT);
  const environmentSds = new Float64Array(TRAIT_COUNT);
  const gxeMask = new Uint8Array(TRAIT_COUNT);

  for (let index = 0; index < TRAIT_COUNT; index += 1) {
    const key = TRAIT_KEYS[index] as TraitKey;
    baselines[index] = resolveBaseline(key, config);
    // v1.3: this analytic now folds in discrete-locus effect variance, which is
    // what makes the h² target hold for hue and preference (Gate A-1 defect 2).
    const geneticVariance = founderGeneticVariance(key, founderSdScale, gates);
    environmentSds[index] =
      Math.sqrt((geneticVariance * (1 - heritability)) / heritability) * environmentDeviationScale;
  }
  for (const key of gxeTraits) gxeMask[TRAIT_INDEX[key]] = 1;

  const derived: DerivedConstants = {
    baselines,
    environmentSds,
    gxeMask,
    wRows: activeWRowsByTrait(gates),
    discreteEffects: activeDiscreteEffectsByLocus(gates),
  };
  DERIVED_CACHE.set(config, derived);
  return derived;
}

/**
 * Genotypic value of every trait, into `out`, **without** GxE, baseline, clade
 * shift or environmental deviation. Shared with the clade re-seeding step in
 * `meiosis.ts`, which has to know what a genome currently expresses before it
 * can shift it onto a new body plan's schema.
 */
export function accumulateGenotypicValues(
  genome: Genome,
  out: Float64Array,
  wRows: WRowsByTrait = W_ROWS_BY_TRAIT,
  effectsByLocus: DiscreteEffectsByLocus = DISCRETE_EFFECTS_BY_LOCUS,
): void {
  const { quant, discrete } = genome;

  for (let index = 0; index < TRAIT_COUNT; index += 1) {
    const key = TRAIT_KEYS[index] as TraitKey;
    let value = 0;
    for (const row of wRows[key]) {
      const maternal = quant[row.locusIndex] ?? 0;
      const paternal = quant[QUANT_LOCUS_COUNT + row.locusIndex] ?? 0;
      value += row.weight * (maternal + paternal);
    }
    out[index] = value;
  }

  // Discrete alleles are additive at half weight per copy, so a heterozygote
  // sits midway and a homozygote gets the full authored delta.
  for (const locus of DISCRETE_LOCI) {
    const effects = effectsByLocus[locus.id];
    if (effects.length === 0) continue;
    const maternal = discrete[locus.index] ?? 0;
    const paternal = discrete[DISCRETE_LOCUS_COUNT + locus.index] ?? 0;
    for (const effect of effects) {
      let copies = 0;
      if (effect.allele === maternal) copies += 1;
      if (effect.allele === paternal) copies += 1;
      if (copies === 0) continue;
      const index = TRAIT_INDEX[effect.trait];
      out[index] = (out[index] ?? 0) + (effect.delta * copies) / 2;
    }
  }
}

export function computePhenotype(
  scratch: PhenotypeScratch,
  genome: Genome,
  rng: RandomSource,
  config: SimConfig,
  context: PhenotypeContext,
): PhenotypeResult {
  const { baselines, environmentSds, gxeMask } = derive(config);
  const { traits, traitsLatent, genotypicValues, genotypicScratch } = scratch;

  const archetype: CladeArchetype = expressedCladeArchetype(genome);
  const { traitBaselineShift } = CLADE_SCHEMA[archetype];

  // The engine passes z = 0 when the mechanism is off; the toggle is honoured
  // here too so a probe cannot accidentally leave GxE running by forgetting to.
  const gxeShift = config.toggles.enableSpatialGxE
    ? config.genetics.gxeSensitivity * context.localTemperatureAnomalyZ
    : 0;

  // G0: one parent draw per birth (keeps successive births distinct), then the
  // environmental deviations come from a private fork drawn in trait-key
  // order. Appending a trait appends draws to this stream that nothing else
  // reads, so growing the trait table cannot shift any other consumer.
  rng.next();
  const deviationRng = rng.fork('envDeviation');

  accumulateGenotypicValues(genome, genotypicScratch, derive(config).wRows, derive(config).discreteEffects);

  for (let index = 0; index < TRAIT_COUNT; index += 1) {
    const key = TRAIT_KEYS[index] as TraitKey;
    const genotypic = genotypicScratch[index] ?? 0;
    // One draw per trait per birth, unconditionally, so that the stream does
    // not shift when a trait's environmental SD happens to be zero.
    const deviation = deviationRng.normal(0, environmentSds[index] ?? 0);
    const latent =
      (baselines[index] ?? 0) +
      (traitBaselineShift[key] ?? 0) +
      genotypic +
      (gxeMask[index] === 1 ? gxeShift : 0) +
      deviation;

    // Raw, environment excluded: this is what A4 separates V_A from V_E with.
    genotypicValues[index] = genotypic;
    traitsLatent[index] = latent;
    traits[index] = applyTraitLink(key, latent);
  }

  return { traits, traitsLatent, genotypicValues, archetype };
}
