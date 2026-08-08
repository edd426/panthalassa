/**
 * Shared model math — FROZEN CONTRACT (see CLAUDE.md).
 *
 * The authored tradeoff formulas that more than one package consumes, so that
 * genetics (A1) and ecology (A2) never import each other. Every function here
 * is **pure**: plain numbers in, a number out, no state, no RNG, no allocation.
 * Every constant lives in `SimConfig`, so the A7 tuning campaign owns them in
 * one place and can log each change against probe numbers.
 *
 * ## The one idea these formulas encode
 *
 * Every trait is unbounded, so nothing here may cap a trait. What stops runaway
 * is that each formula makes a high value *expensive* in a currency the
 * organism also needs. Speed is quadratic in the metabolic bill; thermal
 * breadth is paid for at the performance peak; armour costs energy; being the
 * commonest morph costs you to predators. These are **receding ceilings** — the
 * optimum moves as the environment and the rest of the population move, which
 * is the difference between an evolving population and one that finds the
 * answer in four generations and stops.
 *
 * If you find yourself wanting a `Math.min` here, the model needs another cost,
 * not a clamp.
 */

import { softplus } from './traits';
import type { SimConfig } from './types';

/** Standard logistic. Exported because the predation kernel is not the only thing that needs it. */
export function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * A softplus with an asymptotic **floor** rather than a scale.
 *
 * Approaches `floor` from above as `value → −∞` and is indistinguishable from
 * the identity well above it, so it can keep an ecological quantity positive
 * without ever producing the flat spot that a `Math.max` would. Traits use
 * `applyTraitLink` instead — this is for derived quantities (effective size in
 * a ratio, a denominator that must not reach zero).
 *
 * The result is mathematically strictly above `floor`, and never below it. It
 * does flatten *onto* `floor` in float64 once `value` falls roughly 36·softness
 * beneath it — far outside any reachable range, but the reason a caller must
 * treat the return value as "at least the floor" rather than "above it".
 */
export function softplusFloor(value: number, floor: number, softness = 0.5): number {
  return floor + softplus(value - floor, softness);
}

/**
 * Energy burned per tick.
 *
 * `c0 · size^0.75 · (1 + cs · (v/vRef)²) · (1 + ca · armor) + cw · wariness`
 *
 * Kleiber-ish in size and **quadratic in absolute speed** (wu/tick, normalised
 * by `referenceSpeedWuPerTick`). Absolute, not fraction-of-cap: charging the
 * fraction let a larger `speedCap` deliver more speed for the same bill, so
 * the advertised receding ceiling did not exist (Gate A-1 defect 4). The
 * vigilance term prices `wariness` so it cannot drift free above the sensing
 * horizon (defect 15).
 *
 * `armor` is `armorPlating` in mm — a softplus-floored, non-negative trait.
 * Do **not** pass `defense` here: `defense` is an unbounded predation-kernel
 * logit that may be negative, which would drive `(1 + ca · defense)` to zero or
 * below and produce a negative energy cost. The armour/defense distinction is
 * the point: armour is the thing you pay for, defense is the outcome armour and
 * several other loci buy you.
 */
export function metabolicCostPerTick(
  size: number,
  speedWuPerTick: number,
  armor: number,
  wariness: number,
  config: SimConfig,
): number {
  const { baseRate, sizeExponent, speedCostCoef, referenceSpeedWuPerTick, armorCostCoef, vigilanceCostPerWu } =
    config.metabolism;
  const mass = Math.pow(Math.max(0, size), sizeExponent);
  const speedTerm = speedWuPerTick / Math.max(1e-6, referenceSpeedWuPerTick);
  return (
    baseRate * mass * (1 + speedCostCoef * speedTerm * speedTerm) * (1 + armorCostCoef * Math.max(0, armor)) +
    vigilanceCostPerWu * Math.max(0, wariness)
  );
}

/**
 * Thermal performance multiplier in [0, 1-ish].
 *
 * `exp(−((T − tOpt)/tWidth)²) · (tWidthRef / tWidth)^κ`
 *
 * The first factor is the tolerance curve; the second is the
 * **specialist–generalist tradeoff**: a wide tolerance buys robustness and pays
 * for it at the peak, so neither extreme is free and the population can hold
 * both strategies. With κ = 0 the tax vanishes and `tWidth` runs away.
 *
 * `tWidth` is softplus-floored so it is positive, but a sufficiently negative
 * latent value can still underflow it to zero; the small floor below is
 * numerical protection against a divide-by-zero, not a design bound.
 */
export function thermalPerformance(
  temperatureC: number,
  tOpt: number,
  tWidth: number,
  config: SimConfig,
): number {
  const { referenceWidthC, generalistTaxExponent } = config.thermal;
  const width = Math.max(1e-3, tWidth);
  const z = (temperatureC - tOpt) / width;
  const tolerance = Math.exp(-z * z);
  const tax = Math.pow(referenceWidthC / width, generalistTaxExponent);
  return tolerance * tax;
}

