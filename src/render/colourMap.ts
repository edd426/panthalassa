/**
 * Colour resolution (R1). Pure: no Pixi, no DOM.
 *
 * A port of `crudeRenderer.drawOrganisms`'s colour logic from CSS strings to
 * the 0xRRGGBB ints Pixi tints with. The semantics are deliberately unchanged —
 * the crude dots were watched and tuned against real runs, and the palette
 * decisions (why amber and not blue, why signed diverging and never
 * green-to-red) are recorded in `src/app/palette.ts`. Values are imported from
 * there and converted once at module load; nothing here re-declares a colour.
 *
 * Resolution happens once per *slice*, not once per frame: the p5–p95 span the
 * trait ramps stand on is a property of the population, and recomputing it per
 * rAF would make the ramp shimmer while the population sat still.
 */

import { SAMPLE_SLICE, SAMPLE_SLICE_STRIDE } from '../contracts/protocol';
import { TRAIT_META } from '../contracts/traits';
import type { SimConfig } from '../contracts/types';
import { BASELINE, DIVERGING_COOL, DIVERGING_NEUTRAL, DIVERGING_WARM, INK_MUTED, SEQUENTIAL_AMBER } from '../app/palette';
import { MAX_SLOTS } from './contracts';
import type { ColourLegend, ColourMode, FieldRaster, SliceView } from './contracts';
import { sampleRaster } from './fieldSampling';

function hexToInt(hex: string): number {
  return Number.parseInt(hex.slice(1), 16);
}

const SEQUENTIAL_AMBER_INTS = SEQUENTIAL_AMBER.map(hexToInt);
const DIVERGING_COOL_INTS = DIVERGING_COOL.map(hexToInt);
const DIVERGING_WARM_INTS = DIVERGING_WARM.map(hexToInt);
const DIVERGING_NEUTRAL_INT = hexToInt(DIVERGING_NEUTRAL);
const INK_MUTED_INT = hexToInt(INK_MUTED);

/** The crude renderer's species-ring fallback for the unassigned tag. */
export const UNTAGGED_RING_TINT = 0x061a22;

export const BASELINE_TINT = hexToInt(BASELINE);

const HUE_BUCKETS = 48;

/** Golden-angle spacing, so consecutive species tags never land on similar hues. */
export const SPECIES_HUE_STEP_DEG = 137.508;

/** Alpha floor: a starving fish fades, but never past the point of being countable. */
export const ALPHA_FLOOR = 0.3;

/**
 * Condition floor in the measurement modes.
 *
 * The palette was validated against the crude renderer's ground, and the Pixi
 * ocean is darker — which by itself *helps*: every ramp step clears 3:1 against
 * the abyss at full opacity (3.15:1 at the dimmest, 7.7:1 mid-ramp). What does
 * not survive is the compositing. At the 0.3 floor the dimmest amber step lands
 * at 1.29:1 on the abyss, which is a mark you cannot count.
 *
 * Identity mode keeps {@link ALPHA_FLOOR}: there the animal itself is the
 * subject and watching condition drain away is part of the point. In a
 * measurement mode the question is the trait, condition is the secondary
 * channel, and spending some of its range to keep every living animal legible
 * is the right trade.
 */
export const MEASUREMENT_ALPHA_FLOOR = 0.6;

/**
 * Relative-luminance floor applied to measurement tints, lifting only the
 * darkest ramp steps toward white.
 *
 * Chosen as the largest floor that still leaves every adjacent pair of ramp
 * steps separated by ΔL ≥ 0.06, which is the ordinal guarantee `palette.ts`
 * records for these ramps — 0.15 keeps the tightest pair at 0.089, while 0.18
 * would crush it to 0.059 and the ramp would stop reading as a magnitude.
 *
 * With the alpha floor above, this puts the worst living mark at 2.0:1 on the
 * abyss — the same contrast `palette.ts` validated its dim end at (2.06:1) —
 * and a healthy animal at 3.5:1, clearing the 3:1 mark floor.
 */
