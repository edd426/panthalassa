/**
 * Procedural body outlines for the three clade archetypes.
 *
 * Pure geometry: plain numbers in, point arrays out, no Pixi and no DOM, so the
 * shapes are testable headless and the same builders serve the live near-tier
 * `Graphics` and the mount-time texture bakes.
 *
 * The local frame is shared with `spine.ts`: **body length 1, head at the
 * origin, +x forward**, so the body extends toward −x. The caller scales by
 * `sizeCm * CM_TO_WU` and rotates by `heading`.
 *
 * `CLADE_SCHEMA.<archetype>.<channel>.interpretation` is the drawing spec —
 * `segmentCount` means vertebrae, radial symmetry order and somites in the
 * three archetypes respectively, and each is drawn as that thing. The
 * `renderRange` clamps are re-applied here rather than trusted from
 * `resolveMorphology`, because these builders are also called from the texture
 * bakes with hand-written archetype typicals.
 */

import { ARMOR_RENDER_RANGE } from '../contracts';
import type { CladeArchetype } from '../../contracts/genome';
import { CLADE_SCHEMA } from '../../contracts/genome';
import type { SpineChain, SpineParams } from './spine';
import { bellPulse, buildSpine, createSpineChain } from './spine';

// ---------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------

/** Crawler worst case: `2 * segmentCount` at the top of its renderRange (28). */
const OUTLINE_CAPACITY = 56;
/** Undulator worst case: `2 * finPairs` triangles at the top of its range (6). */
const MAX_FINS = 12;
const FIN_CAPACITY = 3;
/** Crawler worst case: one plate per somite. */
const MAX_PLATES = 28;
const PLATE_CAPACITY = 8;
/** Crawler worst case: `2 * finPairs` limbs (10) plus the dorsal midline. */
const MAX_STROKES = 24;
/** The crawler midline runs the whole chain: `segmentCount + 1` points. */
const STROKE_CAPACITY = 32;

/** A run of points; `closed` shapes are filled, open ones are stroked. */
export interface Polyline {
  readonly points: Float64Array;
  count: number;
  closed: boolean;
}

function createPolyline(capacity: number, closed: boolean): Polyline {
  return { points: new Float64Array(capacity * 2), count: 0, closed };
}

function push(line: Polyline, x: number, y: number): void {
  const at = line.count * 2;
  if (at + 1 >= line.points.length) return;
  line.points[at] = x;
  line.points[at + 1] = y;
  line.count += 1;
}

export interface BodyGeometry {
  archetype: CladeArchetype;
  /** The one closed silhouette: fusiform trunk, medusa bell or carapace. */
  readonly outline: Polyline;
  /** Closed appendage polygons — undulator fins only. */
  readonly fins: Polyline[];
  finCount: number;
  /** Closed overlapping somite plates — crawler only. */
  readonly plates: Polyline[];
  plateCount: number;
  /** Open polylines: drifter rim arms and tentacles, crawler limbs and midline. */
  readonly strokes: Polyline[];
  strokeCount: number;
  /** Bright accent: the undulator/crawler eye, the drifter's bell nucleus. */
  eyeX: number;
  eyeY: number;
  eyeR: number;
  /** Half-width at the widest station — glow sizing and the species rim accent. */
  maxHalfWidth: number;
  /** Width scale the drifter pulse already baked into the outline; 1 elsewhere. */
  pulseScale: number;
  /** `armorPlating` mapped to 0..1: plate stroke weight and mineral lightening. */
  armorLightening: number;
  /** Plate outline weight in local units (multiply by body length for world units). */
  plateStrokeWidth: number;
  /** The chain the trunk archetypes were built on; empty for the drifter. */
  readonly chain: SpineChain;
}

export function createBodyGeometry(): BodyGeometry {
  const fins: Polyline[] = [];
  for (let i = 0; i < MAX_FINS; i += 1) fins.push(createPolyline(FIN_CAPACITY, true));
  const plates: Polyline[] = [];
  for (let i = 0; i < MAX_PLATES; i += 1) plates.push(createPolyline(PLATE_CAPACITY, true));
  const strokes: Polyline[] = [];
  for (let i = 0; i < MAX_STROKES; i += 1) strokes.push(createPolyline(STROKE_CAPACITY, false));
  return {
    archetype: 'undulator',
    outline: createPolyline(OUTLINE_CAPACITY, true),
    fins,
    finCount: 0,
    plates,
    plateCount: 0,
    strokes,
    strokeCount: 0,
    eyeX: 0,
    eyeY: 0,
    eyeR: 0,
    maxHalfWidth: 0,
    pulseScale: 1,
    armorLightening: 0,
    plateStrokeWidth: 0,
    chain: createSpineChain(),
  };
}

