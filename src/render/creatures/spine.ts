/**
 * Spine kinematics — the travelling wave every body plan is hung on.
 *
 * Pure numbers: no Pixi, no DOM, no allocation past `createSpineChain()`, so
 * this module tests headless under the node vitest environment.
 *
 * Two properties matter more than looking right, because everything downstream
 * assumes them:
 *
 * 1. **Segment spacing is exact.** The chain is integrated forward from the
 *    head at a fixed step along a direction derived from the wave's slope,
 *    rather than sampled off `y = A·sin(…)` at even `x`. Sampling in `x`
 *    stretches the body as the wave steepens — the animal visibly grows and
 *    shrinks as it swims. Integrating in arc length cannot.
 * 2. **Phase is 2π-periodic.** Nothing accumulates between frames; the pose is
 *    a pure function of the phase, so a dropped frame cannot desynchronise a
 *    body and a screenshot at the same wall clock is reproducible.
 *
 * The local frame is the one the whole package shares: body length 1, head at
 * the origin, +x forward, so the chain extends toward −x.
 */

/** Widest chain drawn: `armoredCrawler.segmentCount.renderRange` tops out at 28. */
export const MAX_SPINE_POINTS = 32;

export interface SpineParams {
  /** Points in the chain. Rounded and clamped to `[2, MAX_SPINE_POINTS]`. */
  readonly segmentCount: number;
  /** Lateral amplitude at the head, in body lengths. */
  readonly amplitudeHead: number;
  /** Lateral amplitude at the tail tip, in body lengths. */
  readonly amplitudeTail: number;
  /** Travelling-wave wavelength, in body lengths. */
  readonly wavelength: number;
  /** Wave phase, radians. */
  readonly phase: number;
  /** Whole-envelope multiplier: 1 swimming, 0.3 stiff crawler, 0 frozen. */
  readonly amplitudeScale: number;
}

export interface SpineChain {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  /** Unit outward normal at each point (left-hand side of the tail-ward tangent). */
  readonly nxs: Float64Array;
  readonly nys: Float64Array;
  /** Tail-ward tangent angle at each point, radians. */
  readonly angles: Float64Array;
  count: number;
  /** Distance between consecutive points. The chain is exactly unit length. */
  segmentLength: number;
}

export function createSpineChain(): SpineChain {
  return {
    xs: new Float64Array(MAX_SPINE_POINTS),
    ys: new Float64Array(MAX_SPINE_POINTS),
    nxs: new Float64Array(MAX_SPINE_POINTS),
    nys: new Float64Array(MAX_SPINE_POINTS),
    angles: new Float64Array(MAX_SPINE_POINTS),
    count: 0,
    segmentLength: 0,
  };
}

/**
 * Envelope exponent. Above 1 so the head stays quiet while the tail sweeps —
 * the anguilliform look, and the reason the eye reads a direction of travel.
 */
const ENVELOPE_EXP = 1.6;

export function spineSegmentCount(segmentCount: number): number {
  const n = Math.round(segmentCount);
  return n < 2 ? 2 : n > MAX_SPINE_POINTS ? MAX_SPINE_POINTS : n;
}

/** Lateral amplitude at fractional distance `s` from the head, in body lengths. */
export function spineAmplitudeAt(s: number, params: SpineParams): number {
  const t = s < 0 ? 0 : s > 1 ? 1 : s;
  const head = params.amplitudeHead;
  const tail = params.amplitudeTail;
  return (head + (tail - head) * Math.pow(t, ENVELOPE_EXP)) * params.amplitudeScale;
}

/** d(lateral offset)/ds — the slope the chain integrator steers by. */
function lateralSlope(s: number, params: SpineParams): number {
  const t = s < 0 ? 0 : s > 1 ? 1 : s;
  const span = (params.amplitudeTail - params.amplitudeHead) * params.amplitudeScale;
  const amplitude = spineAmplitudeAt(t, params);
  const dAmplitude = span * ENVELOPE_EXP * Math.pow(t, ENVELOPE_EXP - 1);
  const k = (2 * Math.PI) / params.wavelength;
  const angle = k * t - params.phase;
  return dAmplitude * Math.sin(angle) + amplitude * k * Math.cos(angle);
}

