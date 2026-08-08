/**
 * The trait vocabulary — FROZEN CONTRACT (see CLAUDE.md).
 *
 * ## The one rule
 *
 * Traits are **unbounded physical quantities**, never 0–10 designer scales.
 * Herdloom died of a bounded scale: every trait pinned against the clamp
 * inside four generations and evolution had nowhere left to go. Limits in
 * Panthalassa come from *cost tradeoffs* (metabolism, predation risk, thermal
 * tax), never from a `Math.min`.
 *
 * ## Latent vs expressed
 *
 * Every trait has two values per organism:
 *
 * - **latent** — `baseline + Σ w·(a_mat + a_pat) + e`, an unbounded real. This
 *   is what selection acts on and what popgen statistics (V_A, h², response to
 *   selection) must be computed from.
 * - **expressed** — `applyTraitLink(key, latent)`, what the ecology reads.
 *
 * The link is the identity for most traits. Where a trait is physically
 * non-negative (a fish cannot be −3 cm long) the link is a **softplus**, not a
 * clamp: softplus is strictly increasing everywhere, so the latent value keeps
 * varying and keeps responding to selection even down at the floor. A
 * `Math.max(0, x)` would recreate herdloom's pinning failure at the bottom of
 * the range instead of the top. There is **no upper link anywhere**.
 *
 * `SimState.pop` stores both vectors (`traits` expressed, `traitsLatent`), both
 * written once at birth, so stats never has to invert a link.
 *
 * ## Units
 *
 * - `wu` — world units. The world is 2000×1200 wu.
 * - `tick` — one sim step; 30 ticks/s at 1× speed.
 * - Hue is in degrees on a circle and wraps; it is both the mating display
 *   signal and the render colour.
 */

/** Every quantitative trait an organism expresses. Order is not meaningful; `TRAIT_INDEX` is. */
export type TraitKey =
  /** Body length, cm. Softplus floor. Drives metabolic cost (∝ size^0.75), the predation size window, and clutch size. */
  | 'size'
  /** Top sustained swimming speed, wu/tick. Softplus floor. Cost is ∝ speed², so this is the most expensive trait to hold. */
  | 'speedCap'
  /** Dimensionless conversion efficiency (energy retained per energy of intake), nominally ~1. Softplus floor. */
  | 'metabolicEff'
  /** Preferred water temperature, °C. Identity link — a cold specialist is a low tOpt, not a small one. */
  | 'tOpt'
  /** Half-width of the thermal performance curve, °C. Softplus floor. Wide tolerance pays a peak-performance tax. */
  | 'tWidth'
  /** Trophic position as an allocation share in (0,1) via a logistic link: 0 = obligate plankton filterer, 1 = obligate predator. The *latent* scale is unbounded, so specialists at either end can keep evolving further; efficiency is convex in this share (exponent q), which is what makes selection on diet disruptive. */
  | 'diet'
  /** Offensive capability in predation-kernel logit units. Identity link; may be negative. */
  | 'attack'
  /** Defensive capability in predation-kernel logit units. Identity link; may be negative. */
  | 'defense'
  /** Distance at which a detected threat triggers flight, wu. Softplus floor. Fleeing early is safe and costs foraging time. */
  | 'wariness'
  /** Log-multiplier on time spent foraging in open water rather than under kelp cover. Identity link; enters intake and exposure as exp(forageBoldness). */
  | 'forageBoldness'
  /** Ticks of unsuccessful search before abandoning a patch or a pursuit. Softplus floor. */
  | 'givingUpTime'
  /** Preferred male display hue, degrees (circular, wraps mod 360). */
  | 'prefTarget'
  /** Mate-preference precision, dimensionless. Softplus floor. Preference SD = prefSigmaBaseDeg / (choosinessScale · choosiness); higher = fussier and slower to mate. */
  | 'choosiness'
  /** Male display hue, degrees (circular, wraps mod 360). Also the render colour, and the signal frequency-dependent predation matches on. */
  | 'displayHue'
  // --- morphology channels: evolve freely, interpreted per clade archetype ---
  /** Spine/body segment count, real-valued (rounded for rendering). Softplus floor. Interpreted per clade — see `CLADE_SCHEMA`. */
  | 'segmentCount'
  /** Number of paired appendages, real-valued (rounded for rendering). Softplus floor. */
  | 'finPairs'
  /** Body length-to-width ratio, dimensionless. Softplus floor. High = eel-like, ~1 = discoid. */
  | 'bodyAspect'
  /** Dermal plate thickness, mm. Softplus floor. Feeds defense and metabolic cost. */
  | 'armorPlating';

