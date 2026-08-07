/**
 * The genome — FROZEN CONTRACT (see CLAUDE.md).
 *
 * Diploid, four autosomes plus an XY pair. Each autosome carries 12
 * quantitative loci (real-valued alleles under a continuum-of-alleles model)
 * with 3 discrete loci interleaved among them, so linkage drags the discrete
 * markers along with selected quantitative variation — that coupling is what
 * makes neutral markers informative about drift and what lets a sweep be seen
 * as a hitchhiking event rather than a single-locus curiosity.
 *
 * ```
 *                48 quantitative        12 discrete
 *   A1  q01..q12 (body & power)         cladeMacroA, pigmentA, neutralA
 *   A2  q13..q24 (thermal & metabolism) cladeMacroB, pigmentB, neutralB
 *   A3  q25..q36 (trophic & conflict)   prefModA,    pigmentC, neutralC
 *   A4  q37..q48 (behaviour & display)  prefModB,    pigmentD, neutralD
 *   XY  sexDeterminer
 * ```
 *
 * Each chromosome is **100 cM = 1 Morgan long**, which is exactly why
 * recombination is Poisson(1.0) per chromosome: the crossover rate and the map
 * length are the same statement, so map distance can be read straight off
 * `positionCm` when checking recombination fractions.
 *
 * ## Design intent worth knowing before you implement against this
 *
 * - **No null allele.** Founder alleles are drawn from N(0, `founderSd`), the
 *   same family mutation feeds (`mutSigma` ≈ 0.75·`founderSd`). Herdloom
 *   collapsed because founders were mostly a zero-effect "Balanced" allele, so
 *   generation 0 had almost no standing variance to select on.
 * - **Antagonistic pleiotropy is authored, not emergent.** ~17 loci carry
 *   opposed signs on two traits that are each better when higher (armour vs
 *   speed, thermal breadth vs efficiency, attack vs defense). This is a
 *   receding ceiling built into the genotype→phenotype map, on top of the
 *   ecological cost tradeoffs.
 * - **Tight linkage clusters are deliberate.** q07/q08 (41.0/42.5 cM, the
 *   armour block) and q29/q30 (30.0/31.5 cM, the predation block) sit close
 *   enough to hitchhike, giving P10's sweep probe something to drag.
 * - **The magic trait.** q36 loads `diet`, `size` **and** `displayHue`, and
 *   q38 loads `displayHue` **and** `prefTarget`. Diet specialisation therefore
 *   drags the mating signal, and the signal is genetically correlated with the
 *   preference for it — the standard pleiotropic route to sympatric
 *   speciation, present from day one rather than hoped for.
 * - **Neutral markers are genuinely neutral.** The four k=8 marker loci appear
 *   in no effect table at all. The contract test enforces it; drift estimates
 *   (temporal Ne, Fst) are worthless if a "neutral" marker is under selection.
 */

import type { TraitKey } from './traits';
import { TRAIT_KEYS, TRAIT_META } from './traits';

// ---------------------------------------------------------------------------
// Chromosomes
// ---------------------------------------------------------------------------

export type AutosomeId = 'A1' | 'A2' | 'A3' | 'A4';

export const AUTOSOME_IDS = ['A1', 'A2', 'A3', 'A4'] as const satisfies readonly AutosomeId[];

/** Genetic length of every chromosome, cM. 100 cM = 1 Morgan = Poisson(1.0) crossovers. */
export const MAP_LENGTH_CM = 100;

/** Sex determination is XY: the father's gamete decides. */
export type Karyotype = 'XX' | 'XY';

/**
 * The sex-determining locus. Phase A puts **no** quantitative or discrete loci
 * on the sex pair: sex linkage is a real and interesting mechanism, but it
 * interacts with every estimator in `src/stats` (hemizygous males break the
 * diploid variance formulas), so it is deliberately deferred rather than
 * half-done. Left open for Phase B/C.
 */
export const SEX_LOCUS = Object.freeze({
  id: 'sexDeterminer',
  chromosome: 'XY',
  positionCm: 0,
  label: 'Sex determiner (XY)',
} as const);

// ---------------------------------------------------------------------------
// Quantitative loci
// ---------------------------------------------------------------------------

interface QuantLocusSpec {
  readonly id: string;
  readonly chromosome: AutosomeId;
  /** Map position on its chromosome, cM, in [0, MAP_LENGTH_CM]. */
  readonly positionCm: number;
  /** SD of the founder allele draw, in allele units. */
  readonly founderSd: number;
  readonly label: string;
  /** Sparse row of the pleiotropy matrix W: trait latent units per allele unit, per copy. */
  readonly loads: readonly (readonly [TraitKey, number])[];
}