// ---------------------------------------------------------------------------
// Morphology clamps and derived counts
// ---------------------------------------------------------------------------

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** `segmentCount` rounded and clamped to the archetype's presentation range. */
export function clampSegments(archetype: CladeArchetype, segmentCount: number): number {
  const [low, high] = CLADE_SCHEMA[archetype].segmentCount.renderRange;
  return Math.round(clamp(segmentCount, low, high));
}

export function clampFinPairs(archetype: CladeArchetype, finPairs: number): number {
  const [low, high] = CLADE_SCHEMA[archetype].finPairs.renderRange;
  return Math.round(clamp(finPairs, low, high));
}

export function clampBodyAspect(archetype: CladeArchetype, bodyAspect: number): number {
  const [low, high] = CLADE_SCHEMA[archetype].bodyAspect.renderRange;
  return clamp(bodyAspect, low, high);
}

/** Points in the drifter bell, spread over the radial symmetry order. */
export function bellPointCount(segments: number): number {
  return clamp(segments * 6, 16, 48);
}

/**
 * Points in the closed outline, as a function of the clamped `segmentCount`.
 *
 * - undulator: nose, then one side head→tail, then the far side back — `2S − 2`,
 *   with the zero-width nose and tail tip counted once each.
 * - radialDrifter: {@link bellPointCount}.
 * - armoredCrawler: the same construction over an `S + 1` point chain, so that
 *   there are exactly `S` somite gaps to hang plates on — `2S`.
 */
export function outlinePointCount(archetype: CladeArchetype, segmentCount: number): number {
  const s = clampSegments(archetype, segmentCount);
  switch (archetype) {
    case 'undulator':
      return 2 * s - 2;
    case 'radialDrifter':
      return bellPointCount(s);
    case 'armoredCrawler':
      return 2 * s;
  }
}

/** Filled appendage polygons: two triangles per undulator fin pair, none elsewhere. */
export function finPolygonCount(archetype: CladeArchetype, finPairs: number): number {
  return archetype === 'undulator' ? 2 * clampFinPairs(archetype, finPairs) : 0;
}

/** Overlapping somite plates: one per crawler somite, none elsewhere. */
export function platePolygonCount(archetype: CladeArchetype, segmentCount: number): number {
  return archetype === 'armoredCrawler' ? clampSegments(archetype, segmentCount) : 0;
}

/**
 * Open polylines: `S` rim arms plus `2F` tentacles for the drifter, `2F` limbs
 * plus one dorsal midline for the crawler, none for the undulator.
 */
export function strokePolylineCount(
  archetype: CladeArchetype,
  segmentCount: number,
  finPairs: number,
): number {
  switch (archetype) {
    case 'undulator':
      return 0;
    case 'radialDrifter':
      return clampSegments(archetype, segmentCount) + 2 * clampFinPairs(archetype, finPairs);
    case 'armoredCrawler':
      return 2 * clampFinPairs(archetype, finPairs) + 1;
  }
}

// ---------------------------------------------------------------------------
// Width profiles
// ---------------------------------------------------------------------------

/** Fraction of the body length at which a fusiform swimmer is widest. */
const FUSIFORM_PEAK = 0.3;
const FUSIFORM_EXP = Math.log(0.5) / Math.log(FUSIFORM_PEAK);
/** A carapace carries its shoulders further back and blunter than a fish does. */
const CARAPACE_PEAK = 0.4;
const CARAPACE_EXP = Math.log(0.5) / Math.log(CARAPACE_PEAK);
const CARAPACE_BLUNT = 0.6;

/**
 * Fusiform half-width at fractional distance `s` from the head, as a fraction
 * of `maxHalfWidth`. Zero at both ends, peaking at {@link FUSIFORM_PEAK}.
 */