export const MEASUREMENT_LUMINANCE_FLOOR = 0.15;

export function hslToInt(hueDeg: number, saturation: number, lightness: number): number {
  const h = (((hueDeg % 360) + 360) % 360) / 360;
  const s = Math.min(1, Math.max(0, saturation));
  const l = Math.min(1, Math.max(0, lightness));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = l - c / 2;
  const sector = Math.floor(h * 6) % 6;
  let r = 0;
  let g = 0;
  let b = 0;
  if (sector === 0) [r, g, b] = [c, x, 0];
  else if (sector === 1) [r, g, b] = [x, c, 0];
  else if (sector === 2) [r, g, b] = [0, c, x];
  else if (sector === 3) [r, g, b] = [0, x, c];
  else if (sector === 4) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to8 = (value: number): number => Math.round((value + m) * 255);
  return (to8(r) << 16) | (to8(g) << 8) | to8(b);
}

/** The 48 identity buckets, matching `hsl(h 72% 58%)` in the crude renderer. */
const IDENTITY_TINTS = Array.from({ length: HUE_BUCKETS }, (_unused, index) =>
  hslToInt(Math.round((index * 360) / HUE_BUCKETS), 0.72, 0.58),
);

/** `palette.rampAt` over ints — same index arithmetic, same clamping. */
export function rampTintAt(ramp: readonly number[], t: number): number {
  if (ramp.length === 0) return INK_MUTED_INT;
  const clamped = Math.min(1, Math.max(0, t));
  const index = Math.min(ramp.length - 1, Math.floor(clamped * ramp.length));
  return ramp[index] ?? INK_MUTED_INT;
}

/** `palette.divergingAt` over ints — same 0.12 neutral band, same arm mapping. */
export function divergingTintAt(signed: number): number {
  const magnitude = Math.min(1, Math.abs(signed));
  if (magnitude < 0.12) return DIVERGING_NEUTRAL_INT;
  const arm = signed < 0 ? DIVERGING_COOL_INTS : DIVERGING_WARM_INTS;
  return rampTintAt(arm, (magnitude - 0.12) / 0.88);
}

export function identityTint(hueDeg: number): number {
  const bucket = Math.min(
    HUE_BUCKETS - 1,
    Math.max(0, Math.floor((((hueDeg % 360) + 360) % 360) / (360 / HUE_BUCKETS))),
  );
  return IDENTITY_TINTS[bucket] ?? 0x88aadd;
}

function channelLuminance(value: number): number {
  const s = value / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of a 0xRRGGBB int. */
export function relativeLuminance(tint: number): number {
  return (
    0.2126 * channelLuminance((tint >> 16) & 255) +
    0.7152 * channelLuminance((tint >> 8) & 255) +
    0.0722 * channelLuminance(tint & 255)
  );
}

/**
 * Lift a tint toward white until it reaches `floor` luminance, leaving anything
 * already bright enough exactly as it was.
 *
 * Toward white rather than toward a brighter step of its own ramp: white is the
 * only direction that raises luminance without turning the hue, and hue is
 * carrying the measurement. Solved by bisection rather than algebraically
 * because the sRGB transfer curve is piecewise; it runs on 14 palette entries
 * once at module load, never per organism.
 */
export function liftToLuminance(tint: number, floor: number): number {
  if (relativeLuminance(tint) >= floor) return tint;
  const r = (tint >> 16) & 255;
  const g = (tint >> 8) & 255;
  const b = tint & 255;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 24; i += 1) {
    const mid = (low + high) / 2;
    const blended =
      (Math.round(r + (255 - r) * mid) << 16) |
      (Math.round(g + (255 - g) * mid) << 8) |
      Math.round(b + (255 - b) * mid);
    if (relativeLuminance(blended) < floor) low = mid;
    else high = mid;
  }
  return (
    (Math.round(r + (255 - r) * high) << 16) |
    (Math.round(g + (255 - g) * high) << 8) |
    Math.round(b + (255 - b) * high)
  );
}

