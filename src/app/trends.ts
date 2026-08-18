/**
 * Deep history (X2). The instrument for a 5,000-generation overnight.
 *
 * `charts.ts` draws seven sparklines across the whole run at once, which is the
 * right answer for "is anything happening" and the wrong one for "what happened
 * at generation 3,140": with 20,000 rows squeezed into 300 px, a spike is a
 * pixel and there is no way to go and look. This panel is the other half —
 * uPlot, pan and zoom, readable axes, live values at the cursor, and the raw
 * arrays kept so zooming in shows detail rather than an enlarged summary.
 *
 * ## What the design decisions were
 *
 * - **One axis per panel, always.** Small multiples rather than two y-scales:
 *   `size` in cm and `diet` in logits share nothing but a time axis, and a
 *   chart that puts them on one plot invents a correlation. The only panels
 *   carrying two series are the ones whose series are in the *same unit* —
 *   thermal optimum against water temperature (°C), attack against defense
 *   (predation-kernel logits), the two Fst readings (both 0–1).
 * - **Stacked areas for the three part-to-whole readings** — population by
 *   species, by deme column, and deaths by cause. A stack answers "who is the
 *   population made of" in one mark, and its adjacent-pair colours are the ones
 *   the palette validator gates.
 * - **Min/max bucketing, never striding.** A 5,000-generation series has to be
 *   thinned to be drawn, and the spikes are the whole signal: every bucket
 *   contributes its extremes, so a one-row crash survives the thinning. Striding
 *   would drop it, silently, exactly in the runs long enough to matter.
 * - **The wall experiment has its own section.** Fst climbing after a barrier
 *   goes up *is* the experiment working, and it should not take a probe run to
 *   see it.
 *
 * Colour: `palette.ts`'s two frozen slots plus four derived here, all six run
 * through the `dataviz` validator against this panel's own surface (`#03151d`,
 * dark mode) — lightness band, chroma floor, adjacent-pair CVD separation,
 * normal-vision floor and contrast all PASS. Slots 1–4 are the worst case
 * (a four-band stack) and they are adjacent in the validated order.
 */

import type { DiscreteLocus } from '../contracts/genome';
import { CLADE_ARCHETYPES, DISCRETE_LOCI, FOUNDER_FIXED_DISCRETE_KINDS } from '../contracts/genome';
import type { SampleRow } from '../contracts/stats';
import type { SimConfig } from '../contracts/types';
import { DEATH_CAUSES } from '../contracts/types';
import type { TraitKey } from '../contracts/traits';
import { FOCAL_TRAIT_KEYS, TRAIT_META } from '../contracts/traits';
import type uPlot from 'uplot';
import type { Alert } from './alerts';
import { createAlertState, detectAlerts, resetAlertState } from './alerts';
import { BASELINE, GRIDLINE, INK_MUTED, INK_SECONDARY, SERIES_1, SERIES_2 } from './palette';

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/**
 * Categorical slots 3–6. Derived for this panel because two slots do not cover
 * a five-cause death stack, and validated as one ordered set with the frozen
 * two: worst adjacent pair ΔE 10.8 (deutan), normal-vision floor 20.5, every
 * slot inside the dark lightness band and over 3:1 on the panel surface.
 *
 * The order is the safety mechanism and is not a preference — assign from the
 * front, never cycle past the end, and never reorder.
 */
export const SERIES_3 = '#1f9a76';
export const SERIES_4 = '#7a6fd8';
export const SERIES_5 = '#c08a20';
export const SERIES_6 = '#d4548c';

const SLOTS: readonly string[] = [SERIES_1, SERIES_2, SERIES_3, SERIES_4, SERIES_5, SERIES_6];

/**
 * The panel surface, matching `--strip` in index.html. Stacked fills are
 * separated by a 2 px stroke in this colour rather than by a border: a gap of
 * surface reads as a separation, an outline reads as another mark.
 */
const PANEL_SURFACE = '#03151d';

function slot(index: number): string {
  return SLOTS[index] ?? INK_MUTED;
}

function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** The `SampleRow` fields this panel reads. A real row is assignable. */
export type TrendRow = Pick<
  SampleRow,
  | 'tick'
  | 'generation'
  | 'population'
  | 'populationBySpecies'
  | 'populationByDeme'
  | 'populationByArchetype'
  | 'traits'
  | 'discreteAlleleFreq'
  | 'guilds'
  | 'popgen'
  | 'resources'
  | 'deaths'
  // Optional in the contract and absent until the recorder fills it, which is
  // why every life-history column is nullable and its section only appears once
  // a row has actually carried one. `mimicryIndex` is gated the same way, and
  // additionally reads `null` on any row where no hue bin is meaningfully toxic.
  | 'lifeHistory'
  | 'mimicryIndex'
>;

/**
 * The loci where a new allele is an *event* rather than a founding condition.
 *
 * These are exactly the kinds seeded homozygous-ancestral at founding, so
 * every one of them starts at a derived share of precisely 0 and the moment a
 * line leaves the floor is the moment a body plan, a life-history strategy or
 * chemical defence was invented. Anything else in `discreteAlleleFreq` — the
 * pigments, the preference modifiers, the neutral markers — is drawn uniformly
 * at founding and drifts, which is a chart about drift and not about invention.
 */
const MACRO_LOCI: readonly DiscreteLocus[] = DISCRETE_LOCI.filter((locus) =>
  FOUNDER_FIXED_DISCRETE_KINDS.includes(locus.kind),
);

/** Legend-length names for {@link MACRO_LOCI}; the schema labels are sentence-length. */
const MACRO_LABEL: Readonly<Record<string, string>> = Object.freeze({
  cladeMacroA: 'body plan A',
  cladeMacroB: 'body plan B',
  lifeHistoryMacro: 'life history',
  toxinMacro: 'toxin',
  ornamentMacro: 'ornament',
});

