/**
 * Morphological divergence: the pure maths that turns a population of
 * near-clones into a population of visibly different animals.
 *
 * Pixi-free and allocation-free, so every rule here is pinned by a headless
 * test rather than by looking at the screen.
 *
 * ## Why anything here is needed
 *
 * Realised trait CV runs 6–10% in every tuning run, so the three schema
 * morphology channels (`segmentCount`, `finPairs`, `bodyAspect`) sit within a
 * few percent of the archetype typical for the whole population. Drawing those
 * raw values is faithful and useless: the spread exists, it is just far below
 * the eye's discrimination threshold at any zoom. {@link caricature} rescales
 * deviation-from-typical into the schema's `renderRange` so the *ordering* the
 * sim produces survives into something visible.
 *
 * The two channels that genuinely diverge — `diet` ratchets ≈1.4 logits over a
 * run, `defense` moved 3.3σ in twenty generations during the wall experiment —
 * had no effect on body form at all. {@link headFormFromDiet} and
 * {@link spinationFrom} are where they get one.
 *
 * ## What is deliberately *not* here
 *
 * No clamping of the underlying traits, and no population state. Every function
 * is a pure function of one organism's own numbers, so two animals drawn in the
 * same frame never influence each other and a body is reproducible from a slice
 * row alone.
 */

import type { CladeArchetype } from '../../contracts/genome';
import { CLADE_SCHEMA } from '../../contracts/genome';

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// ---------------------------------------------------------------------------
// Caricature amplification
// ---------------------------------------------------------------------------

/**
 * Deviation gain. Near the typical the drawn deviation is ≈`gain/tanh(gain)`
 * times the real one; at the `renderRange` edge it is exactly 1× (the edge maps
 * to the edge), which is what keeps the amplification from inventing shapes the
 * schema does not allow.
 */
export const CARICATURE_GAIN = 2.8;

/**
 * Amplify `value`'s deviation from `typical`, saturating smoothly into
 * `[low, high]`.
 *
 * `tanh(g·u)/tanh(g)` over the normalised deviation `u ∈ [0, 1]`, applied
 * separately to each side so an asymmetric range (every schema range is
 * asymmetric — `undulator.bodyAspect` is 1.2 … 3.2 … 9) is used to its full
 * extent on both sides.
 *
 * Four properties the tests hold it to, because the alternative is the bug that
 * killed the previous project:
 *
 * - **identity at the typical** — `caricature(t, t, …) === t` exactly;
 * - **sign-preserving** — a genuinely longer-bodied fish always draws longer,
 *   never flips past its archetype-mate;
 * - **monotone** — the drawn order is the real order, so the picture can be read
 *   as a measurement;
 * - **range-respecting** — the result never leaves `[low, high]`, and does so by
 *   saturating (tanh is concave on the half-line) rather than by cornering, so a
 *   trait crossing the edge does not pop.
 */
export function caricature(
  value: number,
  typical: number,
  low: number,
  high: number,
  gain: number = CARICATURE_GAIN,
): number {
  const deviation = value - typical;
  if (deviation === 0) return typical;
  const span = deviation > 0 ? high - typical : typical - low;
  if (!(span > 0)) return typical;
  const u = Math.min(1, Math.abs(deviation) / span);
  const shaped = Math.tanh(gain * u) / Math.tanh(gain);
  return typical + (deviation > 0 ? span : -span) * shaped;
}

export function amplifiedSegments(archetype: CladeArchetype, segmentCount: number): number {
  const spec = CLADE_SCHEMA[archetype].segmentCount;
  return caricature(segmentCount, spec.typical, spec.renderRange[0], spec.renderRange[1]);
}

export function amplifiedFinPairs(archetype: CladeArchetype, finPairs: number): number {
  const spec = CLADE_SCHEMA[archetype].finPairs;
  return caricature(finPairs, spec.typical, spec.renderRange[0], spec.renderRange[1]);
}

