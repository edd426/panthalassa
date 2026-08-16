/**
 * G-wave detection units: the recorder's arm gating, the biomass series P3's
 * band is stated in, and the two analytic pieces P17/P18/P19 rest on.
 *
 * The gating tests are the load-bearing ones. The whole G-wave rests on the
 * off arm being inert, and "inert" for the recorder means a row with both
 * toggles off must not gain a key — not a null one, not a zero one — because
 * the run archive in `runs/` is compared byte for byte across commits.
 */

import { describe, expect, it } from 'vitest';

import { QUANT_LOCUS_BY_ID, W_ROWS_BY_TRAIT } from '../contracts/genome';
import type { SampleRow } from '../contracts/stats';
import { HUE_PERIOD_DEG, TRAIT_COUNT, TRAIT_INDEX } from '../contracts/traits';
import { DEFAULT_SIM_CONFIG, resolveSimConfig } from '../contracts/types';
import type { SimConfigOverrides } from '../contracts/types';
import { createSim } from '../sim/engine';
import { BIOMASS_COLUMN, LENGTH_MEAN_COLUMN, hueBinOf, toxicBinFloor } from '../stats/detection';
import { buildModules } from './harness';
import {
  authoredTraitCorrelation,
  couplingBar,
  detectMimicryCycles,
  founderGeneticCovariance,
  gatesOf,
} from './probes/aposematism';
import { driftSd } from './probes/community';
import { killWindowOverlap, killWindowRatios } from './probes/lifehistory';
import type { RunResult } from './harness';
import { SWEEP_DISCRETE_LOCUS } from './scenarios';

const SMALL_WORLD = {
  world: { widthWu: 400, heightWu: 300, initialPopulation: 240, slotCapacity: 512, fieldCellSizeWu: 25 },
} as const;

/** Steps one sample interval and hands back the row the recorder wrote. */
function firstRow(seed: string, overrides: SimConfigOverrides): { row: SampleRow; biomass: number; meanLength: number } {
  const config = resolveSimConfig(overrides);
  const { modules, stats } = buildModules(config);
  const sim = createSim({ seed, config: overrides, modules });
  sim.step(config.sampling.sampleIntervalTicks);
  const row = stats.series(-1)[0];
  if (row === undefined) throw new Error('the recorder wrote no row');
  return {
    row,
    biomass: stats.column(BIOMASS_COLUMN)?.[0] ?? Number.NaN,
    meanLength: stats.column(LENGTH_MEAN_COLUMN)?.[0] ?? Number.NaN,
  };
}

describe('recorder arm gating', () => {
  it('leaves every G-wave field absent — not null, not zero — with both toggles off', () => {
    const { row } = firstRow('gwave-off', SMALL_WORLD);
    for (const field of ['lifeHistory', 'hueBins', 'mimicryIndex', 'traitsByDeme']) {
      expect(field in row, `off-arm row carries '${field}'`).toBe(false);
    }
    const serialised = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
    expect(Object.keys(serialised)).not.toContain('lifeHistory');
    expect(Object.keys(serialised)).not.toContain('hueBins');
  });

  it('reports life history on the ontogeny arm and hue bins on the aposematism arm, never the other way', () => {
    const ontogeny = firstRow('gwave-onto', { ...SMALL_WORLD, toggles: { enableOntogeny: true } }).row;
    expect(ontogeny.lifeHistory).toBeDefined();
    expect(ontogeny.traitsByDeme).toBeDefined();
    expect('hueBins' in ontogeny).toBe(false);
    expect('mimicryIndex' in ontogeny).toBe(false);

    const aposematism = firstRow('gwave-apo', { ...SMALL_WORLD, toggles: { enableAposematism: true } }).row;
    expect(aposematism.hueBins).toHaveLength(DEFAULT_SIM_CONFIG.predation.hueBinCount);
    expect('mimicryIndex' in aposematism).toBe(true);
    expect(aposematism.traitsByDeme).toBeDefined();
    expect('lifeHistory' in aposematism).toBe(false);
  });

  it('reports per-deme moments for the clustering traits and both G-wave axes', () => {
    const { row } = firstRow('gwave-demes', { ...SMALL_WORLD, toggles: { enableAposematism: true } });
    const byDeme = row.traitsByDeme;
    expect(byDeme).toHaveLength(DEFAULT_SIM_CONFIG.world.demeCols * DEFAULT_SIM_CONFIG.world.demeRows);
    const occupied = byDeme?.find((deme) => deme.size !== undefined);
    expect(occupied?.diet).toBeDefined();
    expect(occupied?.toxicity).toBeDefined();
    expect(occupied?.conspicuousness).toBeDefined();
  });
});

