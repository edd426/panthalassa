/**
 * Render-wave seam (Phase B, R0) — the contracts R1 (shell/camera/LOD),
 * R2 (creatures) and R3 (ambience) compile against so they can build
 * concurrently without importing each other. The import rule that keeps the
 * parallel build honest: R2/R3 may import only this module,
 * `./fieldSampling`, `src/contracts/**`, `src/app/palette` and `pixi.js`.
 *
 * Everything here is presentation. Wall-clock time and `Math.random` are legal
 * in `src/render/**` (see eslint.config.js) because nothing flows back into
 * the sim; all sim data arrives read-only through the worker protocol.
 *
 * The `ColourMode`/`Frame` family moved here from `crudeRenderer.ts`, which
 * re-exports them so existing imports keep working until R1/R4 rewire them.
 */

import type { Container, Texture } from 'pixi.js';
import type { SimEvent } from '../contracts/events';
import type { CladeArchetype } from '../contracts/genome';
import { CLADE_ARCHETYPES, CLADE_SCHEMA } from '../contracts/genome';
import type { FieldSliceField } from '../contracts/protocol';
import type { TraitKey } from '../contracts/traits';
import type { SimConfig } from '../contracts/types';

// ---------------------------------------------------------------------------
// Types moved from crudeRenderer.ts (unchanged semantics)
// ---------------------------------------------------------------------------

/**
 * How the creatures are coloured. `identity` is the only mode where colour is
 * a property of the animal (its `displayHue`, simultaneously mating signal and
 * predator search image) rather than a measurement of it.
 */
export type ColourMode =
  | 'identity'
  | 'adaptedness'
  | 'speedCap'
  | 'diet'
  | 'defense'
  | 'toxicity'
  | 'boldness'
  | 'energy';

// The measurement modes are kept contiguous and `energy` stays last, so the
// `c` cycle runs identity → the six readings → condition → back.
export const COLOUR_MODES: readonly ColourMode[] = [
  'identity',
  'adaptedness',
  'speedCap',
  'diet',
  'defense',
  'toxicity',
  'boldness',
  'energy',
];

/** The trait channel each mode needs from the slice, or null when it needs none. */
export function traitKeyForMode(mode: ColourMode): TraitKey | null {
  switch (mode) {
    case 'adaptedness':
      return 'tOpt';
    case 'speedCap':
      return 'speedCap';
    case 'diet':
      return 'diet';
    case 'defense':
      return 'defense';
    case 'toxicity':
      return 'toxicity';
    case 'boldness':
      // The mode is named for what the watcher is looking at, the trait for
      // what the sim reads: exposure to open water rather than kelp cover.
      return 'forageBoldness';
    case 'identity':
    case 'energy':
      return null;
  }
}

/** What the HUD prints under the mode name so the ramp is never colour-alone. */
export interface ColourLegend {
  readonly mode: ColourMode;
  readonly description: string;
  /** Low → high labels for a sequential ramp, or cool → neutral → warm for a diverging one. */
  readonly stops: readonly string[];
}

/** Field underlays the `f` key cycles through. */
export type FieldOverlay = 'off' | FieldSliceField;

export const FIELD_OVERLAYS: readonly FieldOverlay[] = ['off', 'plankton', 'kelp', 'temperature', 'carrion'];

/** A sample slice held on the main thread; `buffer` is the transferred one. */
export interface SliceView {
  readonly count: number;
  readonly buffer: Float32Array;
  /** Expressed values of `traitKey`, organism-aligned with `buffer`. */
  readonly traitValues?: Float32Array;
  readonly traitKey?: TraitKey;
  /** Sim tick the slice was taken at — lets the interpolator skip identical-tick slices while paused. */
  readonly tick?: number;
}

/**
 * One overlay raster, straight off a `fieldSlice` reply. The message carries
 * its own grid shape, so nothing here re-derives the field geometry from
 * config — the worker is the only party that knows it.
 */
export interface FieldRaster {
  readonly field: FieldSliceField;
  readonly cols: number;
  readonly rows: number;
  readonly cellSizeWu: number;
  readonly values: Float32Array;
}