/**
 * Past this many species the stack stops splitting and the tail folds into one
 * band. Six categorical slots exist; a seventh would have to be a generated
 * hue, which is indistinguishable from an existing slot under CVD.
 */
export const MAX_SPECIES_BANDS = 5;

/** Points per panel after thinning. Roughly two per horizontal pixel at panel width. */
const MAX_POINTS = 1400;

export interface SpeciesBand {
  readonly tag: number;
  readonly counts: number[];
}

export interface TraitColumns {
  readonly key: TraitKey;
  readonly mean: number[];
  readonly upper: number[];
  readonly lower: number[];
}

export interface TrendStore {
  readonly generation: number[];
  readonly population: number[];
  /** Constant `slotCapacity`, carried as a column so the guide line is just another series. */
  readonly capacity: number[];
  readonly species: SpeciesBand[];
  /** Everything past `MAX_SPECIES_BANDS`, summed. */
  readonly speciesOther: number[];
  readonly traits: readonly TraitColumns[];
  readonly waterTempC: number[];
  readonly attack: number[];
  readonly defense: number[];
  readonly predatorFraction: number[];
  readonly fstDemes: number[];
  /** `null` on rows with no barrier up; uPlot draws those as gaps, which is the truth. */
  readonly fstBarrier: (number | null)[];
  /** Deme grid summed into columns, west → east: the axis a vertical ridge splits. */
  readonly demeColumns: number[][];
  /** Census by body plan, indexed against `CLADE_ARCHETYPES`. */
  readonly archetypes: number[][];
  /** Per {@link MACRO_LOCI}: the share of gene copies away from the ancestral allele. */
  readonly macroDerived: number[][];
  /** Batesian free-rider share in the most-toxic hue bin; `null` when no bin is toxic. */
  readonly mimicry: (number | null)[];
  /** Whether any row has carried a real `mimicryIndex`; the panel is absent until one does. */
  mimicrySeen: boolean;
  /** Deaths per generation, not per row: rows are a sampling interval, generations are the unit. */
  readonly deaths: readonly number[][];
  readonly plankton: number[];
  readonly kelp: number[];
  readonly heterozygosity: number[];
  readonly neTemporal: (number | null)[];
  /**
   * Realised length, the juvenile share and recruitment.
   *
   * `null` on any row whose `lifeHistory` was absent, rather than skipped:
   * every column in this store is indexed by row against `generation`, so a
   * column that only starts appending part-way through would silently plot the
   * whole run shifted. uPlot draws the nulls as gaps, which is the truth.
   */
  readonly lengthMean: (number | null)[];
  readonly lengthUpper: (number | null)[];
  readonly lengthLower: (number | null)[];
  readonly juvenileFraction: (number | null)[];
  readonly recruitment: (number | null)[];
  /** Whether any row has carried a `lifeHistory` yet; the section is absent until one does. */
  lifeHistorySeen: boolean;
  readonly slotCapacity: number;
  readonly demeCols: number;
  /** Generation of the previous row, for the per-generation death rate. */
  lastGeneration: number;
}

/** Trait series the panel keeps columns for: the focal four, then the two G-wave axes. */
const TREND_TRAIT_KEYS: readonly TraitKey[] = [...FOCAL_TRAIT_KEYS, 'toxicity', 'conspicuousness'];

export function createTrendStore(config: SimConfig): TrendStore {
  const demeCols = Math.max(1, config.world.demeCols);
  return {
    generation: [],
    population: [],
    capacity: [],
    species: [],
    speciesOther: [],
    // The focal four plus the two G-wave axes. `SampleRow.traits` carries every
    // trait ("not only the focal four"), so this costs nothing but the columns
    // — and toxicity and conspicuousness are the two the world view cannot
    // show, which makes a chart the only place they can be read at all.
    traits: TREND_TRAIT_KEYS.map((key) => ({ key, mean: [], upper: [], lower: [] })),
    waterTempC: [],
    attack: [],
    defense: [],
    predatorFraction: [],
    fstDemes: [],
    fstBarrier: [],
    demeColumns: Array.from({ length: demeCols }, () => [] as number[]),
    archetypes: CLADE_ARCHETYPES.map(() => [] as number[]),
    macroDerived: MACRO_LOCI.map(() => [] as number[]),
    mimicry: [],
    mimicrySeen: false,
    deaths: DEATH_CAUSES.map(() => [] as number[]),
    plankton: [],
    kelp: [],
    heterozygosity: [],
    neTemporal: [],
    lengthMean: [],
    lengthUpper: [],
    lengthLower: [],
    juvenileFraction: [],
    recruitment: [],
    lifeHistorySeen: false,
    slotCapacity: config.world.slotCapacity,
    demeCols,
    lastGeneration: 0,
  };
}

export function resetTrendStore(store: TrendStore): void {
  store.generation.length = 0;
  store.population.length = 0;
  store.capacity.length = 0;
  // Bands belong to the dead world's species tags; a new world's tag 0 is not
  // the old world's tag 0.
  store.species.length = 0;
  store.speciesOther.length = 0;
  for (const trait of store.traits) {
    trait.mean.length = 0;
    trait.upper.length = 0;
    trait.lower.length = 0;
  }
  store.waterTempC.length = 0;
  store.attack.length = 0;
  store.defense.length = 0;
  store.predatorFraction.length = 0;
  store.fstDemes.length = 0;
  store.fstBarrier.length = 0;
  for (const column of store.demeColumns) column.length = 0;
  for (const column of store.archetypes) column.length = 0;
  for (const column of store.macroDerived) column.length = 0;
  store.mimicry.length = 0;
  store.mimicrySeen = false;
  for (const column of store.deaths) column.length = 0;
  store.plankton.length = 0;
  store.kelp.length = 0;
  store.heterozygosity.length = 0;
  store.neTemporal.length = 0;
  store.lengthMean.length = 0;
  store.lengthUpper.length = 0;
  store.lengthLower.length = 0;
  store.juvenileFraction.length = 0;
  store.recruitment.length = 0;
  store.lifeHistorySeen = false;
  store.lastGeneration = 0;
}

