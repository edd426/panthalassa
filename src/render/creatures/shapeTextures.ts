/**
 * Turning `bodies.ts` geometry into pixels: the shared `Graphics` emitter, and
 * the mount-time bakes (mid-tier flipbooks, far-tier silhouettes, the glow) that
 * run the same emitter into a texture.
 *
 * The emitter lives here rather than in `creatureLayer.ts` so the bakes and the
 * live near tier cannot drift apart — a mid-tier sprite is by construction the
 * same drawing as the near-tier body it fades into, frozen at four phases.
 *
 * ## The baked frame
 *
 * Every baked texture uses one local-frame window, so a single anchor works for
 * all of them and a sprite's `position` is the animal's **head**, matching the
 * near tier. The window is wider than the body because a drifter's tentacles
 * trail past `x = −1` and a fluttering fin overhangs the flanks.
 */

import { FillGradient, Graphics, Texture } from 'pixi.js';
import type { MountContext } from '../contracts';
import type { CladeArchetype } from '../../contracts/genome';
import { CLADE_ARCHETYPES, CLADE_SCHEMA } from '../../contracts/genome';
import type { BodyGeometry, BodyParams, Polyline } from './bodies';
import { buildBody, createBodyGeometry } from './bodies';
import {
  ASPECT_BUCKETS,
  FLIPBOOK_VARIANTS,
  aspectForBucket,
  decodeFlipbookVariant,
  headFormForBucket,
  patternFamilyForBucket,
} from './divergence';

// ---------------------------------------------------------------------------
// The baked local-frame window
// ---------------------------------------------------------------------------

const FRAME_X_MIN = -1.5;
const FRAME_X_MAX = 0.15;
const FRAME_Y_MIN = -0.85;
const FRAME_Y_MAX = 0.85;
const FRAME_W = FRAME_X_MAX - FRAME_X_MIN;
const FRAME_H = FRAME_Y_MAX - FRAME_Y_MIN;

/** Sprite anchor that puts the animal's head on its `position`. */
export const BAKED_ANCHOR_X = -FRAME_X_MIN / FRAME_W;
export const BAKED_ANCHOR_Y = -FRAME_Y_MIN / FRAME_H;

/**
 * Bakes are drawn in the **unit local frame** and rasterised through
 * `generateTexture`'s `resolution`, which is therefore texture pixels per body
 * length. The upshot for callers: every baked texture measures 1.65 × 1.7 local
 * units whatever its pixel size, so a sprite's scale is just its body length in
 * world units and nothing has to divide by a bake constant.
 */
export const FLIPBOOK_RESOLUTION = 96;
export const SILHOUETTE_RESOLUTION = 64;
export const GLOW_RESOLUTION = 128;

/** Phases in the mid-tier flipbook. Four is enough to read as motion at that size. */
export const FLIPBOOK_PHASES = 4;

/**
 * Textures baked at mount, and the number to watch.
 *
 * `3 archetypes × 12 variants × 4 phases = 144` flipbook frames, plus one far
 * silhouette per archetype and aspect band (9) and the shared glow: **154**. At
 * {@link FLIPBOOK_RESOLUTION} a frame is ≈158 × 163 px, so the flipbook set is
 * ≈15 MB of VRAM — bounded, paid once at mount, and asserted in
 * `shapeTextures.test.ts` so a variant added without thinking cannot quietly
 * multiply it.
 *
 * The bake is one `generateTexture` per frame and it is the mount's only GPU
 * work; if startup ever needs to come back down, the cheap knob is
 * {@link FLIPBOOK_RESOLUTION} rather than the variant count, because the variants
 * are the whole point and the resolution is a mid-tier sprite 10–40 px long.
 */
export const FLIPBOOK_TEXTURE_COUNT = CLADE_ARCHETYPES.length * FLIPBOOK_VARIANTS * FLIPBOOK_PHASES;
export const SILHOUETTE_TEXTURE_COUNT = CLADE_ARCHETYPES.length * ASPECT_BUCKETS;
export const BAKED_TEXTURE_COUNT = FLIPBOOK_TEXTURE_COUNT + SILHOUETTE_TEXTURE_COUNT + 1;

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