export interface Frame {
  readonly slice: SliceView | null;
  readonly overlay: FieldOverlay;
  readonly field: FieldRaster | null;
  /** World position of the inspected organism, for the selection halo. */
  readonly selected: { readonly x: number; readonly y: number } | null;
  readonly colourMode: ColourMode;
  /** Temperature raster, needed by `adaptedness` whether or not it is the overlay. */
  readonly temperature: FieldRaster | null;
  /** Ambience feeds (Phase B); may lag the sim by a couple of seconds. */
  readonly plankton?: FieldRaster | null;
  readonly kelp?: FieldRaster | null;
  /** Current watch speed (0 = paused); the LOD speed criterion reads this. */
  readonly speedMultiplier?: number;
  /** True while the watch is paused; spares the renderer inferring it from slice staleness. */
  readonly paused?: boolean;
}

// ---------------------------------------------------------------------------
// Shared presentation constants
// ---------------------------------------------------------------------------

/** World units per cm of body length: a 12 cm fish spans ≈ 8 wu of ocean. */
export const CM_TO_WU = 0.66;

export const MAX_SLOTS = 4096;

/**
 * Presentation clamp for `armorPlating`, which unlike the other three
 * morphology channels has no per-archetype `renderRange` in `CLADE_SCHEMA`
 * (it is a shared softplus trait, baseline ≈ 0.35, crawler shift +0.8).
 */
export const ARMOR_RENDER_RANGE: readonly [number, number] = [0, 2.5];

/** The abyss the sea is drawn on; matches the page background in `index.html`. */
export const ABYSS_COLOUR = 0x03151d;

/**
 * Expressed `conspicuousness` per unit of drawn signal.
 *
 * The trait is identity-linked, baseline 0, and unbounded in both directions —
 * negative is cryptic, positive is loud. G3's 45-generation cliff runs put
 * population means at +1.69 / +1.08 / −0.10, so ±1.6 maps to ±0.66 and the
 * measured range uses two thirds of the axis with the tails still climbing.
 */
export const CONSPICUOUSNESS_SCALE = 1.6;

/**
 * Expressed conspicuousness → a signed drawn signal in (−1, 1).
 *
 * `tanh` rather than a clamp, for the reason `divergence.headFormFromDiet`
 * gives for diet: the trait is unbounded and ratchets, so the drawing has to
 * saturate smoothly or a lineage that keeps getting louder pops at the edge of
 * the range. Exactly 0 at 0, strictly monotone, and odd — which together are
 * what make every mapping downstream centred, so an animal at the baseline
 * draws exactly as it did before this channel existed.
 */
export function conspicuousnessSignal(conspicuousness: number): number {
  if (conspicuousness === 0) return 0;
  return Math.tanh(conspicuousness / CONSPICUOUSNESS_SCALE);
}

/**
 * Expressed `forageBoldness` per unit of the diverging `boldness` ramp.
 *
 * One log-multiplier, because that is the trait's own unit: exposure enters
 * intake and predation risk as `exp(forageBoldness)`, so ±1 is an e-fold more
 * or less time spent in open water rather than under kelp. An absolute scale
 * and not a p5–p95 window, for the reason `adaptedness` uses a fixed thermal
 * reference: on a diverging ramp the *sign* is the reading, and a window that
 * re-centres itself every slice would paint a population that had gone
 * uniformly bold as though half of it were still timid.
 *
 * Measured against the founding spread (seed s1, 600 founders): p5–p95 spans
 * −1.03 to +1.10, SD 0.65, so the tails saturate the ramp and the middle sits
 * in the neutral band. By generation 60 of an aposematism run the mean has
 * walked to +0.72 — the whole shoal reading warm, which is exactly the
 * population-level move an absolute scale exists to show.
 */
export const BOLDNESS_SCALE = 1;

/** Expressed `forageBoldness` → the signed position on the diverging ramp. */
export function boldnessSignal(forageBoldness: number): number {
  return forageBoldness / BOLDNESS_SCALE;
}

/**
 * True for a measurement mode whose axis this world is not running.
 *
 * `toxicity` is read by the ecology only with `toggles.enableAposematism`, but
 * the trait is on every genome regardless and carries real standing variance:
 * measured off-arm at founding, p5–p95 spans 0.02–0.37 and drifts to 0.21–0.78
 * by generation 20. Ramping over that would draw a chemical-defence axis the
 * world does not have — the same trap the colour map avoids for
 * `conspicuousness` — so the mode paints one flat neutral and says why in its
 * legend instead of inventing a spread.
 */
