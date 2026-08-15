/**
 * Marine snow (R3).
 *
 * Two fields of motes: a background layer of large dim ones in world space,
 * behind the creatures, and a foreground layer of small bright ones in screen
 * space, in front of everything. Together they give the water a depth the
 * creatures cannot supply on their own.
 *
 * The whole drift is a **pure function of (index, time)** over a wrapping tile —
 * {@link driftPos}. No per-mote state, no per-frame allocation, and no
 * `Math.random`: a mote's lane and phase come from a hash of its index, so the
 * same moment of the same world always draws the same snow and a screenshot is
 * reproducible. Parallax is a single offset folded into the wrap, which is also
 * why motes can never wander off the tile.
 */

import { Particle, ParticleContainer } from 'pixi.js';
import type { Container, Texture } from 'pixi.js';
import type { CameraState } from '../contracts';
import { bakeAlphaTexture } from './fieldHaze';

// ---------------------------------------------------------------------------
// Pure drift math
// ---------------------------------------------------------------------------

export interface DriftSpec {
  readonly count: number;
  /** Wrapping tile, in whatever units the caller draws in (world or screen px). */
  readonly tileW: number;
  readonly tileH: number;
  /** Sink rate along +y, units per second. */
  readonly fallRate: number;
  /** Peak lateral excursion, same units. */
  readonly swayAmp: number;
  /** Base lateral oscillation rate, radians per second. */
  readonly swayRate: number;
  /** Separates the two fields so they do not draw the same lanes. */
  readonly seed: number;
}

export interface DriftPoint {
  x: number;
  y: number;
}

/**
 * Index-derived pseudo-randomness (a 32-bit avalanche mix). Uniform enough that
 * `count` motes cover the tile without clumping, and stable across runs.
 */
export function driftHash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Non-negative modulo; `%` alone leaves negatives negative. */
export function wrapInto(value: number, span: number): number {
  if (span <= 0) return 0;
  const r = value % span;
  return r < 0 ? r + span : r;
}

/**
 * Position of mote `index` at wall-clock `tMs`, wrapped into the tile. Writes
 * into `out`; allocates nothing.
 *
 * The wrap is the seam that matters: y advances monotonically and is reduced
 * modulo `tileH`, so a mote leaving the bottom re-enters at the top exactly one
 * step later. Nothing is ever teleported by more than a step, which is what the
 * test pins down.
 */
export function driftPos(spec: DriftSpec, index: number, tMs: number, out: DriftPoint): void {
  const key = index * 3 + spec.seed;
  const lane = driftHash01(key);
  const depth = driftHash01(key + 1);
  const vigour = driftHash01(key + 2);
  const seconds = tMs / 1000;
  // Motes fall at slightly different rates so the field never marches in step.
  const fall = spec.fallRate * (0.55 + 0.9 * vigour);
  out.y = wrapInto(depth * spec.tileH + fall * seconds, spec.tileH);
  const phase = lane * Math.PI * 2;
  const rate = spec.swayRate * (0.5 + vigour);
  out.x = wrapInto(lane * spec.tileW + spec.swayAmp * Math.sin(phase + rate * seconds), spec.tileW);
}

// ---------------------------------------------------------------------------
// The two rendered fields
// ---------------------------------------------------------------------------

const BACKGROUND_COUNT = 600;
const FOREGROUND_COUNT = 400;

/** Depth cues: the far field lags the camera, the near field leads it. */
const BACKGROUND_PARALLAX = 0.92;
const FOREGROUND_PARALLAX = 1.15;

/** Baked dot size, px. Sprite scale maps it to world units or screen px. */
const MOTE_TEXTURE_PX = 16;

/** Screen-space tile margin so motes enter and leave off-viewport. */
const FOREGROUND_MARGIN_PX = 120;

export interface ParticulateOptions {
  readonly worldWidthWu: number;
  readonly worldHeightWu: number;
}

export interface Particulate {
  mount(below: Container, front: Container): void;
  update(
    animMs: number,
    camera: CameraState,
    worldMidX: number,
    worldMidY: number,
    nearSnow: boolean,
  ): void;
  reset(): void;
  destroy(): void;
}