function mixRgb(from: number, to: number, t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const r = ((from >> 16) & 0xff) + (((to >> 16) & 0xff) - ((from >> 16) & 0xff)) * k;
  const g = ((from >> 8) & 0xff) + (((to >> 8) & 0xff) - ((from >> 8) & 0xff)) * k;
  const b = (from & 0xff) + ((to & 0xff) - (from & 0xff)) * k;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

/** The mineral a heavily plated crawler's shell washes toward. */
const MINERAL = 0xb9c4cc;

/** Golden-angle species hue, matching the crude renderer's `speciesStroke`. */
const SPECIES_HUE_STEP_DEG = 137.508;

export function speciesAccentColour(speciesTag: number): number {
  const key = Math.round(speciesTag);
  if (key <= 0) return -1;
  return hslToRgb((key * SPECIES_HUE_STEP_DEG) % 360, 0.95, 0.72);
}

export function hslToRgb(hueDeg: number, saturation: number, lightness: number): number {
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const h = (((hueDeg % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = lightness - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 1) { r = c; g = x; } else if (h < 2) { r = x; g = c; } else if (h < 3) { g = c; b = x; } else if (h < 4) { g = x; b = c; } else if (h < 5) { r = x; b = c; } else { r = c; b = x; }
  return (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255);
}

// ---------------------------------------------------------------------------
// The emitter
// ---------------------------------------------------------------------------

export interface BodyStyle {
  /** Body colour, already resolved upstream by the colour mode. */
  readonly tint: number;
  /** Overall opacity, already multiplied by the birth/death fade. */
  readonly alpha: number;
  /** Species rim accent (identity mode only), or −1 for none. */
  readonly rimTint: number;
}

/** Base outline weight in local units; a body length maps to 1. */
const OUTLINE_STROKE = 0.012;
const RIM_STROKE = 0.016;

function trace(g: Graphics, line: Polyline): boolean {
  if (line.count < 2) return false;
  g.moveTo(line.points[0] ?? 0, line.points[1] ?? 0);
  for (let i = 1; i < line.count; i += 1) {
    g.lineTo(line.points[i * 2] ?? 0, line.points[i * 2 + 1] ?? 0);
  }
  if (line.closed) g.closePath();
  return true;
}

/**
 * Trace `[from, to)` as sub-paths of one path, so a run of same-styled shapes
 * costs one `fill`/`stroke` instead of one each.
 *
 * This is the difference between a crawler costing 22 tessellation batches and
 * costing 5: a 12-somite animal has 12 identically-styled plates, and Pixi
 * charges per fill call, not per vertex. Overlapping plates merge under nonzero
 * winding, which is what the shingled back should look like anyway — the plate
 * strokes are what keep the individual somites readable.
 */
function traceRange(g: Graphics, lines: readonly Polyline[], from: number, to: number): boolean {
  let traced = false;
  for (let i = from; i < to; i += 1) {
    const line = lines[i];
    if (line !== undefined && trace(g, line)) traced = true;
  }
  return traced;
}

/**
 * Emit one body into `g` in the unit local frame. The caller owns `g.clear()`
 * and the position/rotation/scale transform, so the same routine serves the
 * live near tier and the texture bakes.
 */
export function drawBody(g: Graphics, geometry: BodyGeometry, style: BodyStyle): void {
  switch (geometry.archetype) {
    case 'undulator':
      drawUndulator(g, geometry, style);
      return;
    case 'radialDrifter':
      drawDrifter(g, geometry, style);
      return;
    case 'armoredCrawler':
      drawCrawler(g, geometry, style);
      return;
  }
}

function drawEye(g: Graphics, geometry: BodyGeometry, alpha: number): void {
  if (geometry.eyeR <= 0) return;
  g.circle(geometry.eyeX, geometry.eyeY, geometry.eyeR);
  g.fill({ color: 0xf4fbff, alpha: Math.min(1, alpha * 1.2) });
}

function drawRim(g: Graphics, geometry: BodyGeometry, style: BodyStyle): void {
  if (style.rimTint < 0) return;
  if (!trace(g, geometry.outline)) return;
  g.stroke({ color: style.rimTint, alpha: style.alpha * 0.55, width: RIM_STROKE });
}

/**
 * Species marks, over the fill and under the rim. One stroke call for all three:
 * a round cap is what makes the same two-point run serve as a spot, a stripe or
 * a band of countershading, and `patternWidth === 0` is the `none` family.
 */
function drawPatterns(g: Graphics, geometry: BodyGeometry, style: BodyStyle): void {
  if (geometry.patternWidth <= 0) return;
  if (!traceRange(g, geometry.patterns, 0, geometry.patternCount)) return;
  g.stroke({
    color: mixRgb(style.tint, 0x000000, 0.55),
    alpha: style.alpha * 0.5,
    width: geometry.patternWidth,
    cap: 'round',
  });
}

/** The jaw line. Weight rides the head form so a hunter's gape is the darker mark. */
function drawMouth(g: Graphics, geometry: BodyGeometry, style: BodyStyle): void {
  if (!geometry.hasMouth) return;
  if (!trace(g, geometry.mouth)) return;
  g.stroke({
    color: mixRgb(style.tint, 0x000000, 0.6),
    alpha: style.alpha * 0.85,
    width: MOUTH_STROKE,
    cap: 'round',
  });
}

/** Base outline weight, thickened by spination so a serrated back also reads as a hard edge. */
function outlineStroke(geometry: BodyGeometry): number {
  return OUTLINE_STROKE * (1 + 0.9 * geometry.spination);
}

const MOUTH_STROKE = 0.014;

function drawUndulator(g: Graphics, geometry: BodyGeometry, style: BodyStyle): void {
  if (traceRange(g, geometry.fins, 0, geometry.finCount)) {
    g.fill({ color: style.tint, alpha: style.alpha * 0.55 });
  }
  if (trace(g, geometry.outline)) {
    g.fill({ color: style.tint, alpha: style.alpha });
    g.stroke({
      color: mixRgb(style.tint, 0xffffff, 0.45),
      alpha: style.alpha * 0.8,
      width: outlineStroke(geometry),
    });
  }
  drawPatterns(g, geometry, style);
  drawMouth(g, geometry, style);
  drawRim(g, geometry, style);
  drawEye(g, geometry, style.alpha);
}

function drawDrifter(g: Graphics, geometry: BodyGeometry, style: BodyStyle): void {
  // Tentacles and canals sit under the translucent bell, which is the read.
  if (traceRange(g, geometry.strokes, 0, geometry.strokeCount)) {
    g.stroke({ color: mixRgb(style.tint, 0xffffff, 0.3), alpha: style.alpha * 0.45, width: 0.009 });
  }
  if (trace(g, geometry.outline)) {
    g.fill({ color: style.tint, alpha: style.alpha * 0.45 });
    // A drifter has no dorsal line to serrate, so its defense read is the rim:
    // a well-defended bell has a visibly thicker, harder margin.
    g.stroke({
      color: mixRgb(style.tint, 0xffffff, 0.55),
      alpha: style.alpha,
      width: 0.018 + 0.022 * geometry.spination,
    });
  }
  drawPatterns(g, geometry, style);
  drawRim(g, geometry, style);
  drawEye(g, geometry, style.alpha * 0.85);
}

function drawCrawler(g: Graphics, geometry: BodyGeometry, style: BodyStyle): void {
  // The last stroke is the dorsal midline, which is styled on its own.
  if (traceRange(g, geometry.strokes, 0, Math.max(0, geometry.strokeCount - 1))) {
    g.stroke({ color: mixRgb(style.tint, 0x000000, 0.25), alpha: style.alpha * 0.9, width: 0.016 });
  }
  if (trace(g, geometry.outline)) g.fill({ color: mixRgb(style.tint, 0x000000, 0.35), alpha: style.alpha });

  const plateFill = mixRgb(style.tint, MINERAL, geometry.armorLightening * 0.7);
  const plateEdge = mixRgb(plateFill, 0x000000, 0.45);
  if (traceRange(g, geometry.plates, 0, geometry.plateCount)) {
    g.fill({ color: plateFill, alpha: style.alpha });
    g.stroke({ color: plateEdge, alpha: style.alpha, width: geometry.plateStrokeWidth });
  }

  const midline = geometry.strokes[geometry.strokeCount - 1];
  if (midline !== undefined && trace(g, midline)) {
    g.stroke({ color: mixRgb(plateFill, 0xffffff, 0.5), alpha: style.alpha * 0.6, width: 0.01 });
  }
  drawPatterns(g, geometry, style);
  drawMouth(g, geometry, style);
  drawRim(g, geometry, style);
  drawEye(g, geometry, style.alpha);
}

// ---------------------------------------------------------------------------
// Bakes
// ---------------------------------------------------------------------------

export interface ShapeTextures {
  /**
   * `flipbooks[archetype][variant][phase]` — {@link FLIPBOOK_VARIANTS} morphology
   * variants per archetype, four undulation phases each. The mid tier picks a
   * variant from the animal's amplified channels and flips through its phases.
   */
  readonly flipbooks: Readonly<Record<CladeArchetype, readonly (readonly Texture[])[]>>;
  /**
   * `silhouettes[archetype][aspectBucket]` — the far tier's blobs.
   *
   * Bucketed for the same reason the flipbooks are, and it is not cosmetic: a
   * far particle is stretched across its body by `baked / drawn` aspect, and
   * once amplification lets `bodyAspect` reach the ends of the renderRange a
   * single bake per archetype means stretching a slim fish's silhouette by 2.4×
   * to stand in for a stubby one. That also drove the far tier's fill *above*
   * the mid tier's, which inverts the LOD cost ordering.
   */
  readonly silhouettes: Readonly<Record<CladeArchetype, readonly Texture[]>>;
  /** Radial falloff: the near-tier glow underlay and the abyss dot. */
  readonly glow: Texture;
  destroy(): void;
}

/** Body morphology used for the bakes: each archetype at its schema typical. */
function bakeParams(archetype: CladeArchetype, phase: number, pulsePhase: number): BodyParams {
  const schema = CLADE_SCHEMA[archetype];
  return {
    archetype,
    segmentCount: schema.segmentCount.typical,
    finPairs: Math.max(1, schema.finPairs.typical),
    bodyAspect: schema.bodyAspect.typical,
    armorPlating: archetype === 'armoredCrawler' ? 1.15 : 0.35,
    headForm: 0,
    spination: 0,
    // Every bake is an adult. A juvenile bucket would double the flipbook set
    // (144 → 288 frames, ≈30 MB of VRAM) to buy a fin-length difference that is
    // sub-pixel on a 10–40 px sprite; the mid tier reads a juvenile through its
    // length and its translucency instead, which cost no textures at all.
    juvenile: 0,
    patternFamily: 'none',
    patternPhase: 0.5,
    phase,
    pulsePhase,
    amplitudeScale: 1,
  };
}

/**
 * One flipbook variant's morphology.
 *
 * The aspect comes from the bucket centre rather than the archetype typical,
 * which is what lets the mid tier's cross-body squash stay near 1 — see
 * `divergence.ASPECT_BUCKETS`. Spination is left at zero for every variant: a
 * serrated back is sub-pixel at mid range, and spending a bucket on it would
 * cost more textures than it buys reads.
 */
function variantBakeParams(
  archetype: CladeArchetype,
  variant: number,
  phase: number,
  pulsePhase: number,
): BodyParams {
  const { aspectBucket, headBucket, patternBucket } = decodeFlipbookVariant(variant);
  return {
    ...bakeParams(archetype, phase, pulsePhase),
    bodyAspect: aspectForBucket(archetype, aspectBucket),
    headForm: headFormForBucket(headBucket),
    patternFamily: patternFamilyForBucket(patternBucket),
  };
}

/**
 * Pin the graphics bounds to the shared window with a transparent rect, so every
 * bake lands on the same anchor regardless of how far its appendages reach.
 */
function pinFrame(g: Graphics): void {
  g.rect(FRAME_X_MIN, FRAME_Y_MIN, FRAME_W, FRAME_H);
  g.fill({ color: 0x000000, alpha: 0 });
}

/**
 * Untextured stand-in used when a bake fails.
 *
 * Every sprite and particle still draws — as a tinted white quad rather than a
 * silhouette. That is ugly and obviously wrong, which is the point: the failure
 * mode for "the GPU would not give us a texture" has to be a visible population
 * of blobs, not an empty ocean. An empty ocean is indistinguishable from a dead
 * world, and would send whoever is debugging it into the sim.
 */
export function fallbackShapeTextures(): ShapeTextures {
  const flat = Texture.WHITE;
  const phases = Object.freeze(new Array<Texture>(FLIPBOOK_PHASES).fill(flat));
  const variants = Object.freeze(new Array<readonly Texture[]>(FLIPBOOK_VARIANTS).fill(phases));
  const buckets = Object.freeze(new Array<Texture>(ASPECT_BUCKETS).fill(flat));
  return {
    flipbooks: Object.freeze({ undulator: variants, radialDrifter: variants, armoredCrawler: variants }),
    silhouettes: Object.freeze({ undulator: buckets, radialDrifter: buckets, armoredCrawler: buckets }),
    glow: flat,
    destroy(): void {
      // Texture.WHITE is a shared Pixi singleton; destroying it would take the
      // rest of the app's white quads with it.
    },
  };
}

export function bakeShapeTextures(ctx: MountContext): ShapeTextures {
  const geometry = createBodyGeometry();
  const scratch = new Graphics();
  const baked: Texture[] = [];

  const bake = (resolution: number, paint: (g: Graphics) => void): Texture => {
    scratch.clear();
    pinFrame(scratch);
    paint(scratch);
    const texture = ctx.generateTexture(scratch, { resolution });
    baked.push(texture);
    return texture;
  };

  const flipbooks = {} as Record<CladeArchetype, Texture[][]>;
  const silhouettes = {} as Record<CladeArchetype, Texture[]>;

  for (const archetype of CLADE_ARCHETYPES) {
    const variants: Texture[][] = [];
    for (let variant = 0; variant < FLIPBOOK_VARIANTS; variant += 1) {
      const phases: Texture[] = [];
      for (let step = 0; step < FLIPBOOK_PHASES; step += 1) {
        const fraction = step / FLIPBOOK_PHASES;
        buildBody(variantBakeParams(archetype, variant, fraction * 2 * Math.PI, fraction), geometry);
        // White so the per-creature tint carries the whole colour.
        phases.push(bake(FLIPBOOK_RESOLUTION, (g) => drawBody(g, geometry, { tint: 0xffffff, alpha: 1, rimTint: -1 })));
      }
      variants.push(phases);
    }
    flipbooks[archetype] = variants;

    // The far silhouette is a frozen, flat blob: at that size the undulation is
    // sub-pixel and only the outline survives. One per aspect bucket, so the
    // outline that survives is the right shape.
    const blobs: Texture[] = [];
    for (let bucket = 0; bucket < ASPECT_BUCKETS; bucket += 1) {
      buildBody({ ...bakeParams(archetype, 0, 0.15), bodyAspect: aspectForBucket(archetype, bucket) }, geometry);
      blobs.push(
        bake(SILHOUETTE_RESOLUTION, (g) => {
          if (trace(g, geometry.outline)) g.fill({ color: 0xffffff, alpha: 0.92 });
          for (let i = 0; i < geometry.finCount; i += 1) {
            const fin = geometry.fins[i];
            if (fin !== undefined && trace(g, fin)) g.fill({ color: 0xffffff, alpha: 0.7 });
          }
        }),
      );
    }
    silhouettes[archetype] = blobs;
  }

  const glowSource = new Graphics();
  glowSource.circle(0, 0, 0.5);
  glowSource.fill(
    new FillGradient({
      type: 'radial',
      center: { x: 0.5, y: 0.5 },
      innerRadius: 0,
      outerCenter: { x: 0.5, y: 0.5 },
      outerRadius: 0.5,
      textureSpace: 'local',
      colorStops: [
        { offset: 0, color: 'rgba(255,255,255,1)' },
        { offset: 0.22, color: 'rgba(255,255,255,0.6)' },
        { offset: 0.55, color: 'rgba(255,255,255,0.18)' },
        { offset: 1, color: 'rgba(255,255,255,0)' },
      ],
    }),
  );
  const glow = ctx.generateTexture(glowSource, { resolution: GLOW_RESOLUTION });
  baked.push(glow);
  glowSource.destroy();
  scratch.destroy();

  return {
    flipbooks,
    silhouettes,
    glow,
    destroy(): void {
      for (const texture of baked) texture.destroy(true);
      baked.length = 0;
    },
  };
}
