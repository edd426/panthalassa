/**
 * Field haze + kelp fronds (R3).
 *
 * The plankton and kelp rasters become soft luminous water rather than the
 * diagnostic overlay's flat cell grid: the same `normaliseField` RGBA, uploaded
 * to a `cols x rows` texture with linear filtering and stretched over the world
 * rect, so the GPU does the smoothing. Rasters arrive roughly every two seconds;
 * two stacked sprites cross-fade over one second so a refresh never pops.
 *
 * Kelp fronds are the one place the ambience is allowed structural detail. They
 * sell "reef", and kelp is where prey hide from predators, so the watcher should
 * be able to see where the cover is without turning an overlay on.
 *
 * This module also owns the package's texture primitives. Everything R3 draws is
 * ultimately a `BufferImageSource` — beams, motes, glows, rings — and the haze is
 * the module that has to wire one up anyway, so the bakers live here instead of
 * being copied into three files. Buffers are written **premultiplied** and the
 * sources declare `premultiplied-alpha`: `UNPACK_PREMULTIPLY_ALPHA_WEBGL` is a
 * no-op for ArrayBufferView uploads, so letting Pixi think it premultiplied on
 * upload would make every additive sprite blend at full colour regardless of its
 * alpha channel.
 */

import { BufferImageSource, Graphics, Sprite, Texture } from 'pixi.js';
import type { Container } from 'pixi.js';
import type { FieldRaster } from '../contracts';
import { normaliseField } from '../fieldSampling';

// ---------------------------------------------------------------------------
// Texture primitives (shared with godRays / particulate / flourishes)
// ---------------------------------------------------------------------------

export interface BufferTexture {
  readonly texture: Texture;
  readonly source: BufferImageSource;
  /** Row-major premultiplied RGBA; write, then call `source.update()`. */
  readonly pixels: Uint8Array;
}

export function createBufferTexture(width: number, height: number): BufferTexture {
  const pixels = new Uint8Array(width * height * 4);
  const source = new BufferImageSource({
    resource: pixels,
    width,
    height,
    scaleMode: 'linear',
    alphaMode: 'premultiplied-alpha',
    label: 'ambience-buffer',
  });
  return { texture: new Texture({ source }), source, pixels };
}

/**
 * A single-colour sprite texture whose alpha is `alphaAt(u, v)` over the unit
 * square. Baked once at mount; nothing here runs per frame.
 */
export function bakeAlphaTexture(
  width: number,
  height: number,
  rgb: readonly [number, number, number],
  alphaAt: (u: number, v: number) => number,
): Texture {
  const baked = createBufferTexture(width, height);
  const [r, g, b] = rgb;
  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width;
      const a = Math.max(0, Math.min(1, alphaAt(u, v)));
      const base = (y * width + x) * 4;
      pokePremultiplied(baked.pixels, base, r, g, b, a);
    }
  }
  baked.source.update();
  return baked.texture;
}

/** A 1-px-wide vertical ramp; `sample` writes opaque r,g,b (0..255) into `out`. */
export function bakeVerticalTexture(height: number, sample: (v: number, out: Float64Array) => void): Texture {
  const baked = createBufferTexture(1, height);
  const out = new Float64Array(3);
  for (let y = 0; y < height; y += 1) {
    sample((y + 0.5) / height, out);
    pokePremultiplied(baked.pixels, y * 4, out[0] ?? 0, out[1] ?? 0, out[2] ?? 0, 1);
  }
  baked.source.update();
  return baked.texture;
}

function pokePremultiplied(
  pixels: Uint8Array,
  base: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  pixels[base] = Math.round(r * a);
  pixels[base + 1] = Math.round(g * a);
  pixels[base + 2] = Math.round(b * a);
  pixels[base + 3] = Math.round(a * 255);
}

// ---------------------------------------------------------------------------
// Haze
// ---------------------------------------------------------------------------

/**
 * What the flourish layer modulates in here. Passed per frame rather than
 * imported, so `fieldHaze` stays a leaf module of the ambience package.
 */