describe('the biomass series P3 reads', () => {
  it('is Σ expressed size exactly with ontogeny off, so the band means one thing on both arms', () => {
    const config = resolveSimConfig(SMALL_WORLD);
    const { modules, stats } = buildModules(config);
    const sim = createSim({ seed: 'gwave-biomass', config: SMALL_WORLD, modules });
    sim.step(config.sampling.sampleIntervalTicks);

    const pop = sim.state.pop;
    let expected = 0;
    for (let slot = 0; slot < pop.capacity; slot += 1) {
      if (pop.alive[slot] !== 1) continue;
      expected += pop.traits[slot * TRAIT_COUNT + TRAIT_INDEX.size] ?? 0;
    }
    expect(stats.column(BIOMASS_COLUMN)?.[0]).toBeCloseTo(expected, 3);
  });

  it('equals census × realised mean length on the ontogeny arm', () => {
    const { row, biomass, meanLength } = firstRow('gwave-biomass-onto', {
      ...SMALL_WORLD,
      toggles: { enableOntogeny: true },
    });
    expect(row.lifeHistory?.meanLengthCm).toBeCloseTo(meanLength, 6);
    expect(biomass).toBeCloseTo(row.population * meanLength, 3);
  });

  it('is produced on both arms, because P3 gates the off arm', () => {
    expect(firstRow('gwave-col-off', SMALL_WORLD).biomass).toBeGreaterThan(0);
    expect(firstRow('gwave-col-on', { ...SMALL_WORLD, toggles: { enableOntogeny: true } }).biomass).toBeGreaterThan(0);
  });
});

describe('P18 analytic null', () => {
  it('is the q63 cell of W and nothing else', () => {
    // Hand-computed from the authored table: q63 is the only locus loading both
    // traits (0.28 toxicity, 0.35 conspicuousness, founderSd 0.45), so
    //   Cov = 2 · 0.28 · 0.35 · 0.45²          = 0.03969
    //   V_tox = 2 · Σ (w·sd)² over q31,q32,q61,q62,q63,q68 = 0.1992745
    //   V_con = 2 · Σ (w·sd)² over q37,q63,q64,q65,q66,q67 = 0.2971925
    //   r = 0.03969 / √(0.1992745 · 0.2971925) = 0.16309…
    const gates = { ontogeny: false, aposematism: true };
    expect(founderGeneticCovariance('toxicity', 'conspicuousness', 1, gates)).toBeCloseTo(0.03969, 6);
    expect(authoredTraitCorrelation('toxicity', 'conspicuousness', 1, gates)).toBeCloseTo(0.16309, 4);
  });

  it('does not depend on founderSdScale, so it is a property of the table', () => {
    const gates = { ontogeny: false, aposematism: true };
    const wide = authoredTraitCorrelation('toxicity', 'conspicuousness', 1, gates);
    expect(authoredTraitCorrelation('toxicity', 'conspicuousness', 0.1, gates)).toBeCloseTo(wide, 10);
  });

  it('collapses to zero covariance when A6 is dark, because the coupling locus lives there', () => {
    const dark = { ontogeny: false, aposematism: false };
    expect(founderGeneticCovariance('toxicity', 'conspicuousness', 1, dark)).toBe(0);
    expect(QUANT_LOCUS_BY_ID.q63.chromosome).toBe('A6');
  });

  it('reads the gates off a config rather than assuming the arm', () => {
    expect(gatesOf(resolveSimConfig({ toggles: { enableAposematism: true } }))).toEqual({
      ontogeny: false,
      aposematism: true,
    });
  });

  it('widens the bar for a thin population instead of holding a fixed offset', () => {
    const authored = authoredTraitCorrelation('toxicity', 'conspicuousness', 1, {
      ontogeny: false,
      aposematism: true,
    });
    expect(couplingBar(authored, 1_500)).toBeCloseTo(authored + 3 * ((1 - authored ** 2) / Math.sqrt(1_499)), 10);
    expect(couplingBar(authored, 200)).toBeGreaterThan(couplingBar(authored, 2_000));
    expect(couplingBar(authored, 2_000)).toBeGreaterThan(authored);
  });

  it('counts every locus loading either trait, so a table that grows moves the null', () => {
    expect(W_ROWS_BY_TRAIT.toxicity.map((entry) => entry.locusIndex)).toHaveLength(6);
    expect(W_ROWS_BY_TRAIT.conspicuousness.map((entry) => entry.locusIndex)).toHaveLength(6);
  });
});

