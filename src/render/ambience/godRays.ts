/**
 * God rays (R3).
 *
 * Eight soft light shafts rooted at the warm y-edge of the world, leaning into
 * the cold half. They are the ambience's only directional cue: they say which
 * way the sun is, which in this world is the same as saying which way is warm.
 *
 * Beams are pre-baked gradient quads — the shape is a product of a lateral
 * falloff and a length falloff, so there is never a hard edge to catch the eye —
 * drawn additively at alphas in the 0.03..0.075 band. Motion is wall-clock sway
 * on desynchronised 20-40 s periods, which is slow enough that the rays never
 * compete with a moving animal for attention.
 */

import { Container, Sprite } from 'pixi.js';
import type { Texture } from 'pixi.js';
import type { CameraState } from '../contracts';
import { anchorHash, bakeAlphaTexture } from './fieldHaze';

const BEAM_COUNT = 8;
const BEAM_TEXTURE_W = 64;
const BEAM_TEXTURE_H = 256;

/** Distinct edge softnesses, so eight beams do not read as one stencil repeated. */
const BEAM_TEXTURE_VARIANTS = 4;

/**
 * Beams overlap, so the band is the per-beam ceiling, not the composite one. Two
 * crossing shafts at 0.075 already add ~(21, 32, 35) to the sea; anything higher
 * and the light column starts competing with the animals for attention.
 */
const ALPHA_MIN = 0.03;
const ALPHA_MAX = 0.075;

/** Base tilt away from the warm edge, radians (10-25 degrees). */
const TILT_MIN = 0.175;
const TILT_MAX = 0.436;

/** Sway is +/- 2 degrees; anything larger reads as the world moving. */
const SWAY_RADIANS = 0.035;

const BREATH_PERIOD_MIN_S = 20;
const BREATH_PERIOD_MAX_S = 40;

/** Rays sit far off, so they lag the camera. */
const PARALLAX = 0.85;

/**
 * Ceiling on the screen area the beams may paint, in whole viewports. Fill rate
 * is what the ambience actually spends, and this is the only element of it that
 * is not already bounded by the world rect — so it gets an explicit budget
 * rather than an assumption. 1.5 keeps every beam at fit-all, where they were
 * measured at well under that, and thins them as zoom inflates their footprint.
 */
const BEAM_SCREEN_BUDGET = 1.5;

/**
 * Pale teal, not white-blue. The rays sit on top of the green haze under
 * additive blending, and a warm or neutral beam colour is what pushes that sum
 * toward yellow; keeping every additive element in the teal/green family keeps
 * the composite in it too.
 */
const BEAM_COLOUR: readonly [number, number, number] = [140, 214, 234];

export interface GodRaysOptions {
  readonly worldWidthWu: number;
  readonly worldHeightWu: number;
  /** y of the warm edge — 0 or `worldHeightWu`; beams root here and lean away. */
  readonly warmY: number;
}

export interface GodRays {
  mount(parent: Container): void;
  /**
   * `intensity` is the flourish modulation (a meteor dims the rays, a thermal
   * shock makes them flicker); 1 is the resting state.
   */
  update(
    animMs: number,
    camera: CameraState,
    worldMidX: number,
    worldMidY: number,
    intensity: number,
    beamBudget: number,
  ): void;
  reset(): void;
  destroy(): void;
}

interface Beam {
  readonly sprite: Sprite;
  readonly rootX: number;
  /** Half-width and length in world units, for the screen-footprint estimate. */
  readonly halfWidthWu: number;
  readonly lengthWu: number;
  readonly baseAlpha: number;
  readonly baseRotation: number;
  readonly swayRate: number;
  readonly swayPhase: number;
  readonly breathRate: number;
  readonly breathPhase: number;
}