export interface HazeHooks {
  /** Global plankton haze multiplier — a world-wide crash easing down and back. */
  readonly planktonAlpha: number;
  /** Per-cell multiplier for a *regional* crash, applied while the texture is built. */
  planktonCellMultiplier(xWu: number, yWu: number): number;
  /** Frond sway amplitude multiplier at a world position (kelp storms). */
  frondSwayAt(xWu: number, yWu: number): number;
}

/**
 * Peak sprite alpha. `normaliseField` already bakes the crude overlay's 0.32
 * value-proportional alpha into the texture, so the effective ceiling here is
 * 0.32 x 0.70 = 0.22 for plankton and 0.32 x 0.55 = 0.18 for kelp — under the
 * 0.25 the brief allows, and visibly under the diagnostic overlay it shares
 * pixels with.
 */
const PLANKTON_PEAK_ALPHA = 0.7;
const KELP_PEAK_ALPHA = 0.55;

/** Cross-fade time between two raster generations. */
const CROSSFADE_MS = 1000;

const FROND_ANCHORS = 40;
const FROND_COLOUR = 0x1f7d5e;
const FROND_ALPHA = 0.32;
const FROND_WIDTH_WU = 1.6;
/** Blade reach, world units. A 12 cm fish spans ~8 wu, so this is kelp-scale. */
const FROND_LENGTH_WU = 46;

export interface FieldHazeOptions {
  readonly worldWidthWu: number;
  readonly worldHeightWu: number;
  /** The warm y-edge; fronds lean away from it, the way the light comes from it. */
  readonly warmY: number;
}

export interface FieldHaze {
  mount(parent: Container): void;
  update(
    plankton: FieldRaster | null,
    kelp: FieldRaster | null,
    animMs: number,
    dtMs: number,
    hooks: HazeHooks,
  ): void;
  reset(): void;
  destroy(): void;
}

interface HazePair {
  readonly sprites: [Sprite, Sprite];
  readonly buffers: [BufferTexture | null, BufferTexture | null];
  /** Index of the sprite showing the newest raster. */
  front: number;
  /** 0..1 fade-in of `front`. */
  fade: number;
  /** Identity of the last raster consumed; the shell hands us a new object per refresh. */
  lastRaster: FieldRaster | null;
  cols: number;
  rows: number;
  scratch: Uint8Array | null;
  readonly peakAlpha: number;
}

interface FrondAnchor {
  readonly cell: number;
  readonly x: number;
  readonly y: number;
  readonly blades: number;
  readonly scale: number;
}

