/**
 * The one place colour is decided (WP-A6).
 *
 * Every value here was produced by the `dataviz` skill's procedure and checked
 * with its validator against **this app's own surfaces** — the deep-sea gradient
 * `#0d3a4a` (top, the worst case for contrast) and the chart panel `#03151d` —
 * not against the reference surfaces, because a contrast number only means
 * something against the surface the mark actually lands on.
 *
 * Recorded results, so the next person does not have to re-derive them:
 *
 * - Chart series (categorical, dark slots 1+2): `#3987e5` / `#d95926`.
 *   Lightness band PASS, chroma PASS, CVD ΔE 26.8 (protan) PASS, normal-vision
 *   ΔE 31.8 PASS, contrast ≥3:1 PASS.
 * - {@link SEQUENTIAL_AMBER} (magnitude): ordinal PASS — monotone lightness,
 *   every adjacent ΔL ≥ 0.06, dim end 2.06:1 on the sea, single hue (14° spread).
 * - {@link DIVERGING_COOL} / {@link DIVERGING_WARM} (polarity): both arms ordinal
 *   PASS; the warm arm had to be re-spaced upward because its first dim end sat
 *   at 1.68:1, below the 2:1 floor.
 * - {@link DIVERGING_NEUTRAL} `#898781` at 3.40:1 on the sea top. A diverging
 *   midpoint is normally allowed to recede toward the surface, but these marks
 *   are *dots*: a well-adapted fish that fades to invisible is a fish the
 *   watcher cannot count, so the midpoint holds the 3:1 mark floor instead.
 *
 * Why no green-to-red anywhere: red/green is the canonical dichromat collision.
 * Adaptedness is rendered as a *signed* diverging ramp instead — see
 * `crudeRenderer.ts`.
 */

/** Sequential magnitude, dim → bright. Amber because the sea is blue: a blue ramp on blue water encodes nothing. */
export const SEQUENTIAL_AMBER = ['#8a5a14', '#b8791c', '#dc9a22', '#f0b747', '#ffd98a'] as const;

/** Diverging, cool arm: midpoint → pole. */
export const DIVERGING_COOL = ['#4a6a90', '#6d9bd0', '#9ec5f4', '#cde2fb'] as const;

/** Diverging, warm arm: midpoint → pole. Equal step count to the cool arm. */
export const DIVERGING_WARM = ['#c05050', '#e06a6a', '#f08d8d', '#ffb8b8'] as const;

/** The neutral that means "no polarity". Documented muted ink, which clears 3:1 as a dot. */
export const DIVERGING_NEUTRAL = '#898781';

/** Categorical slot 1 — the primary series of every single-series chart. */
export const SERIES_1 = '#3987e5';

/** Categorical slot 2 — the second series where a chart carries two on one axis. */
export const SERIES_2 = '#d95926';

/** Chart chrome, from the reference palette's dark column. */
export const INK_PRIMARY = '#ffffff';
export const INK_SECONDARY = '#c3c2b7';
export const INK_MUTED = '#898781';
export const GRIDLINE = '#2c2c2a';
export const BASELINE = '#383835';

/** Pick a step from a ramp by a 0..1 position. */
export function rampAt(ramp: readonly string[], t: number): string {
  if (ramp.length === 0) return INK_MUTED;
  const clamped = Math.min(1, Math.max(0, t));
  const index = Math.min(ramp.length - 1, Math.floor(clamped * ramp.length));
  return ramp[index] ?? INK_MUTED;
}

/**
 * A signed value in [-1, 1] to a diverging colour: cool pole at −1, neutral at
 * 0, warm pole at +1. The neutral band is deliberately wide enough to read as a
 * band rather than a knife edge, so "matched" is a visible state.
 */
export function divergingAt(signed: number): string {
  const magnitude = Math.min(1, Math.abs(signed));
  if (magnitude < 0.12) return DIVERGING_NEUTRAL;
  const arm = signed < 0 ? DIVERGING_COOL : DIVERGING_WARM;
  return rampAt(arm, (magnitude - 0.12) / 0.88);
}