export function ingestTrendRow(store: TrendStore, row: TrendRow): void {
  const index = store.generation.length;
  store.generation.push(row.generation);
  store.population.push(row.population);
  store.capacity.push(store.slotCapacity);

  appendSpecies(store, row, index);

  for (const trait of store.traits) {
    const sample = row.traits[trait.key];
    trait.mean.push(sample.mean);
    trait.upper.push(sample.mean + sample.sd);
    trait.lower.push(sample.mean - sample.sd);
  }

  for (let index = 0; index < CLADE_ARCHETYPES.length; index += 1) {
    store.archetypes[index]?.push(row.populationByArchetype[index] ?? 0);
  }

  // 1 − freq(ancestral) rather than one line per allele: which derived allele
  // won is a detail, that any of them did is the event. A locus the recorder
  // did not report reads 0, which is also what "still entirely ancestral" is —
  // and for these four loci that is the honest default, because a run cannot
  // reach a derived allele without a `sweepCrossedHalf` or founding event in
  // the feed to go with it.
  for (let index = 0; index < MACRO_LOCI.length; index += 1) {
    const locus = MACRO_LOCI[index];
    const ancestral = locus === undefined ? 1 : (row.discreteAlleleFreq[locus.id]?.[0] ?? 1);
    store.macroDerived[index]?.push(1 - ancestral);
  }

  const mimicry = row.mimicryIndex ?? null;
  if (mimicry !== null) store.mimicrySeen = true;
  store.mimicry.push(mimicry);

  store.waterTempC.push(row.resources.meanTemperatureC);
  store.attack.push(row.guilds.meanAttack);
  store.defense.push(row.guilds.meanDefense);
  store.predatorFraction.push(row.guilds.predatorFraction);
  store.fstDemes.push(row.popgen.fstDemes);
  store.fstBarrier.push(row.popgen.fstBarrier);
  store.heterozygosity.push(row.popgen.meanHeterozygosity);
  store.neTemporal.push(row.popgen.neTemporal);
  store.plankton.push(row.resources.planktonTotal);
  store.kelp.push(row.resources.kelpTotal);

  const life = row.lifeHistory;
  if (life === undefined) {
    store.lengthMean.push(null);
    store.lengthUpper.push(null);
    store.lengthLower.push(null);
    store.juvenileFraction.push(null);
    store.recruitment.push(null);
  } else {
    store.lifeHistorySeen = true;
    store.lengthMean.push(life.meanLengthCm);
    store.lengthUpper.push(life.meanLengthCm + life.sdLengthCm);
    store.lengthLower.push(life.meanLengthCm - life.sdLengthCm);
    store.juvenileFraction.push(life.juvenileFraction);
    store.recruitment.push(life.recruitment);
  }

  for (let column = 0; column < store.demeCols; column += 1) {
    let total = 0;
    for (let cell = column; cell < row.populationByDeme.length; cell += store.demeCols) {
      total += row.populationByDeme[cell] ?? 0;
    }
    store.demeColumns[column]?.push(total);
  }

  // Rows carry deaths since the previous row; the panel shows a rate, so a
  // change of sampling interval cannot look like a change in mortality.
  const elapsed = Math.max(1e-9, row.generation - store.lastGeneration);
  DEATH_CAUSES.forEach((cause, index) => {
    store.deaths[index]?.push(row.deaths[cause] / elapsed);
  });
  store.lastGeneration = row.generation;
}

/**
 * Species bands, assigned in tag order and never reassigned.
 *
 * A band belongs to its species for the life of the run: an extinct species
 * keeps its colour and falls to zero rather than handing the hue to whichever
 * lineage appeared next, which would repaint history.
 */
function appendSpecies(store: TrendStore, row: TrendRow, index: number): void {
  let other = 0;
  for (const group of row.populationBySpecies) {
    const existing = store.species.find((band) => band.tag === group.tag);
    if (existing !== undefined) continue;
    if (store.species.length < MAX_SPECIES_BANDS) {
      // Back-filled with zeros, not nulls: before it split, this species had a
      // population of exactly none, and a stack needs a number at every row.
      store.species.push({ tag: group.tag, counts: new Array<number>(index).fill(0) });
    }
  }
  for (const band of store.species) {
    const group = row.populationBySpecies.find((entry) => entry.tag === band.tag);
    band.counts.push(group?.count ?? 0);
  }
  for (const group of row.populationBySpecies) {
    if (!store.species.some((band) => band.tag === group.tag)) other += group.count;
  }
  store.speciesOther.push(other);
}

// ---------------------------------------------------------------------------
// Thinning (pure; the part the tests care most about)
// ---------------------------------------------------------------------------

/**
 * Half-open index range covering `[min, max]`, widened by one row on each side
 * so a zoomed line reaches both edges of the plot instead of stopping short.
 */
export function sliceRange(generation: readonly number[], min: number, max: number): [number, number] {
  let start = 0;
  while (start < generation.length && (generation[start] ?? 0) < min) start += 1;
  let end = generation.length;
  while (end > start && (generation[end - 1] ?? 0) > max) end -= 1;
  return [Math.max(0, start - 1), Math.min(generation.length, end + 1)];
}

/**
 * Indices to draw for `[start, end)`, preserving extremes.
 *
 * Every bucket contributes the argmin and argmax of every column in it, so a
 * single-row spike survives thinning at any zoom level; striding — take every
 * n-th row — would drop it, and the spikes are what the watcher is looking for.
 * The endpoints are always kept so the line spans the panel.
 */
