/**
 * Detection (X2). The half of "how would I notice a surprise" that does not
 * need anyone to be looking at a chart.
 *
 * A `SampleRow` lands every `sampling.sampleIntervalTicks` ticks and says
 * everything about the world in about a hundred numbers. Nobody reads a hundred
 * numbers every 200 ticks over a 5,000-generation overnight, so these detectors
 * read them instead and emit one line when a reading *changes state* — the
 * predators vanishing, the wall starting to bite, variance running out.
 *
 * Three properties are load-bearing, and each one is a test:
 *
 * - **Pure.** Nothing here touches the DOM, a clock, or the sim. `detectAlerts`
 *   is a fold: `(state, row) → alerts`, with all mutation confined to the state
 *   object the caller owns. That is what makes the thresholds testable against
 *   synthetic rows rather than against a lucky seed.
 * - **Edge-triggered, with hysteresis.** Every detector arms and disarms on two
 *   different thresholds. A quantity parked on a single threshold is the normal
 *   case, not the rare one, and a detector that fires on the level rather than
 *   the crossing would emit the same line every row for an hour.
 * - **Windows are in generations, not rows.** Rows are 200 ticks and a
 *   generation is 900, so a "20-generation window" is 90 rows — and neither
 *   number is fixed by contract. Every lookback searches the recorded
 *   generation axis.
 *
 * Lines are written for the station feed: lowercase, the finding first, the
 * number after a `·`, in the same register as `describeEvent`.
 */

import type { SampleRow } from '../contracts/stats';
import type { TraitKey } from '../contracts/traits';
import { FOCAL_TRAIT_KEYS } from '../contracts/traits';

export type AlertSeverity = 'notice' | 'alert';

export interface Alert {
  readonly tick: number;
  readonly severity: AlertSeverity;
  readonly line: string;
}

/**
 * The `SampleRow` fields the detectors read, named as a Pick so a real row is
 * assignable and a test row costs six fields instead of a hundred.
 */
export type AlertRow = Pick<SampleRow, 'tick' | 'generation' | 'population' | 'traits' | 'guilds' | 'popgen'>;

export interface AlertOptions {
  /** `SimConfig.world.slotCapacity`; cap-riding is only meaningful against it. */
  readonly slotCapacity: number;
}

// ---------------------------------------------------------------------------
// Thresholds
//
// Each pair is (fire, re-arm). The gap between them is the hysteresis, and it
// is what stops a hovering value from filling the feed with one line per row.
// ---------------------------------------------------------------------------

/** A trait mean is "running" when it moves further than sampling noise could carry it. */
const EXCURSION_WINDOW_GEN = 20;
/** 2σ of the pooled within-generation spread: past this the population has actually moved, not jittered. */
const EXCURSION_FIRE_SIGMA = 2;
/** Re-arms once the same window is back inside 1σ, so a slow ramp reports once per leg, not once per row. */
const EXCURSION_REARM_SIGMA = 1;
/** Below this the population is effectively monomorphic and σ is not a yardstick any more. */
const EXCURSION_MIN_SIGMA = 1e-6;

/** One predator in twenty: below this the guild is not a guild, it is a rounding error. */
const GUILD_COLLAPSE_FRACTION = 0.05;
/** Recovery has to clear collapse by half again before "the hunters are back" means anything. */
const GUILD_COLLAPSE_CLEAR = 0.08;
/** Three in twenty: a predator share this high inverts the trophic pyramid and rarely holds. */
const GUILD_BOOM_FRACTION = 0.15;
const GUILD_BOOM_CLEAR = 0.12;

/** Half a barrier's worth of history: long enough that the median is a baseline, not the current value. */
const FST_WINDOW_GEN = 50;
/** Fst is a 0–1 statistic; +0.1 over the trailing median is a structure change, not drift. */
const FST_FIRE_DELTA = 0.1;
const FST_REARM_DELTA = 0.05;
/** A median needs a window to be a median; below this the baseline is still the value itself. */
const FST_MIN_SAMPLES = 8;

/** Five generations is inside one climate excursion, so a drop this fast is demographic, not seasonal. */
const CRASH_WINDOW_GEN = 5;
/** Losing two fifths of the ocean in five generations is the crash the watcher wants woken for. */
const CRASH_FIRE_DROP = 0.4;
/** Re-arms when the same window is no longer falling hard, so one crash is one line. */
const CRASH_REARM_DROP = 0.15;

