/**
 * The species detector.
 *
 * A species here is an operational claim about reproductive isolation, not a
 * clustering artefact: phenotypic clustering only ever *proposes* a boundary,
 * and the proposal is accepted or rejected by the **realized cross-mating
 * rate** measured on the mating log. Two clouds that look separate in trait
 * space but interbreed freely stay one species; two overlapping clouds that
 * never interbreed become two.
 *
 * ## Determinism
 *
 * Every step is a deterministic function of the living population and the
 * mating log: slots are walked in ascending order, the bipartition direction
 * comes from a power iteration seeded by the farthest point from the group mean
 * (ties broken by slot), and the threshold along that direction is chosen by an
 * exhaustive scan rather than by an iterative fit from a random start. No RNG is
 * consulted at all.
 *
 * ## Tag stability
 *
 * The detector keeps its own `OrganismId → SpeciesTag` memory rather than
 * re-reading `pop.speciesTag` every call, seeding from the pool column only for
 * organisms it has not seen. Repeated calls on an unchanged population therefore
 * return identical assignments whether or not the engine has written the
 * previous result back, and a new tag is minted only when a split is actually
 * accepted.
 */

import {
  DISCRETE_LOCUS_BY_ID,
  NEUTRAL_MARKER_LOCI,
  discreteGenotype,
} from '../contracts/genome';
import type { SpeciesDetectionResult } from '../contracts/apis';
import { TRAIT_COUNT, TRAIT_INDEX, TRAIT_META, applyTraitLink } from '../contracts/traits';
import type { TraitKey } from '../contracts/traits';
import type { OrganismId, SimConfig, SimState, SpeciesTag } from '../contracts/types';
import type { MatingLog } from './shared';

/**
 * How much of the clustering distance the four k=8 neutral markers are allowed
 * to carry, expressed in units of "one standardised trait axis".
 *
 * Markers are the only feature that tracks shared ancestry rather than current
 * selection, so they are what separates two lineages that have converged on the
 * same phenotype. Weighted as a block so that adding marker loci does not
 * silently drown the traits.
 */
export const NEUTRAL_MARKER_FEATURE_WEIGHT = 1;

/**
 * Matings needed inside the window before the detector will act on a
 * cross-mating rate. Below this a rate of zero means "nobody bred", not "these
 * two do not interbreed", and acting on it would split on silence.
 */
export const MIN_INFORMATIVE_MATINGS = 20;

/** Power-iteration rounds for the leading principal direction. */
const POWER_ITERATIONS = 24;

interface Living {
  readonly slots: Int32Array;
  readonly ids: Float64Array;
  readonly tags: Int32Array;
  readonly count: number;
  /** Row-major `count × dims` feature matrix, unstandardised. */
  readonly features: Float64Array;
  readonly dims: number;
  /** Per-dimension weight applied after standardisation. */
  readonly weights: Float64Array;
}

/** The evidence a split or merge decision rests on. */
export interface CrossMatingEvidence {
  /** Observed cross-group rate over the expected rate under random mating; 1 = panmixia, 0 = complete isolation. */
  readonly ratio: number;
  readonly within: number;
  readonly cross: number;
}

export class SpeciesDetector {
  private tagOf = new Map<OrganismId, SpeciesTag>();
  private lastSizes = new Map<SpeciesTag, number>();

  constructor(
    private readonly config: SimConfig,
    private readonly matings: MatingLog,
  ) {}

  /** Current tag the detector believes an organism carries, if it has seen it. */
  tagFor(id: OrganismId): SpeciesTag | undefined {
    return this.tagOf.get(id);
  }