export function createGodRays(options: GodRaysOptions): GodRays {
  const textures: Texture[] = [];
  for (let v = 0; v < BEAM_TEXTURE_VARIANTS; v += 1) {
    textures.push(bakeBeamTexture(1.2 + v * 0.8));
  }

  const container = new Container();
  const warmAtTop = options.warmY <= options.worldHeightWu * 0.5;
  const beams: Beam[] = [];

  for (let i = 0; i < BEAM_COUNT; i += 1) {
    const texture = textures[i % BEAM_TEXTURE_VARIANTS];
    if (texture === undefined) continue;
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5, 0);
    sprite.blendMode = 'add';
    // Alpha is only written on frames the beam is drawn, so it starts (and a
    // culled beam stays) dark: anything that shows a beam without updating it
    // fails to nothing rather than to a full-white quad across the ocean.
    sprite.alpha = 0;
    sprite.visible = false;

    // Roots spread across the world width with a jittered stride rather than a
    // uniform one, so the shafts do not read as a picket fence.
    const stride = options.worldWidthWu / BEAM_COUNT;
    const rootX = (i + 0.15 + anchorHash(i * 11 + 3) * 0.7) * stride;
    const tilt = TILT_MIN + anchorHash(i * 11 + 5) * (TILT_MAX - TILT_MIN);
    const lean = anchorHash(i * 11 + 7) < 0.5 ? -1 : 1;
    const reach = 0.45 + anchorHash(i * 11 + 9) * 0.35;

    sprite.position.set(rootX, options.warmY);
    sprite.width = stride * (0.9 + anchorHash(i * 11 + 11) * 0.9);
    sprite.height = options.worldHeightWu * reach;

    const breathSeconds =
      BREATH_PERIOD_MIN_S + anchorHash(i * 11 + 13) * (BREATH_PERIOD_MAX_S - BREATH_PERIOD_MIN_S);

    beams.push({
      sprite,
      rootX,
      halfWidthWu: sprite.width * 0.5,
      lengthWu: sprite.height,
      baseAlpha: ALPHA_MIN + anchorHash(i * 11 + 15) * (ALPHA_MAX - ALPHA_MIN),
      // A sprite anchored at its top extends along +y; rotating by pi points it
      // back up, which is what a warm south edge needs.
      baseRotation: (warmAtTop ? 0 : Math.PI) + tilt * lean,
      swayRate: (Math.PI * 2) / (18 + anchorHash(i * 11 + 17) * 22),
      swayPhase: anchorHash(i * 11 + 19) * Math.PI * 2,
      breathRate: (Math.PI * 2) / breathSeconds,
      breathPhase: anchorHash(i * 11 + 21) * Math.PI * 2,
    });
    container.addChild(sprite);
  }

  function mount(parent: Container): void {
    parent.addChild(container);
  }

  function update(
    animMs: number,
    camera: CameraState,
    worldMidX: number,
    worldMidY: number,
    intensity: number,
    beamBudget: number,
  ): void {
    container.x = (1 - PARALLAX) * (camera.centerX - worldMidX);
    container.y = (1 - PARALLAX) * (camera.centerY - worldMidY);
    const seconds = animMs / 1000;
    // Thin by stride rather than by truncation, so a reduced budget still spans
    // the world instead of lighting only its left edge.
    const detail = Math.min(1, Math.max(0, beamBudget / BEAM_COUNT));
    const stride = Math.max(1, Math.round(beams.length / Math.max(1, beamBudget)));
    // The tier has to move BOTH budgets. With the area ceiling fixed, a coarser
    // tier thins the candidate set but then lets the survivors spend the whole
    // ceiling, so `far` came out more expensive than `mid` at close zoom — the
    // fallback tier costing more than the tier it falls back from, which is the
    // one shape a governor must never have.
    const areaBudget = BEAM_SCREEN_BUDGET * detail;
    // Viewport in world units. A beam is a tall additive quad; one entirely
    // off-screen is pure fill cost, and at close zoom most of them are.
    const halfW = camera.viewportW / (2 * camera.pxPerWu);
    const halfH = camera.viewportH / (2 * camera.pxPerWu);
    const viewLeft = camera.centerX - halfW;
    const viewRight = camera.centerX + halfW;
    const viewTop = camera.centerY - halfH;
    const viewBottom = camera.centerY + halfH;
    const viewAreaWu = halfW * 2 * halfH * 2;
    let coverage = 0;
    for (let i = 0; i < beams.length; i += 1) {
      const beam = beams[i];
      if (beam === undefined) continue;
      // How much of the screen this beam would actually paint. A beam is a fixed
      // size in *world* units, so zooming in grows its screen footprint faster
      // than culling removes beams: at 2 px/wu eight of them cover nearly three
      // screens, where at fit-all they cover well under half of one. Budgeting
      // by area rather than by count is what makes the cost bounded, and it is
      // the right look too — a light shaft is distant structure, not a wall.
      const share =
        viewAreaWu > 0
          ? overlapArea(beamBounds(beam, container.x, container.y), viewLeft, viewTop, viewRight, viewBottom) / viewAreaWu
          : 0;
      const onScreen = i % stride === 0 && share > 0 && coverage + share <= areaBudget;
      if (beam.sprite.visible !== onScreen) beam.sprite.visible = onScreen;
      if (!onScreen) continue;
      coverage += share;
      beam.sprite.rotation = beam.baseRotation + Math.sin(beam.swayPhase + seconds * beam.swayRate) * SWAY_RADIANS;
      const breath = 0.72 + 0.28 * Math.sin(beam.breathPhase + seconds * beam.breathRate);
      beam.sprite.alpha = Math.max(0, beam.baseAlpha * breath * intensity);
    }
  }

  function reset(): void {
    container.x = 0;
    container.y = 0;
    for (const beam of beams) {
      beam.sprite.rotation = beam.baseRotation;
      beam.sprite.alpha = 0;
      beam.sprite.visible = false;
    }
  }

  function destroy(): void {
    container.destroy({ children: true });
    for (const texture of textures) texture.destroy(true);
  }

  return { mount, update, reset, destroy };
}

