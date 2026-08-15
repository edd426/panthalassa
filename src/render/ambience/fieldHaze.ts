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

import { BufferImageSource, Container, Graphics, Sprite, Texture } from 'pixi.js';
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
 * How much ambience the frame can afford, derived from `LodState.tier`.
 *
 * The tier already carries R1's frame-time governor, which sheds detail above
 * `GOVERNOR_DEMOTE_MS`, and every layer in the wave lands in that one number. So
 * the ambience gives fill rate back at exactly the moment the frame is over
 * budget, instead of holding a fixed cost and making the creatures pay for it.
 *
 * What is shed is chosen so the picture degrades rather than changes: the world
 * wash, the plankton haze and the kelp fronds are never dropped, because those
 * three are what carry the latitude, the productivity and the reef.
 *
 * Lives here rather than in `ambienceLayer` because this is the leaf module the
 * other three already import; putting it upstream would make the package cyclic.
 */
export interface AmbienceQuality {
  /** How many of the god-ray beams to draw. */
  readonly beams: number;
  /** Draw the kelp haze pass. The fronds stay regardless. */
  readonly kelpHaze: boolean;
  /** Draw the near (screen-space) marine snow field. */
  readonly nearSnow: boolean;
}

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
 * Effective peak alpha of the haze — the real number, because the texture's own
 * alpha channel is a 0..1 response curve (below) rather than a baked-in opacity.
 *
 * The ambience is NOT the diagnostic overlay. `normaliseField` encodes the crude
 * renderer's *measurement* strength: alpha 0.32 x value/high, which over a field
 * whose cells all sit near the maximum paints the entire world rect at close to
 * full strength — correct for reading a field, catastrophic as scenery, because
 * additive green over the whole sea turns an abyssal ocean olive. So the haze
 * takes `normaliseField`'s colour and span and applies its own response instead.
 */
const PLANKTON_PEAK_ALPHA = 0.11;
const KELP_PEAK_ALPHA = 0.085;

/**
 * Alpha response across the raster's own span, `((v - low) / (high - low))^γ`.
 * Rescaling to the span (not to `high` alone) and then bending it means only
 * genuinely rich water glows: the median cell lands near 0.3 of peak, so the sea
 * reads as dark with luminous patches rather than as a uniform green sheet.
 */
const HAZE_GAMMA = 1.7;

/** Cross-fade time between two raster generations. */
const CROSSFADE_MS = 1000;

const FROND_ANCHORS = 40;
const FROND_COLOUR = 0x1f7d5e;
const FROND_ALPHA = 0.3;
const FROND_WIDTH_WU = 1.6;
/** Blade reach, world units. A 12 cm fish spans ~8 wu, so this is kelp-scale. */
const FROND_LENGTH_WU = 46;
/** Resting sway, radians (~5°); a kelp storm scales this up to ~15°. */
const FROND_SWAY_RAD = 0.09;
/** A touch of shear on top of the rotation, so a blade bends rather than pivots. */
const FROND_SKEW = 0.05;

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
    quality: AmbienceQuality,
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
  readonly swayPhase: number;
  readonly swayRate: number;
  /** Index into the persistent Graphics pool, or -1 while unassigned. */
  slot: number;
}