/**
 * Canonical trait order. **This order defines the memory layout** of
 * `OrganismPools.traits` / `traitsLatent` (`slot * TRAIT_COUNT + TRAIT_INDEX[key]`)
 * and of any trait vector crossing the worker boundary. Appending is a contract
 * change; reordering is a data-corrupting contract change.
 */
export const TRAIT_KEYS = [
  'size',
  'speedCap',
  'metabolicEff',
  'tOpt',
  'tWidth',
  'diet',
  'attack',
  'defense',
  'wariness',
  'forageBoldness',
  'givingUpTime',
  'prefTarget',
  'choosiness',
  'displayHue',
  'segmentCount',
  'finPairs',
  'bodyAspect',
  'armorPlating',
] as const satisfies readonly TraitKey[];

export const TRAIT_COUNT = TRAIT_KEYS.length;

/** Position of each trait in a packed trait vector. */
export const TRAIT_INDEX: Readonly<Record<TraitKey, number>> = Object.freeze(
  Object.fromEntries(TRAIT_KEYS.map((key, index) => [key, index])) as Record<TraitKey, number>,
);

/**
 * How the unbounded latent value becomes the expressed value.
 *
 * - `identity` — expressed = latent. Any real is physically meaningful.
 * - `softplus` — expressed = s·ln(1 + e^(latent/s)). Non-negative, strictly
 *   increasing, and indistinguishable from the identity a few `s` above zero.
 *   NOT a clamp.
 * - `logistic` — expressed = 1/(1 + e^(−latent/s)). For allocation shares only.
 *   Note the one place arithmetic imposes a boundary the design does not: the
 *   expressed value is stored in the Float32 pools, where the result rounds to
 *   exactly 0 or 1 past |latent/s| ≈ 17.3 (not the ≈ 36 of float64). Still
 *   many population SDs from the baseline, and a saturating share is a
 *   deliberate property of a proportion-scale trait — but it is why anything
 *   measuring selection on `diet` must read `traitsLatent` rather than
 *   differencing expressed shares, and why the guild sample reports the
 *   expressed scale alongside.
 * - `circular` — expressed = latent mod 360. For hues and hue preferences.
 */
export type TraitLinkKind = 'identity' | 'softplus' | 'logistic' | 'circular';

/**
 * How fitness reads the trait axis. Documentation, and the gate for the
 * antagonistic-pleiotropy contract test: an entry only counts as antagonistic
 * if the two opposed-sign traits are both `directional` (unambiguously better
 * when higher, in isolation), because opposed signs on a `matching` axis are
 * not a tradeoff.
 */
export type TraitFitnessSense =
  /** Higher is better in isolation; the brake is a cost elsewhere. */
  | 'directional'
  /** Best value is set by the environment or by a partner; both tails are bad. */
  | 'matching'
  /** Lives on a circle; no ordering. */
  | 'circular'
  /** A share of a budget; the interesting structure is at the ends. */
  | 'allocation';

export interface TraitMeta {
  readonly key: TraitKey;
  /** Physical unit, for HUD/inspector labels and for sanity when reading formulas. */
  readonly unit: string;
  readonly link: TraitLinkKind;
  /**
   * Link softness `s`. For `softplus`/`logistic` it is the width of the bend, in
   * latent units; pick it ~10% of the baseline so the link is effectively the
   * identity across the realised range. Unused by `identity`/`circular`.
   */
  readonly linkScale: number;
  /**
   * Founder-population mean on the **latent** scale. Allele effects are centred
   * on zero, so this intercept is what puts the trait in physical units.
   * `SimConfig.genetics.traitBaselineOverrides` retunes it without editing this
   * frozen file.
   */
  readonly baseline: number;
  readonly fitnessSense: TraitFitnessSense;
  /** One of the four traits every variance/flatline probe is denominated in. */
  readonly focal: boolean;
  readonly description: string;
}