export function pickIndices(
  columns: readonly (readonly (number | null)[])[],
  start: number,
  end: number,
  maxPoints: number,
): number[] {
  const count = end - start;
  if (count <= 0) return [];
  if (count <= maxPoints) {
    const all = new Array<number>(count);
    for (let index = 0; index < count; index += 1) all[index] = start + index;
    return all;
  }

  const perBucket = Math.max(1, columns.length * 2);
  // The two endpoints are reserved out of the budget rather than added on top
  // of it: they are forced in below, and without the reservation a panel whose
  // single column has a distinct argmin and argmax in every bucket comes back
  // with `maxPoints + 2` points and quietly overruns the cap it was given.
  const buckets = Math.max(1, Math.floor((maxPoints - 2) / perBucket));
  const width = count / buckets;
  const keep = new Set<number>([start, end - 1]);

  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const from = start + Math.floor(bucket * width);
    const to = bucket === buckets - 1 ? end : start + Math.floor((bucket + 1) * width);
    for (const column of columns) {
      let lowAt = -1;
      let highAt = -1;
      let low = Infinity;
      let high = -Infinity;
      for (let index = from; index < to; index += 1) {
        const value = column[index];
        if (value === null || value === undefined || !Number.isFinite(value)) continue;
        if (value < low) {
          low = value;
          lowAt = index;
        }
        if (value > high) {
          high = value;
          highAt = index;
        }
      }
      if (lowAt >= 0) keep.add(lowAt);
      if (highAt >= 0) keep.add(highAt);
    }
  }

  return [...keep].sort((a, b) => a - b);
}

/** Read a column at the chosen indices. */
export function gather(column: readonly (number | null)[], indices: readonly number[]): (number | null)[] {
  const out = new Array<number | null>(indices.length);
  for (let index = 0; index < indices.length; index += 1) out[index] = column[indices[index] ?? 0] ?? null;
  return out;
}

/**
 * Bottom-to-top columns into cumulative sums, then reversed so the topmost band
 * is drawn first and each lower fill paints over it. That is what makes a plain
 * fill-to-zero series read as a stack without uPlot bands.
 */
export function stackColumns(columns: readonly (readonly (number | null)[])[]): (number | null)[][] {
  const length = columns[0]?.length ?? 0;
  const cumulative: (number | null)[][] = [];
  const running = new Array<number>(length).fill(0);
  for (const column of columns) {
    const layer = new Array<number | null>(length);
    for (let index = 0; index < length; index += 1) {
      running[index] = (running[index] ?? 0) + (column[index] ?? 0);
      layer[index] = running[index] ?? 0;
    }
    cumulative.push(layer);
  }
  return cumulative.reverse();
}

// ---------------------------------------------------------------------------
// Panel specifications
// ---------------------------------------------------------------------------

type Column = readonly (number | null)[];

export interface SeriesSpec {
  readonly label: string;
  readonly colour: string;
  readonly column: Column;
  /** `guide` is a threshold or reference, drawn as a hairline dash so it cannot be read as data. */
  readonly kind?: 'guide';
}

export interface PanelSpec {
  readonly title: string;
  /** The unit, or what the reader is meant to compare. Never a restatement of the title. */
  readonly note: string;
  readonly series: readonly SeriesSpec[];
  readonly stacked?: boolean;
  /** ±1σ around the first series, from these two columns. */
  readonly band?: readonly [Column, Column];
  readonly zeroBased?: boolean;
}

export interface SectionSpec {
  readonly title: string;
  readonly panels: readonly PanelSpec[];
}

function traitColumns(store: TrendStore, key: TraitKey): TraitColumns | undefined {
  return store.traits.find((trait) => trait.key === key);
}

function traitPanel(store: TrendStore, key: TraitKey, extra?: SeriesSpec): PanelSpec | null {
  const columns = traitColumns(store, key);
  if (columns === undefined) return null;
  const meta = TRAIT_META[key];
  return {
    title: key,
    note: `mean ±1σ · ${meta.unit}${meta.link === 'identity' ? '' : ' (latent)'}`,
    series: [{ label: key, colour: SERIES_1, column: columns.mean }, ...(extra === undefined ? [] : [extra])],
    band: [columns.upper, columns.lower],
  };
}

/**
 * The panel set, rebuilt from the store whenever its *shape* changes (a species
 * splits, a barrier goes up). Values are read live; only the shape triggers a
 * rebuild of the plots.
 */