/**
 * Mutation step SD as a fraction of the founder allele SD.
 *
 * Sized so a single mutation moves its trait by roughly a quarter of a
 * population SD (the plan's σ_m ≈ 0.25 trait-SD). With a trait loaded by n
 * loci, trait SD ≈ w·σ_founder·√(2n); a mutation shifts it by w·σ_mut, so
 * σ_mut ≈ 0.25·√(2n)·σ_founder ≈ 0.79·σ_founder at n = 5. Big enough that the
 * population keeps meeting genuinely new material — this ratio is the
 * anti-ceiling engine, and it is the first knob A7 should reach for.
 */
export const MUT_SIGMA_RATIO = 0.75;

const QUANT_LOCUS_SPECS = [
  // --- A1: body & power ---------------------------------------------------
  { id: 'q01', chromosome: 'A1', positionCm: 3, founderSd: 0.55, label: 'frame length', loads: [['size', 0.75]] },
  { id: 'q02', chromosome: 'A1', positionCm: 9, founderSd: 0.45, label: 'trunk mass', loads: [['size', 0.55], ['speedCap', -0.05]] },
  { id: 'q03', chromosome: 'A1', positionCm: 14, founderSd: 0.45, label: 'myotome density', loads: [['speedCap', 0.10], ['metabolicEff', -0.04]] },
  { id: 'q04', chromosome: 'A1', positionCm: 22, founderSd: 0.40, label: 'caudal leverage', loads: [['speedCap', 0.08], ['bodyAspect', 0.12]] },
  { id: 'q05', chromosome: 'A1', positionCm: 28, founderSd: 0.50, label: 'gill surface', loads: [['metabolicEff', 0.06], ['size', -0.30]] },
  { id: 'q06', chromosome: 'A1', positionCm: 34, founderSd: 0.45, label: 'dermal plating A', loads: [['armorPlating', 0.14], ['speedCap', -0.04]] },
  // q07/q08 are the tightly linked armour block (1.5 cM apart).
  { id: 'q07', chromosome: 'A1', positionCm: 41, founderSd: 0.40, label: 'dermal plating B', loads: [['armorPlating', 0.10], ['defense', 0.20]] },
  { id: 'q08', chromosome: 'A1', positionCm: 42.5, founderSd: 0.40, label: 'plate mineralisation', loads: [['armorPlating', 0.12], ['metabolicEff', -0.03]] },
  { id: 'q09', chromosome: 'A1', positionCm: 55, founderSd: 0.50, label: 'fusiform index', loads: [['bodyAspect', 0.22], ['defense', -0.18]] },
  { id: 'q10', chromosome: 'A1', positionCm: 63, founderSd: 0.45, label: 'growth rate', loads: [['size', 0.60], ['givingUpTime', -3.0]] },
  { id: 'q11', chromosome: 'A1', positionCm: 78, founderSd: 0.35, label: 'skeletal density', loads: [['size', 0.35], ['armorPlating', 0.08]] },
  { id: 'q12', chromosome: 'A1', positionCm: 92, founderSd: 0.45, label: 'muscle recruitment', loads: [['speedCap', 0.09], ['attack', 0.18]] },

  // --- A2: thermal & metabolism -------------------------------------------
  { id: 'q13', chromosome: 'A2', positionCm: 2, founderSd: 0.55, label: 'thermal setpoint A', loads: [['tOpt', 1.10]] },
  { id: 'q14', chromosome: 'A2', positionCm: 8, founderSd: 0.50, label: 'thermal setpoint B', loads: [['tOpt', 0.85], ['tWidth', -0.20]] },
  { id: 'q15', chromosome: 'A2', positionCm: 16, founderSd: 0.45, label: 'membrane fluidity', loads: [['tWidth', 0.40], ['metabolicEff', -0.05]] },
  { id: 'q16', chromosome: 'A2', positionCm: 21, founderSd: 0.45, label: 'chaperone load', loads: [['tWidth', 0.35], ['speedCap', -0.05]] },
  { id: 'q17', chromosome: 'A2', positionCm: 27, founderSd: 0.50, label: 'mitochondrial density', loads: [['metabolicEff', 0.07], ['tOpt', 0.45]] },
  { id: 'q18', chromosome: 'A2', positionCm: 33, founderSd: 0.40, label: 'enzyme kinetics', loads: [['metabolicEff', 0.05], ['tWidth', -0.25]] },
  { id: 'q19', chromosome: 'A2', positionCm: 39, founderSd: 0.45, label: 'cold tolerance', loads: [['tOpt', -0.90], ['tWidth', 0.20]] },
  { id: 'q20', chromosome: 'A2', positionCm: 46, founderSd: 0.35, label: 'osmoregulation', loads: [['metabolicEff', 0.04], ['wariness', 1.5]] },
  { id: 'q21', chromosome: 'A2', positionCm: 58, founderSd: 0.50, label: 'lipid reserve', loads: [['size', 0.40], ['metabolicEff', 0.04]] },
  { id: 'q22', chromosome: 'A2', positionCm: 67, founderSd: 0.45, label: 'basal turnover', loads: [['metabolicEff', -0.06], ['speedCap', 0.11]] },
  { id: 'q23', chromosome: 'A2', positionCm: 74, founderSd: 0.40, label: 'heat-shock response', loads: [['tWidth', 0.30], ['defense', -0.15]] },
  { id: 'q24', chromosome: 'A2', positionCm: 88, founderSd: 0.45, label: 'thermal drift', loads: [['tOpt', 0.70], ['displayHue', 12]] },

  // --- A3: trophic & conflict ---------------------------------------------
  { id: 'q25', chromosome: 'A3', positionCm: 5, founderSd: 0.55, label: 'gut length', loads: [['diet', -0.55], ['metabolicEff', 0.04]] },
  { id: 'q26', chromosome: 'A3', positionCm: 11, founderSd: 0.50, label: 'jaw gape', loads: [['diet', 0.50], ['attack', 0.30]] },
  { id: 'q27', chromosome: 'A3', positionCm: 17, founderSd: 0.45, label: 'dentition', loads: [['attack', 0.40], ['metabolicEff', -0.04]] },
  { id: 'q28', chromosome: 'A3', positionCm: 24, founderSd: 0.45, label: 'filter rakers', loads: [['diet', -0.60], ['forageBoldness', -0.25]] },
  // q29/q30 are the tightly linked predation block (1.5 cM apart).
  { id: 'q29', chromosome: 'A3', positionCm: 30, founderSd: 0.40, label: 'strike speed', loads: [['attack', 0.28], ['defense', -0.20]] },
  { id: 'q30', chromosome: 'A3', positionCm: 31.5, founderSd: 0.40, label: 'prey handling', loads: [['attack', 0.22], ['givingUpTime', 4.5]] },
  { id: 'q31', chromosome: 'A3', positionCm: 44, founderSd: 0.50, label: 'integument thickness', loads: [['defense', 0.42], ['speedCap', -0.05]] },
  { id: 'q32', chromosome: 'A3', positionCm: 51, founderSd: 0.45, label: 'spination', loads: [['defense', 0.35], ['forageBoldness', -0.30]] },
  { id: 'q33', chromosome: 'A3', positionCm: 60, founderSd: 0.45, label: 'escape reflex', loads: [['defense', 0.28], ['wariness', 2.5]] },
  { id: 'q34', chromosome: 'A3', positionCm: 69, founderSd: 0.40, label: 'risk appetite', loads: [['forageBoldness', 0.35], ['wariness', -2.2]] },
  { id: 'q35', chromosome: 'A3', positionCm: 80, founderSd: 0.45, label: 'search persistence', loads: [['givingUpTime', 5.0], ['diet', 0.30], ['metabolicEff', -0.03]] },
  // The magic trait: diet specialisation drags the mating signal with it.
  { id: 'q36', chromosome: 'A3', positionCm: 90, founderSd: 0.50, label: 'trophic specialisation', loads: [['diet', 0.55], ['size', 0.30], ['displayHue', 11]] },

  // --- A4: behaviour & display --------------------------------------------
  { id: 'q37', chromosome: 'A4', positionCm: 4, founderSd: 0.50, label: 'pigment cell density', loads: [['displayHue', 18], ['defense', -0.12]] },
  // The other half of the magic trait: signal and preference share a locus.
  { id: 'q38', chromosome: 'A4', positionCm: 10, founderSd: 0.45, label: 'iridophore tuning', loads: [['displayHue', 15], ['prefTarget', 9]] },
  { id: 'q39', chromosome: 'A4', positionCm: 19, founderSd: 0.50, label: 'preference locus A', loads: [['prefTarget', 16]] },
  { id: 'q40', chromosome: 'A4', positionCm: 25, founderSd: 0.45, label: 'preference locus B', loads: [['prefTarget', 13], ['choosiness', 0.10]] },
  { id: 'q41', chromosome: 'A4', positionCm: 29, founderSd: 0.40, label: 'mate discrimination', loads: [['choosiness', 0.14], ['forageBoldness', -0.22]] },
  { id: 'q42', chromosome: 'A4', positionCm: 36, founderSd: 0.45, label: 'courtship investment', loads: [['choosiness', 0.11], ['metabolicEff', -0.03]] },
  { id: 'q43', chromosome: 'A4', positionCm: 43, founderSd: 0.45, label: 'vigilance', loads: [['wariness', 3.2], ['forageBoldness', -0.28]] },
  { id: 'q44', chromosome: 'A4', positionCm: 50, founderSd: 0.40, label: 'boldness', loads: [['forageBoldness', 0.40], ['defense', -0.16]] },
  { id: 'q45', chromosome: 'A4', positionCm: 62, founderSd: 0.50, label: 'segment patterning', loads: [['segmentCount', 0.55], ['bodyAspect', 0.15]] },
  { id: 'q46', chromosome: 'A4', positionCm: 71, founderSd: 0.45, label: 'somite count modifier', loads: [['segmentCount', 0.45], ['speedCap', 0.05]] },
  { id: 'q47', chromosome: 'A4', positionCm: 83, founderSd: 0.45, label: 'fin bud number', loads: [['finPairs', 0.28], ['speedCap', 0.06]] },
  { id: 'q48', chromosome: 'A4', positionCm: 94, founderSd: 0.40, label: 'fin allometry', loads: [['finPairs', 0.22], ['bodyAspect', -0.14]] },
] as const satisfies readonly QuantLocusSpec[];