export function fusiformProfile(s: number): number {
  if (s <= 0 || s >= 1) return 0;
  return Math.sin(Math.PI * Math.pow(s, FUSIFORM_EXP));
}

export function carapaceProfile(s: number): number {
  if (s <= 0 || s >= 1) return 0;
  return Math.pow(Math.sin(Math.PI * Math.pow(s, CARAPACE_EXP)), CARAPACE_BLUNT);
}

// ---------------------------------------------------------------------------
// Undulation
// ---------------------------------------------------------------------------

const BASE_AMPLITUDE_HEAD = 0.02;
const BASE_AMPLITUDE_TAIL = 0.12;
const WAVELENGTH = 0.8;

/** Stiffness of each body plan's travelling wave. The drifter has no chain. */
const STIFFNESS: Readonly<Record<CladeArchetype, number>> = {
  undulator: 1,
  radialDrifter: 0,
  armoredCrawler: 0.3,
};

/** Beat-rate multiplier: a crawler's legs cycle faster than a fish's tail. */
export const ARCHETYPE_FREQUENCY_SCALE: Readonly<Record<CladeArchetype, number>> = {
  undulator: 1,
  radialDrifter: 1,
  armoredCrawler: 1.8,
};

/**
 * Couples swimming vigour to slenderness: a stubby body flexes less than an eel.
 *
 * The bound is borrowed from the offset-curve fold condition — an offset curve
 * folds through itself once the offset exceeds the radius of curvature, which
 * for `A·sin(2πs/λ)` is `λ²/(4π²A)` — but it is **not** what keeps the outline
 * simple. The tail-ward envelope already holds the amplitude at the widest
 * station (30% back) to about a quarter of the tail amplitude, and
 * `bodies.test.ts` shows the outline stays simple with this factor switched off
 * entirely. What the factor buys is the read: an eel at bodyAspect 9 sweeps its
 * full amplitude while a stubby fish at 1.2 sweeps about a fifth of it, from one
 * expression instead of a per-archetype table.
 */
const CURVATURE_SAFETY = 0.6;