// The measurement ramps, pre-lifted once. Identity is deliberately absent: its
// hues are already bright and it is the one mode that reads correctly as-is.
const AMBER_LEGIBLE = SEQUENTIAL_AMBER_INTS.map((t) => liftToLuminance(t, MEASUREMENT_LUMINANCE_FLOOR));
const COOL_LEGIBLE = DIVERGING_COOL_INTS.map((t) => liftToLuminance(t, MEASUREMENT_LUMINANCE_FLOOR));
const WARM_LEGIBLE = DIVERGING_WARM_INTS.map((t) => liftToLuminance(t, MEASUREMENT_LUMINANCE_FLOOR));
const NEUTRAL_LEGIBLE = liftToLuminance(DIVERGING_NEUTRAL_INT, MEASUREMENT_LUMINANCE_FLOOR);

/** `divergingTintAt`, on the abyss-legible ramps. */
export function divergingTintLegible(signed: number): number {
  const magnitude = Math.min(1, Math.abs(signed));
  if (magnitude < 0.12) return NEUTRAL_LEGIBLE;
  const arm = signed < 0 ? COOL_LEGIBLE : WARM_LEGIBLE;
  return rampTintAt(arm, (magnitude - 0.12) / 0.88);
}

export function speciesHueDeg(tag: number): number {
  return (Math.round(tag) * SPECIES_HUE_STEP_DEG) % 360;
}

/** Species ring colour, for R2's near/mid tiers. Untagged animals get the dark ring. */
export function speciesRingTint(tag: number): number {
  const key = Math.round(tag);
  if (key <= 0) return UNTAGGED_RING_TINT;
  return hslToInt(Math.round(speciesHueDeg(key)), 0.95, 0.72);
}

export interface PercentileSpan {
  readonly low: number;
  readonly range: number;
}

export interface ColourMap {
  readonly tints: Uint32Array;
  readonly alphas: Float32Array;
  legend: ColourLegend;
  /** Rows actually written by the last `resolve`. */
  count: number;
  /** The mode that was really used — a trait mode with no trait channel falls back to identity. */
  effectiveMode: ColourMode;
  span: PercentileSpan | null;
  scratch: Float32Array;
}

export function createColourMap(capacity = MAX_SLOTS): ColourMap {
  return {
    tints: new Uint32Array(capacity),
    alphas: new Float32Array(capacity),
    legend: {
      mode: 'identity',
      description: 'display hue (mating signal), ring = species',
      stops: ['hue is the animal itself, not a measurement'],
    },
    count: 0,
    effectiveMode: 'identity',
    span: null,
    scratch: new Float32Array(0),
  };
}

/**
 * The [p5, p95] window of the trait channel.
 *
 * Percentiles rather than min/max because one runaway mutant would otherwise
 * compress the entire population into the bottom step of the ramp and the view
 * would go flat exactly when something interesting had happened.
 */
export function percentileSpan(map: ColourMap, values: Float32Array | null, count: number): PercentileSpan | null {
  if (values === null || count === 0) return null;
  if (map.scratch.length < count) map.scratch = new Float32Array(count);
  const scratch = map.scratch.subarray(0, count);
  scratch.set(values.subarray(0, count));
  scratch.sort();
  const low = scratch[Math.floor((count - 1) * 0.05)] ?? 0;
  const high = scratch[Math.floor((count - 1) * 0.95)] ?? low;
  return { low, range: high - low > 1e-9 ? high - low : 1 };
}