export function sections(store: TrendStore): readonly SectionSpec[] {
  const speciesBands: SeriesSpec[] = store.species.map((band, index) => ({
    label: `species ${band.tag}`,
    colour: slot(index),
    column: band.counts,
  }));
  if (store.speciesOther.some((value) => value > 0)) {
    speciesBands.push({ label: 'other species', colour: INK_MUTED, column: store.speciesOther });
  }

  const populationPanel: PanelSpec =
    speciesBands.length > 1
      ? {
          title: 'population by species',
          note: 'stacked · organisms',
          series: [...speciesBands, { label: 'slot capacity', colour: INK_MUTED, column: store.capacity, kind: 'guide' }],
          stacked: true,
          zeroBased: true,
        }
      : {
          title: 'population',
          note: 'organisms · dashed line is the slot capacity',
          series: [
            { label: 'population', colour: SERIES_1, column: store.population },
            { label: 'slot capacity', colour: INK_MUTED, column: store.capacity, kind: 'guide' },
          ],
          zeroBased: true,
        };

  const traitPanels = [
    traitPanel(store, 'tOpt', { label: 'water', colour: SERIES_2, column: store.waterTempC }),
    traitPanel(store, 'size'),
    traitPanel(store, 'diet'),
    traitPanel(store, 'defense'),
  ].filter((panel): panel is PanelSpec => panel !== null);

  const demeBands: SeriesSpec[] = store.demeColumns.map((column, index) => ({
    label: `col ${index + 1}`,
    colour: slot(index),
    column,
  }));

  const archetypeBands: SeriesSpec[] = CLADE_ARCHETYPES.map((archetype, index) => ({
    label: archetype,
    colour: slot(index),
    column: store.archetypes[index] ?? [],
  }));

  const macroSeries: SeriesSpec[] = MACRO_LOCI.map((locus, index) => ({
    label: MACRO_LABEL[locus.id] ?? locus.id,
    colour: slot(index),
    column: store.macroDerived[index] ?? [],
  }));


  const deathBands: SeriesSpec[] = DEATH_CAUSES.map((cause, index) => ({
    label: cause,
    colour: slot(index),
    column: store.deaths[index] ?? [],
  }));

  // Realised length, not target `size`: with ontogeny on they are different
  // quantities and the difference is the whole mechanism. The panels appear
  // only once a row has carried a `lifeHistory` — an empty chart promising a
  // reading the recorder is not taking yet is worse than no chart.
  const lifePanels: PanelSpec[] = store.lifeHistorySeen
    ? [
        {
          title: 'realised length',
          note: 'mean ±1σ · cm actually swum, against the target size above',
          series: [{ label: 'length', colour: SERIES_1, column: store.lengthMean }],
          band: [store.lengthUpper, store.lengthLower],
          zeroBased: true,
        },
        {
          title: 'juvenile fraction',
          note: 'share below maturity · a population with no juveniles has stopped recruiting',
          series: [{ label: 'juveniles', colour: SERIES_1, column: store.juvenileFraction }],
          zeroBased: true,
        },
        {
          title: 'recruitment',
          note: 'births in the window that survived to maturity',
          series: [{ label: 'recruits', colour: SERIES_1, column: store.recruitment }],
          zeroBased: true,
        },
      ]
    : [];

  // The world view shows these two only under a mode the watcher has to go
  // looking for — `c → toxicity`, and conspicuousness only as saturation in
  // identity mode — so these charts are where the aposematism story is legible
  // without hunting for it.
  //
  // The free-rider share is gated on having been measured, like life history:
  // off-arm it is `null` on every row, and an empty panel promising a reading
  // nobody is taking reads as "no mimics" rather than as "not instrumented".
  const signalPanels = [
    traitPanel(store, 'toxicity'),
    traitPanel(store, 'conspicuousness'),
    ...(store.mimicrySeen
      ? [
          {
            title: 'Batesian free-riders',
            note: 'share of the most-toxic hue bin below the median toxin load · a mimic wears the warning without paying for it',
            series: [{ label: 'free-riders', colour: SERIES_1, column: store.mimicry }],
            zeroBased: true,
          } satisfies PanelSpec,
        ]
      : []),
  ].filter((panel): panel is PanelSpec => panel !== null);

  return [
    { title: 'census', panels: [populationPanel] },
    {
      title: 'inventions — the macro-loci',
      panels: [
        {
          title: 'macro-allele frequencies',
          note: 'share of gene copies away from the ancestral allele · every one of these starts at exactly 0',
          series: macroSeries,
          zeroBased: true,
        },
        {
          title: 'population by body plan',
          note: 'stacked · the two derived archetypes exist only downstream of a clade macro-mutation',
          series: archetypeBands,
          stacked: true,
          zeroBased: true,
        },
      ],
    },
    { title: 'the focal traits', panels: traitPanels },
    ...(lifePanels.length === 0 ? [] : [{ title: 'life history', panels: lifePanels }]),
    ...(signalPanels.length === 0 ? [] : [{ title: 'the signal axis', panels: signalPanels }]),
    {
      title: 'the arms race',
      panels: [
        {
          title: 'attack vs defense',
          note: 'population means · predation-kernel logits, one scale',
          series: [
            { label: 'attack', colour: SERIES_1, column: store.attack },
            { label: 'defense', colour: SERIES_2, column: store.defense },
          ],
        },
        {
          title: 'predator fraction',
          note: 'share with diet > 0.5 · dashes are the alert thresholds',
          series: [
            { label: 'predators', colour: SERIES_1, column: store.predatorFraction },
            { label: 'collapse 0.05', colour: INK_MUTED, column: constant(store.generation.length, 0.05), kind: 'guide' },
            { label: 'boom 0.15', colour: INK_MUTED, column: constant(store.generation.length, 0.15), kind: 'guide' },
          ],
          zeroBased: true,
        },
      ],
    },
    {
      title: 'divergence — the wall experiment',
      panels: [
        {
          title: 'Fst',
          note: 'neutral markers · rising after a wall goes up is the experiment working',
          series: [
            { label: 'across the barrier', colour: SERIES_1, column: store.fstBarrier },
            { label: 'among demes', colour: SERIES_2, column: store.fstDemes },
          ],
          zeroBased: true,
        },
        {
          title: 'population by deme column',
          note: 'stacked · west → east, the axis a vertical ridge splits',
          series: demeBands,
          stacked: true,
          zeroBased: true,
        },
      ],
    },
    {
      title: 'losses and the larder',
      panels: [
        {
          title: 'deaths by cause',
          note: 'stacked · deaths per generation',
          series: deathBands,
          stacked: true,
          zeroBased: true,
        },
        {
          title: 'standing resources',
          note: 'total biomass in the field',
          series: [
            { label: 'plankton', colour: SERIES_1, column: store.plankton },
            { label: 'kelp', colour: SERIES_2, column: store.kelp },
          ],
          zeroBased: true,
        },
      ],
    },
    {
      title: 'the variance economy',
      panels: [
        {
          title: 'heterozygosity',
          note: 'mean expected H at neutral markers',
          series: [{ label: 'H', colour: SERIES_1, column: store.heterozygosity }],
          zeroBased: true,
        },
        {
          title: 'effective size',
          note: 'temporal Ne · gaps are windows it could not be estimated over',
          series: [{ label: 'Ne', colour: SERIES_1, column: store.neTemporal }],
          zeroBased: true,
        },
      ],
    },
  ];
}

function constant(length: number, value: number): number[] {
  return new Array<number>(length).fill(value);
}

/** What forces a plot rebuild rather than a data update. */
function shapeSignature(specs: readonly SectionSpec[]): string {
  return specs.map((section) => section.panels.map((panel) => `${panel.title}:${panel.series.length}`).join(',')).join('|');
}