  detect(state: SimState): SpeciesDetectionResult {
    const living = this.gather(state);
    const windowStart = state.tick - this.config.speciation.detectorIntervalTicks;
    const splits: SpeciesDetectionResult['splits'][number][] = [];
    const absorbed: SpeciesTag[] = [];

    const merged = this.mergePass(living, groupByTag(living), windowStart, absorbed);
    this.splitPass(state, living, groupByTag(living), merged, windowStart, splits);

    const assignments = new Int32Array(state.pop.capacity).fill(-1);
    for (let index = 0; index < living.count; index += 1) {
      assignments[living.slots[index] ?? 0] = living.tags[index] ?? 0;
    }

    // Sizes after this pass, and the extinctions that fall out of comparing them
    // with the previous pass.
    const sizes = new Map<SpeciesTag, number>();
    for (let index = 0; index < living.count; index += 1) {
      const tag = living.tags[index] ?? 0;
      sizes.set(tag, (sizes.get(tag) ?? 0) + 1);
    }
    // A tag can vanish two ways: it was dissolved into another by the merge
    // pass, or its last member died since the previous call. A split parent
    // also ends up empty, but that is reported as a split rather than an
    // extinction — the lineage continued, under two new names.
    const splitParents = new Set(splits.map((split) => split.parentTag));
    const extinct = new Set<SpeciesTag>(absorbed);
    for (const [tag, previous] of this.lastSizes) {
      if (previous > 0 && (sizes.get(tag) ?? 0) === 0 && !splitParents.has(tag)) extinct.add(tag);
    }
    const extinctions = [...extinct].sort((a, b) => a - b);
    this.lastSizes = sizes;

    // Bound the memory: only the living carry a tag forward. Everything the
    // mating log needs is resolved through living partners.
    const carried = new Map<OrganismId, SpeciesTag>();
    for (let index = 0; index < living.count; index += 1) {
      carried.set(living.ids[index] ?? 0, living.tags[index] ?? 0);
    }
    this.tagOf = carried;

    return { assignments, splits, extinctions };
  }

  // -- passes ---------------------------------------------------------------

  /**
   * Fuse tag pairs that turn out to interbreed. Walked in ascending tag order
   * and folded into the lower tag, so the outcome does not depend on which
   * comparison happened first.
   *
   * Returns the tags that absorbed another group this call; they are exempt from
   * the split pass, because splitting what was just merged is how a detector
   * starts oscillating. Dissolved tags are appended to `absorbed` — they cease
   * to exist within this call, so the size comparison against the previous call
   * would never see them.
   */
  private mergePass(
    living: Living,
    groups: Map<SpeciesTag, number[]>,
    sinceTick: number,
    absorbed: SpeciesTag[],
  ): Set<SpeciesTag> {
    const merged = new Set<SpeciesTag>();
    const tags = [...groups.keys()].sort((a, b) => a - b);

    for (let a = 0; a < tags.length; a += 1) {
      for (let b = a + 1; b < tags.length; b += 1) {
        const tagA = tags[a] ?? 0;
        const tagB = tags[b] ?? 0;
        const indicesA = groups.get(tagA);
        const indicesB = groups.get(tagB);
        if (indicesA === undefined || indicesB === undefined) continue;
        if (indicesA.length === 0 || indicesB.length === 0) continue;

        const side = new Map<OrganismId, number>();
        for (const index of indicesA) side.set(living.ids[index] ?? 0, 0);
        for (const index of indicesB) side.set(living.ids[index] ?? 0, 1);
        const evidence = this.crossMatingEvidence(side, sinceTick);
        if (evidence.within + evidence.cross < MIN_INFORMATIVE_MATINGS) continue;
        if (Number.isNaN(evidence.ratio) || evidence.ratio < this.config.speciation.crossMatingThreshold) continue;

        for (const index of indicesB) living.tags[index] = tagA;
        indicesA.push(...indicesB);
        indicesB.length = 0;
        merged.add(tagA);
        absorbed.push(tagB);
      }
    }
    return merged;
  }

