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
import type { PatternFamily } from './divergence';
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
const PLATE_POINTS = 8;
/** Points per drifter tentacle polyline. */
const TENTACLE_POINTS = 5;
/** Crawler worst case: `2 * finPairs` limbs (10) plus the dorsal midline. */
const MAX_STROKES = 24;
/** The crawler midline runs the whole chain: `segmentCount + 1` points. */
const STROKE_CAPACITY = 32;
/** Nose, jaw corner, gape corner. The diet read at the near tier. */
export const MOUTH_POINTS = 3;
/**
 * Species pattern marks, always this many whatever the family.
 *
 * Fixed because {@link nearVertexCount} is the layer's budgeting currency and
 * only sees `(archetype, segmentCount, finPairs)` — a mark count that varied
 * with the species tag would make the budget wrong for exactly the animals it
 * was protecting. The `none` family emits its marks and reports
 * `patternWidth === 0`, so the points are billed and nothing is drawn.
 */
export const PATTERN_MARKS = 3;
/** Every mark is one straight two-point run, stroked with a round cap. */
const PATTERN_POINTS = 2;

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
  /** The jaw line, on the trunk archetypes only; `hasMouth` says whether it was built. */
  readonly mouth: Polyline;
  hasMouth: boolean;
  /** Species marks: always {@link PATTERN_MARKS} two-point runs, drawn only when `patternWidth > 0`. */
  readonly patterns: Polyline[];
  patternCount: number;
  /** Stroke weight for the pattern marks, local units. Zero for the `none` family. */
  patternWidth: number;
  /** 0..1 dorsal spination, already folded into the outline; the tiers use it for stroke weight. */
  spination: number;
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
  for (let i = 0; i < MAX_PLATES; i += 1) plates.push(createPolyline(PLATE_POINTS, true));
  const strokes: Polyline[] = [];
  for (let i = 0; i < MAX_STROKES; i += 1) strokes.push(createPolyline(STROKE_CAPACITY, false));
  const patterns: Polyline[] = [];
  for (let i = 0; i < PATTERN_MARKS; i += 1) patterns.push(createPolyline(PATTERN_POINTS, false));
  return {
    archetype: 'undulator',
    outline: createPolyline(OUTLINE_CAPACITY, true),
    fins,
    finCount: 0,
    plates,
    plateCount: 0,
    strokes,
    strokeCount: 0,
    mouth: createPolyline(MOUTH_POINTS, false),
    hasMouth: false,
    patterns,
    patternCount: 0,
    patternWidth: 0,
    spination: 0,
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

/**
 * Total points a near-tier body will emit — the currency the layer budgets in.
 *
 * Exact, not an estimate: `bodies.test.ts` asserts it against the built
 * geometry for every morphology in every archetype's range, so it cannot drift
 * as the shapes change.
 *
 * It has to exist because body cost is **not** uniform. Measured CPU cost is
 * near-linear in this number, and it spans 25× across the morphology space — a
 * minimal undulator emits 15 points, a maximal crawler 378, because somite count
 * is literally the crawler's morphology signal. Budgeting a fixed *number of
 * bodies* therefore either starves a fish-heavy world or blows the frame in a
 * crawler-heavy one, and which of those happens is decided by evolution at run
 * time.
 */
export function nearVertexCount(
  archetype: CladeArchetype,
  segmentCount: number,
  finPairs: number,
): number {
  const s = clampSegments(archetype, segmentCount);
  const f = clampFinPairs(archetype, finPairs);
  // Species marks are archetype-independent, and the jaw line is a trunk
  // feature; both are emitted unconditionally so that this stays a function of
  // the three arguments it advertises.
  const marks = PATTERN_MARKS * PATTERN_POINTS;
  switch (archetype) {
    case 'undulator':
      return outlinePointCount(archetype, s) + 2 * f * 3 + MOUTH_POINTS + marks;
    case 'radialDrifter':
      return outlinePointCount(archetype, s) + s * 2 + 2 * f * TENTACLE_POINTS + marks;
    case 'armoredCrawler':
      return outlinePointCount(archetype, s) + s * PLATE_POINTS + 2 * f * 3 + (s + 1) + MOUTH_POINTS + marks;
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
// Diet → head form, defense → dorsal spination
// ---------------------------------------------------------------------------

/** Fraction of the body over which the head form reshapes the width profile. */
const HEAD_WINDOW = 0.4;
/**
 * 1 is the ceiling, not a taste call: at the nose the window is 1, so the
 * exponent reaches `1 − HEAD_EXP_GAIN` there, and anything above 1 turns it
 * negative — which would push the snout *wider* than the widest station and
 * break the invariant that the head form cannot inflate a body past its
 * `bodyAspect`. At exactly 1 the bluntest possible head is a nose as wide as the
 * shoulders, which is the right maximum for a filter feeder.
 */
const HEAD_EXP_GAIN = 1;

/**
 * The width profile with the diet-driven head form folded in.
 *
 * Reshaping is an *exponent* on the base profile rather than a multiplier,
 * because the base is in (0, 1]: raising it to a power below 1 fills the snout
 * out toward the widest station (the blunt filter-feeder head) and a power above
 * 1 starves it into a wedge (the predatory taper). Two consequences that a
 * multiplier would not give for free — it is strictly monotone in `headForm`
 * (so the drawn head order is the diet order, with no discontinuity at diet 0,
 * where the exponent is exactly 1), and it cannot push a station past the base
 * profile's peak, so the head form can never widen a fish past its `bodyAspect`.
 *
 * The window ramps the exponent to 1 by `HEAD_WINDOW`, which is what keeps the
 * effect a *head* form: the tail is also thin, and shaping it would just make
 * hunters read as thin animals rather than as sharp-headed ones.
 */
export function headShapedProfile(s: number, base: number, headForm: number): number {
  if (base <= 0 || base >= 1 || s >= HEAD_WINDOW || headForm === 0) return base;
  return Math.pow(base, 1 + HEAD_EXP_GAIN * headForm * (1 - s / HEAD_WINDOW));
}

/**
 * Extra dorsal half-width on alternating stations at full spination.
 *
 * The serration is folded into the outline rather than drawn as separate spikes
 * so that a heavily defended animal costs the same points as a smooth one and
 * the budget stays a function of the morphology channels alone. Displacing one
 * side outward cannot fold an outline that was already simple, but it does
 * enlarge the offset the travelling wave has to clear, so `bodies.test.ts`
 * sweeps this against the self-crossing check rather than reasoning about it.
 */
const SERRATION_GAIN = 0.45;

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
  /** −1 blunt filter feeder … 0 neutral fusiform … +1 predatory wedge. */
  readonly headForm: number;
  /** 0..1 dorsal spination; see `divergence.spinationFrom`. */
  readonly spination: number;
  readonly patternFamily: PatternFamily;
  /** 0..1, stable per slot: shifts the species marks so schoolmates are not stencils. */
  readonly patternPhase: number;
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
  out.mouth.count = 0;
  out.hasMouth = false;
  out.patternCount = 0;
  out.pulseScale = 1;
  out.spination = clamp(params.spination, 0, 1);
  out.patternWidth = PATTERN_WIDTH[params.patternFamily];
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

/** Half-width at chain station `i`, head form included but spination excluded. */
function trunkHalfWidth(
  chain: SpineChain,
  i: number,
  maxHalfWidth: number,
  profile: (s: number) => number,
  headForm: number,
): number {
  const s = i / (chain.count - 1);
  return maxHalfWidth * headShapedProfile(s, profile(s), headForm);
}

/**
 * Offset the chain into a closed outline: the zero-width nose once, the dorsal
 * side head→tail, then the ventral side tail→head. `2N − 2` points for an `N`
 * point chain, whatever the head form or the spination — both reshape existing
 * stations rather than adding any.
 *
 * The `+normal` side is dorsal: the chain runs head→tail toward −x, so the
 * left-hand normal of the tail-ward tangent points at −y, which is up on screen.
 * That is the side the spines go on and the side the jaw is measured against.
 */
function offsetOutline(
  chain: SpineChain,
  maxHalfWidth: number,
  profile: (s: number) => number,
  headForm: number,
  spination: number,
  out: Polyline,
): void {
  const n = chain.count;
  push(out, chain.xs[0] ?? 0, chain.ys[0] ?? 0);
  for (let i = 1; i < n; i += 1) {
    const spike = i % 2 === 1 ? 1 + SERRATION_GAIN * spination : 1;
    const h = trunkHalfWidth(chain, i, maxHalfWidth, profile, headForm) * spike;
    push(out, (chain.xs[i] ?? 0) + (chain.nxs[i] ?? 0) * h, (chain.ys[i] ?? 0) + (chain.nys[i] ?? 0) * h);
  }
  for (let i = n - 2; i >= 1; i -= 1) {
    const h = trunkHalfWidth(chain, i, maxHalfWidth, profile, headForm);
    push(out, (chain.xs[i] ?? 0) - (chain.nxs[i] ?? 0) * h, (chain.ys[i] ?? 0) - (chain.nys[i] ?? 0) * h);
  }
}

/**
 * Place the eye at a *continuous* station along the chain.
 *
 * Snapping to the nearest chain point was the first attempt and it inverted the
 * read it exists for: a hunter's eye slides forward onto the narrow part of the
 * snout, so rounding it a whole station forward on a 14-point chain shrank it
 * faster than the size multiplier grew it, and predators ended up beadier-eyed
 * than filter feeders. Interpolating between stations makes the size a smooth
 * function of the head form and lets the multiplier win, which is also what the
 * continuity through diet 0 needs.
 */
function placeEye(
  chain: SpineChain,
  maxHalfWidth: number,
  profile: (s: number) => number,
  headForm: number,
  out: BodyGeometry,
): void {
  const n = chain.count;
  // A hunter's eye sits further forward as well as bigger — the two together are
  // what read as a face pointed at something rather than as a larger fish.
  const at = clamp(0.12 - 0.03 * headForm, 0.02, 0.9);
  const f = at * (n - 1);
  const i = Math.max(0, Math.min(n - 2, Math.floor(f)));
  const t = f - i;
  const cx = (chain.xs[i] ?? 0) + ((chain.xs[i + 1] ?? 0) - (chain.xs[i] ?? 0)) * t;
  const cy = (chain.ys[i] ?? 0) + ((chain.ys[i + 1] ?? 0) - (chain.ys[i] ?? 0)) * t;
  const nx = (chain.nxs[i] ?? 0) + ((chain.nxs[i + 1] ?? 0) - (chain.nxs[i] ?? 0)) * t;
  const ny = (chain.nys[i] ?? 0) + ((chain.nys[i + 1] ?? 0) - (chain.nys[i] ?? 0)) * t;
  const h = maxHalfWidth * headShapedProfile(at, profile(at), headForm);
  out.eyeX = cx + nx * h * 0.45;
  out.eyeY = cy + ny * h * 0.45;
  out.eyeR = clamp(0.34 * h * (1 + 0.45 * headForm), 0.011, 0.062);
}

// ---------------------------------------------------------------------------
// The jaw line
// ---------------------------------------------------------------------------

/** Jaw length in body lengths at neutral diet. */
const MOUTH_SPAN = 0.17;

/**
 * The mouth, as a three-point ventral polyline anchored at the nose.
 *
 * Always built for the trunk archetypes, with every dimension linear in
 * `headForm`, so nothing appears or vanishes as a lineage crosses diet 0 — the
 * filter feeder's short shallow slit grows continuously into the hunter's long
 * gape, and the kink at the middle point is the tooth notch.
 */
function buildMouth(chain: SpineChain, maxHalfWidth: number, headForm: number, out: BodyGeometry): void {
  const x0 = chain.xs[0] ?? 0;
  const y0 = chain.ys[0] ?? 0;
  const angle = chain.angles[0] ?? 0;
  // Tail-ward tangent and the ventral normal (the `−normal` side of the outline).
  const tx = Math.cos(angle);
  const ty = Math.sin(angle);
  const nx = -(chain.nxs[0] ?? 0);
  const ny = -(chain.nys[0] ?? 0);
  const length = MOUTH_SPAN * (0.85 + 0.45 * headForm);
  const drop = maxHalfWidth * (0.5 + 0.42 * headForm);
  const mouth = out.mouth;
  mouth.count = 0;
  push(mouth, x0, y0);
  push(mouth, x0 + tx * length * 0.52 + nx * drop, y0 + ty * length * 0.52 + ny * drop);
  push(mouth, x0 + tx * length + nx * drop * 0.3, y0 + ty * length + ny * drop * 0.3);
  out.hasMouth = true;
}

// ---------------------------------------------------------------------------
// Species patterning
// ---------------------------------------------------------------------------

/** Stroke weight per family, local units. `none` is the switch that skips the draw. */
const PATTERN_WIDTH: Readonly<Record<PatternFamily, number>> = {
  none: 0,
  stripes: 0.05,
  spots: 0.085,
  // Wide enough that the three marks overlap into one dorsal wash rather than
  // reading as three fat stripes.
  countershading: 0.24,
};

/** Where along the body each mark sits, before the per-slot phase shift. */
const PATTERN_STATIONS: Readonly<Record<PatternFamily, readonly [number, number, number]>> = {
  none: [0.26, 0.45, 0.64],
  stripes: [0.26, 0.45, 0.64],
  spots: [0.28, 0.46, 0.64],
  countershading: [0.22, 0.44, 0.66],
};

/** Marks are placed inside the fat part of the body, so a stroke cannot spill past the silhouette. */
const PATTERN_S_MIN = 0.16;
const PATTERN_S_MAX = 0.8;
const PATTERN_PHASE_SWING = 0.05;

function patternStation(family: PatternFamily, mark: number, phase: number): number {
  const base = PATTERN_STATIONS[family][mark] ?? 0.45;
  return clamp(base + (phase - 0.5) * PATTERN_PHASE_SWING, PATTERN_S_MIN, PATTERN_S_MAX);
}

/**
 * Species marks on a trunk body, as {@link PATTERN_MARKS} two-point runs.
 *
 * One representation for every family — a straight run with a per-family stroke
 * weight — because a round-capped thick stroke is a spot, a thin one across the
 * body is a stripe, and three overlapping wide ones down the dorsal half are
 * countershading. Sharing the representation is what lets the point cost be
 * constant across families, which the near-tier budget depends on.
 */
function buildTrunkPatterns(
  chain: SpineChain,
  maxHalfWidth: number,
  profile: (s: number) => number,
  headForm: number,
  family: PatternFamily,
  phase: number,
  out: BodyGeometry,
): void {
  const n = chain.count;
  for (let mark = 0; mark < PATTERN_MARKS; mark += 1) {
    const line = out.patterns[mark];
    if (line === undefined) break;
    line.count = 0;
    const s = patternStation(family, mark, phase);
    const i = Math.max(1, Math.min(n - 2, Math.round(s * (n - 1))));
    const h = trunkHalfWidth(chain, i, maxHalfWidth, profile, headForm);
    const cx = chain.xs[i] ?? 0;
    const cy = chain.ys[i] ?? 0;
    const nx = chain.nxs[i] ?? 0;
    const ny = chain.nys[i] ?? 0;
    if (family === 'spots') {
      // Alternating flanks, and a stub along the body so a round cap reads as a dot.
      const side = mark % 2 === 0 ? 1 : -1;
      const ox = cx + nx * h * 0.42 * side;
      const oy = cy + ny * h * 0.42 * side;
      const tx = Math.cos(chain.angles[i] ?? 0) * 0.02;
      const ty = Math.sin(chain.angles[i] ?? 0) * 0.02;
      push(line, ox - tx, oy - ty);
      push(line, ox + tx, oy + ty);
    } else if (family === 'countershading') {
      push(line, cx + nx * h * 0.14, cy + ny * h * 0.14);
      push(line, cx + nx * h * 0.94, cy + ny * h * 0.94);
    } else {
      push(line, cx - nx * h * 0.78, cy - ny * h * 0.78);
      push(line, cx + nx * h * 0.78, cy + ny * h * 0.78);
    }
    out.patternCount += 1;
  }
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
  offsetOutline(chain, maxHalfWidth, fusiformProfile, params.headForm, out.spination, out.outline);
  placeEye(chain, maxHalfWidth, fusiformProfile, params.headForm, out);
  buildMouth(chain, maxHalfWidth, params.headForm, out);
  buildTrunkPatterns(
    chain,
    maxHalfWidth,
    fusiformProfile,
    params.headForm,
    params.patternFamily,
    params.patternPhase,
    out,
  );

  const n = chain.count;
  for (let pair = 0; pair < finPairs; pair += 1) {
    const at = Math.max(1, Math.min(n - 2, Math.round(((pair + 1) / (finPairs + 1)) * (n - 1))));
    const flutter = FIN_FLUTTER * Math.sin(params.phase - pair * FIN_PHASE_LAG);
    const half = Math.max(
      trunkHalfWidth(chain, at, maxHalfWidth, fusiformProfile, params.headForm),
      maxHalfWidth * 0.15,
    );
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

/**
 * The same three marks on a bell instead of a chain. The superellipse is even in
 * `theta`, so the chord at ±θ is horizontal and a mark is a straight run in y —
 * the same two-point representation the trunk bodies use.
 */
function buildDrifterPatterns(
  height: number,
  width: number,
  family: PatternFamily,
  phase: number,
  out: BodyGeometry,
): void {
  for (let mark = 0; mark < PATTERN_MARKS; mark += 1) {
    const line = out.patterns[mark];
    if (line === undefined) break;
    line.count = 0;
    const u = clamp(0.28 + 0.22 * mark + (phase - 0.5) * 0.08, 0.16, 0.84);
    const theta = Math.PI * u;
    const x = bellRimX(theta, height);
    const y = Math.abs(bellRimY(theta, width));
    if (family === 'spots') {
      const side = mark % 2 === 0 ? 1 : -1;
      push(line, x - 0.02, y * 0.45 * side);
      push(line, x + 0.02, y * 0.45 * side);
    } else if (family === 'countershading') {
      push(line, x, y * 0.14);
      push(line, x, y * 0.94);
    } else {
      push(line, x, -y * 0.78);
      push(line, x, y * 0.78);
    }
    out.patternCount += 1;
  }
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

  buildDrifterPatterns(height, width, params.patternFamily, params.patternPhase, out);

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
  offsetOutline(chain, maxHalfWidth, carapaceProfile, params.headForm, out.spination, out.outline);
  placeEye(chain, maxHalfWidth, carapaceProfile, params.headForm, out);
  buildMouth(chain, maxHalfWidth, params.headForm, out);
  buildTrunkPatterns(
    chain,
    maxHalfWidth,
    carapaceProfile,
    params.headForm,
    params.patternFamily,
    params.patternPhase,
    out,
  );

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
    const sp = (p + 0.5) / segments;
    const across = maxHalfWidth * headShapedProfile(sp, carapaceProfile(sp), params.headForm) * PLATE_INSET;
    for (let k = 0; k < PLATE_POINTS; k += 1) {
      const theta = (2 * Math.PI * k) / PLATE_POINTS;
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
    const half = Math.max(
      trunkHalfWidth(chain, at, maxHalfWidth, carapaceProfile, params.headForm),
      maxHalfWidth * 0.2,
    );
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