// ---------------------------------------------------------------------------
// Plot construction
//
// Module scope, not inside `createTrends`, because the one thing that must not
// drift is the correspondence between a panel's series list and its data
// columns: uPlot matches them by position, and a mismatch shows up as a guide
// line drawn with a stack band's numbers rather than as an error. `panelSeries`
// and `panelData` both walk `orderedSeries`, and a test asserts the two agree
// for every panel the app can build.
// ---------------------------------------------------------------------------

/**
 * Drawing order. A stack is drawn top band first so each lower fill paints over
 * the one above it, leaving the visible band between two cumulative curves;
 * guides are not part of the stack and follow it.
 */
function orderedSeries(spec: PanelSpec): readonly SeriesSpec[] {
  if (spec.stacked !== true) return spec.series;
  const bands = spec.series.filter((series) => series.kind !== 'guide');
  const guides = spec.series.filter((series) => series.kind === 'guide');
  return [...[...bands].reverse(), ...guides];
}

function axisOptions(): uPlot.Axis[] {
  const base = {
    stroke: INK_MUTED,
    // Hairline, solid, one shade off the surface: the frame is orientation, and
    // a dashed grid would read as a threshold.
    grid: { stroke: GRIDLINE, width: 1 },
    ticks: { stroke: BASELINE, width: 1, size: 4 },
    font: '10px ui-monospace, SFMono-Regular, Menlo, monospace',
  };
  return [
    { ...base, label: 'generation', labelSize: 18, labelFont: '10px ui-monospace, monospace' },
    { ...base, size: 52 },
  ];
}

export function panelSeries(spec: PanelSpec): uPlot.Series[] {
  const out: uPlot.Series[] = [{}];
  for (const series of orderedSeries(spec)) {
    if (series.kind === 'guide') {
      out.push({ label: series.label, stroke: INK_MUTED, width: 1, dash: [4, 4], points: { show: false } });
    } else if (spec.stacked === true) {
      out.push({
        label: series.label,
        // The stroke is the surface colour: a 2 px gap between fills, not an
        // outline around them.
        stroke: PANEL_SURFACE,
        width: 2,
        fill: series.colour,
        points: { show: false },
      });
    } else {
      out.push({ label: series.label, stroke: series.colour, width: 2, points: { show: false } });
    }
  }
  if (spec.band !== undefined) {
    // Hidden edges with a band between them: the ±1σ envelope is context for
    // the mean, so it never appears in the legend as if it were a reading.
    out.push({ label: '+1σ', stroke: 'transparent', width: 0, points: { show: false }, class: 'tr-quiet' });
    out.push({ label: '−1σ', stroke: 'transparent', width: 0, points: { show: false }, class: 'tr-quiet' });
  }
  return out;
}

export function panelBands(spec: PanelSpec): uPlot.Band[] {
  if (spec.band === undefined) return [];
  const colour = spec.series[0]?.colour ?? SERIES_1;
  // Series layout is [x, ...orderedSeries, upper, lower]; the envelope spans
  // the last two.
  const upper = spec.series.length + 1;
  return [{ series: [upper, upper + 1], fill: withAlpha(colour, 0.14) }];
}

/**
 * The drawn columns for a panel, thinned to the point budget over the visible
 * range. Column order matches `panelSeries` exactly.
 */