  /** Attempt one bipartition per eligible species. */
  private splitPass(
    state: SimState,
    living: Living,
    groups: Map<SpeciesTag, number[]>,
    merged: Set<SpeciesTag>,
    sinceTick: number,
    splits: SpeciesDetectionResult['splits'][number][],
  ): void {
    const { minSpeciesSize, crossMatingThreshold } = this.config.speciation;
    const tags = [...groups.keys()].sort((a, b) => a - b);

    for (const tag of tags) {
      const indices = groups.get(tag);
      if (indices === undefined || indices.length < 2 * minSpeciesSize) continue;
      if (merged.has(tag)) continue;

      const partition = bipartition(living, indices, minSpeciesSize);
      if (partition === null) continue;

      const side = new Map<OrganismId, number>();
      for (const index of partition.first) side.set(living.ids[index] ?? 0, 0);
      for (const index of partition.second) side.set(living.ids[index] ?? 0, 1);

      const evidence = this.crossMatingEvidence(side, sinceTick);
      if (evidence.within + evidence.cross < MIN_INFORMATIVE_MATINGS) continue;
      if (Number.isNaN(evidence.ratio) || evidence.ratio >= crossMatingThreshold) continue;

      const childA = state.nextSpeciesTag;
      const childB = state.nextSpeciesTag + 1;
      state.nextSpeciesTag += 2;
      for (const index of partition.first) living.tags[index] = childA;
      for (const index of partition.second) living.tags[index] = childB;

      splits.push({
        parentTag: tag,
        childTags: [childA, childB],
        crossMatingRate: evidence.ratio,
        sizes: [partition.first.length, partition.second.length],
      });
    }
  }

  // -- evidence -------------------------------------------------------------

  /**
   * Realized cross-group mating rate, normalised by what random mating would
   * have produced given the two group sizes.
   *
   * The raw cross-mating count is not comparable across unequal groups: a 10/90
   * split produces far fewer cross pairings than a 50/50 one even under complete
   * panmixia. Dividing the observed cross and within fractions by their expected
   * fractions removes that, leaving a quantity that is 1 under random mating and
   * 0 under complete isolation — which is what
   * `speciation.crossMatingThreshold` is written against.
   *
   * The expectation is **directed**, computed from the two sexes' margins
   * separately: a mating is one female and one male, so under random pairing
   * `P(cross) = f_f(1 − f_m) + (1 − f_f)f_m` where `f_f` is the fraction of
   * mothers in the first group and `f_m` the fraction of fathers. The pooled
   * `2f(1 − f)` this replaces assumes both partners are drawn from the same
   * margin (Gate A-1 defect 11). They are not, and the error is not small where
   * it matters: a cluster pair with, say, most females in one group and most
   * males in the other has a pooled f near ½ — expected cross ½ — while the
   * directed expectation is near 1. Every cross mating those two produce is
   * then read as evidence of panmixia against an expectation that random pairing
   * could never have reached, and a real barrier fails to split. Sex-biased
   * dispersal across a ridge produces exactly that geometry.
   *
   * Only matings where **both** partners are currently alive contribute, since a
   * candidate cluster is only defined for living individuals. That biases the
   * window toward survivors; over a window of a couple of generations the effect
   * is small, and the alternative (classifying the dead) would need a phenotype
   * store the contract does not provide.
   */
  crossMatingEvidence(side: ReadonlyMap<OrganismId, number>, sinceTick: number): CrossMatingEvidence {
    let within = 0;
    let cross = 0;
    let mothersInFirst = 0;
    let fathersInFirst = 0;

    this.matings.forEachSince(sinceTick, (motherId, fatherId) => {
      const motherSide = side.get(motherId);
      const fatherSide = side.get(fatherId);
      if (motherSide === undefined || fatherSide === undefined) return;
      if (motherSide === fatherSide) within += 1;
      else cross += 1;
      if (motherSide === 0) mothersInFirst += 1;
      if (fatherSide === 0) fathersInFirst += 1;
    });

    const total = within + cross;
    if (total === 0) return { ratio: Number.NaN, within, cross };

    const femaleFirst = mothersInFirst / total;
    const maleFirst = fathersInFirst / total;
    const expectedCross = femaleFirst * (1 - maleFirst) + (1 - femaleFirst) * maleFirst;
    const expectedWithin = femaleFirst * maleFirst + (1 - femaleFirst) * (1 - maleFirst);
    if (expectedCross <= 0 || expectedWithin <= 0) return { ratio: Number.NaN, within, cross };

    const crossRate = cross / total / expectedCross;
    const withinRate = within / total / expectedWithin;
    return { ratio: withinRate > 0 ? crossRate / withinRate : Number.POSITIVE_INFINITY, within, cross };
  }

  // -- feature extraction ---------------------------------------------------

