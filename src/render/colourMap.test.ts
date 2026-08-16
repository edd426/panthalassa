import { describe, expect, it } from 'vitest';
import { SAMPLE_SLICE, SAMPLE_SLICE_STRIDE } from '../contracts/protocol';
import { resolveSimConfig } from '../contracts/types';
import {
  DIVERGING_COOL,
  DIVERGING_NEUTRAL,
  DIVERGING_WARM,
  SEQUENTIAL_AMBER,
  divergingAt,
  rampAt,
} from '../app/palette';
import {
  ALPHA_FLOOR,
  MEASUREMENT_ALPHA_FLOOR,
  MEASUREMENT_LUMINANCE_FLOOR,
  UNTAGGED_RING_TINT,
  liftToLuminance,
  relativeLuminance,
  buildLegend,
  conditionAlpha,
  createColourMap,
  divergingTintAt,
  hslToInt,
  identityTint,
  percentileSpan,
  rampTintAt,
  resolveColours,
  signalTint,
  speciesHueDeg,
  speciesRingTint,
} from './colourMap';
import type { FieldRaster, SliceView } from './contracts';

const CONFIG = resolveSimConfig({});
/** The G-B arm. `conspicuousness` only reaches a tint in a world that reads it. */
const SIGNAL_CONFIG = resolveSimConfig({ toggles: { enableAposematism: true } });
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
  conspicuousness?: number;
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
    buffer[base + SAMPLE_SLICE.conspicuousness] = row.conspicuousness ?? 0;
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

