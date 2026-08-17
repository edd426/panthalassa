/**
 * Field-raster helper tests.
 *
 * The colour table is the part worth pinning: three density fields share one
 * normalisation path and are told apart by tint alone, so "carrion is a
 * different colour from kelp" is the whole readability of the overlay and is
 * exactly the kind of thing a later tidy-up merges back together.
 */

import { describe, expect, it } from 'vitest';
import { ABYSS_COLOUR } from './contracts';
import type { FieldRaster } from './contracts';
import { FIELD_TINT, normaliseField, rasterMean, rasterSpan, sampleRaster } from './fieldSampling';

function raster(field: FieldRaster['field'], values: readonly number[], cols: number, rows: number): FieldRaster {
  return { field, cols, rows, cellSizeWu: 100, values: Float32Array.from(values) };
}

/** WCAG relative luminance of an 8-bit RGB triple. */
function luminance(rgb: readonly [number, number, number]): number {
  const channel = (value: number): number => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function distance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe('sampleRaster', () => {
  it('reads the nearest cell and clamps outside the grid', () => {
    const grid = raster('temperature', [4, 24], 2, 1);
    expect(sampleRaster(grid, 10, 10)).toBe(4);
    expect(sampleRaster(grid, 150, 10)).toBe(24);
    expect(sampleRaster(grid, -500, -500)).toBe(4);
    expect(sampleRaster(grid, 99_999, 99_999)).toBe(24);
  });

  it('summarises a raster', () => {
    const grid = raster('plankton', [1, 2, 3, 6], 2, 2);
    expect(rasterSpan(grid)).toEqual({ low: 1, high: 6 });
    expect(rasterMean(grid)).toBe(3);
    expect(rasterSpan(raster('plankton', [], 0, 0))).toEqual({ low: 0, high: 0 });
  });
});

describe('the field colour table', () => {
  it('gives carrion a tint no one could mistake for either green', () => {
    // The two resources are both green because they are both living biomass;
    // carrion is the one field that is not, and it has to separate at a glance
    // from a kelp bed in the same frame.
    expect(distance(FIELD_TINT.carrion, FIELD_TINT.kelp)).toBeGreaterThan(150);
    expect(distance(FIELD_TINT.carrion, FIELD_TINT.plankton)).toBeGreaterThan(150);
  });

  it('makes carrion the pale one', () => {
    // "Bone against the abyss": the drift of the dead reads as a light patch,
    // which is also the only direction left once both greens are taken.
    expect(luminance(FIELD_TINT.carrion)).toBeGreaterThan(luminance(FIELD_TINT.plankton));
    expect(luminance(FIELD_TINT.plankton)).toBeGreaterThan(luminance(FIELD_TINT.kelp));
    const abyss: [number, number, number] = [
      (ABYSS_COLOUR >> 16) & 255,
      (ABYSS_COLOUR >> 8) & 255,
      ABYSS_COLOUR & 255,
    ];
    expect(luminance(FIELD_TINT.carrion)).toBeGreaterThan(luminance(abyss));
  });
});

describe('normaliseField', () => {
  it('paints a density field in its own tint, with alpha tracking the cell', () => {
    const { rgba, low, high } = normaliseField(raster('carrion', [0, 5, 10], 3, 1));
    expect({ low, high }).toEqual({ low: 0, high: 10 });
    const [r, g, b] = FIELD_TINT.carrion;
    expect([rgba[4], rgba[5], rgba[6]]).toEqual([r, g, b]);
    // Empty cells are fully transparent; a fuller cell is more opaque than a
    // half-full one, on the crude renderer's 0.32 ceiling.
    expect(rgba[3]).toBe(0);
    expect(rgba[11]).toBeGreaterThan(rgba[7] ?? 0);
    expect(rgba[11]).toBeLessThanOrEqual(Math.ceil(255 * 0.32));
  });

  it('keeps temperature on its own diverging path', () => {
    const { rgba } = normaliseField(raster('temperature', [0, 30], 2, 1));
    // Cold is blue-dominant, warm is red-dominant, and neither borrows a
    // density tint — temperature returns before the colour table is read.
    expect(rgba[2]).toBeGreaterThan(rgba[0] ?? 0);
    expect(rgba[4]).toBeGreaterThan(rgba[6] ?? 0);
  });

  it('reuses a buffer of the right length and allocates otherwise', () => {
    const grid = raster('kelp', [1, 2], 2, 1);
    const recycled = new Uint8Array(8);
    expect(normaliseField(grid, recycled).rgba).toBe(recycled);
    expect(normaliseField(grid, new Uint8Array(4)).rgba).not.toBe(recycled);
  });
});
