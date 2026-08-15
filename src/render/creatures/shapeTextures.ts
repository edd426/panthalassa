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

import type { Texture } from 'pixi.js';
import { FillGradient, Graphics } from 'pixi.js';
import type { MountContext } from '../contracts';
import type { CladeArchetype } from '../../contracts/genome';
import { CLADE_ARCHETYPES, CLADE_SCHEMA } from '../../contracts/genome';
import type { BodyGeometry, BodyParams, Polyline } from './bodies';
import { buildBody, createBodyGeometry } from './bodies';

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

function drawUndulator(g: Graphics, geometry: BodyGeometry, style: BodyStyle): void {
  for (let i = 0; i < geometry.finCount; i += 1) {
    const fin = geometry.fins[i];
    if (fin === undefined) continue;
    if (trace(g, fin)) g.fill({ color: style.tint, alpha: style.alpha * 0.55 });
  }
  if (trace(g, geometry.outline)) {
    g.fill({ color: style.tint, alpha: style.alpha });
    g.stroke({ color: mixRgb(style.tint, 0xffffff, 0.45), alpha: style.alpha * 0.8, width: OUTLINE_STROKE });
  }
  drawRim(g, geometry, style);
  drawEye(g, geometry, style.alpha);
}

function drawDrifter(g: Graphics, geometry: BodyGeometry, style: BodyStyle): void {
  // Tentacles and canals sit under the translucent bell, which is the read.
  for (let i = 0; i < geometry.strokeCount; i += 1) {
    const stroke = geometry.strokes[i];
    if (stroke === undefined) continue;
    if (trace(g, stroke)) {
      g.stroke({ color: mixRgb(style.tint, 0xffffff, 0.3), alpha: style.alpha * 0.45, width: 0.009 });
    }
  }
  if (trace(g, geometry.outline)) {
    g.fill({ color: style.tint, alpha: style.alpha * 0.45 });
    g.stroke({ color: mixRgb(style.tint, 0xffffff, 0.55), alpha: style.alpha, width: 0.018 });
  }
  drawRim(g, geometry, style);
  drawEye(g, geometry, style.alpha * 0.85);
}

function drawCrawler(g: Graphics, geometry: BodyGeometry, style: BodyStyle): void {
  for (let i = 0; i < geometry.strokeCount - 1; i += 1) {
    const limb = geometry.strokes[i];
    if (limb === undefined) continue;
    if (trace(g, limb)) {
      g.stroke({ color: mixRgb(style.tint, 0x000000, 0.25), alpha: style.alpha * 0.9, width: 0.016 });
    }
  }
  if (trace(g, geometry.outline)) g.fill({ color: mixRgb(style.tint, 0x000000, 0.35), alpha: style.alpha });

  const plateFill = mixRgb(style.tint, MINERAL, geometry.armorLightening * 0.7);
  const plateEdge = mixRgb(plateFill, 0x000000, 0.45);
  for (let i = 0; i < geometry.plateCount; i += 1) {
    const plate = geometry.plates[i];
    if (plate === undefined) continue;
    if (trace(g, plate)) {
      g.fill({ color: plateFill, alpha: style.alpha });
      g.stroke({ color: plateEdge, alpha: style.alpha, width: geometry.plateStrokeWidth });
    }
  }

  const midline = geometry.strokes[geometry.strokeCount - 1];
  if (midline !== undefined && trace(g, midline)) {
    g.stroke({ color: mixRgb(plateFill, 0xffffff, 0.5), alpha: style.alpha * 0.6, width: 0.01 });
  }
  drawRim(g, geometry, style);
  drawEye(g, geometry, style.alpha);
}

// ---------------------------------------------------------------------------
// Bakes
// ---------------------------------------------------------------------------

export interface ShapeTextures {
  /** Four undulation phases per archetype; the mid tier flips through them. */
  readonly flipbooks: Readonly<Record<CladeArchetype, readonly Texture[]>>;
  /** One soft silhouette per archetype for the far tier. */
  readonly silhouettes: Readonly<Record<CladeArchetype, Texture>>;
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
    phase,
    pulsePhase,
    amplitudeScale: 1,
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

  const flipbooks = {} as Record<CladeArchetype, Texture[]>;
  const silhouettes = {} as Record<CladeArchetype, Texture>;

  for (const archetype of CLADE_ARCHETYPES) {
    const phases: Texture[] = [];
    for (let step = 0; step < FLIPBOOK_PHASES; step += 1) {
      const fraction = step / FLIPBOOK_PHASES;
      buildBody(bakeParams(archetype, fraction * 2 * Math.PI, fraction), geometry);
      // White so the per-creature tint carries the whole colour.
      phases.push(bake(FLIPBOOK_RESOLUTION, (g) => drawBody(g, geometry, { tint: 0xffffff, alpha: 1, rimTint: -1 })));
    }
    flipbooks[archetype] = phases;

    // The far silhouette is a frozen, flat blob: at that size the undulation is
    // sub-pixel and only the outline survives.
    buildBody(bakeParams(archetype, 0, 0.15), geometry);
    silhouettes[archetype] = bake(SILHOUETTE_RESOLUTION, (g) => {
      if (trace(g, geometry.outline)) g.fill({ color: 0xffffff, alpha: 0.92 });
      for (let i = 0; i < geometry.finCount; i += 1) {
        const fin = geometry.fins[i];
        if (fin !== undefined && trace(g, fin)) g.fill({ color: 0xffffff, alpha: 0.7 });
      }
    });
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
