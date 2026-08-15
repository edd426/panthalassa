/**
 * Detail tier selection (R1). Pure: no Pixi, no DOM, and it never reads a
 * clock — `nowMs` arrives in the inputs so the hysteresis and the governor can
 * be driven frame by frame in a node test.
 *
 * Two independent pressures pick the tier. The *criteria* answer "is there
 * anything to see at this zoom": a fish 3 px long gets no spine chain no matter
 * how fast the machine is. The *governor* answers "can we afford it", and
 * overrides the criteria downward when the measured frame cost says the answer
 * is no. Both are deliberately sticky — a tier that flaps between near and mid
 * every few frames looks far worse than the lower tier held steadily.
 */

import { CM_TO_WU } from './contracts';
import type { LodState, LodTier } from './contracts';

/** Fraction a criterion must be beaten by before the tier actually moves. */
export const HYSTERESIS = 0.15;

/** How long a candidate tier has to stay the candidate before the switch commits. */
export const STABILITY_MS = 500;

/** Cross-fade length; `previousTier` stays non-null for exactly this long. */
export const BLEND_MS = 220;

/** Frame cost above which the governor sheds a tier (≈2/3 of a 16.7 ms budget). */
export const GOVERNOR_DEMOTE_MS = 11;

/** Frame cost the governor wants to see before it hands detail back. */
export const GOVERNOR_PROMOTE_MS = 7;

/** Minimum dwell after any governor move, so a demote cannot be undone by its own relief. */
export const GOVERNOR_HOLD_MS = 2000;

/** How long the frame cost must stay under the promote threshold before detail returns. */
export const GOVERNOR_PROMOTE_SUSTAIN_MS = 3000;

/** Deepest the governor may push below the criteria tier. */
const MAX_PENALTY = 3;

/**
 * How long a tier stays distrusted after it proved too expensive, doubling on
 * each repeat failure up to {@link MAX_DISTRUST_MS}. The first retry is soon
 * enough that a genuine change in the world (a die-off, a zoom out) is picked
 * up quickly; a tier that keeps failing is retried exponentially less often.
 */
const BASE_DISTRUST_MS = 4000;
const MAX_DISTRUST_MS = 60_000;

/** Consecutive failures past which the backoff stops growing. */
const MAX_BACKOFF_STEPS = 4;

/** Uninterrupted time in a tier that clears its bad reputation. */
const RECOVERY_MS = 10_000;

const TIER_ORDER: readonly LodTier[] = ['near', 'mid', 'far', 'abyss'];

export function tierIndex(tier: LodTier): number {
  const index = TIER_ORDER.indexOf(tier);
  return index < 0 ? TIER_ORDER.length - 1 : index;
}

export function tierAt(index: number): LodTier {
  return TIER_ORDER[Math.max(0, Math.min(TIER_ORDER.length - 1, index))] ?? 'abyss';
}

export interface LodInputs {
  readonly nowMs: number;
  readonly pxPerWu: number;
  readonly visibleCount: number;
  readonly speedMultiplier: number;
  /** Smoothed cost of the last few `app.render()` calls, ms. */
  readonly renderMsEma: number;
  readonly medianSizeCm: number;
}

/**
 * On-screen length of the median animal, CSS px. The one number that decides
 * whether detail is visible at all: everything else is a budget.
 */
export function medianLengthPx(inputs: LodInputs): number {
  return inputs.medianSizeCm * CM_TO_WU * inputs.pxPerWu;
}

/**
 * The tier the criteria alone would pick. `bias` above 1 makes detail harder
 * to earn (the promotion test), below 1 harder to lose (the demotion test);
 * the gap between the two is the hysteresis band.
 */
export function criteriaTier(inputs: LodInputs, bias = 1): LodTier {
  const lpx = medianLengthPx(inputs);
  const visible = inputs.visibleCount;
  const speed = inputs.speedMultiplier;
  if (lpx >= 40 * bias && visible <= 250 / bias && speed <= 16 / bias) return 'near';
  if (lpx >= 10 * bias && visible <= 1500 / bias && speed <= 64 / bias) return 'mid';
  if (lpx >= 3 * bias) return 'far';
  return 'abyss';
}