export function panelData(
  store: TrendStore,
  spec: PanelSpec,
  zoom: { readonly min: number; readonly max: number } | null,
  maxPoints = MAX_POINTS,
): uPlot.AlignedData {
  const [from, to] = zoom === null ? [0, store.generation.length] : sliceRange(store.generation, zoom.min, zoom.max);
  const ordered = orderedSeries(spec);
  const sources: Column[] = ordered.map((series) => series.column);
  if (spec.band !== undefined) sources.push(spec.band[0], spec.band[1]);
  const indices = pickIndices(sources, from, to, maxPoints);
  const x = gather(store.generation, indices) as number[];

  const values: (number | null)[][] = [];
  if (spec.stacked === true) {
    // Cumulated in bottom-to-top order, then reversed by `stackColumns` — which
    // is the order `orderedSeries` puts the bands in.
    const bands = ordered.filter((series) => series.kind !== 'guide');
    values.push(...stackColumns([...bands].reverse().map((series) => gather(series.column, indices))));
    for (const guide of ordered.filter((series) => series.kind === 'guide')) {
      values.push(gather(guide.column, indices));
    }
  } else {
    for (const series of ordered) values.push(gather(series.column, indices));
  }
  if (spec.band !== undefined) values.push(gather(spec.band[0], indices), gather(spec.band[1], indices));
  return [x, ...values] as uPlot.AlignedData;
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export interface Trends {
  /** Fold one sample row into the history and the detectors. */
  ingest(row: TrendRow): void;
  setOpen(open: boolean): void;
  resize(): void;
  /** Drop the previous world: columns, plots, detector state and the alert log. */
  reset(): void;
}

/** How many alert lines the panel's own log keeps. The station feed keeps its own. */
const ALERT_LOG_LINES = 12;

/** Redraw ceiling. Rows land every 200 ticks; anything faster redraws an identical picture. */
const REDRAW_MS = 700;

const CHART_HEIGHT = 180;
const SYNC_KEY = 'panthalassa-trends';

/**
 * uPlot's own stylesheet (v1.6.32), inlined rather than imported.
 *
 * A side-effect import of the library's stylesheet is what uPlot documents, and
 * it is what this file would do if the project's tsconfig declared
 * `vite/client` types. Without them such an import fails `tsc --noEmit` with
 * TS2882, and tsconfig.json is A0's file — so the stylesheet is carried here
 * and injected with the panel chrome instead. The rules below are not optional
 * decoration: uPlot positions its canvases, axes and cursor through them.
 */
const UPLOT_CSS = `.uplot, .uplot *, .uplot *::before, .uplot *::after {box-sizing: border-box;}.uplot {font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";line-height: 1.5;width: min-content;}.u-title {text-align: center;font-size: 18px;font-weight: bold;}.u-wrap {position: relative;user-select: none;}.u-over, .u-under {position: absolute;}.u-under {overflow: hidden;}.uplot canvas {display: block;position: relative;width: 100%;height: 100%;}.u-axis {position: absolute;}.u-legend {font-size: 14px;margin: auto;text-align: center;}.u-inline {display: block;}.u-inline * {display: inline-block;}.u-inline tr {margin-right: 16px;}.u-legend th {font-weight: 600;}.u-legend th > * {vertical-align: middle;display: inline-block;}.u-legend .u-marker {width: 1em;height: 1em;margin-right: 4px;background-clip: padding-box !important;}.u-inline.u-live th::after {content: ":";vertical-align: middle;}.u-inline:not(.u-live) .u-value {display: none;}.u-series > * {padding: 4px;}.u-series th {cursor: pointer;}.u-legend .u-off > * {opacity: 0.3;}.u-select {background: rgba(0,0,0,0.07);position: absolute;pointer-events: none;}.u-cursor-x, .u-cursor-y {position: absolute;left: 0;top: 0;pointer-events: none;will-change: transform;}.u-hz .u-cursor-x, .u-vt .u-cursor-y {height: 100%;border-right: 1px dashed #607D8B;}.u-hz .u-cursor-y, .u-vt .u-cursor-x {width: 100%;border-bottom: 1px dashed #607D8B;}.u-cursor-pt {position: absolute;top: 0;left: 0;border-radius: 50%;border: 0 solid;pointer-events: none;will-change: transform;/*this has to be !important since we set inline "background" shorthand */background-clip: padding-box !important;}.u-axis.u-off, .u-select.u-off, .u-cursor-x.u-off, .u-cursor-y.u-off, .u-cursor-pt.u-off {display: none;}`;

const CHROME_CSS = `
.tr-root {
  position: fixed;
  inset: 0;
  z-index: 4;
  overflow-y: auto;
  padding: 0 0 24px;
  background: var(--strip, ${PANEL_SURFACE});
  color: var(--ink, ${INK_SECONDARY});
  font: 11px/1.4 var(--mono, ui-monospace, monospace);
  scrollbar-width: thin;
  scrollbar-color: var(--hairline, #2c4a56) transparent;
}
.tr-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 16px 8px;
  background: var(--strip, ${PANEL_SURFACE});
  border-bottom: 1px solid var(--hairline, #2c4a56);
}
.tr-title { font-size: 11px; letter-spacing: 0.22em; text-transform: uppercase; }
.tr-hint { color: var(--ink-dim, ${INK_MUTED}); font-size: 10px; letter-spacing: 0.06em; }
.tr-alerts { padding: 6px 16px 0; }
.tr-alert { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-dim, ${INK_MUTED}); }
.tr-alert::before { content: '◦ '; color: var(--phosphor, #6ff2c4); }
.tr-alert--alert { color: var(--alert, #ff8264); }
.tr-alert--alert::before { color: var(--alert, #ff8264); }
.tr-empty { color: var(--ink-dim, ${INK_MUTED}); padding: 10px 16px; }
.tr-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 12px;
  padding: 10px 16px 0;
}
.tr-section {
  grid-column: 1 / -1;
  margin-top: 6px;
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink-dim, ${INK_MUTED});
  border-bottom: 1px solid var(--hairline-soft, rgba(127, 168, 184, 0.13));
  padding-bottom: 3px;
}
.tr-card { min-width: 0; }
.tr-card-title { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink, ${INK_SECONDARY}); }
.tr-card-note { display: block; margin-bottom: 2px; color: var(--ink-dim, ${INK_MUTED}); font-size: 10px; }
.tr-root .u-legend { font-size: 10px; color: var(--ink-dim, ${INK_MUTED}); margin-top: 2px; }
.tr-root .u-legend .u-marker { width: 10px; height: 2px; border: none !important; }
.tr-root .u-legend .u-value { color: var(--ink, ${INK_SECONDARY}); font-variant-numeric: tabular-nums; }
.tr-root .u-legend .tr-quiet { display: none; }
.tr-root .u-select { background: rgba(111, 242, 196, 0.12); }
`;

/**
 * Build the panel over `container` (index.html's `#trends`).
 *
 * Asynchronous because uPlot is loaded on demand: the module reads `document`
 * at import time, and the node-environment tests import this file for the pure
 * store and thinning functions. Deferring the import is what keeps those
 * testable without a DOM.
 */
export async function createTrends(
  container: HTMLElement,
  config: SimConfig,
  onAlert: (alert: Alert) => void,
): Promise<Trends> {
  const { default: UPlot } = await import('uplot');
  injectChrome();

  const store = createTrendStore(config);
  const alertState = createAlertState({ slotCapacity: config.world.slotCapacity });
  const log: Alert[] = [];

  container.classList.add('tr-root');
  const head = document.createElement('div');
  head.className = 'tr-head';
  const title = document.createElement('span');
  title.className = 'tr-title';
  title.textContent = 'Deep history';
  const hint = document.createElement('span');
  hint.className = 'tr-hint';
  hint.textContent = 'drag on a panel to zoom · double-click to reset · t closes';
  head.append(title, hint);

  const alertBox = document.createElement('div');
  alertBox.className = 'tr-alerts';

  const grid = document.createElement('div');
  grid.className = 'tr-grid';

  const empty = document.createElement('div');
  empty.className = 'tr-empty';
  empty.textContent = 'awaiting the first sample rows — the trace needs two before it can draw a line';

  container.append(head, alertBox, grid, empty);

  interface LivePanel {
    readonly spec: PanelSpec;
    readonly plot: uPlot;
    readonly body: HTMLElement;
    /** The x range the reader zoomed to, or null while the panel shows everything. */
    zoom: { min: number; max: number } | null;
  }

  let panels: LivePanel[] = [];
  let signature = '';
  let open = false;
  let dirty = false;
  let drawnAt = 0;
  let applying = false;

  function injectChrome(): void {
    if (document.getElementById('tr-chrome') !== null) return;
    const style = document.createElement('style');
    style.id = 'tr-chrome';
    style.textContent = `${UPLOT_CSS}\n${CHROME_CSS}`;
    document.head.append(style);
  }

  function chartWidth(body: HTMLElement): number {
    return Math.max(200, Math.floor(body.getBoundingClientRect().width));
  }

  function makePlot(spec: PanelSpec, body: HTMLElement): uPlot {
    const options: uPlot.Options = {
      width: chartWidth(body),
      height: CHART_HEIGHT,
      padding: [10, 12, 0, 0],
      scales: {
        x: { time: false },
        y:
          spec.zeroBased === true
            ? { range: (_self: uPlot, min: number, max: number): [number, number] => [Math.min(0, min), max === min ? max + 1 : max] }
            : {},
      },
      axes: axisOptions(),
      series: panelSeries(spec),
      bands: panelBands(spec),
      cursor: { sync: { key: SYNC_KEY }, drag: { x: true, y: false, setScale: true } },
      legend: { live: true },
      hooks: {
        // Only the x scale: y ranges follow the visible window automatically,
        // and reacting to those would schedule a redraw for every redraw.
        setScale: [
          (self: uPlot, key: string) => {
            if (applying || key !== 'x') return;
            onZoom(self);
          },
        ],
      },
    };
    return new UPlot(options, panelData(store, spec, null), body);
  }

  /**
   * Re-read the raw arrays for the range the reader zoomed into.
   *
   * This is the whole reason the store keeps every row: at full extent the
   * panel shows thinned extremes, and zooming in has to reveal detail rather
   * than magnify the summary.
   */
  function onZoom(self: uPlot): void {
    const panel = panels.find((entry) => entry.plot === self);
    if (panel === undefined) return;
    const min = self.scales['x']?.min;
    const max = self.scales['x']?.max;
    const first = store.generation[0];
    const last = store.generation[store.generation.length - 1];
    if (min === undefined || max === undefined || first === undefined || last === undefined) return;
    const whole = min <= first && max >= last;
    panel.zoom = whole ? null : { min, max };
    dirty = true;
  }

  function build(): void {
    const specs = sections(store);
    for (const panel of panels) panel.plot.destroy();
    panels = [];
    grid.replaceChildren();

    for (const section of specs) {
      const heading = document.createElement('div');
      heading.className = 'tr-section';
      heading.textContent = section.title;
      grid.append(heading);

      for (const spec of section.panels) {
        const card = document.createElement('div');
        card.className = 'tr-card';
        const cardTitle = document.createElement('div');
        cardTitle.className = 'tr-card-title';
        cardTitle.textContent = spec.title;
        const note = document.createElement('span');
        note.className = 'tr-card-note';
        note.textContent = spec.note;
        const body = document.createElement('div');
        card.append(cardTitle, note, body);
        grid.append(card);
        panels.push({ spec, plot: makePlot(spec, body), body, zoom: null });
      }
    }
    signature = shapeSignature(specs);
  }

  function draw(): void {
    if (store.generation.length < 2) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    const specs = sections(store);
    if (signature !== shapeSignature(specs) || panels.length === 0) {
      build();
      return;
    }

    // Specs are rebuilt every draw and carry the live columns; a plot keeps the
    // spec it was built from only for its shape, so the fresh one is read here.
    const flat = specs.flatMap((section) => [...section.panels]);
    applying = true;
    for (let index = 0; index < panels.length; index += 1) {
      const panel = panels[index];
      if (panel === undefined) continue;
      const spec = flat[index] ?? panel.spec;
      panel.plot.setData(panelData(store, spec, panel.zoom), true);
      // Re-applied after the reset so the reader stays where they zoomed to,
      // now looking at rows read fresh from the raw arrays.
      if (panel.zoom !== null) panel.plot.setScale('x', panel.zoom);
    }
    applying = false;
  }

  function renderAlerts(): void {
    alertBox.replaceChildren();
    for (const alert of log) {
      const line = document.createElement('span');
      line.className = alert.severity === 'alert' ? 'tr-alert tr-alert--alert' : 'tr-alert';
      line.textContent = alert.line;
      alertBox.append(line);
    }
  }

  function tick(timestamp: number): void {
    window.requestAnimationFrame(tick);
    if (!open || !dirty || timestamp - drawnAt < REDRAW_MS) return;
    drawnAt = timestamp;
    dirty = false;
    draw();
  }

  function sizePanels(): void {
    for (const panel of panels) panel.plot.setSize({ width: chartWidth(panel.body), height: CHART_HEIGHT });
  }

  window.requestAnimationFrame(tick);
  window.addEventListener('resize', () => {
    if (open) sizePanels();
  });

  return {
    ingest(row: TrendRow): void {
      ingestTrendRow(store, row);
      const alerts = detectAlerts(alertState, row);
      for (const alert of alerts) {
        onAlert(alert);
        log.unshift(alert);
      }
      if (log.length > ALERT_LOG_LINES) log.length = ALERT_LOG_LINES;
      if (alerts.length > 0 && open) renderAlerts();
      dirty = true;
    },
    setOpen(next: boolean): void {
      open = next;
      container.hidden = !next;
      if (!next) return;
      // Plots can only be sized once the panel has a layout box.
      renderAlerts();
      draw();
      sizePanels();
      dirty = false;
    },
    resize(): void {
      if (open) sizePanels();
    },
    reset(): void {
      resetTrendStore(store);
      resetAlertState(alertState);
      log.length = 0;
      for (const panel of panels) panel.plot.destroy();
      panels = [];
      signature = '';
      grid.replaceChildren();
      renderAlerts();
      empty.hidden = false;
      dirty = true;
    },
  };
}
