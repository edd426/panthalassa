/**
 * Hot-path trait access (WP-A2).
 *
 * `readTrait(packed, slot, 'size')` looks `TRAIT_INDEX` up by string every call,
 * and `TRAIT_INDEX` is built by `Object.fromEntries`, which leaves it in
 * dictionary mode — the lookup is a hash probe that no inline cache can fold
 * away. At a few million organism-ticks a second that is not a rounding error,
 * so the offsets are resolved once at module load and the hot stages index the
 * packed array directly.
 *
 * These constants are *derived from* the frozen table, never a second copy of
 * it: reordering `TRAIT_KEYS` moves them automatically.
 */

import { TRAIT_COUNT, TRAIT_INDEX } from '../../contracts/traits';

export const T_SIZE = TRAIT_INDEX.size;
export const T_SPEED_CAP = TRAIT_INDEX.speedCap;
export const T_METABOLIC_EFF = TRAIT_INDEX.metabolicEff;
export const T_OPT = TRAIT_INDEX.tOpt;
export const T_WIDTH = TRAIT_INDEX.tWidth;
export const T_DIET = TRAIT_INDEX.diet;
export const T_ATTACK = TRAIT_INDEX.attack;
export const T_DEFENSE = TRAIT_INDEX.defense;
export const T_WARINESS = TRAIT_INDEX.wariness;
export const T_FORAGE_BOLDNESS = TRAIT_INDEX.forageBoldness;
export const T_GIVING_UP_TIME = TRAIT_INDEX.givingUpTime;
export const T_DISPLAY_HUE = TRAIT_INDEX.displayHue;
export const T_ARMOR_PLATING = TRAIT_INDEX.armorPlating;
/** G-wave: the target adult length is the `size` trait; realised length is the `sizeCurrent` pool column. */
export const T_GROWTH_ALLOCATION = TRAIT_INDEX.growthAllocation;

/** Read one trait by its pre-resolved offset. */
export function trait(packed: Float32Array, slot: number, offset: number): number {
  return packed[slot * TRAIT_COUNT + offset] ?? 0;
}