/** `'q01' | 'q02' | … | 'q48'`. */
export type QuantLocusId = (typeof QUANT_LOCUS_SPECS)[number]['id'];

export interface QuantLocus {
  readonly id: QuantLocusId;
  /** Index into the allele arrays, 0..47. This is the layout contract. */
  readonly index: number;
  readonly chromosome: AutosomeId;
  readonly positionCm: number;
  readonly founderSd: number;
  /** SD of the Gaussian component of a mutation step, allele units. */
  readonly mutSigma: number;
  readonly label: string;
}

export const QUANT_LOCI: readonly QuantLocus[] = Object.freeze(
  QUANT_LOCUS_SPECS.map((spec, index) => Object.freeze({
    id: spec.id,
    index,
    chromosome: spec.chromosome,
    positionCm: spec.positionCm,
    founderSd: spec.founderSd,
    mutSigma: spec.founderSd * MUT_SIGMA_RATIO,
    label: spec.label,
  })),
);

export const QUANT_LOCUS_COUNT = QUANT_LOCI.length;

export const QUANT_LOCUS_BY_ID: Readonly<Record<QuantLocusId, QuantLocus>> = Object.freeze(
  Object.fromEntries(QUANT_LOCI.map((locus) => [locus.id, locus])) as Record<QuantLocusId, QuantLocus>,
);