/** Axis-aligned world bounds of a beam's rotated quad, written into a scratch. */
const beamBoundsScratch = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

function beamBounds(beam: Beam, offsetX: number, offsetY: number): typeof beamBoundsScratch {
  const rotation = beam.sprite.rotation;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const originX = beam.sprite.x + offsetX;
  const originY = beam.sprite.y + offsetY;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  // The sprite is anchored at the middle of its short edge, so its local corners
  // are (+/-halfWidth, 0) and (+/-halfWidth, length).
  for (const lx of [-beam.halfWidthWu, beam.halfWidthWu]) {
    for (const ly of [0, beam.lengthWu]) {
      const x = originX + lx * cos - ly * sin;
      const y = originY + lx * sin + ly * cos;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  beamBoundsScratch.minX = minX;
  beamBoundsScratch.minY = minY;
  beamBoundsScratch.maxX = maxX;
  beamBoundsScratch.maxY = maxY;
  return beamBoundsScratch;
}

function overlapArea(
  bounds: typeof beamBoundsScratch,
  left: number,
  top: number,
  right: number,
  bottom: number,
): number {
  const w = Math.min(bounds.maxX, right) - Math.max(bounds.minX, left);
  const h = Math.min(bounds.maxY, bottom) - Math.max(bounds.minY, top);
  return w <= 0 || h <= 0 ? 0 : w * h;
}

/**
 * One beam stencil. `edgeExponent` sets how sharply the shaft narrows to its
 * sides; the length falloff fades the shaft out before it reaches the cold edge,
 * which is what makes the light look like it came from the warm one.
 */
function bakeBeamTexture(edgeExponent: number): Texture {
  return bakeAlphaTexture(BEAM_TEXTURE_W, BEAM_TEXTURE_H, BEAM_COLOUR, (u, v) => {
    const lateral = Math.cos((u - 0.5) * Math.PI);
    if (lateral <= 0) return 0;
    // A short ramp at the root so the shaft does not start with a flat cap.
    const root = Math.min(1, v / 0.08);
    const along = Math.pow(1 - v, 1.7);
    return Math.pow(lateral, edgeExponent) * along * root;
  });
}