export function amplifiedBodyAspect(archetype: CladeArchetype, bodyAspect: number): number {
  const spec = CLADE_SCHEMA[archetype].bodyAspect;
  return caricature(bodyAspect, spec.typical, spec.renderRange[0], spec.renderRange[1]);
}

// ---------------------------------------------------------------------------
// Diet → head form
// ---------------------------------------------------------------------------

/**
 * Diet logits per unit of head form. Population means reach ±1.5, which maps to
 * ≈±0.87 — most of the axis in use without the tails ever reaching the ends.
 */
export const DIET_SCALE = 1.1;

/**
 * −1 blunt rounded filter-feeder snout, 0 neutral fusiform, +1 tapered predatory
 * wedge. `tanh` rather than a clamp: `diet` is unbounded and keeps ratcheting, so
 * the drawing has to saturate smoothly or a specialising lineage pops.
 */
export function headFormFromDiet(diet: number): number {
  return Math.tanh(diet / DIET_SCALE);
}

// ---------------------------------------------------------------------------
// Defense → spination
// ---------------------------------------------------------------------------

/** Below this combined load a back is smooth; `defense` alone is typically 0.3–3. */
export const SPINATION_FLOOR = 0.5;
export const SPINATION_SCALE = 1.9;
/** `armorPlating` counts toward the serrated read, at less than its face value. */
export const ARMOR_TO_SPINATION = 0.7;

/**
 * 0 (smooth back) … 1 (heavily serrated dorsal line).
 *
 * Both inputs are softplus-linked and unbounded upstream, so both are floored at
 * zero here before they are combined — a negative expressed value is a decode
 * artefact, not a negative spine.
 */
export function spinationFrom(defense: number, armorPlating: number): number {
  const load = Math.max(0, defense) + ARMOR_TO_SPINATION * Math.max(0, armorPlating);
  return Math.tanh(Math.max(0, load - SPINATION_FLOOR) / SPINATION_SCALE);
}

// ---------------------------------------------------------------------------
// Species patterning
// ---------------------------------------------------------------------------

export const PATTERN_FAMILIES = ['none', 'stripes', 'spots', 'countershading'] as const;

export type PatternFamily = (typeof PATTERN_FAMILIES)[number];