// ---------------------------------------------------------------------------
// The pleiotropy matrix W
// ---------------------------------------------------------------------------

/**
 * One nonzero cell of W. The genotypic value of trait k is
 * `Σ_l weight_kl · (a_mat_l + a_pat_l)` — both allele copies, additively, no
 * dominance at quantitative loci in Phase A.
 */
export interface PleiotropyEntry {
  readonly locus: QuantLocusId;
  readonly locusIndex: number;
  readonly trait: TraitKey;
  /** Trait latent units per allele unit, per allele copy. */
  readonly weight: number;
}

export const PLEIOTROPY: readonly PleiotropyEntry[] = Object.freeze(
  QUANT_LOCUS_SPECS.flatMap((spec, index) =>
    spec.loads.map(([trait, weight]) => Object.freeze({ locus: spec.id, locusIndex: index, trait, weight })),
  ),
);

/** W indexed by locus: "what does this locus do?" (inspector, mutation reporting). */
export const W_BY_LOCUS: Readonly<Record<QuantLocusId, readonly PleiotropyEntry[]>> = Object.freeze(
  Object.fromEntries(
    QUANT_LOCI.map((locus) => [locus.id, PLEIOTROPY.filter((entry) => entry.locus === locus.id)]),
  ) as unknown as Record<QuantLocusId, readonly PleiotropyEntry[]>,
);

/**
 * W indexed by trait: "which loci build this trait?" — the phenotype hot path.
 * Iterate `W_ROWS_BY_TRAIT[key]` and accumulate
 * `weight * (quant[quantAlleleIndex(0, locusIndex)] + quant[quantAlleleIndex(1, locusIndex)])`.
 */
export const W_ROWS_BY_TRAIT: Readonly<Record<TraitKey, readonly { readonly locusIndex: number; readonly weight: number }[]>> =
  Object.freeze(
    Object.fromEntries(
      TRAIT_KEYS.map((trait) => [
        trait,
        Object.freeze(
          PLEIOTROPY.filter((entry) => entry.trait === trait).map((entry) =>
            Object.freeze({ locusIndex: entry.locusIndex, weight: entry.weight }),
          ),
        ),
      ]),
    ) as Record<TraitKey, readonly { locusIndex: number; weight: number }[]>,
  );

