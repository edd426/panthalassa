/**
 * Trend-store and thinning tests.
 *
 * Everything here is the part of `trends.ts` that runs without a DOM: the
 * columns a row is flattened into, and the index selection that decides which
 * of 20,000 rows actually reach the canvas. The thinning is the piece worth
 * testing hardest — a downsampler that loses spikes is indistinguishable from a
 * working one until the run is long enough to matter, which is the only kind of
 * run this panel exists for.
 */

import { describe, expect, it } from 'vitest';
import type { GroupCount, TraitSample } from '../contracts/stats';
import type { TraitKey } from '../contracts/traits';
import { TRAIT_KEYS } from '../contracts/traits';
import type { DeathCause } from '../contracts/types';
import { DEATH_CAUSES, resolveSimConfig } from '../contracts/types';
import type { PanelSpec, TrendRow } from './trends';
import {
  MAX_SPECIES_BANDS,
  createTrendStore,
  gather,
  ingestTrendRow,
  panelBands,
  panelData,
  panelSeries,
  pickIndices,
  resetTrendStore,
  sections,
  sliceRange,
  stackColumns,
} from './trends';

const config = resolveSimConfig({});
const DEME_CELLS = config.world.demeCols * config.world.demeRows;

interface RowSpec {
  readonly generation: number;
  readonly population?: number;
  readonly bySpecies?: readonly GroupCount[];
  readonly byDeme?: readonly number[];
  readonly deaths?: Partial<Record<DeathCause, number>>;
  readonly sizeMean?: number;
  readonly sizeSd?: number;
  readonly fstBarrier?: number | null;
  /** Absent by default: the recorder only fills `lifeHistory` with ontogeny on. */
  readonly lifeHistory?: TrendRow['lifeHistory'];
}

function traitSample(mean: number, sd: number): TraitSample {
  return { mean, sd, additiveVariance: sd * sd, phenotypicVariance: sd * sd, heritability: 0.5 };
}

function makeRow(spec: RowSpec): TrendRow {
  const traits = Object.fromEntries(
    TRAIT_KEYS.map((key) => [key, traitSample(key === 'size' ? (spec.sizeMean ?? 12) : 0, key === 'size' ? (spec.sizeSd ?? 1) : 1)]),
  ) as Record<TraitKey, TraitSample>;
  const deaths = Object.fromEntries(DEATH_CAUSES.map((cause) => [cause, spec.deaths?.[cause] ?? 0])) as Record<
    DeathCause,
    number
  >;
  const population = spec.population ?? 100;
  return {
    tick: Math.round(spec.generation * config.time.generationTicks),
    generation: spec.generation,
    population,
    populationBySpecies: spec.bySpecies ?? [{ tag: 0, count: population }],
    populationByDeme: spec.byDeme ?? new Array<number>(DEME_CELLS).fill(0),
    traits,
    guilds: { predatorFraction: 0.5, filtererFraction: 0.5, meanAttack: 0.1, meanDefense: 0.2 },
    popgen: {
      neDemographic: 500,
      neTemporal: 400,
      fstDemes: 0.02,
      fstBarrier: spec.fstBarrier === undefined ? null : spec.fstBarrier,
      meanHeterozygosity: 0.4,
      midparentH2Size: 0.4,
    },
    resources: { planktonTotal: 1000, kelpTotal: 500, meanTemperatureC: 18, climateOffsetC: 0 },
    deaths,
    ...(spec.lifeHistory === undefined ? {} : { lifeHistory: spec.lifeHistory }),
  };
}

describe('sliceRange', () => {
  it('covers the requested span with one row of margin on each side', () => {
    const generation = [0, 1, 2, 3, 4, 5];
    expect(sliceRange(generation, 2, 4)).toEqual([1, 6]);
  });

  it('returns the whole axis for a range that contains it', () => {
    expect(sliceRange([0, 1, 2], -5, 99)).toEqual([0, 3]);
  });

  it('returns an empty span for an axis with nothing in it', () => {
    expect(sliceRange([], 0, 10)).toEqual([0, 0]);
  });
});