export function isInertMode(mode: ColourMode, config: SimConfig): boolean {
  return mode === 'toxicity' && !config.toggles.enableAposematism;
}

/**
 * `lifeStage` is a flag, not a ramp: 1 is mature, 0 is a juvenile (the age
 * floor, plus the length floor when ontogeny is on). Read through a threshold
 * rather than compared to 0 so a channel that ever carries an intermediate —
 * an old-stride slice, a partially written row — still resolves to one of the
 * two states the sim actually has.
 */
export function isJuvenile(lifeStage: number): boolean {
  return lifeStage < 0.5;
}

// ---------------------------------------------------------------------------
// The outward-facing renderer API (main.ts talks to this; the crude fallback
// is wrapped to satisfy it too)
// ---------------------------------------------------------------------------

export interface WorldRenderer {
  draw(frame: Frame): void;
  resize(): void;
  toWorld(clientX: number, clientY: number): { x: number; y: number };
  readonly pixelsPerWu: number;
  readonly colourLegend: ColourLegend;
  /** Narrative events from `ticked`/`events` pushes; the renderer stamps arrival time. */
  pushEvents(events: readonly SimEvent[]): void;
  /** New world (reseed): clear ghosts, flourishes and interpolator state. */
  reset(): void;
  /** True when the click that just fired was actually the end of a drag-pan. */
  isDragClick(event: MouseEvent): boolean;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export interface CameraState {
  /** World coordinates of the viewport centre. */
  readonly centerX: number;
  readonly centerY: number;
  /** CSS pixels per world unit. */
  readonly pxPerWu: number;
  /** Viewport size, CSS pixels. */
  readonly viewportW: number;
  readonly viewportH: number;
}

// ---------------------------------------------------------------------------
// LOD
// ---------------------------------------------------------------------------

export const LOD_TIERS = ['near', 'mid', 'far', 'abyss'] as const;

export type LodTier = (typeof LOD_TIERS)[number];

export interface LodState {
  readonly tier: LodTier;
  /** Non-null while a tier cross-fade is in flight. */
  readonly previousTier: LodTier | null;
  /** 0..1 fade-in of `tier` (≈220 ms ramp). */
  readonly blend: number;
}

// ---------------------------------------------------------------------------
// Per-frame creature data (SoA, pooled — mirrors the SAMPLE_SLICE idiom)
// ---------------------------------------------------------------------------

export const POSE_STRIDE = 6;

export const POSE = Object.freeze({
  x: 0,
  y: 1,
  /** Radians; smoothed shortest-arc heading from slice deltas. */
  heading: 2,
  /** Observed speed between slices, wu/s — drives undulation vigour. */
  speed: 3,
  /** 0..1; ramps in on birth (~250 ms), out on a death ghost (~200 ms). */
  fade: 4,
  /** Stable per-slot uniform [0,1): phase offsets and morphology fallback. */
  jitter: 5,
});

export const VISUAL_STRIDE = 12;

export const VISUAL = Object.freeze({
  /** Index into `CLADE_ARCHETYPES`. */
  archetype: 0,
  sizeCm: 1,
  hueDeg: 2,
  // The four morphology channels, renderRange-clamped (real slice values when
  // the stride carries them, `resolveMorphology` fallback otherwise).
  segments: 3,
  finPairs: 4,
  bodyAspect: 5,
  armor: 6,
  speciesTag: 7,
  // Expressed diet and defense, raw and unbounded (contracts v1.6): the two
  // traits with real standing divergence, so bodies can differ where the
  // evolution actually happens. Consumers clamp at draw time.
  diet: 8,
  defense: 9,
  // G-wave (contracts v1.8, G5). `lifeStage` is the 0/1 maturity flag and is
  // never interpolated — a slot whose flag moved is an animal that grew up, or
  // a slot that was reused, and blending the two would draw an animal that is
  // half a juvenile. `conspicuousness` is expressed once at birth and immutable
  // after it, so it needs no interpolation either: a row whose value changed is
  // a different organism, which the continuity test already turns into a birth.
  lifeStage: 10,
  conspicuousness: 11,
});

export interface CreatureFrame {
  readonly count: number;
  /** `count * POSE_STRIDE`. */
  readonly poses: Float32Array;
  /** `count * VISUAL_STRIDE`. */
  readonly visuals: Float32Array;
  /** 0xRRGGBB per row — the active colour mode is already resolved here. */
  readonly tints: Uint32Array;
  /** Energy-condition alpha per row (0.3 floor, matching the crude renderer). */
  readonly alphas: Float32Array;
  /** Row indices inside the padded viewport, sorted by sizeCm ascending. */
  readonly visible: Uint16Array;
  readonly visibleCount: number;
}

/** Decoded per-creature view for near-tier body builds; filled in place. */
export interface CreatureVisual {
  archetype: CladeArchetype;
  sizeCm: number;
  hueDeg: number;
  segmentCount: number;
  finPairs: number;
  bodyAspect: number;
  armorPlating: number;
  /** Expressed diet logit; negative grazes, positive hunts. Unclamped. */
  diet: number;
  /** Expressed defense; unclamped. */
  defense: number;
  /** 1 mature, 0 juvenile. Defaults to 1, so a missing channel draws an adult. */
  lifeStage: number;
  /** Expressed signal amplitude; negative is cryptic. Unclamped — see {@link conspicuousnessSignal}. */
  conspicuousness: number;
  tint: number;
  alpha: number;
  jitter: number;
  heading: number;
  speed: number;
  fade: number;
}

export function archetypeFromIndex(index: number): CladeArchetype {
  return CLADE_ARCHETYPES[Math.max(0, Math.min(CLADE_ARCHETYPES.length - 1, Math.round(index)))] ?? 'undulator';
}

/** Decode one row of a `CreatureFrame` into `out` without allocating. */
export function readCreatureVisual(frame: CreatureFrame, row: number, out: CreatureVisual): void {
  const p = row * POSE_STRIDE;
  const v = row * VISUAL_STRIDE;
  out.archetype = archetypeFromIndex(frame.visuals[v + VISUAL.archetype] ?? 0);
  out.sizeCm = frame.visuals[v + VISUAL.sizeCm] ?? 0;
  out.hueDeg = frame.visuals[v + VISUAL.hueDeg] ?? 0;
  out.segmentCount = frame.visuals[v + VISUAL.segments] ?? 0;
  out.finPairs = frame.visuals[v + VISUAL.finPairs] ?? 0;
  out.bodyAspect = frame.visuals[v + VISUAL.bodyAspect] ?? 1;
  out.armorPlating = frame.visuals[v + VISUAL.armor] ?? 0;
  out.diet = frame.visuals[v + VISUAL.diet] ?? 0;
  out.defense = frame.visuals[v + VISUAL.defense] ?? 0;
  out.lifeStage = frame.visuals[v + VISUAL.lifeStage] ?? 1;
  out.conspicuousness = frame.visuals[v + VISUAL.conspicuousness] ?? 0;
  out.tint = frame.tints[row] ?? 0xffffff;
  out.alpha = frame.alphas[row] ?? 1;
  out.jitter = frame.poses[p + POSE.jitter] ?? 0;
  out.heading = frame.poses[p + POSE.heading] ?? 0;
  out.speed = frame.poses[p + POSE.speed] ?? 0;
  out.fade = frame.poses[p + POSE.fade] ?? 1;
}

export interface MorphologyValues {
  segments: number;
  finPairs: number;
  bodyAspect: number;
  armor: number;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * Morphology channels for one organism, clamped to the archetype's
 * `CLADE_SCHEMA` renderRange (the presentation clamp: the trait keeps evolving
 * underneath, the drawing saturates at the range edge). `real` comes from the
 * widened sample slice; when null (an old-stride slice), the fallback is the
 * archetype typical spread deterministically by the slot's jitter, so a
 * population still shows variety rather than clones.
 */
export function resolveMorphology(
  archetypeIndex: number,
  jitter: number,
  real: MorphologyValues | null,
  out: MorphologyValues,
): void {
  const schema = CLADE_SCHEMA[archetypeFromIndex(archetypeIndex)];
  const seg = schema.segmentCount.renderRange;
  const fin = schema.finPairs.renderRange;
  const aspect = schema.bodyAspect.renderRange;
  if (real !== null) {
    out.segments = clamp(real.segments, seg[0], seg[1]);
    out.finPairs = clamp(real.finPairs, fin[0], fin[1]);
    out.bodyAspect = clamp(real.bodyAspect, aspect[0], aspect[1]);
    out.armor = clamp(real.armor, ARMOR_RENDER_RANGE[0], ARMOR_RENDER_RANGE[1]);
    return;
  }
  const spread = jitter * 2 - 1;
  out.segments = clamp(schema.segmentCount.typical + spread * 0.15 * (seg[1] - seg[0]), seg[0], seg[1]);
  out.finPairs = clamp(schema.finPairs.typical + spread * 0.15 * (fin[1] - fin[0]), fin[0], fin[1]);
  out.bodyAspect = clamp(schema.bodyAspect.typical + spread * 0.15 * (aspect[1] - aspect[0]), aspect[0], aspect[1]);
  out.armor = clamp(0.35 + jitter * 0.3, ARMOR_RENDER_RANGE[0], ARMOR_RENDER_RANGE[1]);
}

// ---------------------------------------------------------------------------
// Layer plumbing
// ---------------------------------------------------------------------------

export interface MountContext {
  /**
   * Fixed z-ordered container slots; a layer adds children only to its own.
   * backdrop/foreground are screen-space; the middle three are world-space
   * (the shell applies the camera transform to them each frame).
   */
  readonly slots: {
    /** Screen-space, behind the world: abyss gradient. [R3] */
    readonly backdrop: Container;
    /** World-space, under creatures: haze, god rays, kelp fronds. [R3] */
    readonly waterBelow: Container;
    /** World-space: the animals. [R2] */
    readonly creatures: Container;
    /** World-space, above creatures: shockwaves, beacons, selection halo. [R3 + R1] */
    readonly waterAbove: Container;
    /** Screen-space, in front: near particulate, vignette. [R3] */
    readonly foreground: Container;
  };
  readonly world: { readonly widthWu: number; readonly heightWu: number };
  /** Read-only sim config (e.g. `thermal` for god-ray direction). Never cache across frames. */
  readonly config: SimConfig;
  /** Render-to-texture for pre-baked flipbooks, silhouettes and glows. */
  generateTexture(source: Container, options?: { resolution?: number }): Texture;
}

export interface AmbientEvent {
  readonly event: SimEvent;
  /** Wall-clock arrival, ms — flourish TTLs decay against this. */
  readonly receivedAtMs: number;
}

export interface FrameContext {
  /** Wall clock, ms. ALL animation phase derives from this, never from sim ticks. */
  readonly nowMs: number;
  readonly dtMs: number;
  readonly camera: CameraState;
  readonly lod: LodState;
  /** Null before the first slice of a world. */
  readonly creatures: CreatureFrame | null;
  readonly colourMode: ColourMode;
  readonly overlay: FieldOverlay;
  /** The diagnostic overlay raster (the `f` key). */
  readonly overlayRaster: FieldRaster | null;
  readonly plankton: FieldRaster | null;
  readonly kelp: FieldRaster | null;
  readonly temperature: FieldRaster | null;
  /** Drained each frame by the shell; capped at 32 per frame. */
  readonly events: readonly AmbientEvent[];
  readonly selected: { readonly x: number; readonly y: number } | null;
  readonly paused: boolean;
  readonly speedMultiplier: number;
  /**
   * Which G-wave axes the sim is actually running, read fresh from
   * `SimConfig.toggles` by the shell every frame (a layer must not cache
   * config — see {@link MountContext.config}).
   *
   * The channels are on the slice whether or not the mechanisms are on, and
   * off-arm they are **not** neutral: `lifeStage` is then only the age test, so
   * 59–100% of a default run reads juvenile while every one of those animals is
   * at full adult length, and `conspicuousness` carries ≈0.29 SD of standing
   * genetic variance that nothing in the sim reads. Drawing either would show
   * the watcher a mechanism that is switched off, so the two mappings are held
   * at their neutral values here instead.
   */
  readonly ontogeny: boolean;
  readonly aposematism: boolean;
}

export interface RenderLayer {
  readonly name: string;
  mount(ctx: MountContext): void;
  /** Once per rAF, before the shell's single `app.render()`. */
  update(frame: FrameContext): void;
  /** Reseed: drop every trace of the previous world. */
  reset(): void;
  destroy(): void;
}