/**
 * Loci carrying a genuine tradeoff: opposed signs on two traits that are each
 * `directional` (better when higher in isolation). Derived from W so it can
 * never drift out of sync with the table above. Examples by design: q06/q08
 * armour vs speed and efficiency, q15/q16 thermal breadth vs efficiency and
 * speed, q29 attack vs defense, q34/q43 boldness vs wariness.
 */
export const ANTAGONISTIC_LOCI: readonly QuantLocusId[] = Object.freeze(
  QUANT_LOCI.filter((locus) => {
    const directional = W_BY_LOCUS[locus.id].filter((entry) => TRAIT_META[entry.trait].fitnessSense === 'directional');
    return directional.some((a) => a.weight > 0) && directional.some((b) => b.weight < 0);
  }).map((locus) => locus.id),
);

/**
 * Analytic additive genetic variance of a trait's latent value in an
 * unselected founder population, `Σ_l 2·(w·σ_founder·scale)²`.
 *
 * A1 uses this to size the birth environmental deviation for a target founder
 * heritability: `envSd = sqrt(Vg · (1 − h²) / h²)`. Deriving it rather than
 * authoring per-trait environment SDs means the h² target stays honest when
 * A7 retunes `founderSdScale`.
 */
export function founderGeneticVariance(trait: TraitKey, founderSdScale = 1): number {
  let variance = 0;
  for (const entry of PLEIOTROPY) {
    if (entry.trait !== trait) continue;
    const sd = (QUANT_LOCI[entry.locusIndex]?.founderSd ?? 0) * founderSdScale;
    variance += 2 * (entry.weight * sd) ** 2;
  }
  return variance;
}

// ---------------------------------------------------------------------------
// Discrete loci
// ---------------------------------------------------------------------------

export type DiscreteLocusKind =
  /** Two of these; their combination names the body-plan archetype. Macro-mutation here founds a clade. */
  | 'cladeMacro'
  /** Shifts display hue. Visible, selectable through mating and through frequency-dependent predation. */
  | 'pigment'
  /** Shifts mate preference target or precision. */
  | 'preferenceModifier'
  /** k=8 alleles, zero phenotypic effect. Pure drift instrumentation: temporal Ne, Fst, pedigree checks. */
  | 'neutralMarker';

interface DiscreteLocusSpec {
  readonly id: string;
  readonly chromosome: AutosomeId;
  readonly positionCm: number;
  readonly kind: DiscreteLocusKind;
  readonly alleleCount: number;
  readonly label: string;
}

const DISCRETE_LOCUS_SPECS = [
  { id: 'cladeMacroA', chromosome: 'A1', positionCm: 18, kind: 'cladeMacro', alleleCount: 4, label: 'body-plan macro-locus A' },
  { id: 'pigmentA', chromosome: 'A1', positionCm: 47, kind: 'pigment', alleleCount: 4, label: 'pigment A' },
  { id: 'neutralA', chromosome: 'A1', positionCm: 85, kind: 'neutralMarker', alleleCount: 8, label: 'neutral marker A' },

  { id: 'cladeMacroB', chromosome: 'A2', positionCm: 12, kind: 'cladeMacro', alleleCount: 4, label: 'body-plan macro-locus B' },
  { id: 'pigmentB', chromosome: 'A2', positionCm: 52, kind: 'pigment', alleleCount: 4, label: 'pigment B' },
  { id: 'neutralB', chromosome: 'A2', positionCm: 95, kind: 'neutralMarker', alleleCount: 8, label: 'neutral marker B' },

  { id: 'prefModA', chromosome: 'A3', positionCm: 20, kind: 'preferenceModifier', alleleCount: 3, label: 'preference modifier A' },
  { id: 'pigmentC', chromosome: 'A3', positionCm: 56, kind: 'pigment', alleleCount: 4, label: 'pigment C' },
  { id: 'neutralC', chromosome: 'A3', positionCm: 97, kind: 'neutralMarker', alleleCount: 8, label: 'neutral marker C' },

  { id: 'prefModB', chromosome: 'A4', positionCm: 15, kind: 'preferenceModifier', alleleCount: 3, label: 'preference modifier B' },
  { id: 'pigmentD', chromosome: 'A4', positionCm: 57, kind: 'pigment', alleleCount: 4, label: 'pigment D' },
  { id: 'neutralD', chromosome: 'A4', positionCm: 88, kind: 'neutralMarker', alleleCount: 8, label: 'neutral marker D' },
] as const satisfies readonly DiscreteLocusSpec[];

export type DiscreteLocusId = (typeof DISCRETE_LOCUS_SPECS)[number]['id'];