describe('pickIndices', () => {
  const ramp = Array.from({ length: 5000 }, (_value, index) => index);

  it('returns every index when the range fits the budget', () => {
    expect(pickIndices([[1, 2, 3]], 0, 3, 100)).toEqual([0, 1, 2]);
  });

  it('keeps the endpoints, stays ascending and never repeats an index', () => {
    const picked = pickIndices([ramp], 0, ramp.length, 400);
    expect(picked[0]).toBe(0);
    expect(picked[picked.length - 1]).toBe(ramp.length - 1);
    expect([...picked].sort((a, b) => a - b)).toEqual(picked);
    expect(new Set(picked).size).toBe(picked.length);
  });

  it('respects the point budget', () => {
    expect(pickIndices([ramp], 0, ramp.length, 400).length).toBeLessThanOrEqual(400);
    expect(pickIndices([ramp, ramp, ramp], 0, ramp.length, 400).length).toBeLessThanOrEqual(400);
  });

  it('preserves a one-row spike that striding would drop', () => {
    const flat = new Array<number>(5000).fill(10);
    flat[3137] = 900;
    const picked = pickIndices([flat], 0, flat.length, 400);
    expect(picked).toContain(3137);
    // The comparison that makes the point: every 20th row misses it entirely.
    expect(picked.length).toBeLessThan(flat.length);
  });

  it('preserves the deepest trough as well as the tallest spike', () => {
    const flat = new Array<number>(5000).fill(10);
    flat[812] = -40;
    flat[4020] = 90;
    const picked = pickIndices([flat], 0, flat.length, 300);
    expect(picked).toContain(812);
    expect(picked).toContain(4020);
  });

  it('finds the extremes of every column, not only the first', () => {
    const flat = new Array<number>(2000).fill(1);
    const other = new Array<number>(2000).fill(1);
    other[1234] = 77;
    const picked = pickIndices([flat, other], 0, flat.length, 200);
    expect(picked).toContain(1234);
  });

  it('ignores gaps and non-finite readings', () => {
    const gappy: (number | null)[] = new Array<number | null>(2000).fill(null);
    gappy[500] = 5;
    gappy[1500] = 9;
    const picked = pickIndices([gappy], 0, gappy.length, 200);
    expect(picked).toContain(500);
    expect(picked).toContain(1500);
    expect(pickIndices([new Array<number>(2000).fill(Number.NaN)], 0, 2000, 200)).toEqual([0, 1999]);
  });

  it('honours the start of a zoomed sub-range', () => {
    const picked = pickIndices([ramp], 1000, 2000, 200);
    expect(picked[0]).toBe(1000);
    expect(picked[picked.length - 1]).toBe(1999);
  });
});

describe('gather', () => {
  it('reads a column at the chosen indices and keeps gaps as gaps', () => {
    expect(gather([1, 2, 3, 4], [0, 3])).toEqual([1, 4]);
    expect(gather([1, null, 3], [1])).toEqual([null]);
  });
});

describe('stackColumns', () => {
  it('accumulates bottom-to-top and returns the topmost band first', () => {
    // Drawn top band first so each lower fill paints over it; the top band is
    // therefore the full total.
    expect(stackColumns([[1, 1], [2, 2], [3, 3]])).toEqual([
      [6, 6],
      [3, 3],
      [1, 1],
    ]);
  });

  it('treats a gap as no contribution rather than breaking the stack', () => {
    expect(stackColumns([[1, 1], [null, 2]])).toEqual([
      [1, 3],
      [1, 1],
    ]);
  });
});

