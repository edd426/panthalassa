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
import type { FieldSliceField } from '../contracts/protocol';
import type { TraitKey } from '../contracts/traits';
import { TRAIT_META } from '../contracts/traits';
import type { SimConfig } from '../contracts/types';
import { BASELINE, SEQUENTIAL_AMBER, divergingAt, rampAt } from './palette';

/**
 * How the dots are coloured. `identity` is the original look — hue is the
 * organism's own `displayHue`, which is simultaneously its mating signal and the
 * search image its predators match on, so it is the only mode where colour is a
 * property of the animal rather than a measurement of it.
 */
export type ColourMode = 'identity' | 'adaptedness' | 'speedCap' | 'diet' | 'defense' | 'energy';

export const COLOUR_MODES: readonly ColourMode[] = [
  'identity',
  'adaptedness',
  'speedCap',
  'diet',
  'defense',
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

export const FIELD_OVERLAYS: readonly FieldOverlay[] = ['off', 'plankton', 'kelp', 'temperature'];

/** A sample slice held on the main thread; `buffer` is the transferred one. */
export interface SliceView {
  readonly count: number;
  readonly buffer: Float32Array;
  /** Expressed values of `traitKey`, organism-aligned with `buffer`. */
  readonly traitValues?: Float32Array;
  readonly traitKey?: TraitKey;
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
}

/** Screen pixels per world unit of body length. Fish are ~12 cm in a 2000 wu sea. */
const BODY_PIXELS_PER_CM = 0.55;
const MIN_DOT_RADIUS_PX = 1.4;
const MAX_DOT_RADIUS_PX = 16;

/** Golden-angle spacing, so consecutive species tags never land on similar hues. */
const SPECIES_HUE_STEP_DEG = 137.508;

const HUE_BUCKETS = 48;

/** Value of a field raster at a world position, nearest cell. */
function sampleRaster(raster: FieldRaster, x: number, y: number): number {
  const col = Math.min(raster.cols - 1, Math.max(0, Math.floor(x / raster.cellSizeWu)));
  const row = Math.min(raster.rows - 1, Math.max(0, Math.floor(y / raster.cellSizeWu)));
  return raster.values[row * raster.cols + col] ?? 0;
}

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
  private sortScratch = new Float32Array(0);
  private legend: ColourLegend = {
    mode: 'identity',
    description: 'display hue (mating signal), ring = species',
    stops: [],
  };
  /** Full-scale thermal mismatch for the adaptedness ramp: one reference tolerance half-width. */
  private readonly thermalReferenceC: number;

  constructor(canvas: HTMLCanvasElement, config: SimConfig) {
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('canvas 2d context unavailable');
    this.canvas = canvas;
    this.context = context;
    this.config = config;
    this.thermalReferenceC = Math.max(0.5, config.thermal.referenceWidthC);
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

  /** What the last drawn frame was coloured by; the HUD prints it so hue is never alone. */
  get colourLegend(): ColourLegend {
    return this.legend;
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

    if (frame.overlay !== 'off' && frame.field !== null && frame.field.field === frame.overlay) {
      this.drawField(frame.field);
    }
    if (frame.slice !== null) this.drawOrganisms(frame.slice, frame.colourMode, frame.temperature);
    if (frame.selected !== null) this.drawSelection(frame.selected.x, frame.selected.y);

    context.lineWidth = 2 / this.scale;
    context.strokeStyle = 'rgba(150, 210, 230, 0.35)';
    context.strokeRect(0, 0, widthWu, heightWu);
    context.restore();
  }

  private drawField(field: FieldRaster): void {
    const cells = field.values;
    let low = Infinity;
    let high = -Infinity;
    for (let index = 0; index < cells.length; index += 1) {
      const value = cells[index] ?? 0;
      if (value < low) low = value;
      if (value > high) high = value;
    }
    if (!Number.isFinite(low) || !Number.isFinite(high)) return;

    const context = this.context;
    const size = field.cellSizeWu;
    // Temperature is a diverging axis and is rescaled to whatever range the
    // field currently spans: the climate walk shifts the whole sea, and a fixed
    // scale would wash the gradient out exactly when it starts moving.
    const span = high - low;
    const resourceBase = field.field === 'plankton' ? '86, 214, 132' : '26, 128, 96';

    for (let row = 0; row < field.rows; row += 1) {
      for (let col = 0; col < field.cols; col += 1) {
        const value = cells[row * field.cols + col] ?? 0;
        if (field.field === 'temperature') {
          const t = span > 1e-6 ? (value - low) / span : 0.5;
          const red = Math.round(40 + t * 190);
          const blue = Math.round(230 - t * 190);
          context.fillStyle = `rgba(${red}, 70, ${blue}, 0.3)`;
        } else {
          if (high <= 0 || value <= 0) continue;
          context.fillStyle = `rgba(${resourceBase}, ${((value / high) * 0.32).toFixed(3)})`;
        }
        context.fillRect(col * size, row * size, size, size);
      }
    }
  }

  private drawOrganisms(slice: SliceView, mode: ColourMode, temperature: FieldRaster | null): void {
    const context = this.context;
    const data = slice.buffer;
    const count = Math.min(slice.count, Math.floor(data.length / SAMPLE_SLICE_STRIDE));
    const radiusScale = BODY_PIXELS_PER_CM / this.scale;
    const minRadius = MIN_DOT_RADIUS_PX / this.scale;
    const maxRadius = MAX_DOT_RADIUS_PX / this.scale;

    const traits = slice.traitValues;
    const usable = traits !== undefined && traits.length >= count ? traits : null;
    // A trait mode with no trait channel yet (the first frame after the key was
    // pressed) falls back to identity rather than painting every dot one colour
    // and implying the population is uniform.
    const effective: ColourMode = mode !== 'identity' && mode !== 'energy' && usable === null ? 'identity' : mode;
    const span = this.percentileSpan(usable, count);
    this.legend = this.buildLegend(effective, span, temperature);

    context.lineWidth = 1 / this.scale;

    for (let index = 0; index < count; index += 1) {
      const base = index * SAMPLE_SLICE_STRIDE;
      const x = data[base + SAMPLE_SLICE.x] ?? 0;
      const y = data[base + SAMPLE_SLICE.y] ?? 0;
      const size = data[base + SAMPLE_SLICE.size] ?? 0;
      const energyFraction = data[base + SAMPLE_SLICE.energyFraction] ?? 0;
      const traitValue = usable?.[index] ?? 0;

      const radius = Math.min(maxRadius, Math.max(minRadius, size * radiusScale));

      let fill: string;
      switch (effective) {
        case 'identity': {
          const hue = data[base + SAMPLE_SLICE.hue] ?? 0;
          const bucket = Math.min(
            HUE_BUCKETS - 1,
            Math.max(0, Math.floor((((hue % 360) + 360) % 360) / (360 / HUE_BUCKETS))),
          );
          fill = this.bodyFills[bucket] ?? '#8ad';
          break;
        }
        case 'adaptedness': {
          // Signed, not absolute: the direction of the mismatch is the story.
          // During a warm excursion of the climate walk the whole population
          // turns cool-coloured together — every fish wanting a colder sea than
          // the one it is in — and that is the OU walk outrunning selection,
          // visible at a glance.
          const water = temperature === null ? traitValue : sampleRaster(temperature, x, y);
          fill = divergingAt((traitValue - water) / this.thermalReferenceC);
          break;
        }
        case 'diet':
          // Expressed diet is a share in (0,1); 0.5 is the generalist, and the
          // convex efficiency makes that the worst place to be.
          fill = divergingAt((traitValue - 0.5) * 2);
          break;
        case 'speedCap':
        case 'defense':
          fill = rampAt(SEQUENTIAL_AMBER, span === null ? 0.5 : (traitValue - span.low) / span.range);
          break;
        case 'energy':
          fill = rampAt(SEQUENTIAL_AMBER, energyFraction);
          break;
      }

      // Condition still reads as opacity in every mode: a starving fish fades
      // before it dies, which is a different question from what it is coloured by.
      context.globalAlpha = Number.isFinite(energyFraction)
        ? Math.min(1, Math.max(0.3, 0.3 + energyFraction * 0.7))
        : 1;
      context.fillStyle = fill;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();

      context.globalAlpha = 1;
      // Species rings only in identity mode. Over a trait ramp a bright ring
      // fights the fill it surrounds, and one question per view reads better.
      context.strokeStyle =
        effective === 'identity' ? this.speciesStroke(data[base + SAMPLE_SLICE.speciesTag] ?? 0) : BASELINE;
      context.stroke();
    }

    context.globalAlpha = 1;
  }

  /**
   * The [p5, p95] window of the trait channel, recomputed per slice.
   *
   * Percentiles rather than min/max because one runaway mutant would otherwise
   * compress the entire population into the bottom step of the ramp and the view
   * would go flat exactly when something interesting had happened.
   */
  private percentileSpan(values: Float32Array | null, count: number): { low: number; range: number } | null {
    if (values === null || count === 0) return null;
    if (this.sortScratch.length < count) this.sortScratch = new Float32Array(count);
    const scratch = this.sortScratch.subarray(0, count);
    scratch.set(values.subarray(0, count));
    scratch.sort();
    const low = scratch[Math.floor((count - 1) * 0.05)] ?? 0;
    const high = scratch[Math.floor((count - 1) * 0.95)] ?? low;
    return { low, range: high - low > 1e-9 ? high - low : 1 };
  }

  private buildLegend(
    mode: ColourMode,
    span: { low: number; range: number } | null,
    temperature: FieldRaster | null,
  ): ColourLegend {
    switch (mode) {
      case 'identity':
        return {
          mode,
          description: 'display hue (mating signal), ring = species',
          stops: ['hue is the animal itself, not a measurement'],
        };
      case 'adaptedness': {
        const reference = this.thermalReferenceC.toFixed(0);
        return {
          mode,
          description: `tOpt − local water °C${temperature === null ? ' (waiting for temperature field)' : ''}`,
          stops: [`−${reference} wants colder`, 'matched', `+${reference} wants warmer`],
        };
      }
      case 'diet':
        return { mode, description: 'diet share', stops: ['0.0 filterer', '0.5 generalist', '1.0 predator'] };
      case 'energy':
        return { mode, description: 'energy as a fraction of storage', stops: ['0% empty', '100% full'] };
      case 'speedCap':
      case 'defense': {
        const unit = TRAIT_META[mode].unit;
        const low = span === null ? '—' : span.low.toFixed(2);
        const high = span === null ? '—' : (span.low + span.range).toFixed(2);
        return { mode, description: `${mode} (${unit}), p5–p95 of the living`, stops: [`${low} low`, `${high} high`] };
      }
    }
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
