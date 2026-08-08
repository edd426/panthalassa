/**
 * Dots on a canvas (WP-A6). Deliberately ugly — Phase B replaces this whole
 * file with PixiJS spine-chain creatures. What it has to get right is the
 * mapping, not the looks: hue is the organism's `displayHue` (which is also the
 * mating signal and the search image predators match on), radius is its `size`
 * in cm, and the ring is its species tag. If a dot looks wrong, the model is
 * wrong; that is the entire point of watching this before building graphics.
 *
 * The renderer reads one `Float32Array` sample slice and an optional field
 * raster. It never sees `SimState`, a genome, or an organism object.
 */

import { SAMPLE_SLICE, SAMPLE_SLICE_STRIDE } from '../contracts/protocol';
import type { SimConfig } from '../contracts/types';

/** Field underlays the `f` key cycles through. */
export type FieldOverlay = 'off' | 'plankton' | 'kelp';

export const FIELD_OVERLAYS: readonly FieldOverlay[] = ['off', 'plankton', 'kelp'];

/** A sample slice held on the main thread; `buffer` is the transferred one. */
export interface SliceView {
  readonly count: number;
  readonly buffer: Float32Array;
}

/**
 * Resource cells lifted out of a snapshot. `SimSnapshot` carries `plankton` and
 * `kelp` but not the grid shape, so the caller derives it from the same config
 * the worker was initialised with and checks the length before trusting it.
 */
export interface FieldRaster {
  readonly cols: number;
  readonly rows: number;
  readonly cellSizeWu: number;
  readonly plankton: Float32Array;
  readonly kelp: Float32Array;
}

export interface Frame {
  readonly slice: SliceView | null;
  readonly overlay: FieldOverlay;
  readonly field: FieldRaster | null;
  /** World position of the inspected organism, for the selection halo. */
  readonly selected: { readonly x: number; readonly y: number } | null;
}

/** Screen pixels per world unit of body length. Fish are ~12 cm in a 2000 wu sea. */
const BODY_PIXELS_PER_CM = 0.55;
const MIN_DOT_RADIUS_PX = 1.4;
const MAX_DOT_RADIUS_PX = 16;

/** Golden-angle spacing, so consecutive species tags never land on similar hues. */
const SPECIES_HUE_STEP_DEG = 137.508;

const HUE_BUCKETS = 48;