/** Integer avalanche (Murmur3 finaliser constants); no RNG, no state. */
function hash32(value: number): number {
  let x = value >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * The pattern family an organism wears.
 *
 * Keyed on `speciesTag` first, so **every member of a species wears the same
 * pattern** — that is the whole point of the channel, and two species side by
 * side have to read as different animals rather than as two shuffles of the same
 * one. Tag 0 means the stats layer has not assigned a species yet (founders, and
 * anything below the cluster threshold), and there the slot's stable `jitter`
 * stands in so a founder population is not uniformly bare.
 *
 * Deterministic in both branches: `jitter` is fixed per slot for the life of the
 * organism, so a body never changes pattern between frames.
 */
export function patternFamilyFor(speciesTag: number, jitter: number): PatternFamily {
  const tag = Math.round(speciesTag);
  const key = tag > 0 ? hash32(tag) : hash32(0x9e37 + Math.floor(clamp01(jitter) * 64));
  return PATTERN_FAMILIES[key % PATTERN_FAMILIES.length] ?? 'none';
}

/** Where along the body the marks sit, 0..1. Spreads same-species animals apart. */
export function patternPhaseFor(jitter: number): number {
  return clamp01(jitter);
}

// ---------------------------------------------------------------------------
// Mid-tier flipbook buckets
// ---------------------------------------------------------------------------

/**
 * The bucketing that gives the mid tier variety without a texture per organism.
 *
 * 3 × 2 × 2 = 12 variants per archetype. The aspect buckets are the ones that
 * pay for themselves twice: a mid sprite is squashed across its length to make
 * up the difference between its own `bodyAspect` and the aspect it was baked at,
 * and with one bake per archetype that correction reaches 0.36× at the top of
 * the undulator range — enough to visibly crush the head and fins. Bucketing in
 * log aspect bounds it at `exp(ln(high/low) / 2N)`, ≈1.40 for the widest range.
 * The far tier's silhouettes use the same three bands for the same reason.
 */
export const ASPECT_BUCKETS = 3;
export const HEAD_BUCKETS = 2;
export const PATTERN_BUCKETS = 2;
export const FLIPBOOK_VARIANTS = ASPECT_BUCKETS * HEAD_BUCKETS * PATTERN_BUCKETS;

/**
 * Bands are equal in **log** aspect, not in aspect.
 *
 * `bodyAspect` is a ratio (length over width), and the correction the mid tier
 * applies is a ratio too, so the quantity to spread evenly is the log. Equal
 * linear bands put the undulator's whole 1.2–3.8 stubby end in one bucket
 * centred at 2.5, which is a 2.08× squash at the bottom of the range — worse
 * than two of the three bands are wide. In log the worst case is
 * `exp(ln(high/low) / 2N)`, ≈1.40 for the widest archetype range.
 */
export function aspectBucketFor(archetype: CladeArchetype, bodyAspect: number): number {
  const [low, high] = CLADE_SCHEMA[archetype].bodyAspect.renderRange;
  if (!(high > low) || !(low > 0)) return 0;
  const span = Math.log(high / low);
  const u = Math.log(clamp(bodyAspect, low, high) / low) / span;
  return Math.min(ASPECT_BUCKETS - 1, Math.max(0, Math.floor(u * ASPECT_BUCKETS)));
}

/** The `bodyAspect` a bucket is baked at: the geometric centre of its band. */
export function aspectForBucket(archetype: CladeArchetype, bucket: number): number {
  const [low, high] = CLADE_SCHEMA[archetype].bodyAspect.renderRange;
  if (!(high > low) || !(low > 0)) return low;
  const b = clamp(Math.round(bucket), 0, ASPECT_BUCKETS - 1);
  return low * Math.exp(((b + 0.5) / ASPECT_BUCKETS) * Math.log(high / low));
}

export function headBucketFor(headForm: number): number {
  return headForm >= 0 ? 1 : 0;
}

/** Head form a bucket is baked at. Inside the band rather than at its end, so no bucket is a caricature of a caricature. */
export function headFormForBucket(bucket: number): number {
  return bucket >= 1 ? 0.55 : -0.55;
}

/**
 * Two buckets, not four: at mid-tier size a sprite is 10–40 px long and the eye
 * cannot separate a stripe from a spot, but it can separate a broken outline
 * from an unbroken one. `countershading` bakes as unbroken because its read is a
 * dorsal darkening, and the mid sprite is flat-tinted anyway.
 */
export function patternBucketFor(family: PatternFamily): number {
  return family === 'stripes' || family === 'spots' ? 1 : 0;
}

export function patternFamilyForBucket(bucket: number): PatternFamily {
  return bucket >= 1 ? 'stripes' : 'none';
}

export function flipbookVariantIndex(aspectBucket: number, headBucket: number, patternBucket: number): number {
  const a = clamp(Math.round(aspectBucket), 0, ASPECT_BUCKETS - 1);
  const h = clamp(Math.round(headBucket), 0, HEAD_BUCKETS - 1);
  const p = clamp(Math.round(patternBucket), 0, PATTERN_BUCKETS - 1);
  return (a * HEAD_BUCKETS + h) * PATTERN_BUCKETS + p;
}

export interface FlipbookVariant {
  readonly aspectBucket: number;
  readonly headBucket: number;
  readonly patternBucket: number;
}

/** Inverse of {@link flipbookVariantIndex}; the bake loop walks variants by index. */
export function decodeFlipbookVariant(index: number): FlipbookVariant {
  const i = clamp(Math.round(index), 0, FLIPBOOK_VARIANTS - 1);
  return {
    aspectBucket: Math.floor(i / (HEAD_BUCKETS * PATTERN_BUCKETS)),
    headBucket: Math.floor(i / PATTERN_BUCKETS) % HEAD_BUCKETS,
    patternBucket: i % PATTERN_BUCKETS,
  };
}