/** Slots, not carrying capacity: past this the pool itself is the binding constraint on births. */
const CAP_RIDING_FRACTION = 0.85;
/** Sustained, because a single row at capacity is a good generation, not a regime. */
const CAP_RIDING_SUSTAIN_GEN = 20;
const CAP_RIDING_CLEAR = 0.75;

/** A hundred generations: long enough that drift, not a bad season, is what drained it. */
const DIVERSITY_WINDOW_GEN = 100;
/** Heterozygosity is the variance economy's balance; 0.15 of it is most of a founding population's. */
const DIVERSITY_FIRE_DROP = 0.15;
const DIVERSITY_REARM_DROP = 0.05;

/** History is trimmed to the longest window any detector looks back over, plus a row of slack. */
const MAX_HISTORY_GEN = DIVERSITY_WINDOW_GEN;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface TraitTrack {
  readonly key: TraitKey;
  readonly mean: number[];
  readonly sd: number[];
  armed: boolean;
}

/** `null` until the first row: an edge-triggered detector has no edge to report yet. */
type GuildPhase = 'collapsed' | 'normal' | 'boom' | null;

interface SurgeTrack {
  readonly values: number[];
  armed: boolean;
}

export interface AlertState {
  readonly options: AlertOptions;
  /** Ascending; every lookback is a search over this axis. */
  readonly generation: number[];
  readonly population: number[];
  readonly heterozygosity: number[];
  readonly traits: readonly TraitTrack[];
  readonly fstDemes: SurgeTrack;
  /** Only rows with a barrier up contribute; `generation` is not its x-axis, `fstBarrierGen` is. */
  readonly fstBarrierGen: number[];
  readonly fstBarrier: SurgeTrack;
  guild: GuildPhase;
  crashArmed: boolean;
  diversityArmed: boolean;
  capRidingArmed: boolean;
  /** Generation the population first crossed the cap-riding line in the current stretch, or null. */
  capRidingSince: number | null;
}

export function createAlertState(options: AlertOptions): AlertState {
  return {
    options,
    generation: [],
    population: [],
    heterozygosity: [],
    traits: FOCAL_TRAIT_KEYS.map((key) => ({ key, mean: [], sd: [], armed: true })),
    fstDemes: { values: [], armed: true },
    fstBarrierGen: [],
    fstBarrier: { values: [], armed: true },
    guild: null,
    crashArmed: true,
    diversityArmed: true,
    capRidingArmed: true,
    capRidingSince: null,
  };
}

/**
 * Forget the previous world. Detector arming is reset too: a fresh ocean at 40
 * organisms is not "the population is falling" just because the dead one ended
 * at 4,000.
 */