/**
 * Mutable tier machine. It is returned from `select` as a `LodState` (the extra
 * fields are structurally invisible to the seam) so the per-frame path
 * allocates nothing.
 */
export interface LodRuntime extends LodState {
  tier: LodTier;
  previousTier: LodTier | null;
  blend: number;
  /**
   * The criteria tier alone, before the governor's penalty. Kept separately
   * because the hysteresis band is measured from it: folding the penalty back
   * in would make a governor demote look like a criteria change and cancel
   * itself out.
   */
  criteria: LodTier;
  /** Candidate serving out its stability window, or null when none is pending. */
  pending: LodTier | null;
  pendingSinceMs: number;
  switchedAtMs: number;
  /** Tiers the frame-time governor is currently holding back. */
  penalty: number;
  penaltyUntilMs: number;
  /** Wall clock since which `renderMsEma` has been continuously under the promote threshold. */
  goodSinceMs: number;
  /** When the current tier was entered; a tier held this long clears its reputation. */
  tierSinceMs: number;
  /**
   * What each tier cost, in ms, on the frame the governor gave up on it. 0 means
   * "never disappointed us". This is the memory that stops the governor
   * promoting back into a tier on the strength of the cheap tier it fled to.
   */
  rememberedCost: Record<LodTier, number>;
  /** Wall clock after which a remembered cost is stale enough to re-probe. */
  distrustUntilMs: Record<LodTier, number>;
  /** Consecutive times each tier has been demoted out of, for the backoff. */
  failures: Record<LodTier, number>;
}

function zeroPerTier(): Record<LodTier, number> {
  return { near: 0, mid: 0, far: 0, abyss: 0 };
}

export function createLod(nowMs = 0, tier: LodTier = 'mid'): LodRuntime {
  return {
    tier,
    previousTier: null,
    blend: 1,
    criteria: tier,
    pending: null,
    pendingSinceMs: nowMs,
    switchedAtMs: nowMs,
    penalty: 0,
    penaltyUntilMs: nowMs,
    goodSinceMs: nowMs,
    tierSinceMs: nowMs,
    rememberedCost: zeroPerTier(),
    distrustUntilMs: zeroPerTier(),
    failures: zeroPerTier(),
  };
}

/**
 * Whether the governor should refuse to promote back into `tier`.
 *
 * The promote decision is necessarily taken from inside the *cheaper* tier, so
 * the frame cost it can measure is not the cost of the tier it is about to
 * enter. Trusting it alone produces a limit cycle: demote out of an expensive
 * tier, watch the cheap one run well, promote back, stutter, demote again,
 * forever, at whatever period the hold enforces.
 *
 * So a tier that has disappointed us has to clear two bars. The remembered
 * overshoot — how far past the demote threshold it ran — must still fit under
 * the promote threshold on top of what we are paying now, and enough time must
 * have passed to be worth the risk of a retry at all. The time bar exists
 * because the overshoot test alone would be permanent: the remembered cost never
 * improves while we are away from the tier, so nothing could ever satisfy it.
 */
function promotionDistrusted(lod: LodRuntime, tier: LodTier, nowMs: number): boolean {
  const remembered = lod.rememberedCost[tier];
  if (remembered <= 0) return false;
  // Old news: the world may be nothing like it was, so allow a fresh probe.
  if (nowMs >= lod.distrustUntilMs[tier]) return false;
  // The best available estimate of what a tier will cost is what it did cost.
  // Comparing the *current* frame time instead is the trap this whole mechanism
  // exists to avoid — that number is the cheap tier's, and it is always good.
  return remembered >= GOVERNOR_PROMOTE_MS;
}

/** Record that `tier` was too expensive, and back off before trying it again. */
function rememberDemotion(lod: LodRuntime, tier: LodTier, nowMs: number, renderMsEma: number): void {
  const failures = Math.min(MAX_BACKOFF_STEPS, lod.failures[tier] + 1);
  lod.failures[tier] = failures;
  lod.rememberedCost[tier] = renderMsEma;
  lod.distrustUntilMs[tier] = nowMs + Math.min(MAX_DISTRUST_MS, BASE_DISTRUST_MS * 2 ** (failures - 1));
}