const META: readonly TraitMeta[] = [
  { key: 'size', unit: 'cm', link: 'softplus', linkScale: 0.8, baseline: 12, fitnessSense: 'directional', focal: true, description: 'Body length; sets metabolic cost, the predation size window, and clutch size.' },
  { key: 'speedCap', unit: 'wu/tick', link: 'softplus', linkScale: 0.15, baseline: 1.8, fitnessSense: 'directional', focal: false, description: 'Top sustained speed; cost scales with the square.' },
  { key: 'metabolicEff', unit: 'ratio', link: 'softplus', linkScale: 0.08, baseline: 1, fitnessSense: 'directional', focal: false, description: 'Energy retained per unit of intake.' },
  { key: 'tOpt', unit: '°C', link: 'identity', linkScale: 0, baseline: 18, fitnessSense: 'matching', focal: true, description: 'Peak of the thermal performance curve.' },
  { key: 'tWidth', unit: '°C', link: 'softplus', linkScale: 0.5, baseline: 6, fitnessSense: 'directional', focal: false, description: 'Half-width of the thermal performance curve; taxed at the peak.' },
  { key: 'diet', unit: 'share', link: 'logistic', linkScale: 1, baseline: 0, fitnessSense: 'allocation', focal: true, description: 'Plankton filterer (0) to predator (1); efficiency is convex in the share.' },
  { key: 'attack', unit: 'logit', link: 'identity', linkScale: 0, baseline: 0, fitnessSense: 'directional', focal: false, description: 'Offensive term of the predation kernel.' },
  { key: 'defense', unit: 'logit', link: 'identity', linkScale: 0, baseline: 0, fitnessSense: 'directional', focal: true, description: 'Defensive term of the predation kernel.' },
  { key: 'wariness', unit: 'wu', link: 'softplus', linkScale: 4, baseline: 40, fitnessSense: 'directional', focal: false, description: 'Flight-initiation distance.' },
  { key: 'forageBoldness', unit: 'log-multiplier', link: 'identity', linkScale: 0, baseline: 0, fitnessSense: 'directional', focal: false, description: 'Open-water foraging exposure; raises intake and predation risk together.' },
  { key: 'givingUpTime', unit: 'ticks', link: 'softplus', linkScale: 5, baseline: 45, fitnessSense: 'matching', focal: false, description: 'Patience before abandoning a patch or a pursuit.' },
  { key: 'prefTarget', unit: 'deg', link: 'circular', linkScale: 0, baseline: 200, fitnessSense: 'circular', focal: false, description: 'Preferred display hue in a mate.' },
  { key: 'choosiness', unit: 'precision', link: 'softplus', linkScale: 0.15, baseline: 1, fitnessSense: 'matching', focal: false, description: 'Narrowness of the mate-preference window.' },
  { key: 'displayHue', unit: 'deg', link: 'circular', linkScale: 0, baseline: 200, fitnessSense: 'circular', focal: false, description: 'Display colour; the mating signal, the render hue, and the search image predators match on.' },
  { key: 'segmentCount', unit: 'count', link: 'softplus', linkScale: 0.5, baseline: 8, fitnessSense: 'matching', focal: false, description: 'Body segments; interpreted per clade archetype.' },
  { key: 'finPairs', unit: 'count', link: 'softplus', linkScale: 0.3, baseline: 2, fitnessSense: 'matching', focal: false, description: 'Paired appendages; interpreted per clade archetype.' },
  { key: 'bodyAspect', unit: 'ratio', link: 'softplus', linkScale: 0.25, baseline: 3.2, fitnessSense: 'matching', focal: false, description: 'Length over width; eel-like at high values, discoid near 1.' },
  { key: 'armorPlating', unit: 'mm', link: 'softplus', linkScale: 0.15, baseline: 0.6, fitnessSense: 'directional', focal: false, description: 'Dermal plate thickness; buys defense, costs speed and metabolism.' },
];

export const TRAIT_META: Readonly<Record<TraitKey, TraitMeta>> = Object.freeze(
  Object.fromEntries(META.map((meta) => [meta.key, meta])) as Record<TraitKey, TraitMeta>,
);