describe('legibility on the abyss', () => {
  /** The Pixi ocean's darkest ground — what a mark has to survive against. */
  const ABYSS = 0x03151d;

  function contrast(tint: number, background: number): number {
    const a = relativeLuminance(tint);
    const b = relativeLuminance(background);
    const [high, low] = a >= b ? [a, b] : [b, a];
    return (high + 0.05) / (low + 0.05);
  }

  /** What the GPU actually composites: source over destination, straight alpha. */
  function composite(tint: number, background: number, alpha: number): number {
    const blend = (shift: number): number =>
      Math.round(alpha * ((tint >> shift) & 255) + (1 - alpha) * ((background >> shift) & 255));
    return (blend(16) << 16) | (blend(8) << 8) | blend(0);
  }

  const RAMPS = [SEQUENTIAL_AMBER, DIVERGING_COOL, DIVERGING_WARM].map((ramp) =>
    ramp.map((hex) => liftToLuminance(toInt(hex), MEASUREMENT_LUMINANCE_FLOOR)),
  );

  it('the unlifted palette is what goes invisible — this is the bug', () => {
    // Recorded so the floors below are never "tidied away" as arbitrary.
    const dimmest = toInt(SEQUENTIAL_AMBER[0] ?? '#000000');
    expect(contrast(composite(dimmest, ABYSS, ALPHA_FLOOR), ABYSS)).toBeLessThan(1.4);
    // Yet at full opacity the same colour is fine: the compositing is the fault,
    // not the palette, which is why palette.ts stays frozen.
    expect(contrast(dimmest, ABYSS)).toBeGreaterThan(3);
  });

  it('keeps every living animal countable in a measurement mode', () => {
    for (const ramp of RAMPS) {
      for (const tint of ramp) {
        const faded = composite(tint, ABYSS, MEASUREMENT_ALPHA_FLOOR);
        expect(contrast(faded, ABYSS)).toBeGreaterThanOrEqual(2);
        // A healthy animal clears the 3:1 mark floor palette.ts asks for.
        expect(contrast(tint, ABYSS)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('lifts only the dim end, and never breaks the ramp ordering', () => {
    for (const ramp of RAMPS) {
      let previous = -1;
      for (const tint of ramp) {
        const luminance = relativeLuminance(tint);
        expect(luminance).toBeGreaterThanOrEqual(MEASUREMENT_LUMINANCE_FLOOR - 1e-9);
        // Strictly increasing, and by the margin palette.ts records as the
        // threshold for a ramp still reading as a magnitude.
        if (previous >= 0) expect(luminance - previous).toBeGreaterThanOrEqual(0.06);
        previous = luminance;
      }
    }
    // The bright end is untouched: only steps below the floor move at all.
    const brightest = toInt(SEQUENTIAL_AMBER[SEQUENTIAL_AMBER.length - 1] ?? '#ffffff');
    expect(liftToLuminance(brightest, MEASUREMENT_LUMINANCE_FLOOR)).toBe(brightest);
  });

  it('leaves identity mode exactly as the crude renderer had it', () => {
    const map = createColourMap(8);
    resolveColours(map, makeSlice([{ hue: 10, energy: 0 }]), 'identity', null, CONFIG);
    expect(map.tints[0]).toBe(identityTint(10));
    expect(map.alphas[0]).toBeCloseTo(ALPHA_FLOOR, 6);
  });

  it('raises the condition floor only where the trait is the subject', () => {
    const map = createColourMap(8);
    resolveColours(map, makeSlice([{ energy: 0 }, { energy: 1 }]), 'energy', null, CONFIG);
    expect(map.alphas[0]).toBeCloseTo(MEASUREMENT_ALPHA_FLOOR, 6);
    expect(map.alphas[1]).toBeCloseTo(1, 6);
  });

  it('spends the whole range above whatever floor it is given', () => {
    // At the crude floor the formula is unchanged from Phase A.
    expect(conditionAlpha(0.5)).toBeCloseTo(0.3 + 0.5 * 0.7, 9);
    expect(conditionAlpha(0, MEASUREMENT_ALPHA_FLOOR)).toBeCloseTo(MEASUREMENT_ALPHA_FLOOR, 9);
    expect(conditionAlpha(1, MEASUREMENT_ALPHA_FLOOR)).toBeCloseTo(1, 9);
    expect(conditionAlpha(0.5, MEASUREMENT_ALPHA_FLOOR)).toBeCloseTo(0.8, 9);
  });

  it('paints a starving animal in a trait mode far brighter than it used to', () => {
    const map = createColourMap(8);
    resolveColours(map, makeSlice([{ energy: 0 }], [0]), 'speedCap', null, CONFIG);
    const now = contrast(composite(map.tints[0] ?? 0, ABYSS, map.alphas[0] ?? 0), ABYSS);
    const before = contrast(composite(toInt(SEQUENTIAL_AMBER[0] ?? '#000000'), ABYSS, ALPHA_FLOOR), ABYSS);
    expect(now).toBeGreaterThan(before * 1.5);
  });
});

describe('conspicuousness → saturation and contrast', () => {
  const ABYSS = 0x03151d;

  function chroma(tint: number): number {
    const r = (tint >> 16) & 255;
    const g = (tint >> 8) & 255;
    const b = tint & 255;
    return Math.max(r, g, b) - Math.min(r, g, b);
  }

  function distanceToWater(tint: number): number {
    const channel = (shift: number): number => ((tint >> shift) & 255) - ((ABYSS >> shift) & 255);
    return Math.hypot(channel(16), channel(8), channel(0));
  }

  it('leaves an animal at the baseline pixel-identical', () => {
    // The centring guarantee, asserted as integer equality rather than as a
    // closeness: the off arm and every pre-G-wave world sit at conspicuousness
    // 0, and they have to keep rendering as the colour they always did.
    for (const hue of [0, 47, 118, 203, 299, 358]) {
      expect(signalTint(identityTint(hue), 0)).toBe(identityTint(hue));
    }
    const map = createColourMap(8);
    resolveColours(map, makeSlice([{ hue: 200, conspicuousness: 0 }]), 'identity', null, SIGNAL_CONFIG);
    expect(map.tints[0]).toBe(identityTint(200));
  });

  it('paints nothing at all in a world with the aposematism axis off', () => {
    // Measured on a default (off-arm) run: conspicuousness still carries ≈0.29
    // SD of standing genetic variance, spanning ±1. Nothing in that sim reads
    // it, so tinting by it would show the watcher a signal axis the world does
    // not have — and would break the off-arm picture for every animal at once.
    const rows = [
      { hue: 200, conspicuousness: -1 },
      { hue: 200, conspicuousness: 0 },
      { hue: 200, conspicuousness: 1 },
    ];
    const map = createColourMap(8);
    resolveColours(map, makeSlice(rows), 'identity', null, CONFIG);
    expect([map.tints[0], map.tints[1], map.tints[2]]).toEqual([
      identityTint(200),
      identityTint(200),
      identityTint(200),
    ]);
  });

  it('is monotone in the signal, both ways from the baseline', () => {
    const base = identityTint(200);
    let previousChroma = -1;
    let previousDistance = -1;
    for (let signal = -0.99; signal <= 0.99; signal += 0.03) {
      const tint = signalTint(base, signal);
      // Loud is more of the animal's own colour; cryptic is less of it and
      // closer to the water. Both are monotone, so drawn order is signal order.
      expect(chroma(tint)).toBeGreaterThanOrEqual(previousChroma);
      expect(distanceToWater(tint)).toBeGreaterThanOrEqual(previousDistance - 1);
      previousChroma = chroma(tint);
      previousDistance = distanceToWater(tint);
    }
  });

  it('makes a loud animal more saturated and a cryptic one duller and closer to the water', () => {
    const base = identityTint(200);
    const loud = signalTint(base, 1);
    const cryptic = signalTint(base, -1);
    expect(chroma(loud)).toBeGreaterThan(chroma(base));
    expect(chroma(cryptic)).toBeLessThan(chroma(base) * 0.5);
    expect(distanceToWater(cryptic)).toBeLessThan(distanceToWater(base));
    expect(relativeLuminance(loud)).toBeGreaterThan(relativeLuminance(base));
  });

  it('leaves a fully cryptic animal countable against the abyss', () => {
    // The pull toward the water is the only thing bounding this, so the bound
    // is asserted where a reader will look for it. Below 2:1 and the mark is
    // one the watcher cannot count, which is the failure palette.ts exists to
    // prevent.
    const cryptic = signalTint(identityTint(200), -1);
    const a = relativeLuminance(cryptic);
    const b = relativeLuminance(ABYSS);
    expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThan(2);
  });

  it('reaches identity tints and leaves every measuring ramp alone', () => {
    // A measurement ramp stands on ΔL ≥ 0.06 between adjacent steps; a cryptic
    // animal costs ≈0.13, so two animals with the same trait value would read
    // as two different values. The signal is carried by the near-tier glow in
    // those modes instead.
    const rows = [
      { hue: 200, conspicuousness: -2.5 },
      { hue: 200, conspicuousness: 0 },
      { hue: 200, conspicuousness: 2.5 },
    ];
    const identity = createColourMap(8);
    resolveColours(identity, makeSlice(rows), 'identity', null, SIGNAL_CONFIG);
    expect(new Set([identity.tints[0], identity.tints[1], identity.tints[2]]).size).toBe(3);

    for (const mode of ['speedCap', 'defense', 'energy'] as const) {
      const map = createColourMap(8);
      resolveColours(map, makeSlice(rows, [1, 1, 1]), mode, null, SIGNAL_CONFIG);
      expect(new Set([map.tints[0], map.tints[1], map.tints[2]]).size).toBe(1);
    }
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