export interface DiscreteLocus {
  readonly id: DiscreteLocusId;
  /** Index into the discrete allele arrays, 0..11. */
  readonly index: number;
  readonly chromosome: AutosomeId;
  readonly positionCm: number;
  readonly kind: DiscreteLocusKind;
  /** k — allele values are integers in [0, alleleCount). */
  readonly alleleCount: number;
  readonly label: string;
}

export const DISCRETE_LOCI: readonly DiscreteLocus[] = Object.freeze(
  DISCRETE_LOCUS_SPECS.map((spec, index) => Object.freeze({ ...spec, index })),
);

export const DISCRETE_LOCUS_COUNT = DISCRETE_LOCI.length;

export const DISCRETE_LOCUS_BY_ID: Readonly<Record<DiscreteLocusId, DiscreteLocus>> = Object.freeze(
  Object.fromEntries(DISCRETE_LOCI.map((locus) => [locus.id, locus])) as Record<DiscreteLocusId, DiscreteLocus>,
);

export const NEUTRAL_MARKER_LOCI: readonly DiscreteLocus[] = Object.freeze(
  DISCRETE_LOCI.filter((locus) => locus.kind === 'neutralMarker'),
);

export const CLADE_MACRO_LOCI: readonly DiscreteLocus[] = Object.freeze(
  DISCRETE_LOCI.filter((locus) => locus.kind === 'cladeMacro'),
);

/**
 * What a discrete allele does to a trait's latent value.
 *
 * Both copies contribute, each at half weight, so a heterozygote sits midway
 * and a homozygote gets the full `delta` — additive, matching the quantitative
 * loci. `cladeMacro` and `neutralMarker` loci have **no** entries here: the
 * former acts through `CLADE_SCHEMA`, the latter acts on nothing at all.
 */
export interface DiscreteEffect {
  readonly locus: DiscreteLocusId;
  readonly allele: number;
  readonly trait: TraitKey;
  /** Latent-units shift when both copies carry this allele. */
  readonly delta: number;
}

export const DISCRETE_EFFECTS: readonly DiscreteEffect[] = Object.freeze([
  // Pigment: four hue morphs per locus, spread around the circle so that
  // frequency-dependent predation always has a rare morph to reward.
  { locus: 'pigmentA', allele: 1, trait: 'displayHue', delta: 35 },
  { locus: 'pigmentA', allele: 2, trait: 'displayHue', delta: -30 },
  { locus: 'pigmentA', allele: 3, trait: 'displayHue', delta: 70 },
  { locus: 'pigmentB', allele: 1, trait: 'displayHue', delta: -45 },
  { locus: 'pigmentB', allele: 2, trait: 'displayHue', delta: 25 },
  { locus: 'pigmentB', allele: 3, trait: 'displayHue', delta: 95 },
  { locus: 'pigmentC', allele: 1, trait: 'displayHue', delta: 55 },
  { locus: 'pigmentC', allele: 2, trait: 'displayHue', delta: -65 },
  { locus: 'pigmentC', allele: 3, trait: 'displayHue', delta: 15 },
  { locus: 'pigmentD', allele: 1, trait: 'displayHue', delta: -20 },
  { locus: 'pigmentD', allele: 2, trait: 'displayHue', delta: 80 },
  { locus: 'pigmentD', allele: 3, trait: 'displayHue', delta: -85 },

  // Preference modifiers: big discrete jumps in what a female looks for, so a
  // new preference morph can appear without waiting on the polygenic tail.
  { locus: 'prefModA', allele: 1, trait: 'prefTarget', delta: 45 },
  { locus: 'prefModA', allele: 2, trait: 'choosiness', delta: 0.35 },
  { locus: 'prefModB', allele: 1, trait: 'choosiness', delta: 0.5 },
  { locus: 'prefModB', allele: 2, trait: 'prefTarget', delta: -40 },
] as const satisfies readonly DiscreteEffect[]);

export const DISCRETE_EFFECTS_BY_LOCUS: Readonly<Record<DiscreteLocusId, readonly DiscreteEffect[]>> = Object.freeze(
  Object.fromEntries(
    DISCRETE_LOCI.map((locus) => [locus.id, Object.freeze(DISCRETE_EFFECTS.filter((effect) => effect.locus === locus.id))]),
  ) as Record<DiscreteLocusId, readonly DiscreteEffect[]>,
);

// ---------------------------------------------------------------------------
// Chromosome maps (what meiosis walks)
// ---------------------------------------------------------------------------

export type ChromosomeLocusRef =
  | { readonly kind: 'quant'; readonly id: QuantLocusId; readonly index: number; readonly positionCm: number }
  | { readonly kind: 'discrete'; readonly id: DiscreteLocusId; readonly index: number; readonly positionCm: number };

export interface ChromosomeMap {
  readonly id: AutosomeId;
  readonly lengthCm: number;
  /** Every locus on the chromosome, **ascending by cM**. Meiosis walks this in order. */
  readonly loci: readonly ChromosomeLocusRef[];
}