export function createFieldHaze(options: FieldHazeOptions): FieldHaze {
  const plankton = makePair(PLANKTON_PEAK_ALPHA);
  const kelp = makePair(KELP_PEAK_ALPHA);
  const fronds = new Graphics();
  /** Keyed by raster cell so a frond that survives a refresh keeps its place. */
  const anchorsByCell = new Map<number, FrondAnchor>();
  /** Rebuilt on each kelp refresh, reusing the anchor objects above. */
  let activeAnchors: FrondAnchor[] = [];
  const topCells = new Int32Array(FROND_ANCHORS);
  const topValues = new Float64Array(FROND_ANCHORS);
  let topCount = 0;

  function mount(parent: Container): void {
    for (const sprite of plankton.sprites) parent.addChild(sprite);
    for (const sprite of kelp.sprites) parent.addChild(sprite);
    parent.addChild(fronds);
  }

  function update(
    planktonRaster: FieldRaster | null,
    kelpRaster: FieldRaster | null,
    animMs: number,
    dtMs: number,
    hooks: HazeHooks,
  ): void {
    stepPair(plankton, planktonRaster, dtMs, hooks, true);
    const kelpRefreshed = stepPair(kelp, kelpRaster, dtMs, hooks, false);
    if (kelpRefreshed && kelpRaster !== null) rebuildAnchors(kelpRaster);
    drawFronds(animMs, hooks);
  }

  /** Returns true on the frame a new raster generation was taken up. */
  function stepPair(
    pair: HazePair,
    raster: FieldRaster | null,
    dtMs: number,
    hooks: HazeHooks,
    isPlankton: boolean,
  ): boolean {
    let refreshed = false;
    if (raster !== null && raster !== pair.lastRaster) {
      refreshed = true;
      pair.lastRaster = raster;
      pair.front = 1 - pair.front;
      pair.fade = 0;
      writeRaster(pair, pair.front, raster, hooks, isPlankton);
    }
    if (pair.lastRaster === null) return refreshed;
    pair.fade = Math.min(1, pair.fade + dtMs / CROSSFADE_MS);
    const ceiling = pair.peakAlpha * (isPlankton ? hooks.planktonAlpha : 1);
    const front = pair.sprites[pair.front];
    const back = pair.sprites[1 - pair.front];
    if (front !== undefined) front.alpha = ceiling * pair.fade;
    if (back !== undefined) back.alpha = ceiling * (1 - pair.fade);
    return refreshed;
  }

  function writeRaster(
    pair: HazePair,
    slot: number,
    raster: FieldRaster,
    hooks: HazeHooks,
    isPlankton: boolean,
  ): void {
    if (pair.cols !== raster.cols || pair.rows !== raster.rows) {
      releaseBuffers(pair);
      pair.cols = raster.cols;
      pair.rows = raster.rows;
      pair.scratch = new Uint8Array(raster.cols * raster.rows * 4);
      for (let i = 0; i < 2; i += 1) {
        const baked = createBufferTexture(raster.cols, raster.rows);
        pair.buffers[i] = baked;
        const sprite = pair.sprites[i];
        if (sprite === undefined) continue;
        sprite.texture = baked.texture;
        // Both sprites take the world rect now, not just the one being written:
        // the other is the outgoing half of the next cross-fade.
        sprite.width = raster.cols * raster.cellSizeWu;
        sprite.height = raster.rows * raster.cellSizeWu;
      }
    }
    const scratch = pair.scratch;
    const target = pair.buffers[slot];
    const sprite = pair.sprites[slot];
    if (scratch === null || target === undefined || target === null || sprite === undefined) return;

    const normalised = normaliseField(raster, scratch);
    const cell = raster.cellSizeWu;
    const pixels = target.pixels;
    for (let row = 0; row < raster.rows; row += 1) {
      const yWu = (row + 0.5) * cell;
      for (let col = 0; col < raster.cols; col += 1) {
        const base = (row * raster.cols + col) * 4;
        const scale = isPlankton ? hooks.planktonCellMultiplier((col + 0.5) * cell, yWu) : 1;
        const alpha = ((normalised.rgba[base + 3] ?? 0) / 255) * scale;
        pokePremultiplied(
          pixels,
          base,
          normalised.rgba[base] ?? 0,
          normalised.rgba[base + 1] ?? 0,
          normalised.rgba[base + 2] ?? 0,
          alpha,
        );
      }
    }
    target.source.update();
    sprite.width = raster.cols * cell;
    sprite.height = raster.rows * cell;
  }

  /**
   * The richest cells become frond anchors. Selection is a fixed-size insertion
   * pass rather than a sort: 3840 cells x 40 slots at roughly 0.5 Hz, and it
   * allocates nothing.
   */
  function rebuildAnchors(raster: FieldRaster): void {
    topCount = 0;
    for (let i = 0; i < raster.values.length; i += 1) {
      const value = raster.values[i] ?? 0;
      if (value <= 0) continue;
      if (topCount === FROND_ANCHORS && value <= (topValues[topCount - 1] ?? 0)) continue;
      let slot = Math.min(topCount, FROND_ANCHORS - 1);
      while (slot > 0 && (topValues[slot - 1] ?? 0) < value) {
        topValues[slot] = topValues[slot - 1] ?? 0;
        topCells[slot] = topCells[slot - 1] ?? 0;
        slot -= 1;
      }
      topValues[slot] = value;
      topCells[slot] = i;
      if (topCount < FROND_ANCHORS) topCount += 1;
    }

    const next: FrondAnchor[] = [];
    for (let i = 0; i < topCount; i += 1) {
      const cellIndex = topCells[i] ?? 0;
      let anchor = anchorsByCell.get(cellIndex);
      if (anchor === undefined) {
        const col = cellIndex % raster.cols;
        const row = Math.floor(cellIndex / raster.cols);
        const jitterX = (anchorHash(cellIndex * 3 + 1) - 0.5) * raster.cellSizeWu * 0.8;
        const jitterY = (anchorHash(cellIndex * 3 + 2) - 0.5) * raster.cellSizeWu * 0.8;
        anchor = {
          cell: cellIndex,
          x: (col + 0.5) * raster.cellSizeWu + jitterX,
          y: (row + 0.5) * raster.cellSizeWu + jitterY,
          blades: 3 + Math.floor(anchorHash(cellIndex * 3 + 3) * 3),
          scale: 0.7 + anchorHash(cellIndex * 3 + 4) * 0.6,
        };
        anchorsByCell.set(cellIndex, anchor);
      }
      next.push(anchor);
    }
    for (const key of [...anchorsByCell.keys()]) {
      if (!next.some((anchor) => anchor.cell === key)) anchorsByCell.delete(key);
    }
    activeAnchors = next;
  }

  function drawFronds(animMs: number, hooks: HazeHooks): void {
    fronds.clear();
    if (activeAnchors.length === 0) return;
    // Blades lean away from the warm edge, matching the direction the god rays
    // come from, so the reef reads as lit from one side.
    const leanSign = options.warmY <= options.worldHeightWu * 0.5 ? 1 : -1;
    const seconds = animMs / 1000;
    for (const anchor of activeAnchors) {
      const sway = hooks.frondSwayAt(anchor.x, anchor.y);
      for (let blade = 0; blade < anchor.blades; blade += 1) {
        const key = anchor.cell * 8 + blade;
        const spread = (anchorHash(key * 5 + 1) - 0.5) * 1.5;
        const length = FROND_LENGTH_WU * anchor.scale * (0.6 + anchorHash(key * 5 + 2) * 0.8);
        const phase = anchorHash(key * 5 + 3) * Math.PI * 2;
        const rate = 0.25 + anchorHash(key * 5 + 4) * 0.35;
        const wobble = Math.sin(phase + seconds * rate) * length * 0.22 * sway;
        const dirX = Math.sin(spread);
        const dirY = leanSign * Math.cos(spread);
        const tipX = anchor.x + dirX * length + dirY * wobble;
        const tipY = anchor.y + dirY * length - dirX * wobble;
        const midX = anchor.x + dirX * length * 0.5 + dirY * wobble * 0.45;
        const midY = anchor.y + dirY * length * 0.5 - dirX * wobble * 0.45;
        fronds.moveTo(anchor.x, anchor.y);
        fronds.quadraticCurveTo(midX, midY, tipX, tipY);
      }
    }
    fronds.stroke({ color: FROND_COLOUR, alpha: FROND_ALPHA, width: FROND_WIDTH_WU, cap: 'round' });
  }

  function reset(): void {
    for (const pair of [plankton, kelp]) {
      pair.lastRaster = null;
      pair.fade = 0;
      pair.front = 0;
      for (const sprite of pair.sprites) sprite.alpha = 0;
    }
    anchorsByCell.clear();
    activeAnchors = [];
    topCount = 0;
    fronds.clear();
  }

  function destroy(): void {
    for (const pair of [plankton, kelp]) {
      for (const sprite of pair.sprites) sprite.destroy();
      releaseBuffers(pair);
    }
    fronds.destroy();
    anchorsByCell.clear();
    activeAnchors = [];
  }

  return { mount, update, reset, destroy };
}

function makePair(peakAlpha: number): HazePair {
  const sprites: [Sprite, Sprite] = [new Sprite(Texture.EMPTY), new Sprite(Texture.EMPTY)];
  for (const sprite of sprites) {
    sprite.blendMode = 'add';
    sprite.alpha = 0;
    sprite.position.set(0, 0);
  }
  return {
    sprites,
    buffers: [null, null],
    front: 0,
    fade: 0,
    lastRaster: null,
    cols: 0,
    rows: 0,
    scratch: null,
    peakAlpha,
  };
}

function releaseBuffers(pair: HazePair): void {
  for (let i = 0; i < 2; i += 1) {
    const baked = pair.buffers[i];
    if (baked !== undefined && baked !== null) baked.texture.destroy(true);
    pair.buffers[i] = null;
  }
}

/**
 * Index-derived pseudo-randomness. Deliberately not `Math.random`: frond shape
 * is keyed to the raster cell, so the same world redraws the same reef and a
 * screenshot is reproducible.
 */
export function anchorHash(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