/**
 * Integrate the chain into `out`. Exact segment spacing, head pinned at the
 * origin, every point at `x <= 0` because the step direction always carries a
 * negative x component.
 */
export function buildSpine(params: SpineParams, out: SpineChain): void {
  const n = spineSegmentCount(params.segmentCount);
  const segLen = 1 / (n - 1);
  out.count = n;
  out.segmentLength = segLen;
  out.xs[0] = 0;
  out.ys[0] = 0;

  for (let i = 1; i < n; i += 1) {
    // Midpoint slope: second-order accurate on the wave shape at no extra cost,
    // and the step length stays exactly `segLen` either way.
    const slope = lateralSlope((i - 0.5) * segLen, params);
    const inv = segLen / Math.sqrt(1 + slope * slope);
    const dx = -inv;
    const dy = slope * inv;
    out.xs[i] = (out.xs[i - 1] ?? 0) + dx;
    out.ys[i] = (out.ys[i - 1] ?? 0) + dy;
  }

  // Normals come from the drawn polyline, not from the analytic curve, so the
  // offset outline can never disagree with the chain it is offset from.
  for (let i = 0; i < n; i += 1) {
    const prev = i > 0 ? i - 1 : 0;
    const next = i < n - 1 ? i + 1 : n - 1;
    const tx = (out.xs[next] ?? 0) - (out.xs[prev] ?? 0);
    const ty = (out.ys[next] ?? 0) - (out.ys[prev] ?? 0);
    const len = Math.sqrt(tx * tx + ty * ty) || 1;
    const ux = tx / len;
    const uy = ty / len;
    out.angles[i] = Math.atan2(uy, ux);
    out.nxs[i] = -uy;
    out.nys[i] = ux;
  }
}

// ---------------------------------------------------------------------------
// Wall-clock drivers
// ---------------------------------------------------------------------------

export const MIN_SWIM_HZ = 0.6;
export const MAX_SWIM_HZ = 3;

/**
 * Tail-beat frequency from observed speed.
 *
 * Presentation clamp, not a trait clamp: the animal's `speedCap` keeps evolving
 * underneath. Below 0.6 Hz a body reads as dead and above 3 Hz it reads as a
 * strobe, and at 256× time compression the observed speed runs far past both.
 */
export function swimFrequencyHz(speedWuPerS: number, gain = 0.35, base = 0.9): number {
  const hz = base + speedWuPerS * gain;
  return hz < MIN_SWIM_HZ ? MIN_SWIM_HZ : hz > MAX_SWIM_HZ ? MAX_SWIM_HZ : hz;
}

/**
 * Wave phase from the wall clock. `jitter` is the slot's stable uniform, so two
 * animals of the same species never beat in lockstep and the same `nowMs`
 * always reproduces the same pose.
 */
export function wavePhase(nowMs: number, freqHz: number, jitter: number): number {
  return 2 * Math.PI * ((nowMs / 1000) * freqHz + jitter);
}

/** Bell pulse period, seconds. Slow enough to read as a pump rather than a flicker. */
export const BELL_PULSE_SECONDS = 2.2;

/** Fraction of the pulse period spent contracting. The rest is the slow relax. */
const CONTRACTION_FRACTION = 0.28;

/**
 * Medusa bell pulse: +1 fully expanded, −1 fully contracted, 1-periodic in `t`.
 *
 * Deliberately asymmetric — the snap out of expansion takes 28% of the cycle
 * and the recovery takes the other 72%. A symmetric sine reads as breathing;
 * the asymmetry is what reads as swimming. Both joins have zero slope, so the
 * waveform is smooth across the period boundary.
 */
export function bellPulse(t: number): number {
  const frac = t - Math.floor(t);
  if (frac < CONTRACTION_FRACTION) {
    return Math.cos(Math.PI * (frac / CONTRACTION_FRACTION));
  }
  return -Math.cos(Math.PI * ((frac - CONTRACTION_FRACTION) / (1 - CONTRACTION_FRACTION)));
}

/** Bell pulse phase in [0, 1) from the wall clock. */
export function bellPulsePhase(nowMs: number, jitter: number): number {
  const t = nowMs / 1000 / BELL_PULSE_SECONDS + jitter;
  return t - Math.floor(t);
}