export const CHROMOSOMES: Readonly<Record<AutosomeId, ChromosomeMap>> = Object.freeze(
  Object.fromEntries(
    AUTOSOME_IDS.map((chromosome) => {
      const refs: ChromosomeLocusRef[] = [
        ...QUANT_LOCI.filter((locus) => locus.chromosome === chromosome).map(
          (locus): ChromosomeLocusRef => ({ kind: 'quant', id: locus.id, index: locus.index, positionCm: locus.positionCm }),
        ),
        ...DISCRETE_LOCI.filter((locus) => locus.chromosome === chromosome).map(
          (locus): ChromosomeLocusRef => ({ kind: 'discrete', id: locus.id, index: locus.index, positionCm: locus.positionCm }),
        ),
      ].sort((a, b) => a.positionCm - b.positionCm);
      return [chromosome, Object.freeze({ id: chromosome, lengthCm: MAP_LENGTH_CM, loci: Object.freeze(refs) })];
    }),
  ) as Record<AutosomeId, ChromosomeMap>,
);

// ---------------------------------------------------------------------------
// Genome layout
// ---------------------------------------------------------------------------

export const PLOIDY = 2;

/** 0 = maternal haplotype, 1 = paternal haplotype. */
export type HaplotypeIndex = 0 | 1;

/**
 * An organism's genome. **Immutable after construction** — the tick loop must
 * never touch it; the phenotype is computed once at birth and cached in the
 * SoA pools. Meiosis reads two parent genomes and writes a fresh one.
 */
export interface Genome {
  /** `PLOIDY * QUANT_LOCUS_COUNT` = 96 real-valued alleles, `hap * 48 + locusIndex`. */
  readonly quant: Float32Array;
  /** `PLOIDY * DISCRETE_LOCUS_COUNT` = 24 allele indices, `hap * 12 + locusIndex`. */
  readonly discrete: Uint8Array;
  readonly karyotype: Karyotype;
}

export const QUANT_GENOME_LENGTH = PLOIDY * QUANT_LOCUS_COUNT;
export const DISCRETE_GENOME_LENGTH = PLOIDY * DISCRETE_LOCUS_COUNT;

export function quantAlleleIndex(haplotype: HaplotypeIndex, locusIndex: number): number {
  return haplotype * QUANT_LOCUS_COUNT + locusIndex;
}

export function discreteAlleleIndex(haplotype: HaplotypeIndex, locusIndex: number): number {
  return haplotype * DISCRETE_LOCUS_COUNT + locusIndex;
}

/** All-zero genome of the given karyotype. Founder construction fills it in. */
export function createEmptyGenome(karyotype: Karyotype): Genome {
  return {
    quant: new Float32Array(QUANT_GENOME_LENGTH),
    discrete: new Uint8Array(DISCRETE_GENOME_LENGTH),
    karyotype,
  };
}

/** Sum of both allele copies at a quantitative locus — the term W multiplies. */
export function quantGenotypicValue(genome: Genome, locusIndex: number): number {
  return (genome.quant[locusIndex] ?? 0) + (genome.quant[QUANT_LOCUS_COUNT + locusIndex] ?? 0);
}

/** The two allele indices at a discrete locus, maternal first. */
export function discreteGenotype(genome: Genome, locusIndex: number): readonly [number, number] {
  return [genome.discrete[locusIndex] ?? 0, genome.discrete[DISCRETE_LOCUS_COUNT + locusIndex] ?? 0];
}

// ---------------------------------------------------------------------------
// Clade archetypes
// ---------------------------------------------------------------------------

export type CladeArchetype = 'undulator' | 'radialDrifter' | 'armoredCrawler';

export const CLADE_ARCHETYPES = ['undulator', 'radialDrifter', 'armoredCrawler'] as const satisfies readonly CladeArchetype[];

/** Everyone starts here; the other two archetypes must be discovered by macro-mutation. */
export const ANCESTRAL_ARCHETYPE: CladeArchetype = 'undulator';

/**
 * How the renderer reads a morphology trait for this archetype.
 *
 * `renderRange` is a **presentation** clamp — the widest geometry the renderer
 * knows how to draw. The sim never clamps the trait; an organism whose
 * `segmentCount` evolves past the range simply draws at the range edge, and
 * the value keeps evolving underneath. Do not import `renderRange` into
 * `src/sim`.
 */
export interface MorphologyChannelSchema {
  /** Expected value for a well-adapted member of this clade. */
  readonly typical: number;
  readonly renderRange: readonly [number, number];
  /** What the number means for this body plan — the same trait means different things per clade. */
  readonly interpretation: string;
}

