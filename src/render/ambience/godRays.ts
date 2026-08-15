/**
 * God rays (R3).
 *
 * Eight soft light shafts rooted at the warm y-edge of the world, leaning into
 * the cold half. They are the ambience's only directional cue: they say which
 * way the sun is, which in this world is the same as saying which way is warm.
 *
 * Beams are pre-baked gradient quads — the shape is a product of a lateral
 * falloff and a length falloff, so there is never a hard edge to catch the eye —
 * drawn additively at alphas in the 0.04..0.10 band. Motion is wall-clock sway
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

const ALPHA_MIN = 0.04;
const ALPHA_MAX = 0.1;

/** Base tilt away from the warm edge, radians (10-25 degrees). */
const TILT_MIN = 0.175;
const TILT_MAX = 0.436;

/** Sway is +/- 2 degrees; anything larger reads as the world moving. */
const SWAY_RADIANS = 0.035;

const BREATH_PERIOD_MIN_S = 20;
const BREATH_PERIOD_MAX_S = 40;

/** Rays sit far off, so they lag the camera. */
const PARALLAX = 0.85;

const BEAM_COLOUR: readonly [number, number, number] = [186, 232, 246];

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
  update(animMs: number, camera: CameraState, worldMidX: number, worldMidY: number, intensity: number): void;
  reset(): void;
  destroy(): void;
}

interface Beam {
  readonly sprite: Sprite;
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
  ): void {
    container.x = (1 - PARALLAX) * (camera.centerX - worldMidX);
    container.y = (1 - PARALLAX) * (camera.centerY - worldMidY);
    const seconds = animMs / 1000;
    for (const beam of beams) {
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
      beam.sprite.alpha = beam.baseAlpha;
    }
  }

  function destroy(): void {
    container.destroy({ children: true });
    for (const texture of textures) texture.destroy(true);
  }

  return { mount, update, reset, destroy };
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