describe('the store', () => {
  it('flattens a row into aligned columns', () => {
    const store = createTrendStore(config);
    ingestTrendRow(store, makeRow({ generation: 1, population: 400, sizeMean: 12, sizeSd: 2 }));
    ingestTrendRow(store, makeRow({ generation: 2, population: 380 }));

    expect(store.generation).toEqual([1, 2]);
    expect(store.population).toEqual([400, 380]);
    expect(store.capacity).toEqual([config.world.slotCapacity, config.world.slotCapacity]);
    const size = store.traits.find((trait) => trait.key === 'size');
    expect(size?.mean[0]).toBe(12);
    expect(size?.upper[0]).toBe(14);
    expect(size?.lower[0]).toBe(10);
    expect(store.fstBarrier).toEqual([null, null]);
  });

  it('sums the deme grid into columns, west to east', () => {
    const store = createTrendStore(config);
    const byDeme = new Array<number>(DEME_CELLS).fill(0);
    // One organism in every cell of the western column, none anywhere else.
    for (let row = 0; row < config.world.demeRows; row += 1) byDeme[row * config.world.demeCols] = 7;
    ingestTrendRow(store, makeRow({ generation: 1, byDeme }));

    expect(store.demeColumns).toHaveLength(config.world.demeCols);
    expect(store.demeColumns[0]?.[0]).toBe(7 * config.world.demeRows);
    expect(store.demeColumns[1]?.[0]).toBe(0);
  });

  it('reports deaths per generation, not per row', () => {
    const store = createTrendStore(config);
    const perRow = 200 / config.time.generationTicks;
    ingestTrendRow(store, makeRow({ generation: perRow, deaths: { predation: 9 } }));
    ingestTrendRow(store, makeRow({ generation: perRow * 2, deaths: { predation: 9 } }));
    const predation = store.deaths[DEATH_CAUSES.indexOf('predation')];
    // Nine deaths per 200-tick row against 900-tick generations is 40.5 per generation.
    expect(predation?.[0]).toBeCloseTo(9 / perRow, 6);
    expect(predation?.[1]).toBeCloseTo(9 / perRow, 6);
  });

  it('opens a band when a species appears and back-fills it with zeros', () => {
    const store = createTrendStore(config);
    ingestTrendRow(store, makeRow({ generation: 1, bySpecies: [{ tag: 0, count: 100 }] }));
    ingestTrendRow(store, makeRow({ generation: 2, bySpecies: [{ tag: 0, count: 60 }, { tag: 1, count: 40 }] }));

    expect(store.species.map((band) => band.tag)).toEqual([0, 1]);
    expect(store.species[1]?.counts).toEqual([0, 40]);
    expect(store.species[0]?.counts).toEqual([100, 60]);
  });

  it('keeps an extinct species on its own colour instead of handing it to the next lineage', () => {
    const store = createTrendStore(config);
    ingestTrendRow(store, makeRow({ generation: 1, bySpecies: [{ tag: 0, count: 100 }] }));
    ingestTrendRow(store, makeRow({ generation: 2, bySpecies: [{ tag: 1, count: 50 }] }));

    expect(store.species.map((band) => band.tag)).toEqual([0, 1]);
    expect(store.species[0]?.counts).toEqual([100, 0]);
    expect(store.species[1]?.counts).toEqual([0, 50]);
  });

  it('folds species past the band limit into one tail band', () => {
    const store = createTrendStore(config);
    const many = Array.from({ length: MAX_SPECIES_BANDS + 3 }, (_value, index) => ({ tag: index, count: 10 }));
    ingestTrendRow(store, makeRow({ generation: 1, bySpecies: many }));

    expect(store.species).toHaveLength(MAX_SPECIES_BANDS);
    expect(store.speciesOther[0]).toBe(30);
  });

  it('forgets the previous world on reset, bands included', () => {
    const store = createTrendStore(config);
    ingestTrendRow(store, makeRow({ generation: 1, bySpecies: [{ tag: 0, count: 100 }, { tag: 4, count: 20 }] }));
    resetTrendStore(store);

    expect(store.generation).toHaveLength(0);
    expect(store.species).toHaveLength(0);
    expect(store.speciesOther).toHaveLength(0);
    expect(store.demeColumns.every((column) => column.length === 0)).toBe(true);
    expect(store.deaths.every((column) => column.length === 0)).toBe(true);
    expect(store.lastGeneration).toBe(0);

    // A new world's first row must not be rated against the dead world's clock.
    ingestTrendRow(store, makeRow({ generation: 0.5, deaths: { starvation: 5 } }));
    expect(store.deaths[DEATH_CAUSES.indexOf('starvation')]?.[0]).toBeCloseTo(10, 6);
  });

  it('stays aligned across a long run, which is what uPlot requires of its columns', () => {
    const store = createTrendStore(config);
    for (let index = 1; index <= 2000; index += 1) {
      ingestTrendRow(store, makeRow({ generation: index * 0.25, population: 100 + index }));
    }
    const length = store.generation.length;
    expect(length).toBe(2000);
    for (const column of [store.population, store.capacity, store.heterozygosity, store.plankton, store.fstBarrier]) {
      expect(column).toHaveLength(length);
    }
    for (const trait of store.traits) expect(trait.mean).toHaveLength(length);
    for (const column of store.demeColumns) expect(column).toHaveLength(length);
    for (const column of store.deaths) expect(column).toHaveLength(length);
    expect(store.species[0]?.counts).toHaveLength(length);
  });

  it('keeps a column for the two axes the world view cannot show', () => {
    // `SampleRow.traits` carries every trait, not only the focal four, so these
    // cost nothing to keep — and a chart is the only place toxicity is legible
    // at all, because it is deliberately absent from the sample slice.
    const store = createTrendStore(config);
    ingestTrendRow(store, makeRow({ generation: 1 }));
    for (const key of ['toxicity', 'conspicuousness'] as const) {
      expect(store.traits.find((trait) => trait.key === key)?.mean).toHaveLength(1);
    }
  });

  it('pads life history with nulls until the recorder starts reporting it', () => {
    // Alignment, not politeness: every column is indexed by row against
    // `generation`, so a column that only started appending when the field
    // appeared would plot the whole run shifted by however many rows it missed.
    const store = createTrendStore(config);
    ingestTrendRow(store, makeRow({ generation: 1 }));
    expect(store.lifeHistorySeen).toBe(false);
    expect(store.juvenileFraction).toEqual([null]);

    ingestTrendRow(
      store,
      makeRow({
        generation: 2,
        lifeHistory: {
          meanLengthCm: 9,
          sdLengthCm: 3,
          juvenileFraction: 0.32,
          meanAgeAtMaturityTicks: 400,
          recruitment: 17,
        },
      }),
    );
    expect(store.lifeHistorySeen).toBe(true);
    expect(store.lengthMean).toEqual([null, 9]);
    expect(store.lengthUpper).toEqual([null, 12]);
    expect(store.lengthLower).toEqual([null, 6]);
    expect(store.juvenileFraction).toEqual([null, 0.32]);
    expect(store.recruitment).toEqual([null, 17]);

    resetTrendStore(store);
    expect(store.lifeHistorySeen).toBe(false);
    expect(store.lengthMean).toEqual([]);
  });
});