function amplitudeFactor(maxHalfWidth: number): number {
  if (maxHalfWidth <= 0) return 1;
  const cap = (CURVATURE_SAFETY * WAVELENGTH * WAVELENGTH) / (4 * Math.PI * Math.PI * maxHalfWidth);
  return BASE_AMPLITUDE_TAIL > cap ? cap / BASE_AMPLITUDE_TAIL : 1;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface BodyParams {
  readonly archetype: CladeArchetype;
  readonly segmentCount: number;
  readonly finPairs: number;
  readonly bodyAspect: number;
  readonly armorPlating: number;
  /** Travelling-wave phase, radians (undulator, crawler). */
  readonly phase: number;
  /** Bell pulse phase in [0, 1) (drifter). */
  readonly pulsePhase: number;
  /** Global undulation multiplier: 1 live, 0 frozen for bakes and tests. */
  readonly amplitudeScale: number;
}

/**
 * One reusable parameter block, so a per-frame body build allocates nothing.
 * Safe as module state because `buildBody` is synchronous and never re-entered.
 */
const spineParams: { -readonly [K in keyof SpineParams]: SpineParams[K] } = {
  segmentCount: 8,
  amplitudeHead: BASE_AMPLITUDE_HEAD,
  amplitudeTail: BASE_AMPLITUDE_TAIL,
  wavelength: WAVELENGTH,
  phase: 0,
  amplitudeScale: 1,
};

export function buildBody(params: BodyParams, out: BodyGeometry): void {
  out.archetype = params.archetype;
  out.outline.count = 0;
  out.finCount = 0;
  out.plateCount = 0;
  out.strokeCount = 0;
  out.pulseScale = 1;
  out.armorLightening = clamp(params.armorPlating / ARMOR_RENDER_RANGE[1], 0, 1);
  out.plateStrokeWidth = 0.006 + 0.018 * out.armorLightening;

  switch (params.archetype) {
    case 'undulator':
      buildUndulator(params, out);
      return;
    case 'radialDrifter':
      buildDrifter(params, out);
      return;
    case 'armoredCrawler':
      buildCrawler(params, out);
      return;
  }
}

/** Integrate the trunk chain shared by the undulator and the crawler. */
function buildTrunkChain(
  params: BodyParams,
  chainPoints: number,
  maxHalfWidth: number,
  chain: SpineChain,
): void {
  const factor = amplitudeFactor(maxHalfWidth);
  spineParams.segmentCount = chainPoints;
  spineParams.amplitudeHead = BASE_AMPLITUDE_HEAD * factor;
  spineParams.amplitudeTail = BASE_AMPLITUDE_TAIL * factor;
  spineParams.phase = params.phase;
  spineParams.amplitudeScale = params.amplitudeScale * STIFFNESS[params.archetype];
  buildSpine(spineParams, chain);
}

/**
 * Offset the chain into a closed outline: the zero-width nose once, one side
 * head→tail, then the far side tail→head. `2N − 2` points for an `N` point chain.
 */
function offsetOutline(
  chain: SpineChain,
  maxHalfWidth: number,
  profile: (s: number) => number,
  out: Polyline,
): void {
  const n = chain.count;
  push(out, chain.xs[0] ?? 0, chain.ys[0] ?? 0);
  for (let i = 1; i < n; i += 1) {
    const h = maxHalfWidth * profile(i / (n - 1));
    push(out, (chain.xs[i] ?? 0) + (chain.nxs[i] ?? 0) * h, (chain.ys[i] ?? 0) + (chain.nys[i] ?? 0) * h);
  }
  for (let i = n - 2; i >= 1; i -= 1) {
    const h = maxHalfWidth * profile(i / (n - 1));
    push(out, (chain.xs[i] ?? 0) - (chain.nxs[i] ?? 0) * h, (chain.ys[i] ?? 0) - (chain.nys[i] ?? 0) * h);
  }
}

function placeEye(
  chain: SpineChain,
  maxHalfWidth: number,
  profile: (s: number) => number,
  out: BodyGeometry,
): void {
  const n = chain.count;
  const i = Math.max(1, Math.min(n - 1, Math.round(0.12 * (n - 1))));
  const h = maxHalfWidth * profile(i / (n - 1));
  out.eyeX = (chain.xs[i] ?? 0) + (chain.nxs[i] ?? 0) * h * 0.45;
  out.eyeY = (chain.ys[i] ?? 0) + (chain.nys[i] ?? 0) * h * 0.45;
  out.eyeR = clamp(0.34 * h, 0.011, 0.05);
}

// --- undulator --------------------------------------------------------------

const FIN_LENGTH = 0.16;
/** Radians the fin tip swings through; the lag makes the pairs ripple aft-ward. */
const FIN_FLUTTER = 0.5;
const FIN_PHASE_LAG = 0.9;

function buildUndulator(params: BodyParams, out: BodyGeometry): void {
  const segments = clampSegments('undulator', params.segmentCount);
  const finPairs = clampFinPairs('undulator', params.finPairs);
  const aspect = clampBodyAspect('undulator', params.bodyAspect);
  const maxHalfWidth = 1 / (2 * aspect);
  out.maxHalfWidth = maxHalfWidth;

  const chain = out.chain;
  buildTrunkChain(params, segments, maxHalfWidth, chain);
  offsetOutline(chain, maxHalfWidth, fusiformProfile, out.outline);
  placeEye(chain, maxHalfWidth, fusiformProfile, out);

  const n = chain.count;
  for (let pair = 0; pair < finPairs; pair += 1) {
    const at = Math.max(1, Math.min(n - 2, Math.round(((pair + 1) / (finPairs + 1)) * (n - 1))));
    const flutter = FIN_FLUTTER * Math.sin(params.phase - pair * FIN_PHASE_LAG);
    const half = Math.max(maxHalfWidth * fusiformProfile(at / (n - 1)), maxHalfWidth * 0.15);
    for (let side = 0; side < 2; side += 1) {
      const sign = side === 0 ? 1 : -1;
      const fin = out.fins[out.finCount];
      if (fin === undefined) break;
      fin.count = 0;
      const nx = (chain.nxs[at] ?? 0) * sign;
      const ny = (chain.nys[at] ?? 0) * sign;
      const tx = Math.cos(chain.angles[at] ?? 0);
      const ty = Math.sin(chain.angles[at] ?? 0);
      const ax = (chain.xs[at] ?? 0) + nx * half;
      const ay = (chain.ys[at] ?? 0) + ny * half;
      const spread = chain.segmentLength * 0.6;
      push(fin, ax + tx * spread, ay + ty * spread);
      push(fin, ax - tx * spread, ay - ty * spread);
      const cs = Math.cos(flutter * sign);
      const sn = Math.sin(flutter * sign);
      push(fin, ax + (nx * cs + tx * sn) * FIN_LENGTH, ay + (ny * cs + ty * sn) * FIN_LENGTH);
      out.finCount += 1;
    }
  }
}

// --- radialDrifter ----------------------------------------------------------

/** Superellipse exponent of the bell. Above 2 keeps it convex, so never self-crossing. */
const BELL_EXPONENT = 2.5;
/** Peak width swing of the pulse. The bell narrows as it contracts and lengthens a little. */
const BELL_PULSE_WIDTH = 0.08;
const BELL_PULSE_LENGTH = 0.04;
const ARM_INNER = 0.45;
const ARM_OUTER = 0.92;
const TENTACLE_POINTS = 5;
const TENTACLE_LENGTH = 0.45;
const TENTACLE_CURL = 0.09;
/** Tentacles answer the bell a beat late; that lag is most of the medusa read. */
const TENTACLE_LAG = 0.22;

function bellRimX(theta: number, height: number): number {
  const c = Math.cos(theta);
  const shaped = Math.sign(c) * Math.pow(Math.abs(c), 2 / BELL_EXPONENT);
  return (-height / 2) * (1 - shaped);
}

function bellRimY(theta: number, width: number): number {
  const s = Math.sin(theta);
  return (width / 2) * Math.sign(s) * Math.pow(Math.abs(s), 2 / BELL_EXPONENT);
}

function buildDrifter(params: BodyParams, out: BodyGeometry): void {
  const segments = clampSegments('radialDrifter', params.segmentCount);
  const finPairs = clampFinPairs('radialDrifter', params.finPairs);
  const aspect = clampBodyAspect('radialDrifter', params.bodyAspect);

  const pulse = bellPulse(params.pulsePhase) * params.amplitudeScale;
  const scaleY = 1 + BELL_PULSE_WIDTH * pulse;
  const scaleX = 1 - BELL_PULSE_LENGTH * pulse;
  out.pulseScale = scaleY;

  const height = scaleX;
  const width = scaleY / aspect;
  out.maxHalfWidth = width / 2;

  const points = bellPointCount(segments);
  for (let k = 0; k < points; k += 1) {
    const theta = (2 * Math.PI * k) / points;
    push(out.outline, bellRimX(theta, height), bellRimY(theta, width));
  }

  // Radial canals: the symmetry order made visible, drawn apex-outward.
  for (let k = 0; k < segments; k += 1) {
    const theta = (2 * Math.PI * (k + 0.5)) / segments;
    const rx = bellRimX(theta, height);
    const ry = bellRimY(theta, width);
    const arm = out.strokes[out.strokeCount];
    if (arm === undefined) break;
    arm.count = 0;
    push(arm, rx * ARM_INNER, ry * ARM_INNER);
    push(arm, rx * ARM_OUTER, ry * ARM_OUTER);
    out.strokeCount += 1;
  }

  const lagged = params.pulsePhase - TENTACLE_LAG;
  for (let pair = 0; pair < finPairs; pair += 1) {
    const spread = 0.35 + (0.55 * pair) / Math.max(1, finPairs - 1);
    for (let side = 0; side < 2; side += 1) {
      const sign = side === 0 ? 1 : -1;
      const theta = Math.PI - sign * spread;
      const ax = bellRimX(theta, height);
      const ay = bellRimY(theta, width);
      const tentacle = out.strokes[out.strokeCount];
      if (tentacle === undefined) break;
      tentacle.count = 0;
      for (let m = 0; m < TENTACLE_POINTS; m += 1) {
        const u = m / (TENTACLE_POINTS - 1);
        const wobble = TENTACLE_CURL * u * u * Math.sin(2 * Math.PI * lagged + u * 2.2);
        push(tentacle, ax - TENTACLE_LENGTH * u, ay + sign * wobble);
      }
      out.strokeCount += 1;
    }
  }

  // The bell nucleus stands in for an eye: the one bright interior mark.
  out.eyeX = -height * 0.4;
  out.eyeY = 0;
  out.eyeR = clamp(width * 0.13, 0.012, 0.06);
}

// --- armoredCrawler ---------------------------------------------------------

/** Plates overrun their somite gap by this much each side, so they shingle. */
const PLATE_OVERLAP = 0.68;
const PLATE_INSET = 0.94;
const LIMB_SWEEP = 0.55;
/** Phase step between adjacent limb pairs — the metachronal wave down the body. */
const METACHRONAL_LAG = 0.8;

function buildCrawler(params: BodyParams, out: BodyGeometry): void {
  const segments = clampSegments('armoredCrawler', params.segmentCount);
  const finPairs = clampFinPairs('armoredCrawler', params.finPairs);
  const aspect = clampBodyAspect('armoredCrawler', params.bodyAspect);
  const maxHalfWidth = 1 / (2 * aspect);
  out.maxHalfWidth = maxHalfWidth;

  // One extra chain point so there are exactly `segments` somite gaps.
  const chain = out.chain;
  buildTrunkChain(params, segments + 1, maxHalfWidth, chain);
  offsetOutline(chain, maxHalfWidth, carapaceProfile, out.outline);
  placeEye(chain, maxHalfWidth, carapaceProfile, out);

  const n = chain.count;
  for (let p = 0; p < segments; p += 1) {
    const plate = out.plates[out.plateCount];
    if (plate === undefined) break;
    plate.count = 0;
    const cx = ((chain.xs[p] ?? 0) + (chain.xs[p + 1] ?? 0)) / 2;
    const cy = ((chain.ys[p] ?? 0) + (chain.ys[p + 1] ?? 0)) / 2;
    const tx = Math.cos(chain.angles[p] ?? 0);
    const ty = Math.sin(chain.angles[p] ?? 0);
    const along = chain.segmentLength * PLATE_OVERLAP;
    const across = maxHalfWidth * carapaceProfile((p + 0.5) / segments) * PLATE_INSET;
    for (let k = 0; k < PLATE_CAPACITY; k += 1) {
      const theta = (2 * Math.PI * k) / PLATE_CAPACITY;
      const a = along * Math.cos(theta);
      const b = across * Math.sin(theta);
      push(plate, cx + tx * a - ty * b, cy + ty * a + tx * b);
    }
    out.plateCount += 1;
  }

  const limbLength = 0.16 + 0.5 * maxHalfWidth;
  for (let pair = 0; pair < finPairs; pair += 1) {
    const at = Math.max(1, Math.min(n - 2, Math.round(((pair + 0.5) / finPairs) * (n - 1))));
    const sweep = LIMB_SWEEP * Math.sin(params.phase - pair * METACHRONAL_LAG);
    const half = Math.max(maxHalfWidth * carapaceProfile(at / (n - 1)), maxHalfWidth * 0.2);
    const tx = Math.cos(chain.angles[at] ?? 0);
    const ty = Math.sin(chain.angles[at] ?? 0);
    for (let side = 0; side < 2; side += 1) {
      const sign = side === 0 ? 1 : -1;
      const limb = out.strokes[out.strokeCount];
      if (limb === undefined) break;
      limb.count = 0;
      const nx = (chain.nxs[at] ?? 0) * sign;
      const ny = (chain.nys[at] ?? 0) * sign;
      const ax = (chain.xs[at] ?? 0) + nx * half;
      const ay = (chain.ys[at] ?? 0) + ny * half;
      const cs = Math.cos(sweep * sign);
      const sn = Math.sin(sweep * sign);
      const dx = nx * cs + tx * sn;
      const dy = ny * cs + ty * sn;
      push(limb, ax, ay);
      push(limb, ax + dx * limbLength * 0.55, ay + dy * limbLength * 0.55);
      push(limb, ax + dx * limbLength + tx * limbLength * 0.25 * sn, ay + dy * limbLength + ty * limbLength * 0.25 * sn);
      out.strokeCount += 1;
    }
  }

  const midline = out.strokes[out.strokeCount];
  if (midline !== undefined) {
    midline.count = 0;
    for (let i = 0; i < n; i += 1) push(midline, chain.xs[i] ?? 0, chain.ys[i] ?? 0);
    out.strokeCount += 1;
  }
}