export class CrudeRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly config: SimConfig;
  private readonly bodyFills: readonly string[];
  private readonly speciesStrokes = new Map<number, string>();

  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private cssWidth = 1;
  private cssHeight = 1;

  constructor(canvas: HTMLCanvasElement, config: SimConfig) {
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('canvas 2d context unavailable');
    this.canvas = canvas;
    this.context = context;
    this.config = config;
    this.bodyFills = Array.from(
      { length: HUE_BUCKETS },
      (_unused, index) => `hsl(${Math.round((index * 360) / HUE_BUCKETS)} 72% 58%)`,
    );
    this.resize();
  }

  /** Pixels per world unit, for turning a click radius in pixels into world units. */
  get pixelsPerWu(): number {
    return this.scale;
  }

  resize(): void {
    const ratio = Math.min(3, Math.max(1, window.devicePixelRatio));
    const cssWidth = Math.max(1, window.innerWidth);
    const cssHeight = Math.max(1, window.innerHeight);

    this.canvas.width = Math.round(cssWidth * ratio);
    this.canvas.height = Math.round(cssHeight * ratio);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;

    const { widthWu, heightWu } = this.config.world;
    this.scale = Math.min(cssWidth / widthWu, cssHeight / heightWu);
    this.offsetX = (cssWidth - widthWu * this.scale) / 2;
    this.offsetY = (cssHeight - heightWu * this.scale) / 2;

    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const bounds = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - bounds.left - this.offsetX) / this.scale,
      y: (clientY - bounds.top - this.offsetY) / this.scale,
    };
  }

  draw(frame: Frame): void {
    const context = this.context;
    const { widthWu, heightWu } = this.config.world;

    context.fillStyle = '#03151d';
    context.fillRect(0, 0, this.cssWidth, this.cssHeight);

    context.save();
    context.translate(this.offsetX, this.offsetY);
    context.scale(this.scale, this.scale);

    // The sea itself: a cold-to-warm wash standing in for the latitudinal
    // gradient, so a dot's position reads as a temperature at a glance.
    const water = context.createLinearGradient(0, 0, 0, heightWu);
    water.addColorStop(0, '#0d3a4a');
    water.addColorStop(1, '#071f2c');
    context.fillStyle = water;
    context.fillRect(0, 0, widthWu, heightWu);

    if (frame.overlay !== 'off' && frame.field !== null) this.drawField(frame.overlay, frame.field);
    if (frame.slice !== null) this.drawOrganisms(frame.slice);
    if (frame.selected !== null) this.drawSelection(frame.selected.x, frame.selected.y);

    context.lineWidth = 2 / this.scale;
    context.strokeStyle = 'rgba(150, 210, 230, 0.35)';
    context.strokeRect(0, 0, widthWu, heightWu);
    context.restore();
  }

  private drawField(overlay: FieldOverlay, field: FieldRaster): void {
    const context = this.context;
    const cells = overlay === 'plankton' ? field.plankton : field.kelp;
    let peak = 0;
    for (let index = 0; index < cells.length; index += 1) {
      const value = cells[index] ?? 0;
      if (value > peak) peak = value;
    }
    if (peak <= 0) return;

    const size = field.cellSizeWu;
    const base = overlay === 'plankton' ? '86, 214, 132' : '26, 128, 96';
    for (let row = 0; row < field.rows; row += 1) {
      for (let col = 0; col < field.cols; col += 1) {
        const value = cells[row * field.cols + col] ?? 0;
        if (value <= 0) continue;
        context.fillStyle = `rgba(${base}, ${((value / peak) * 0.32).toFixed(3)})`;
        context.fillRect(col * size, row * size, size, size);
      }
    }
  }

  private drawOrganisms(slice: SliceView): void {
    const context = this.context;
    const data = slice.buffer;
    const count = Math.min(slice.count, Math.floor(data.length / SAMPLE_SLICE_STRIDE));
    const radiusScale = BODY_PIXELS_PER_CM / this.scale;
    const minRadius = MIN_DOT_RADIUS_PX / this.scale;
    const maxRadius = MAX_DOT_RADIUS_PX / this.scale;

    context.lineWidth = 1 / this.scale;

    for (let index = 0; index < count; index += 1) {
      const base = index * SAMPLE_SLICE_STRIDE;
      const x = data[base + SAMPLE_SLICE.x] ?? 0;
      const y = data[base + SAMPLE_SLICE.y] ?? 0;
      const hue = data[base + SAMPLE_SLICE.hue] ?? 0;
      const size = data[base + SAMPLE_SLICE.size] ?? 0;
      const energyFraction = data[base + SAMPLE_SLICE.energyFraction] ?? 0;
      const speciesTag = data[base + SAMPLE_SLICE.speciesTag] ?? 0;

      const radius = Math.min(maxRadius, Math.max(minRadius, size * radiusScale));
      const bucket = Math.min(
        HUE_BUCKETS - 1,
        Math.max(0, Math.floor((((hue % 360) + 360) % 360) / (360 / HUE_BUCKETS))),
      );

      // Condition reads as opacity: a starving fish fades before it dies.
      context.globalAlpha = Number.isFinite(energyFraction)
        ? Math.min(1, Math.max(0.3, 0.3 + energyFraction * 0.7))
        : 1;
      context.fillStyle = this.bodyFills[bucket] ?? '#8ad';
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();

      context.globalAlpha = 1;
      context.strokeStyle = this.speciesStroke(speciesTag);
      context.stroke();
    }

    context.globalAlpha = 1;
  }

  private drawSelection(x: number, y: number): void {
    const context = this.context;
    context.globalAlpha = 1;
    context.strokeStyle = '#ffffff';
    context.lineWidth = 2 / this.scale;
    context.beginPath();
    context.arc(x, y, 14 / this.scale, 0, Math.PI * 2);
    context.stroke();
  }

  private speciesStroke(tag: number): string {
    const key = Math.round(tag);
    const cached = this.speciesStrokes.get(key);
    if (cached !== undefined) return cached;
    const stroke =
      key <= 0
        ? 'rgba(6, 26, 34, 0.75)'
        : `hsl(${Math.round((key * SPECIES_HUE_STEP_DEG) % 360)} 95% 72%)`;
    this.speciesStrokes.set(key, stroke);
    return stroke;
  }
}