export function createParticulate(options: ParticulateOptions): Particulate {
  const texture = bakeMoteTexture();

  const backgroundSpec: DriftSpec = {
    count: BACKGROUND_COUNT,
    tileW: options.worldWidthWu,
    tileH: options.worldHeightWu,
    fallRate: 3.2,
    swayAmp: 9,
    swayRate: 0.22,
    seed: 0,
  };
  const background = makeField(texture, BACKGROUND_COUNT, 0x9fd4e0, 0.16, 0.34);
  const backgroundScales = new Float32Array(BACKGROUND_COUNT);
  for (let i = 0; i < BACKGROUND_COUNT; i += 1) {
    // World-unit motes: they scale with zoom because they are *in* the water.
    backgroundScales[i] = ((1.8 + driftHash01(i * 7 + 11) * 2.6) * 2) / MOTE_TEXTURE_PX;
  }

  let foregroundSpec: DriftSpec = makeForegroundSpec(1280, 720);
  const foreground = makeField(texture, FOREGROUND_COUNT, 0xdff2f7, 0.2, 0.42);
  const scratch: DriftPoint = { x: 0, y: 0 };
  // Last inputs, so a frame that changes nothing costs nothing.
  let lastAnimMs = Number.NaN;
  let lastCenterX = Number.NaN;
  let lastCenterY = Number.NaN;
  let lastPxPerWu = Number.NaN;
  let lastViewportW = Number.NaN;
  let lastViewportH = Number.NaN;

  function mount(below: Container, front: Container): void {
    below.addChild(background.container);
    front.addChild(foreground.container);
    applyStaticScales();
  }

  function applyStaticScales(): void {
    for (let i = 0; i < BACKGROUND_COUNT; i += 1) {
      const particle = background.particles[i];
      if (particle === undefined) continue;
      const scale = backgroundScales[i] ?? 0.2;
      particle.scaleX = scale;
      particle.scaleY = scale;
    }
    for (let i = 0; i < FOREGROUND_COUNT; i += 1) {
      const particle = foreground.particles[i];
      if (particle === undefined) continue;
      const scale = ((1.1 + driftHash01(i * 7 + 29) * 1.7) * 2) / MOTE_TEXTURE_PX;
      particle.scaleX = scale;
      particle.scaleY = scale;
    }
    background.container.update();
    foreground.container.update();
  }

  function update(
    animMs: number,
    camera: CameraState,
    worldMidX: number,
    worldMidY: number,
    nearSnow: boolean,
  ): void {
    // The near field is the first thing to go when the frame is over budget: it
    // is the layer the watcher is least likely to miss, and zoomed far out
    // "particles close to the lens" is the least meaningful depth cue anyway.
    if (foreground.container.visible !== nearSnow) foreground.container.visible = nearSnow;
    // Nothing to recompute if neither the clock nor the camera moved — which is
    // the whole of a paused, un-panned watch. Skipping here skips two full
    // particle-buffer uploads inside `app.render()`.
    if (animMs === lastAnimMs && camera.centerX === lastCenterX && camera.centerY === lastCenterY && camera.pxPerWu === lastPxPerWu && camera.viewportW === lastViewportW && camera.viewportH === lastViewportH) {
      return;
    }
    lastAnimMs = animMs;
    lastCenterX = camera.centerX;
    lastCenterY = camera.centerY;
    lastPxPerWu = camera.pxPerWu;
    lastViewportW = camera.viewportW;
    lastViewportH = camera.viewportH;

    // World-space field: a parallax factor below 1 means the layer should lag
    // the camera, which in a camera-transformed container is a world offset of
    // (1 - p) * (camera - worldCentre). Folding it through the wrap keeps every
    // mote inside the world rect instead of drifting over the void.
    const lagX = wrapInto((1 - BACKGROUND_PARALLAX) * (camera.centerX - worldMidX), backgroundSpec.tileW);
    const lagY = wrapInto((1 - BACKGROUND_PARALLAX) * (camera.centerY - worldMidY), backgroundSpec.tileH);
    for (let i = 0; i < BACKGROUND_COUNT; i += 1) {
      const particle = background.particles[i];
      if (particle === undefined) continue;
      driftPos(backgroundSpec, i, animMs, scratch);
      particle.x = wrapInto(scratch.x + lagX, backgroundSpec.tileW);
      particle.y = wrapInto(scratch.y + lagY, backgroundSpec.tileH);
    }
    background.container.update();

    if (!nearSnow) return;
    const viewW = camera.viewportW + FOREGROUND_MARGIN_PX * 2;
    const viewH = camera.viewportH + FOREGROUND_MARGIN_PX * 2;
    if (viewW !== foregroundSpec.tileW || viewH !== foregroundSpec.tileH) {
      foregroundSpec = makeForegroundSpec(camera.viewportW, camera.viewportH);
    }
    // Screen-space field: a parallax factor above 1 means it must slide against
    // the camera faster than the world does, in screen pixels.
    const leadX = wrapInto(
      -FOREGROUND_PARALLAX * (camera.centerX - worldMidX) * camera.pxPerWu,
      foregroundSpec.tileW,
    );
    const leadY = wrapInto(
      -FOREGROUND_PARALLAX * (camera.centerY - worldMidY) * camera.pxPerWu,
      foregroundSpec.tileH,
    );
    for (let i = 0; i < FOREGROUND_COUNT; i += 1) {
      const particle = foreground.particles[i];
      if (particle === undefined) continue;
      driftPos(foregroundSpec, i, animMs, scratch);
      particle.x = wrapInto(scratch.x + leadX, foregroundSpec.tileW) - FOREGROUND_MARGIN_PX;
      particle.y = wrapInto(scratch.y + leadY, foregroundSpec.tileH) - FOREGROUND_MARGIN_PX;
    }
    foreground.container.update();
  }

  function reset(): void {
    // Drift is a pure function of the layer clock, which the layer rewinds on
    // reset; there is no per-mote state left to clear beyond the change guard.
    lastAnimMs = Number.NaN;
    applyStaticScales();
  }

  function destroy(): void {
    background.container.destroy();
    foreground.container.destroy();
    texture.destroy(true);
  }

  return { mount, update, reset, destroy };
}

