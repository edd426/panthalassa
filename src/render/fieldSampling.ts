/**
 * Pure field-raster helpers shared by the overlay layer (R1), the colour map
 * (R1, adaptedness samples water temperature) and the ambience haze (R3).
 * No Pixi, no DOM — node-testable.
 *
 * The normalisation semantics are the crude renderer's, kept deliberately:
 * every raster is rescaled to its own current span because the climate walk
 * shifts the whole sea — an absolute scale would fade the picture out.
 */

import type { FieldRaster } from './contracts';

/** Value of a field raster at a world position, nearest cell (crude semantics). */
export function sampleRaster(raster: FieldRaster, x: number, y: number): number {
  const col = Math.min(raster.cols - 1, Math.max(0, Math.floor(x / raster.cellSizeWu)));
  const row = Math.min(raster.rows - 1, Math.max(0, Math.floor(y / raster.cellSizeWu)));
  return raster.values[row * raster.cols + col] ?? 0;
}

export function rasterSpan(raster: FieldRaster): { low: number; high: number } {
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < raster.values.length; i += 1) {
    const value = raster.values[i] ?? 0;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  if (low === Infinity) return { low: 0, high: 0 };
  return { low, high };
}

export function rasterMean(raster: FieldRaster): number {
  if (raster.values.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < raster.values.length; i += 1) sum += raster.values[i] ?? 0;
  return sum / raster.values.length;
}

export interface NormalisedField {
  /** Row-major RGBA, `cols * rows * 4`. */
  readonly rgba: Uint8Array;
  readonly low: number;
  readonly high: number;
}

/**
 * Raster → RGBA pixels with the crude renderer's per-frame span rescale.
 * Temperature is a cold-blue → warm-red diverge across the current span;
 * resources (plankton/kelp) are their field colour with alpha proportional to
 * `value / high`, empty cells fully transparent. Callers hand the same output
 * buffer back to avoid churn; a mismatched length allocates a fresh one.
 */
export function normaliseField(raster: FieldRaster, recycle?: Uint8Array): NormalisedField {
  const length = raster.cols * raster.rows * 4;
  const rgba = recycle !== undefined && recycle.length === length ? recycle : new Uint8Array(length);
  const { low, high } = rasterSpan(raster);
  const span = high - low;

  if (raster.field === 'temperature') {
    for (let i = 0; i < raster.values.length; i += 1) {
      const t = span > 0 ? ((raster.values[i] ?? 0) - low) / span : 0.5;
      const base = i * 4;
      rgba[base] = 40 + t * 190;
      rgba[base + 1] = 70;
      rgba[base + 2] = 230 - t * 190;
      rgba[base + 3] = 255 * 0.3;
    }
    return { rgba, low, high };
  }

  const r = raster.field === 'plankton' ? 86 : 26;
  const g = raster.field === 'plankton' ? 214 : 128;
  const b = raster.field === 'plankton' ? 132 : 96;
  for (let i = 0; i < raster.values.length; i += 1) {
    const value = raster.values[i] ?? 0;
    const base = i * 4;
    rgba[base] = r;
    rgba[base + 1] = g;
    rgba[base + 2] = b;
    rgba[base + 3] = high > 0 && value > 0 ? Math.min(255, 255 * (value / high) * 0.32) : 0;
  }
  return { rgba, low, high };
}