/** Frame-cost side of the decision; returns true when the penalty moved this frame. */
function runGovernor(lod: LodRuntime, inputs: LodInputs): boolean {
  const now = inputs.nowMs;
  if (inputs.renderMsEma >= GOVERNOR_PROMOTE_MS) lod.goodSinceMs = now;

  if (inputs.renderMsEma > GOVERNOR_DEMOTE_MS) {
    if (now >= lod.penaltyUntilMs && lod.penalty < MAX_PENALTY) {
      lod.penalty += 1;
      lod.penaltyUntilMs = now + GOVERNOR_HOLD_MS;
      return true;
    }
    return false;
  }

  // The tier a promotion would land in — the one whose reputation is at stake.
  const wouldEnter = tierAt(tierIndex(lod.tier) - 1);
  if (
    lod.penalty > 0 &&
    inputs.renderMsEma < GOVERNOR_PROMOTE_MS &&
    now >= lod.penaltyUntilMs &&
    now - lod.goodSinceMs >= GOVERNOR_PROMOTE_SUSTAIN_MS &&
    !promotionDistrusted(lod, wouldEnter, now)
  ) {
    lod.penalty -= 1;
    lod.penaltyUntilMs = now + GOVERNOR_HOLD_MS;
    lod.goodSinceMs = now;
    return true;
  }
  return false;
}

export function select(lod: LodRuntime, inputs: LodInputs): LodState {
  const now = inputs.nowMs;
  const penaltyMoved = runGovernor(lod, inputs);

  // Only the direction being asked for is tested against its biased criteria,
  // so a tier sitting inside the band is left alone.
  const promoted = criteriaTier(inputs, 1 + HYSTERESIS);
  const demoted = criteriaTier(inputs, 1 - HYSTERESIS);
  let base = tierIndex(lod.criteria);
  if (tierIndex(promoted) < base) base = tierIndex(promoted);
  else if (tierIndex(demoted) > base) base = tierIndex(demoted);
  lod.criteria = tierAt(base);
  const target = tierAt(base + lod.penalty);

  if (target === lod.tier) {
    lod.pending = null;
  } else {
    if (lod.pending !== target) {
      lod.pending = target;
      lod.pendingSinceMs = now;
    }
    // A governor move is a stutter already happening; it does not wait out the
    // stability window the way a zoom change does.
    if (penaltyMoved || now - lod.pendingSinceMs >= STABILITY_MS) {
      // Only a cost-driven demotion blackens a tier's name. Dropping detail
      // because the animals became 3 px long says nothing about what that tier
      // costs, and holding it against the tier would keep detail off the screen
      // long after the watcher zoomed back in.
      if (penaltyMoved && tierIndex(target) > tierIndex(lod.tier)) {
        rememberDemotion(lod, lod.tier, now, inputs.renderMsEma);
      }
      lod.previousTier = lod.tier;
      lod.tier = target;
      lod.switchedAtMs = now;
      lod.tierSinceMs = now;
      lod.blend = 0;
      lod.pending = null;
    }
  }

  // A tier that has held for a long stretch without the governor intervening
  // has earned its reputation back; without this, one bad minute would keep a
  // tier distrusted for the rest of a run that had since become cheap.
  if (lod.rememberedCost[lod.tier] > 0 && now - lod.tierSinceMs >= RECOVERY_MS) {
    lod.rememberedCost[lod.tier] = 0;
    lod.failures[lod.tier] = 0;
    lod.distrustUntilMs[lod.tier] = 0;
  }

  if (lod.previousTier !== null) {
    const blend = BLEND_MS <= 0 ? 1 : (now - lod.switchedAtMs) / BLEND_MS;
    if (blend >= 1) {
      lod.blend = 1;
      lod.previousTier = null;
    } else {
      lod.blend = blend < 0 ? 0 : blend;
    }
  } else {
    lod.blend = 1;
  }

  return lod;
}