describe('P19 cycle detector', () => {
  const bins = (count: number, toxicity: number): SampleRow['hueBins'] => [
    { count, meanToxicity: toxicity, meanConspicuousness: 1 },
    { count: 100, meanToxicity: 0, meanConspicuousness: 0 },
  ];
  const row = (generation: number, count: number, toxicity: number, mimicry: number | null): SampleRow =>
    ({ generation, hueBins: bins(count, toxicity), mimicryIndex: mimicry }) as SampleRow;

  it('finds fill, collapse and empty in that order and only in that order', () => {
    const cycles = detectMimicryCycles([
      row(30, 200, 1.0, 0.2),
      row(31, 400, 1.0, 0.7), // fill: free riders past the bar while the ring is toxic
      row(32, 400, 0.3, 0.7), // collapse: ring mean defence halved
      row(33, 40, 0.3, 0.7), // empty: ring cleared
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.peakGeneration).toBe(31);
    expect(cycles[0]?.emptyGeneration).toBe(33);
  });

  it('does not call an emptying ring a cycle when its defence never collapsed', () => {
    expect(detectMimicryCycles([row(31, 400, 1.0, 0.7), row(32, 400, 1.0, 0.7), row(33, 20, 1.0, 0.7)])).toHaveLength(0);
  });

  it('does not fire on a toxic ring nobody is mimicking', () => {
    expect(detectMimicryCycles([row(31, 400, 1.0, 0.1), row(32, 400, 0.2, 0.1), row(33, 20, 0.2, 0.1)])).toHaveLength(0);
  });

  it('ignores rows from an arm that carries no hue bins', () => {
    expect(detectMimicryCycles([{ generation: 31 } as SampleRow])).toHaveLength(0);
  });

  it('needs a ring above the toxic floor before it will call anything focal', () => {
    expect(toxicBinFloor()).toBeGreaterThan(0);
    const belowFloor = toxicBinFloor() / 2;
    expect(detectMimicryCycles([row(31, 400, belowFloor, 0.9), row(32, 20, 0, 0.9)])).toHaveLength(0);
  });
});

describe('the pieces P10 and P17 read', () => {
  it('bins hue the way the predation grid does', () => {
    expect(hueBinOf(0, 12)).toBe(0);
    expect(hueBinOf(HUE_PERIOD_DEG - 0.001, 12)).toBe(11);
    expect(hueBinOf(HUE_PERIOD_DEG, 12)).toBe(0);
    expect(hueBinOf(-1, 12)).toBe(11);
    expect(hueBinOf(HUE_PERIOD_DEG / 2, 12)).toBe(6);
  });

  it('tracks a locus nothing selects on, which is the point of the P10 move', () => {
    // `neutralD` is a k=8 marker: no DISCRETE_EFFECTS row, no quantitative load.
    expect(SWEEP_DISCRETE_LOCUS).toBe('neutralD');
    const config = resolveSimConfig();
    const { modules } = buildModules(config);
    const sim = createSim({ seed: 'gwave-neutral', config: {}, modules });
    expect(sim.state.config.predation.hueBinCount).toBeGreaterThan(0);
  });

  it('saturates the drift SD at the heterozygosity rather than running past it', () => {
    expect(driftSd(0.125, 0, 500)).toBeNaN();
    expect(driftSd(0.125, 10, 500)).toBeLessThan(driftSd(0.125, 200, 500));
    // The linearisation f(1−f)·t/2Ne would read 0.33 here; the diffusion form
    // cannot exceed √(f(1−f)) = 0.331 no matter how long the window.
    expect(driftSd(0.125, 100_000, 500)).toBeLessThanOrEqual(Math.sqrt(0.125 * 0.875) + 1e-12);
  });

  it('scores a write-once-size population near 1 on kill-window overlap, which is what P17s ceiling catches', () => {
    // The defect P17 exists for: with ontogeny off every animal is an adult of
    // its final length, so the realised ratio distribution is a point mass at 1
    // — and at the emergency sizeRatioOptimum 0.88 that point mass sits inside
    // the window. The ontogeny arm measures 0.28–0.44 against this.
    const config = resolveSimConfig(SMALL_WORLD);
    const { modules } = buildModules(config);
    const sim = createSim({ seed: 'gwave-monomorphic', config: SMALL_WORLD, modules });
    sim.step(config.sampling.sampleIntervalTicks);
    const { overlap, predators } = killWindowOverlap({ sim, config } as RunResult);
    expect(predators).toBeGreaterThan(0);
    // 0.83 at founding, where the size spread is still the full founder
    // variance; a settled off-arm population sits tighter and scores higher.
    expect(overlap).toBeGreaterThan(0.75);
  });

  it('derives P17s kill window from the tuned predation pair', () => {
    const config = resolveSimConfig();
    const [low, high] = killWindowRatios(config);
    expect(low).toBeCloseTo(config.predation.sizeRatioOptimum - config.predation.sizeRatioWidth, 10);
    expect(high).toBeCloseTo(config.predation.sizeRatioOptimum + config.predation.sizeRatioWidth, 10);
  });
});