export function resetAlertState(state: AlertState): void {
  state.generation.length = 0;
  state.population.length = 0;
  state.heterozygosity.length = 0;
  for (const track of state.traits) {
    track.mean.length = 0;
    track.sd.length = 0;
    track.armed = true;
  }
  state.fstDemes.values.length = 0;
  state.fstDemes.armed = true;
  state.fstBarrierGen.length = 0;
  state.fstBarrier.values.length = 0;
  state.fstBarrier.armed = true;
  state.guild = null;
  state.crashArmed = true;
  state.diversityArmed = true;
  state.capRidingArmed = true;
  state.capRidingSince = null;
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

/**
 * Fold one row into the state and return whatever changed state because of it.
 *
 * Detector order is fixed so the same row sequence always produces the same
 * feed, which is the only reason a test can assert on more than a set.
 */
export function detectAlerts(state: AlertState, row: AlertRow): readonly Alert[] {
  const alerts: Alert[] = [];

  // Appended before detection: every detector compares the current row against
  // the history *including* itself, so the "trailing median" of a rising series
  // is conservative rather than a value the series has already left behind.
  state.generation.push(row.generation);
  state.population.push(row.population);
  state.heterozygosity.push(row.popgen.meanHeterozygosity);
  for (const track of state.traits) {
    const sample = row.traits[track.key];
    track.mean.push(sample.mean);
    track.sd.push(sample.sd);
  }
  state.fstDemes.values.push(row.popgen.fstDemes);
  if (row.popgen.fstBarrier !== null) {
    state.fstBarrierGen.push(row.generation);
    state.fstBarrier.values.push(row.popgen.fstBarrier);
  }

  detectTraitExcursion(state, row, alerts);
  detectGuildShift(state, row, alerts);
  detectFstSurge(state, row, alerts);
  detectPopulationRegime(state, row, alerts);
  detectDiversityDrain(state, row, alerts);

  trimHistory(state, row.generation);
  return alerts;
}

function detectTraitExcursion(state: AlertState, row: AlertRow, out: Alert[]): void {
  const past = indexAtOrBefore(state.generation, row.generation - EXCURSION_WINDOW_GEN);
  if (past < 0) return;
  const spanGen = row.generation - (state.generation[past] ?? row.generation);

  for (const track of state.traits) {
    const now = track.mean[track.mean.length - 1] ?? 0;
    const then = track.mean[past] ?? 0;
    const sdNow = track.sd[track.sd.length - 1] ?? 0;
    const sdThen = track.sd[past] ?? 0;
    // Pooled SD of the two endpoints: a trait whose spread doubled mid-window
    // has not moved as far, in units the population can tell apart, as the raw
    // difference suggests.
    const pooled = Math.sqrt((sdNow * sdNow + sdThen * sdThen) / 2);
    if (pooled < EXCURSION_MIN_SIGMA) continue;
    const sigmas = (now - then) / pooled;
    const magnitude = Math.abs(sigmas);

    if (track.armed && magnitude >= EXCURSION_FIRE_SIGMA) {
      track.armed = false;
      out.push({
        tick: row.tick,
        severity: 'notice',
        line: `${track.key} is running · ${signed(sigmas, 1)}σ in ${Math.round(spanGen)} gen`,
      });
    } else if (!track.armed && magnitude <= EXCURSION_REARM_SIGMA) {
      track.armed = true;
    }
  }
}

/**
 * The guild bands, as a phase with two exits.
 *
 * The first row only *classifies*: recorded runs sit at a predator share of
 * 0.43–0.73, well above the boom line, so a detector that reported the level it
 * found would open every world with "predators everywhere" and then never speak
 * again. What is worth a line is the crossing.
 */
function detectGuildShift(state: AlertState, row: AlertRow, out: Alert[]): void {
  const share = row.guilds.predatorFraction;
  const was = state.guild;
  const now = classifyGuild(share, was);
  state.guild = now;
  if (was === null || now === was) return;

  if (now === 'collapsed') {
    out.push({ tick: row.tick, severity: 'alert', line: `the hunters are gone · predator share ${percent(share)}` });
  } else if (was === 'collapsed') {
    out.push({ tick: row.tick, severity: 'notice', line: `the hunters are back · predator share ${percent(share)}` });
  } else if (now === 'boom') {
    out.push({ tick: row.tick, severity: 'notice', line: `predators everywhere · predator share ${percent(share)}` });
  }
  // boom → normal is the hysteresis exit, not an event: the line that mattered
  // was the one on the way in.
}

function classifyGuild(share: number, phase: GuildPhase): Exclude<GuildPhase, null> {
  if (phase === null) {
    if (share < GUILD_COLLAPSE_FRACTION) return 'collapsed';
    return share > GUILD_BOOM_FRACTION ? 'boom' : 'normal';
  }
  if (phase !== 'collapsed' && share < GUILD_COLLAPSE_FRACTION) return 'collapsed';
  if (phase === 'collapsed') return share >= GUILD_COLLAPSE_CLEAR ? 'normal' : 'collapsed';
  if (phase === 'normal' && share > GUILD_BOOM_FRACTION) return 'boom';
  if (phase === 'boom' && share <= GUILD_BOOM_CLEAR) return 'normal';
  return phase;
}

function detectFstSurge(state: AlertState, row: AlertRow, out: Alert[]): void {
  surge(
    state.fstDemes,
    state.generation,
    row.generation,
    (value) => out.push({ tick: row.tick, severity: 'notice', line: `the demes are pulling apart · Fst ${value.toFixed(2)}` }),
  );
  surge(
    state.fstBarrier,
    state.fstBarrierGen,
    row.generation,
    (value) =>
      out.push({
        tick: row.tick,
        severity: 'notice',
        line: `populations diverging across the wall · Fst ${value.toFixed(2)}`,
      }),
  );
}

/**
 * Shared by both Fst readings: fire when the newest value sits far enough above
 * the trailing median of its own window. A median rather than a mean because
 * the surge being detected would drag a mean up behind it.
 */
function surge(track: SurgeTrack, generations: readonly number[], generation: number, emit: (value: number) => void): void {
  const count = track.values.length;
  if (count === 0) return;
  const value = track.values[count - 1] ?? 0;
  const from = indexAtOrBefore(generations, generation - FST_WINDOW_GEN);
  const start = from < 0 ? 0 : from;
  if (count - start < FST_MIN_SAMPLES) return;
  const baseline = median(track.values, start, count);
  const delta = value - baseline;

  if (track.armed && delta > FST_FIRE_DELTA) {
    track.armed = false;
    emit(value);
  } else if (!track.armed && delta <= FST_REARM_DELTA) {
    track.armed = true;
  }
}

function detectPopulationRegime(state: AlertState, row: AlertRow, out: Alert[]): void {
  const past = indexAtOrBefore(state.generation, row.generation - CRASH_WINDOW_GEN);
  if (past >= 0) {
    const then = state.population[past] ?? 0;
    const spanGen = row.generation - (state.generation[past] ?? row.generation);
    // A world that was empty five generations ago cannot have crashed; the
    // fraction would divide by zero and the founding of a world would read as
    // its collapse.
    const drop = then > 0 ? (then - row.population) / then : 0;
    if (state.crashArmed && drop > CRASH_FIRE_DROP) {
      state.crashArmed = false;
      out.push({
        tick: row.tick,
        severity: 'alert',
        line: `the population is falling · -${percent(drop)} in ${Math.round(spanGen)} gen`,
      });
    } else if (!state.crashArmed && drop < CRASH_REARM_DROP) {
      state.crashArmed = true;
    }
  }

  const capacity = state.options.slotCapacity;
  if (capacity <= 0) return;
  const share = row.population / capacity;
  if (share >= CAP_RIDING_FRACTION) {
    state.capRidingSince ??= row.generation;
    const heldGen = row.generation - state.capRidingSince;
    if (state.capRidingArmed && heldGen >= CAP_RIDING_SUSTAIN_GEN) {
      state.capRidingArmed = false;
      out.push({
        tick: row.tick,
        severity: 'notice',
        line: `the ocean is full · ${row.population} of ${capacity} slots for ${Math.round(heldGen)} gen`,
      });
    }
  } else {
    state.capRidingSince = null;
    if (share < CAP_RIDING_CLEAR) state.capRidingArmed = true;
  }
}

function detectDiversityDrain(state: AlertState, row: AlertRow, out: Alert[]): void {
  const past = indexAtOrBefore(state.generation, row.generation - DIVERSITY_WINDOW_GEN);
  if (past < 0) return;
  const then = state.heterozygosity[past] ?? 0;
  const now = row.popgen.meanHeterozygosity;
  const drop = then - now;
  const spanGen = row.generation - (state.generation[past] ?? row.generation);

  if (state.diversityArmed && drop > DIVERSITY_FIRE_DROP) {
    state.diversityArmed = false;
    out.push({
      tick: row.tick,
      severity: 'alert',
      line: `variance is draining · heterozygosity ${then.toFixed(2)} → ${now.toFixed(2)} over ${Math.round(spanGen)} gen`,
    });
  } else if (!state.diversityArmed && drop < DIVERSITY_REARM_DROP) {
    state.diversityArmed = true;
  }
}

/**
 * Drop history the longest window can no longer reach.
 *
 * One row at a time from the front, which is what keeps an overnight run's
 * detector state a few hundred numbers instead of a few hundred thousand.
 */
function trimHistory(state: AlertState, generation: number): void {
  const horizon = generation - MAX_HISTORY_GEN;
  while (state.generation.length > 1 && (state.generation[1] ?? 0) <= horizon) {
    state.generation.shift();
    state.population.shift();
    state.heterozygosity.shift();
    state.fstDemes.values.shift();
    for (const track of state.traits) {
      track.mean.shift();
      track.sd.shift();
    }
  }
  while (state.fstBarrierGen.length > 1 && (state.fstBarrierGen[1] ?? 0) <= horizon) {
    state.fstBarrierGen.shift();
    state.fstBarrier.values.shift();
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for their tests)
// ---------------------------------------------------------------------------

/**
 * Index of the last entry at or before `target` in an ascending axis, or −1.
 * Binary search because the axis is every row of an overnight run and this is
 * called once per detector per row.
 */
export function indexAtOrBefore(ascending: readonly number[], target: number): number {
  let low = 0;
  let high = ascending.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((ascending[middle] ?? 0) <= target) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

/** Median of `values[start..end)`. Copies the slice; the window is bounded by the trim. */
export function median(values: readonly number[], start = 0, end = values.length): number {
  const slice = values.slice(start, end).sort((a, b) => a - b);
  if (slice.length === 0) return 0;
  const middle = slice.length >> 1;
  if (slice.length % 2 === 1) return slice[middle] ?? 0;
  return ((slice[middle - 1] ?? 0) + (slice[middle] ?? 0)) / 2;
}

function signed(value: number, digits: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function percent(fraction: number): string {
  const scaled = fraction * 100;
  return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)}%`;
}