/**
 * The four traits every variance (P4), flatline (P5) and heritability (P13)
 * probe is denominated in. Chosen to span the model: a life-history trait, an
 * environment-matching trait, the disruptive-selection axis, and one side of
 * the predator–prey arms race.
 */
export const FOCAL_TRAIT_KEYS = TRAIT_KEYS.filter((key) => TRAIT_META[key].focal);

/** Traits the renderer turns into geometry rather than behaviour. */
export const MORPHOLOGY_TRAIT_KEYS = ['segmentCount', 'finPairs', 'bodyAspect', 'armorPlating'] as const satisfies readonly TraitKey[];

/** Traits whose values live on a circle; averaging them needs circular statistics. */
export const CIRCULAR_TRAIT_KEYS = TRAIT_KEYS.filter((key) => TRAIT_META[key].link === 'circular');

/** Degrees in a full hue turn. Display hue and preference target both wrap here. */
export const HUE_PERIOD_DEG = 360;

/** latent → expressed. The only place a link function may be applied. */
export function applyTraitLink(key: TraitKey, latent: number): number {
  const meta = TRAIT_META[key];
  switch (meta.link) {
    case 'identity':
      return latent;
    case 'softplus':
      return softplus(latent, meta.linkScale);
    case 'logistic':
      return 1 / (1 + Math.exp(-latent / meta.linkScale));
    case 'circular':
      return ((latent % HUE_PERIOD_DEG) + HUE_PERIOD_DEG) % HUE_PERIOD_DEG;
  }
}

/**
 * expressed → latent. Provided for tooling and tests; the sim should read
 * `OrganismPools.traitsLatent` instead of inverting, and `circular` is not
 * invertible (it returns its input, having lost the winding number).
 */
export function invertTraitLink(key: TraitKey, expressed: number): number {
  const meta = TRAIT_META[key];
  switch (meta.link) {
    case 'identity':
    case 'circular':
      return expressed;
    case 'softplus':
      return inverseSoftplus(expressed, meta.linkScale);
    case 'logistic': {
      const clamped = Math.min(1 - 1e-9, Math.max(1e-9, expressed));
      return meta.linkScale * Math.log(clamped / (1 - clamped));
    }
  }
}

/** s·ln(1 + e^(x/s)), computed so that large |x/s| does not overflow. */
export function softplus(value: number, scale: number): number {
  if (scale <= 0) return value;
  const z = value / scale;
  return z > 30 ? value : scale * Math.log1p(Math.exp(z));
}

/** Inverse of {@link softplus}; floors at −40·s where the forward map underflows. */
export function inverseSoftplus(value: number, scale: number): number {
  if (scale <= 0) return value;
  const z = value / scale;
  if (z > 30) return value;
  if (z <= 0) return -40 * scale;
  return scale * Math.log(Math.expm1(z));
}

/** Signed shortest angular difference a − b, in (−180, 180]. */
export function hueDelta(a: number, b: number): number {
  const raw = (((a - b) % HUE_PERIOD_DEG) + HUE_PERIOD_DEG * 1.5) % HUE_PERIOD_DEG - HUE_PERIOD_DEG / 2;
  return raw;
}

/** A trait vector as a plain record. Hot paths use the packed `Float32Array` instead. */
export type TraitVector = Readonly<Record<TraitKey, number>>;

/** Read one trait out of a packed per-organism trait array. */
export function readTrait(packed: Float32Array, slot: number, key: TraitKey): number {
  return packed[slot * TRAIT_COUNT + TRAIT_INDEX[key]] ?? 0;
}

/** Write one trait into a packed per-organism trait array. */
export function writeTrait(packed: Float32Array, slot: number, key: TraitKey, value: number): void {
  packed[slot * TRAIT_COUNT + TRAIT_INDEX[key]] = value;
}

/** Copy a packed organism's traits out as a record (inspector / dump path, not hot). */
export function unpackTraits(packed: Float32Array, slot: number): Record<TraitKey, number> {
  const out = {} as Record<TraitKey, number>;
  for (let index = 0; index < TRAIT_COUNT; index += 1) {
    out[TRAIT_KEYS[index] as TraitKey] = packed[slot * TRAIT_COUNT + index] ?? 0;
  }
  return out;
}