export function buildLegend(
  mode: ColourMode,
  span: PercentileSpan | null,
  temperature: FieldRaster | null,
  thermalReferenceC: number,
): ColourLegend {
  switch (mode) {
    case 'identity':
      return {
        mode,
        description: 'display hue (mating signal), ring = species',
        stops: ['hue is the animal itself, not a measurement'],
      };
    case 'adaptedness': {
      const reference = thermalReferenceC.toFixed(0);
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

/**
 * Condition reads as opacity in every mode; a starving fish fades before it
 * dies. `floor` is where that fade bottoms out — the whole range above it is
 * spent linearly, so at {@link ALPHA_FLOOR} this reproduces the crude
 * renderer's `0.3 + e * 0.7` exactly.
 */
export function conditionAlpha(energyFraction: number, floor: number = ALPHA_FLOOR): number {
  if (!Number.isFinite(energyFraction)) return 1;
  const clamped = Math.min(1, Math.max(0, energyFraction));
  return floor + clamped * (1 - floor);
}

/**
 * Fill `map.tints` / `map.alphas` for one slice and rebuild the legend.
 * `config` is read fresh rather than captured, so a tuning swap of the config
 * object is picked up on the next slice.
 */
export function resolveColours(
  map: ColourMap,
  slice: SliceView,
  mode: ColourMode,
  temperature: FieldRaster | null,
  config: SimConfig,
): void {
  const data = slice.buffer;
  const count = Math.max(
    0,
    Math.min(map.tints.length, slice.count, Math.floor(data.length / SAMPLE_SLICE_STRIDE)),
  );
  const thermalReferenceC = Math.max(0.5, config.thermal.referenceWidthC);

  const traits = slice.traitValues;
  const usable = traits !== undefined && traits.length >= count ? traits : null;
  // A trait mode with no trait channel yet (the first frame after the key was
  // pressed) falls back to identity rather than painting every dot one colour
  // and implying the population is uniform.
  const effective: ColourMode = mode !== 'identity' && mode !== 'energy' && usable === null ? 'identity' : mode;
  const span = percentileSpan(map, usable, count);

  map.count = count;
  map.effectiveMode = effective;
  map.span = span;
  map.legend = buildLegend(effective, span, temperature, thermalReferenceC);

  // Identity keeps the crude renderer's floors; every measuring mode is lifted
  // so a faded animal is still countable against the abyss.
  const alphaFloor = effective === 'identity' ? ALPHA_FLOOR : MEASUREMENT_ALPHA_FLOOR;
  const amber = effective === 'identity' ? SEQUENTIAL_AMBER_INTS : AMBER_LEGIBLE;

  for (let index = 0; index < count; index += 1) {
    const base = index * SAMPLE_SLICE_STRIDE;
    const energyFraction = data[base + SAMPLE_SLICE.energyFraction] ?? 0;
    const traitValue = usable?.[index] ?? 0;

    let tint: number;
    switch (effective) {
      case 'identity':
        tint = identityTint(data[base + SAMPLE_SLICE.hue] ?? 0);
        break;
      case 'adaptedness': {
        // Signed, not absolute: the direction of the mismatch is the story. A
        // whole population turning cool-coloured together is the climate walk
        // outrunning selection, visible at a glance.
        const x = data[base + SAMPLE_SLICE.x] ?? 0;
        const y = data[base + SAMPLE_SLICE.y] ?? 0;
        const water = temperature === null ? traitValue : sampleRaster(temperature, x, y);
        tint = divergingTintLegible((traitValue - water) / thermalReferenceC);
        break;
      }
      case 'diet':
        // Expressed diet is a share in (0,1); 0.5 is the generalist, and the
        // convex efficiency makes that the worst place to be.
        tint = divergingTintLegible((traitValue - 0.5) * 2);
        break;
      case 'speedCap':
      case 'defense':
        tint = rampTintAt(amber, span === null ? 0.5 : (traitValue - span.low) / span.range);
        break;
      case 'energy':
        tint = rampTintAt(amber, energyFraction);
        break;
    }

    map.tints[index] = tint;
    map.alphas[index] = conditionAlpha(energyFraction, alphaFloor);
  }
}