export function createFieldHaze(options: FieldHazeOptions): FieldHaze {
  const plankton = makePair(PLANKTON_PEAK_ALPHA);
  const kelp = makePair(KELP_PEAK_ALPHA);
  /**
   * One persistent Graphics per anchor, its blades tessellated in *local*
   * coordinates when the anchor is assigned and never again. Sway is then a
   * transform write per frond per frame. The single-Graphics version this
   * replaced re-tessellated 160 stroked quadratic curves every frame, which is
   * geometry rebuild plus GPU upload inside `app.render()` sixty times a second.
   */
  const frondRoot = new Container();
  const frondPool: Graphics[] = [];
  const slotAnchor: (FrondAnchor | null)[] = [];
  for (let i = 0; i < FROND_ANCHORS; i += 1) {
    const blade = new Graphics();
    blade.visible = false;
    frondPool.push(blade);
    slotAnchor.push(null);
    frondRoot.addChild(blade);
  }
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
    parent.addChild(frondRoot);
  }

  function update(
    planktonRaster: FieldRaster | null,
    kelpRaster: FieldRaster | null,
    animMs: number,
    dtMs: number,
    hooks: HazeHooks,
    quality: AmbienceQuality,
  ): void {
    stepPair(plankton, planktonRaster, dtMs, hooks, true, true);
    // The kelp raster is still consumed when the pass is shed, so the frond
    // anchors keep tracking the reef and nothing pops back when detail returns.
    const kelpRefreshed = stepPair(kelp, kelpRaster, dtMs, hooks, false, quality.kelpHaze);
    if (kelpRefreshed && kelpRaster !== null) rebuildAnchors(kelpRaster);
    swayFronds(animMs, hooks);
  }

  /** Returns true on the frame a new raster generation was taken up. */
  function stepPair(
    pair: HazePair,
    raster: FieldRaster | null,
    dtMs: number,
    hooks: HazeHooks,
    isPlankton: boolean,
    drawn: boolean,
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
    const ceiling = drawn ? pair.peakAlpha * (isPlankton ? hooks.planktonAlpha : 1) : 0;
    setHalf(pair.sprites[pair.front], ceiling * pair.fade);
    setHalf(pair.sprites[1 - pair.front], ceiling * (1 - pair.fade));
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

    // `normaliseField` supplies the field's colour and its current span; the
    // alpha is this layer's own, because the overlay's is a measurement and the
    // ambience is scenery. See {@link HAZE_GAMMA}.
    const normalised = normaliseField(raster, scratch);
    const span = normalised.high - normalised.low;
    const cell = raster.cellSizeWu;
    const pixels = target.pixels;
    for (let row = 0; row < raster.rows; row += 1) {
      const yWu = (row + 0.5) * cell;
      for (let col = 0; col < raster.cols; col += 1) {
        const index = row * raster.cols + col;
        const base = index * 4;
        const scale = isPlankton ? hooks.planktonCellMultiplier((col + 0.5) * cell, yWu) : 1;
        const t = span > 0 ? ((raster.values[index] ?? 0) - normalised.low) / span : 0;
        const alpha = Math.pow(Math.max(0, Math.min(1, t)), HAZE_GAMMA) * scale;
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
          swayPhase: anchorHash(cellIndex * 3 + 5) * Math.PI * 2,
          swayRate: 0.25 + anchorHash(cellIndex * 3 + 6) * 0.35,
          slot: -1,
        };
        anchorsByCell.set(cellIndex, anchor);
      }
      next.push(anchor);
    }
    for (const key of [...anchorsByCell.keys()]) {
      if (!next.some((anchor) => anchor.cell === key)) anchorsByCell.delete(key);
    }
    assignFrondSlots(next);
    activeAnchors = next;
  }

  /**
   * Hand each anchor a Graphics from the pool. Survivors keep the slot they
   * already hold, so nothing is re-tessellated for a frond that did not change;
   * only slots that changed occupant are redrawn.
   */
  function assignFrondSlots(next: readonly FrondAnchor[]): void {
    for (let slot = 0; slot < FROND_ANCHORS; slot += 1) {
      const held = slotAnchor[slot];
      if (held !== null && held !== undefined && !next.includes(held)) {
        slotAnchor[slot] = null;
        held.slot = -1;
        const blade = frondPool[slot];
        if (blade !== undefined) blade.visible = false;
      }
    }
    for (const anchor of next) {
      if (anchor.slot >= 0) continue;
      const slot = slotAnchor.indexOf(null);
      if (slot < 0) continue; // Pool is exactly FROND_ANCHORS deep; cannot happen.
      slotAnchor[slot] = anchor;
      anchor.slot = slot;
      const blade = frondPool[slot];
      if (blade === undefined) continue;
      drawFrond(blade, anchor);
      blade.position.set(anchor.x, anchor.y);
      blade.visible = true;
    }
  }

  /** Tessellate one frond's blades around a local origin. Runs on refresh only. */
  function drawFrond(blade: Graphics, anchor: FrondAnchor): void {
    // Blades lean away from the warm edge, matching the direction the god rays
    // come from, so the reef reads as lit from one side.
    const leanSign = options.warmY <= options.worldHeightWu * 0.5 ? 1 : -1;
    blade.clear();
    for (let i = 0; i < anchor.blades; i += 1) {
      const key = anchor.cell * 8 + i;
      const spread = (anchorHash(key * 5 + 1) - 0.5) * 1.5;
      const length = FROND_LENGTH_WU * anchor.scale * (0.6 + anchorHash(key * 5 + 2) * 0.8);
      const curl = (anchorHash(key * 5 + 3) - 0.5) * length * 0.35;
      const dirX = Math.sin(spread);
      const dirY = leanSign * Math.cos(spread);
      blade.moveTo(0, 0);
      blade.quadraticCurveTo(
        dirX * length * 0.5 + dirY * curl * 0.45,
        dirY * length * 0.5 - dirX * curl * 0.45,
        dirX * length + dirY * curl,
        dirY * length - dirX * curl,
      );
    }
    blade.stroke({ color: FROND_COLOUR, alpha: FROND_ALPHA, width: FROND_WIDTH_WU, cap: 'round' });
  }

  /** Per frame: two transform writes per frond. No geometry touched. */
  function swayFronds(animMs: number, hooks: HazeHooks): void {
    const seconds = animMs / 1000;
    for (const anchor of activeAnchors) {
      const blade = anchor.slot >= 0 ? frondPool[anchor.slot] : undefined;
      if (blade === undefined) continue;
      const sway = hooks.frondSwayAt(anchor.x, anchor.y);
      const wobble = Math.sin(anchor.swayPhase + seconds * anchor.swayRate) * sway;
      blade.rotation = wobble * FROND_SWAY_RAD;
      blade.skew.x = wobble * FROND_SKEW;
    }
  }

  function reset(): void {
    for (const pair of [plankton, kelp]) {
      pair.lastRaster = null;
      pair.fade = 0;
      pair.front = 0;
      for (const sprite of pair.sprites) {
        sprite.alpha = 0;
        sprite.visible = false;
      }
    }
    anchorsByCell.clear();
    activeAnchors = [];
    topCount = 0;
    for (let slot = 0; slot < FROND_ANCHORS; slot += 1) {
      slotAnchor[slot] = null;
      const blade = frondPool[slot];
      if (blade === undefined) continue;
      blade.clear();
      blade.visible = false;
      blade.rotation = 0;
      blade.skew.x = 0;
    }
  }

  function destroy(): void {
    for (const pair of [plankton, kelp]) {
      for (const sprite of pair.sprites) sprite.destroy();
      releaseBuffers(pair);
    }
    frondRoot.destroy({ children: true });
    anchorsByCell.clear();
    activeAnchors = [];
  }

  return { mount, update, reset, destroy };
}

/**
 * Fill rate is the ambience's real cost: these sprites cover the whole world
 * rect, so on a HiDPI display each one is millions of blended pixels per frame.
 * Once a cross-fade finishes, the outgoing half is a full-screen additive quad
 * contributing nothing — hide it rather than blend it, which takes the steady
 * state from four world-sized haze passes to two.
 */
function setHalf(sprite: Sprite | undefined, alpha: number): void {
  if (sprite === undefined) return;
  const lit = alpha > 0.002;
  if (sprite.visible !== lit) sprite.visible = lit;
  if (lit) sprite.alpha = alpha;
}

function makePair(peakAlpha: number): HazePair {
  const sprites: [Sprite, Sprite] = [new Sprite(Texture.EMPTY), new Sprite(Texture.EMPTY)];
  for (const sprite of sprites) {
    sprite.blendMode = 'add';
    sprite.alpha = 0;
    sprite.visible = false;
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