  private gather(state: SimState): Living {
    const { capacity, alive, id, speciesTag, traitsLatent, genomes } = state.pop;
    const clusterTraits = this.config.speciation.clusterTraits;

    let count = 0;
    for (let slot = 0; slot < capacity; slot += 1) if (alive[slot] === 1) count += 1;

    const layout = featureLayout(clusterTraits);
    const slots = new Int32Array(count);
    const ids = new Float64Array(count);
    const tags = new Int32Array(count);
    const features = new Float64Array(count * layout.dims);

    let row = 0;
    for (let slot = 0; slot < capacity; slot += 1) {
      if (alive[slot] !== 1) continue;
      const organismId = id[slot] ?? 0;
      slots[row] = slot;
      ids[row] = organismId;
      const remembered = this.tagOf.get(organismId);
      tags[row] = remembered ?? Math.max(0, speciesTag[slot] ?? 0);

      let column = row * layout.dims;
      for (const key of clusterTraits) {
        const latent = traitsLatent[slot * TRAIT_COUNT + TRAIT_INDEX[key]] ?? 0;
        if (TRAIT_META[key].link === 'circular') {
          const radians = (applyTraitLink(key, latent) * Math.PI) / 180;
          features[column] = Math.cos(radians);
          features[column + 1] = Math.sin(radians);
          column += 2;
        } else {
          features[column] = latent;
          column += 1;
        }
      }
      const genome = genomes[slot];
      for (const locus of NEUTRAL_MARKER_LOCI) {
        const spec = DISCRETE_LOCUS_BY_ID[locus.id];
        if (genome === undefined) {
          column += spec.alleleCount;
          continue;
        }
        const [first, second] = discreteGenotype(genome, spec.index);
        for (let allele = 0; allele < spec.alleleCount; allele += 1) {
          let dosage = 0;
          if (first === allele) dosage += 0.5;
          if (second === allele) dosage += 0.5;
          features[column + allele] = dosage;
        }
        column += spec.alleleCount;
      }
      row += 1;
    }

    return { slots, ids, tags, count, features, dims: layout.dims, weights: layout.weights };
  }
}

// ---------------------------------------------------------------------------
// Feature layout
// ---------------------------------------------------------------------------

function featureLayout(clusterTraits: readonly TraitKey[]): { dims: number; weights: Float64Array } {
  let traitDims = 0;
  for (const key of clusterTraits) traitDims += TRAIT_META[key].link === 'circular' ? 2 : 1;
  let markerDims = 0;
  for (const locus of NEUTRAL_MARKER_LOCI) markerDims += locus.alleleCount;

  const weights = new Float64Array(traitDims + markerDims);
  let index = 0;
  for (const key of clusterTraits) {
    if (TRAIT_META[key].link === 'circular') {
      // A hue costs two axes but should still count as one trait, so each half
      // carries 1/√2 of the weight.
      weights[index] = Math.SQRT1_2;
      weights[index + 1] = Math.SQRT1_2;
      index += 2;
    } else {
      weights[index] = 1;
      index += 1;
    }
  }
  const markerWeight = markerDims > 0 ? Math.sqrt(NEUTRAL_MARKER_FEATURE_WEIGHT / markerDims) : 0;
  for (; index < weights.length; index += 1) weights[index] = markerWeight;
  return { dims: traitDims + markerDims, weights };
}