function makeForegroundSpec(viewportW: number, viewportH: number): DriftSpec {
  return {
    count: FOREGROUND_COUNT,
    tileW: viewportW + FOREGROUND_MARGIN_PX * 2,
    tileH: viewportH + FOREGROUND_MARGIN_PX * 2,
    fallRate: 11,
    swayAmp: 16,
    swayRate: 0.5,
    seed: 977,
  };
}

interface MoteField {
  readonly container: ParticleContainer;
  readonly particles: Particle[];
}

function makeField(
  texture: Texture,
  count: number,
  tint: number,
  alphaLow: number,
  alphaHigh: number,
): MoteField {
  const container = new ParticleContainer({
    // Only position moves; tint and alpha are baked per mote at construction, so
    // the GPU never re-uploads the colour buffer.
    dynamicProperties: { position: true, rotation: false, vertex: false, uvs: false, color: false },
  });
  container.blendMode = 'add';
  const particles: Particle[] = [];
  for (let i = 0; i < count; i += 1) {
    const particle = new Particle({
      texture,
      tint,
      alpha: alphaLow + driftHash01(i * 13 + 5) * (alphaHigh - alphaLow),
      anchorX: 0.5,
      anchorY: 0.5,
    });
    container.addParticle(particle);
    particles.push(particle);
  }
  return { container, particles };
}

/** A soft round mote: Gaussian falloff, so scaling one up never shows an edge. */
function bakeMoteTexture(): Texture {
  return bakeAlphaTexture(MOTE_TEXTURE_PX, MOTE_TEXTURE_PX, [255, 255, 255], (u, v) => {
    const dx = u - 0.5;
    const dy = v - 0.5;
    const r = Math.sqrt(dx * dx + dy * dy) / 0.5;
    return r >= 1 ? 0 : Math.exp(-(r * r) * 5.5) * (1 - r * r);
  });
}