export interface CladeSchema {
  readonly archetype: CladeArchetype;
  readonly label: string;
  readonly description: string;
  /**
   * Additive shift on the **latent** trait baseline for members of this clade.
   * This is the body plan's built-in bargain, not a bonus: a radial drifter is
   * cheap and well-defended but slow and small.
   */
  readonly traitBaselineShift: Partial<Record<TraitKey, number>>;
  readonly segmentCount: MorphologyChannelSchema;
  readonly finPairs: MorphologyChannelSchema;
  readonly bodyAspect: MorphologyChannelSchema;
}

export const CLADE_SCHEMA: Readonly<Record<CladeArchetype, CladeSchema>> = Object.freeze({
  undulator: Object.freeze({
    archetype: 'undulator',
    label: 'Undulator',
    description: 'Ancestral spine-chain swimmer; a body that travels by passing a wave down its length.',
    traitBaselineShift: {},
    segmentCount: { typical: 8, renderRange: [4, 20] as const, interpretation: 'vertebral segments in the swimming chain' },
    finPairs: { typical: 2, renderRange: [0, 6] as const, interpretation: 'paired lateral fins along the trunk' },
    bodyAspect: { typical: 3.2, renderRange: [1.2, 9] as const, interpretation: 'length over width; high is eel-like' },
  }),
  radialDrifter: Object.freeze({
    archetype: 'radialDrifter',
    label: 'Radial drifter',
    description: 'Medusoid body pulsing a bell; slow and cheap to run, hard to grab, poor at chasing anything.',
    traitBaselineShift: { speedCap: -0.6, metabolicEff: 0.12, size: -1.5, defense: 0.3 },
    segmentCount: { typical: 3, renderRange: [2, 12] as const, interpretation: 'radial symmetry order (arms around the bell)' },
    finPairs: { typical: 0, renderRange: [0, 4] as const, interpretation: 'trailing tentacle pairs; zero is the normal state' },
    bodyAspect: { typical: 1.1, renderRange: [0.6, 3] as const, interpretation: 'bell height over bell width; near 1 is discoid' },
  }),
  armoredCrawler: Object.freeze({
    archetype: 'armoredCrawler',
    label: 'Armoured crawler',
    description: 'Segmented benthic body under plate armour; expensive and slow, very hard to kill.',
    traitBaselineShift: { speedCap: -0.9, armorPlating: 0.8, defense: 0.6, size: 2, metabolicEff: -0.08 },
    segmentCount: { typical: 12, renderRange: [6, 28] as const, interpretation: 'body somites, each carrying a dorsal plate' },
    finPairs: { typical: 4, renderRange: [1, 10] as const, interpretation: 'paired walking/paddling limbs' },
    bodyAspect: { typical: 2, renderRange: [1, 6] as const, interpretation: 'carapace length over width' },
  }),
});

/**
 * Archetype as a function of the expressed allele at each clade macro-locus.
 * Rows are `cladeMacroA`, columns `cladeMacroB`. Allele 0 is ancestral at both
 * loci, so founders (all 0/0) are undulators and 9 of the 16 combinations stay
 * undulator — a macro-mutation usually does nothing visible, which is what
 * makes an actual clade founding an event worth logging.
 */
export const CLADE_MACRO_TABLE: readonly (readonly CladeArchetype[])[] = Object.freeze([
  Object.freeze(['undulator', 'undulator', 'undulator', 'radialDrifter'] as const),
  Object.freeze(['undulator', 'undulator', 'armoredCrawler', 'undulator'] as const),
  Object.freeze(['undulator', 'radialDrifter', 'undulator', 'radialDrifter'] as const),
  Object.freeze(['armoredCrawler', 'undulator', 'armoredCrawler', 'radialDrifter'] as const),
]);

export function cladeArchetypeFor(macroAlleleA: number, macroAlleleB: number): CladeArchetype {
  return CLADE_MACRO_TABLE[macroAlleleA]?.[macroAlleleB] ?? ANCESTRAL_ARCHETYPE;
}

/**
 * The archetype a genome expresses.
 *
 * The **highest-index allele is dominant** at clade macro-loci, so a single
 * new macro-allele shows up in the body plan immediately rather than waiting
 * for a homozygote. That is what makes clade founding watchable.
 */
export function expressedCladeArchetype(genome: Genome): CladeArchetype {
  const macroA = DISCRETE_LOCUS_BY_ID.cladeMacroA.index;
  const macroB = DISCRETE_LOCUS_BY_ID.cladeMacroB.index;
  const [a0, a1] = discreteGenotype(genome, macroA);
  const [b0, b1] = discreteGenotype(genome, macroB);
  return cladeArchetypeFor(Math.max(a0, a1), Math.max(b0, b1));
}