function groupByTag(living: Living): Map<SpeciesTag, number[]> {
  const groups = new Map<SpeciesTag, number[]>();
  for (let index = 0; index < living.count; index += 1) {
    const tag = living.tags[index] ?? 0;
    const bucket = groups.get(tag);
    if (bucket === undefined) groups.set(tag, [index]);
    else bucket.push(index);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Bipartition
// ---------------------------------------------------------------------------

interface Bipartition {
  readonly first: number[];
  readonly second: number[];
  /** Between-group sum of squares along the split direction; larger is a cleaner gap. */
  readonly separation: number;
}

/**
 * Split one group in two along its leading principal direction.
 *
 * Features are standardised within the group (so a trait measured in cm cannot
 * outvote one measured in °C), weighted per the layout, then projected onto the
 * first principal component found by power iteration. The cut point along that
 * projection is the one maximising between-group sum of squares — a 1-D Otsu
 * scan, exhaustive and therefore free of the random restarts that would make
 * k-means non-deterministic.
 *
 * Returns null when either side would fall below `minSize`.
 */
function bipartition(living: Living, indices: readonly number[], minSize: number): Bipartition | null {
  const n = indices.length;
  const dims = living.dims;
  if (n < 2 * minSize || dims === 0) return null;

  // Standardise within the group.
  const centred = new Float64Array(n * dims);
  for (let dim = 0; dim < dims; dim += 1) {
    let mean = 0;
    for (const index of indices) mean += living.features[index * dims + dim] ?? 0;
    mean /= n;
    let variance = 0;
    for (const index of indices) {
      const delta = (living.features[index * dims + dim] ?? 0) - mean;
      variance += delta * delta;
    }
    variance /= Math.max(1, n - 1);
    const scale = variance > 1e-12 ? (living.weights[dim] ?? 0) / Math.sqrt(variance) : 0;
    for (let row = 0; row < n; row += 1) {
      const index = indices[row] ?? 0;
      centred[row * dims + dim] = ((living.features[index * dims + dim] ?? 0) - mean) * scale;
    }
  }

  // Seed the power iteration with the farthest point from the group centroid —
  // deterministic, and already close to the leading direction when the group
  // really is two clouds. Ties go to the lower row, which is the lower slot.
  let seedRow = 0;
  let seedNorm = -1;
  for (let row = 0; row < n; row += 1) {
    let norm = 0;
    for (let dim = 0; dim < dims; dim += 1) {
      const value = centred[row * dims + dim] ?? 0;
      norm += value * value;
    }
    if (norm > seedNorm) {
      seedNorm = norm;
      seedRow = row;
    }
  }
  if (seedNorm <= 0) return null;

  let direction = new Float64Array(dims);
  for (let dim = 0; dim < dims; dim += 1) direction[dim] = centred[seedRow * dims + dim] ?? 0;
  normalise(direction);

  const next = new Float64Array(dims);
  for (let round = 0; round < POWER_ITERATIONS; round += 1) {
    next.fill(0);
    for (let row = 0; row < n; row += 1) {
      let projection = 0;
      for (let dim = 0; dim < dims; dim += 1) projection += (centred[row * dims + dim] ?? 0) * (direction[dim] ?? 0);
      for (let dim = 0; dim < dims; dim += 1) next[dim] = (next[dim] ?? 0) + (centred[row * dims + dim] ?? 0) * projection;
    }
    if (!normalise(next)) break;
    direction = Float64Array.from(next);
  }

  const projections = new Float64Array(n);
  for (let row = 0; row < n; row += 1) {
    let projection = 0;
    for (let dim = 0; dim < dims; dim += 1) projection += (centred[row * dims + dim] ?? 0) * (direction[dim] ?? 0);
    projections[row] = projection;
  }

  const order = Array.from({ length: n }, (_value, row) => row);
  order.sort((a, b) => {
    const delta = (projections[a] ?? 0) - (projections[b] ?? 0);
    if (delta !== 0) return delta;
    return (indices[a] ?? 0) - (indices[b] ?? 0);
  });

  let total = 0;
  for (let row = 0; row < n; row += 1) total += projections[row] ?? 0;

  let runningSum = 0;
  let bestCut = -1;
  let bestScore = -1;
  for (let cut = 1; cut < n; cut += 1) {
    runningSum += projections[order[cut - 1] ?? 0] ?? 0;
    if (cut < minSize || n - cut < minSize) continue;
    const meanLow = runningSum / cut;
    const meanHigh = (total - runningSum) / (n - cut);
    const gap = meanHigh - meanLow;
    const score = (cut * (n - cut) * gap * gap) / n;
    if (score > bestScore) {
      bestScore = score;
      bestCut = cut;
    }
  }
  if (bestCut < 0) return null;

  const first: number[] = [];
  const second: number[] = [];
  for (let row = 0; row < n; row += 1) {
    const target = row < bestCut ? first : second;
    target.push(indices[order[row] ?? 0] ?? 0);
  }
  first.sort((a, b) => a - b);
  second.sort((a, b) => a - b);
  return { first, second, separation: bestScore };
}

function normalise(vector: Float64Array): boolean {
  let norm = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index] ?? 0;
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (!(norm > 1e-12)) return false;
  for (let index = 0; index < vector.length; index += 1) vector[index] = (vector[index] ?? 0) / norm;
  return true;
}