describe('panel construction', () => {
  /** A world that exercises every panel shape: two species, a barrier, deaths. */
  function populated(): ReturnType<typeof createTrendStore> {
    const store = createTrendStore(config);
    for (let index = 1; index <= 40; index += 1) {
      const byDeme = new Array<number>(DEME_CELLS).fill(index);
      ingestTrendRow(
        store,
        makeRow({
          generation: index * 0.25,
          population: 400 + index,
          bySpecies: index < 20 ? [{ tag: 0, count: 400 }] : [{ tag: 0, count: 300 }, { tag: 1, count: 100 }],
          byDeme,
          deaths: { predation: index, starvation: 2 },
          fstBarrier: index < 10 ? null : 0.02 * index,
        }),
      );
    }
    return store;
  }

  function allPanels(store: ReturnType<typeof createTrendStore>): PanelSpec[] {
    return sections(store).flatMap((section) => [...section.panels]);
  }

  it('withholds the life-history section until a row has carried one, then aligns it', () => {
    // An empty chart promising a reading nobody is taking is worse than no
    // chart: it reads as "measured zero" rather than as "not instrumented".
    const quiet = populated();
    expect(sections(quiet).some((section) => section.title === 'life history')).toBe(false);
    // The signal axis is not gated the same way: `SampleRow.traits` always
    // carries both traits, so those two panels are real from the first row.
    expect(sections(quiet).some((section) => section.title === 'the signal axis')).toBe(true);

    const store = populated();
    ingestTrendRow(
      store,
      makeRow({
        generation: 41,
        lifeHistory: {
          meanLengthCm: 9,
          sdLengthCm: 3,
          juvenileFraction: 0.32,
          meanAgeAtMaturityTicks: 400,
          recruitment: 17,
        },
      }),
    );
    const life = sections(store).find((section) => section.title === 'life history');
    expect(life?.panels.map((panel) => panel.title)).toEqual([
      'realised length',
      'juvenile fraction',
      'recruitment',
    ]);
    for (const panel of life?.panels ?? []) {
      const data = panelData(store, panel, null);
      expect(data.length).toBe(panelSeries(panel).length);
      const length = data[0]?.length ?? 0;
      for (const column of data) expect(column).toHaveLength(length);
    }
  });

  it('gives every panel a title, a note and at least one series', () => {
    const panels = allPanels(populated());
    expect(panels.length).toBeGreaterThan(6);
    for (const panel of panels) {
      expect(panel.title.length).toBeGreaterThan(0);
      expect(panel.note.length).toBeGreaterThan(0);
      expect(panel.series.length).toBeGreaterThan(0);
    }
  });

  it('hands uPlot exactly as many data columns as it declares series', () => {
    // uPlot matches series to columns by position; a mismatch draws one
    // series' numbers under another's label rather than raising anything.
    const store = populated();
    for (const panel of allPanels(store)) {
      const series = panelSeries(panel);
      const data = panelData(store, panel, null);
      expect(data.length).toBe(series.length);
      const length = data[0]?.length ?? 0;
      for (const column of data) expect(column).toHaveLength(length);
    }
  });

  it('keeps the same alignment when a panel is zoomed', () => {
    const store = populated();
    for (const panel of allPanels(store)) {
      const data = panelData(store, panel, { min: 3, max: 6 });
      expect(data.length).toBe(panelSeries(panel).length);
      const x = data[0] ?? [];
      expect(x.length).toBeGreaterThan(1);
      expect(Math.min(...x)).toBeLessThanOrEqual(3);
      expect(Math.max(...x)).toBeGreaterThanOrEqual(6);
    }
  });

  it('points every ±1σ band at the two hidden edge series', () => {
    const store = populated();
    for (const panel of allPanels(store)) {
      const bands = panelBands(panel);
      if (panel.band === undefined) {
        expect(bands).toHaveLength(0);
        continue;
      }
      const series = panelSeries(panel);
      expect(bands[0]?.series).toEqual([series.length - 2, series.length - 1]);
      expect(series[series.length - 1]?.class).toBe('tr-quiet');
    }
  });

  it('stacks the species panel to the population, with the capacity guide unstacked', () => {
    const store = populated();
    const panel = allPanels(store).find((entry) => entry.title === 'population by species');
    expect(panel).toBeDefined();
    if (panel === undefined) return;
    const data = panelData(store, panel, null);
    // Column 1 is the top of the stack, so it carries the whole census; the
    // last column is the capacity guide, which is not part of the stack.
    const top = data[1] ?? [];
    const guide = data[data.length - 1] ?? [];
    expect(top[top.length - 1]).toBe(400);
    expect(guide[guide.length - 1]).toBe(config.world.slotCapacity);
  });

  it('splits the population panel into bands only once there is more than one species', () => {
    const store = createTrendStore(config);
    ingestTrendRow(store, makeRow({ generation: 1 }));
    ingestTrendRow(store, makeRow({ generation: 2 }));
    const single = sections(store)[0]?.panels[0];
    expect(single?.title).toBe('population');
    expect(single?.stacked).toBeUndefined();
  });

  it('thins a long run to the point budget on every panel', () => {
    const store = createTrendStore(config);
    for (let index = 1; index <= 12_000; index += 1) {
      ingestTrendRow(store, makeRow({ generation: index * 0.25, population: 400 + (index % 37) }));
    }
    for (const panel of allPanels(store)) {
      const data = panelData(store, panel, null);
      expect(data[0]?.length ?? 0).toBeLessThanOrEqual(1400);
      expect(data[0]?.length ?? 0).toBeGreaterThan(10);
    }
  });
});