/**
 * Efficiency at extracting energy from plankton, `(1 − diet)^q`.
 *
 * With q > 1 the two diet efficiencies are **convex**, so their sum is
 * minimised at the generalist midpoint: a 50/50 forager is worse at both jobs
 * than a specialist is at one. That is disruptive selection on a continuous
 * trait, and it is the strongest sympatric-speciation mechanism in the model —
 * especially given that `diet` shares locus q36 with `displayHue`, so
 * specialising also splits the mating signal.
 *
 * `diet` is the expressed share in (0,1).
 */
export function dietEfficiencyPlankton(diet: number, config: SimConfig): number {
  return Math.pow(Math.max(0, 1 - diet), config.metabolism.dietConvexity);
}

/** Efficiency at extracting energy from prey, `diet^q`. See {@link dietEfficiencyPlankton}. */
export function dietEfficiencyPrey(diet: number, config: SimConfig): number {
  return Math.pow(Math.max(0, diet), config.metabolism.dietConvexity);
}

/**
 * Holling type-II grazing intake: `bite · dietEff · R / (Rhalf + R)`.
 *
 * Saturating rather than linear, so a rich patch cannot be converted into
 * unbounded energy and the population is limited by the *rate* it can harvest,
 * not by the slot cap. Half the asymptote is reached at `R = Rhalf`.
 */
export function grazingIntake(bite: number, dietEfficiency: number, cellResource: number, config: SimConfig): number {
  const resource = Math.max(0, cellResource);
  return bite * dietEfficiency * (resource / (config.resources.grazingHalfSaturation + resource));
}

/**
 * Probability that one predation attempt kills.
 *
 * The logit sums five terms:
 *
 * 1. `baseLogit` — the overall predation pressure dial.
 * 2. `kAD · (attack − defense)` — the arms race. P9 needs both sides to move.
 * 3. a **size window**: prey are most vulnerable at `sizeRatioOptimum` of the
 *    predator's length, falling off as a Gaussian either side. Too small is not
 *    worth chasing, too big fights back — this is what stops one body size
 *    from being universally optimal.
 * 4. `kSpeed · (speedPredator − speedVictim)` — you cannot eat what outruns you.
 * 5. `kCover · cover` (a **negative** coefficient: kelp shelters prey) plus the
 *    frequency-dependent search-image term.
 *
 * `patternMatchFreq` is the local frequency of the victim's hue morph, 0..1.
 * The term is **centred on `1 / hueBinCount`**, the frequency of a morph in a
 * perfectly even population, so that switching the mechanism off changes the
 * *shape* of predation without shifting its mean. Uncentred, a toggle-off run
 * would also drop overall predation pressure, and A7 could not attribute the
 * difference in maintained variance to frequency dependence rather than to
 * milder predation. This is a positive contribution: the **commonest** morph is
 * eaten more, which protects rare morphs and pumps variance into `displayHue`.
 */
export function predationKillProbability(
  attack: number,
  defense: number,
  sizePredator: number,
  sizeVictim: number,
  speedPredator: number,
  speedVictim: number,
  cover: number,
  patternMatchFreq: number,
  config: SimConfig,
): number {
  const p = config.predation;
  const ratio = sizeVictim / Math.max(1e-3, sizePredator);
  const window = (ratio - p.sizeRatioOptimum) / Math.max(1e-3, p.sizeRatioWidth);
  const neutralFreq = 1 / Math.max(1, p.hueBinCount);

  const logit =
    p.baseLogit +
    p.attackDefenseCoef * (attack - defense) +
    p.sizeWindowGain * Math.exp(-window * window) +
    p.speedDiffCoef * (speedPredator - speedVictim) +
    p.kelpCoverCoef * Math.max(0, cover) +
    p.frequencyDependenceCoef * (patternMatchFreq - neutralFreq);

  return logistic(logit);
}

/**
 * Gompertz senescence hazard per tick, `a · exp(b · (age − onset))`.
 *
 * Flat at `a` up to `onsetTicks`, then exponential. Calibrated so senescence
 * carries 15–30% of deaths and never dominates — herdloom's fatal mistake was
 * making old age the *only* way to die, which removes natural selection
 * entirely. P7 fails if this channel takes more than 70% or less than 5%.
 */
export function senescenceHazard(ageTicks: number, config: SimConfig): number {
  const { gompertzA, gompertzB, onsetTicks } = config.senescence;
  return gompertzA * Math.exp(gompertzB * Math.max(0, ageTicks - onsetTicks));
}

/**
 * Thermal mortality hazard per tick, `hT · max(0, |T − tOpt| − tWidth)²`.
 *
 * Exactly zero inside the tolerance window and quadratic outside it, so a
 * well-matched organism pays nothing and a badly matched one dies fast. Because
 * the window is set by `tWidth` — itself taxed at the performance peak by
 * {@link thermalPerformance} — widening tolerance to escape this hazard is a
 * real bargain rather than a free lunch.
 */
export function temperatureHazard(
  temperatureC: number,
  tOpt: number,
  tWidth: number,
  config: SimConfig,
): number {
  const excess = Math.max(0, Math.abs(temperatureC - tOpt) - Math.max(0, tWidth));
  return config.thermal.hazardCoef * excess * excess;
}
