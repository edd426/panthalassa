import { describe, expect, it } from 'vitest';
import { SAMPLE_SLICE, SAMPLE_SLICE_STRIDE } from '../contracts/protocol';
import { resolveSimConfig } from '../contracts/types';
import { DIVERGING_NEUTRAL, SEQUENTIAL_AMBER, divergingAt, rampAt } from '../app/palette';
import {
  ALPHA_FLOOR,
  UNTAGGED_RING_TINT,
  buildLegend,
  conditionAlpha,
  createColourMap,
  divergingTintAt,
  hslToInt,
  identityTint,
  percentileSpan,
  rampTintAt,
  resolveColours,
  speciesHueDeg,
  speciesRingTint,
} from './colourMap';
import type { FieldRaster, SliceView } from './contracts';

const CONFIG = resolveSimConfig({});
const THERMAL_REFERENCE_C = Math.max(0.5, CONFIG.thermal.referenceWidthC);

function toInt(hex: string): number {
  return Number.parseInt(hex.slice(1), 16);
}

/** Independent HSL→RGB, written from the CSS definition rather than ported. */
function referenceHslInt(hueDeg: number, saturation: number, lightness: number): number {
  const h = (((hueDeg % 360) + 360) % 360) / 360;
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const channel = (offset: number): number => {
    let t = h + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return (
    (Math.round(channel(1 / 3) * 255) << 16) | (Math.round(channel(0) * 255) << 8) | Math.round(channel(-1 / 3) * 255)
  );
}

interface Row {
  x?: number;
  y?: number;
  hue?: number;
  energy?: number;
}

function makeSlice(rows: readonly Row[], traitValues?: readonly number[]): SliceView {
  const buffer = new Float32Array(rows.length * SAMPLE_SLICE_STRIDE);
  rows.forEach((row, index) => {
    const base = index * SAMPLE_SLICE_STRIDE;
    buffer[base + SAMPLE_SLICE.slot] = index;
    buffer[base + SAMPLE_SLICE.x] = row.x ?? 0;
    buffer[base + SAMPLE_SLICE.y] = row.y ?? 0;
    buffer[base + SAMPLE_SLICE.hue] = row.hue ?? 0;
    buffer[base + SAMPLE_SLICE.size] = 12;
    buffer[base + SAMPLE_SLICE.speciesTag] = 1;
    buffer[base + SAMPLE_SLICE.energyFraction] = row.energy ?? 1;
  });
  if (traitValues === undefined) return { count: rows.length, buffer };
  return { count: rows.length, buffer, traitValues: Float32Array.from(traitValues), traitKey: 'speedCap' };
}

function raster(values: readonly number[], cols: number, rows: number): FieldRaster {
  return { field: 'temperature', cols, rows, cellSizeWu: 100, values: Float32Array.from(values) };
}

describe('palette parity', () => {
  it('reproduces divergingAt exactly, as an int', () => {
    for (let signed = -2; signed <= 2; signed += 0.017) {
      expect(divergingTintAt(signed)).toBe(toInt(divergingAt(signed)));
    }
    expect(divergingTintAt(0)).toBe(toInt(DIVERGING_NEUTRAL));
    expect(divergingTintAt(0.119)).toBe(toInt(DIVERGING_NEUTRAL));
  });

  it('reproduces rampAt exactly, as an int', () => {
    const amber = SEQUENTIAL_AMBER.map(toInt);
    for (let t = -0.5; t <= 1.5; t += 0.013) {
      expect(rampTintAt(amber, t)).toBe(toInt(rampAt(SEQUENTIAL_AMBER, t)));
    }
  });

  it('converts hsl the way a browser would', () => {
    for (const hue of [0, 37, 120, 200, 359]) {
      expect(hslToInt(hue, 0.72, 0.58)).toBe(referenceHslInt(hue, 0.72, 0.58));
      expect(hslToInt(hue, 0.95, 0.72)).toBe(referenceHslInt(hue, 0.95, 0.72));
    }
  });

  it('buckets identity hue into 48 steps of hsl(h 72% 58%)', () => {
    expect(identityTint(0)).toBe(referenceHslInt(0, 0.72, 0.58));
    expect(identityTint(7)).toBe(identityTint(0));
    expect(identityTint(8)).not.toBe(identityTint(0));
    expect(identityTint(-10)).toBe(identityTint(350));
    expect(identityTint(360)).toBe(identityTint(0));
  });

  it('spaces species rings by the golden angle', () => {
    expect(speciesHueDeg(1)).toBeCloseTo(137.508, 6);
    expect(speciesHueDeg(2)).toBeCloseTo(275.016, 6);
    expect(speciesRingTint(0)).toBe(UNTAGGED_RING_TINT);
    expect(speciesRingTint(1)).toBe(referenceHslInt(Math.round(137.508), 0.95, 0.72));
  });
});

describe('percentile span', () => {
  it('ignores a runaway outlier instead of flattening the ramp', () => {
    const map = createColourMap(128);
    const values = Float32Array.from({ length: 100 }, (_unused, index) => (index === 99 ? 10_000 : index));
    const span = percentileSpan(map, values, 100);
    expect(span).not.toBeNull();
    expect(span?.low).toBe(4);
    expect((span?.low ?? 0) + (span?.range ?? 0)).toBe(94);

    // The same data on a min/max span would put a mid-population animal in the
    // bottom ramp step; on p5–p95 it lands in the middle.
    const mid = rampTintAt(
      SEQUENTIAL_AMBER.map(toInt),
      ((span?.low ?? 0) + (span?.range ?? 0) / 2 - (span?.low ?? 0)) / (span?.range ?? 1),
    );
    expect(mid).toBe(toInt(rampAt(SEQUENTIAL_AMBER, 0.5)));
    expect(mid).not.toBe(toInt(rampAt(SEQUENTIAL_AMBER, 49 / 10_000)));
  });

  it('is null with no trait channel and survives a degenerate span', () => {
    const map = createColourMap(8);
    expect(percentileSpan(map, null, 4)).toBeNull();
    expect(percentileSpan(map, Float32Array.from([3, 3, 3, 3]), 4)).toEqual({ low: 3, range: 1 });
  });
});

describe('resolveColours', () => {
  it('colours identity by the animal own hue', () => {
    const map = createColourMap(8);
    resolveColours(map, makeSlice([{ hue: 10 }, { hue: 200 }]), 'identity', null, CONFIG);
    expect(map.tints[0]).toBe(identityTint(10));
    expect(map.tints[1]).toBe(identityTint(200));
    expect(map.effectiveMode).toBe('identity');
  });

  it('falls back to identity when a trait mode has no trait channel yet', () => {
    const map = createColourMap(8);
    resolveColours(map, makeSlice([{ hue: 10 }]), 'speedCap', null, CONFIG);
    expect(map.effectiveMode).toBe('identity');
    expect(map.tints[0]).toBe(identityTint(10));
    expect(map.legend.mode).toBe('identity');
  });

  it('keeps energy working without a trait channel', () => {
    const map = createColourMap(8);
    resolveColours(map, makeSlice([{ energy: 0.9 }]), 'energy', null, CONFIG);
    expect(map.effectiveMode).toBe('energy');
    expect(map.tints[0]).toBe(toInt(rampAt(SEQUENTIAL_AMBER, 0.9)));
  });

  it('reads adaptedness against the water each animal is actually in', () => {
    const map = createColourMap(8);
    // Two cells: cold on the left, warm on the right.
    const temperature = raster([4, 24], 2, 1);
    const slice = makeSlice([{ x: 10, y: 10 }, { x: 150, y: 10 }], [14, 14]);
    resolveColours(map, slice, 'adaptedness', temperature, CONFIG);
    expect(map.tints[0]).toBe(toInt(divergingAt((14 - 4) / THERMAL_REFERENCE_C)));
    expect(map.tints[1]).toBe(toInt(divergingAt((14 - 24) / THERMAL_REFERENCE_C)));
    expect(map.tints[0]).not.toBe(map.tints[1]);
  });

  it('reads neutral for every animal while the temperature field is missing', () => {
    const map = createColourMap(8);
    resolveColours(map, makeSlice([{}, {}], [14, 2]), 'adaptedness', null, CONFIG);
    expect(map.tints[0]).toBe(toInt(DIVERGING_NEUTRAL));
    expect(map.tints[1]).toBe(toInt(DIVERGING_NEUTRAL));
  });

  it('puts the diet generalist on the diverging midpoint', () => {
    const map = createColourMap(8);
    resolveColours(map, makeSlice([{}, {}, {}], [0.5, 0, 1]), 'diet', null, CONFIG);
    expect(map.tints[0]).toBe(toInt(DIVERGING_NEUTRAL));
    expect(map.tints[1]).toBe(toInt(divergingAt(-1)));
    expect(map.tints[2]).toBe(toInt(divergingAt(1)));
  });

  it('ramps a trait mode over the p5–p95 window', () => {
    const map = createColourMap(256);
    const values = Array.from({ length: 100 }, (_unused, index) => (index === 99 ? 10_000 : index));
    const rows = values.map(() => ({}) as Row);
    resolveColours(map, makeSlice(rows, values), 'speedCap', null, CONFIG);
    const span = map.span;
    expect(span).not.toBeNull();
    expect(map.tints[49]).toBe(toInt(rampAt(SEQUENTIAL_AMBER, (49 - (span?.low ?? 0)) / (span?.range ?? 1))));
    // The outlier saturates at the top of the ramp rather than defining it.
    expect(map.tints[99]).toBe(toInt(rampAt(SEQUENTIAL_AMBER, 1)));
  });

  it('holds the alpha floor and never exceeds one', () => {
    expect(conditionAlpha(0)).toBe(ALPHA_FLOOR);
    expect(conditionAlpha(1)).toBe(1);
    expect(conditionAlpha(0.5)).toBeCloseTo(0.65, 9);
    expect(conditionAlpha(Number.NaN)).toBe(1);
    expect(conditionAlpha(-5)).toBe(ALPHA_FLOOR);

    const map = createColourMap(8);
    resolveColours(map, makeSlice([{ energy: 0 }, { energy: 1 }]), 'identity', null, CONFIG);
    expect(map.alphas[0]).toBeCloseTo(ALPHA_FLOOR, 6);
    expect(map.alphas[1]).toBe(1);
  });
});

describe('legend', () => {
  it('prints the crude renderer text for every mode', () => {
    expect(buildLegend('identity', null, null, 6)).toEqual({
      mode: 'identity',
      description: 'display hue (mating signal), ring = species',
      stops: ['hue is the animal itself, not a measurement'],
    });
    expect(buildLegend('diet', null, null, 6)).toEqual({
      mode: 'diet',
      description: 'diet share',
      stops: ['0.0 filterer', '0.5 generalist', '1.0 predator'],
    });
    expect(buildLegend('energy', null, null, 6)).toEqual({
      mode: 'energy',
      description: 'energy as a fraction of storage',
      stops: ['0% empty', '100% full'],
    });
  });

  it('says so when adaptedness has no water to compare against', () => {
    const waiting = buildLegend('adaptedness', null, null, 6);
    expect(waiting.description).toBe('tOpt − local water °C (waiting for temperature field)');
    expect(waiting.stops).toEqual(['−6 wants colder', 'matched', '+6 wants warmer']);

    const ready = buildLegend('adaptedness', null, raster([10], 1, 1), 6);
    expect(ready.description).toBe('tOpt − local water °C');
  });

  it('prints the p5–p95 window and unit for a trait ramp', () => {
    expect(buildLegend('speedCap', { low: 1.25, range: 2 }, null, 6)).toEqual({
      mode: 'speedCap',
      description: 'speedCap (wu/tick), p5–p95 of the living',
      stops: ['1.25 low', '3.25 high'],
    });
    expect(buildLegend('defense', null, null, 6)).toEqual({
      mode: 'defense',
      description: 'defense (logit), p5–p95 of the living',
      stops: ['— low', '— high'],
    });
  });

  it('is rebuilt by resolveColours for the mode actually used', () => {
    const map = createColourMap(8);
    resolveColours(map, makeSlice([{}], [2]), 'speedCap', null, CONFIG);
    expect(map.legend.mode).toBe('speedCap');
    expect(map.legend.description).toContain('p5–p95');
  });
});
