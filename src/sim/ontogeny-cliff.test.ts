/**
 * G2 — the ontogeny cliff screen, in test form (LONG_SIM only).
 *
 * Three seeds, 45 generations, `enableOntogeny` on at the authored defaults.
 * The question this answers is the one a cliff screen exists to answer: does
 * the axis leave a world standing, and does it produce the thing it was added
 * for — a population with an age structure, rather than a cloud of identical
 * adults.
 *
 * Thresholds sit just under achieved behaviour (CLAUDE.md: a probe that has
 * never failed is not testing anything), so they are a ratchet for G6 to tighten
 * rather than a wish. The summary line per seed is printed because the numbers,
 * not the pass, are what the tuning campaign reads.
 *
 * Each run is stepped in short chunks with a macrotask between them. A single
 * ~100 s synchronous block starves vitest's worker RPC, and the run then reports
 * "3 passed, 1 error" and **exits 1** — the same reporter-starvation failure
 * `vitest.config.ts` already documents. The clock is never read and nothing here
 * feeds the sim; the await is purely a yield.
 */

import { describe, expect, it } from 'vitest';

import type { SimConfigOverrides } from '../contracts/types';
import { resolveSimConfig } from '../contracts/types';
import { buildModules } from '../probes/harness';
import { createSim } from './engine';
import type { SimHandleInternal } from './engine';
import { T, traitAt } from './organisms';

const SEEDS = ['s1', 's2', 's3'] as const;
const GENERATIONS = 45;

/** Ticks per synchronous chunk; ~1 s of work, well inside the RPC timeout. */
const CHUNK_TICKS = 300;

function yieldToReporter(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Authored defaults with the axis on; the point is the defaults, not a rig. */
const OVERRIDES: SimConfigOverrides = { toggles: { enableOntogeny: true } };

interface LifeHistorySummary {
  readonly population: number;
  readonly juvenileFraction: number;
  readonly meanLengthCm: number;
  readonly lengthCv: number;
  readonly shortestCm: number;
  readonly longestCm: number;
}

function summarise(sim: SimHandleInternal): LifeHistorySummary {
  const pools = sim.pools;
  const fraction = sim.state.config.growth.maturityLengthFraction;

  let population = 0;
  let juveniles = 0;
  let sum = 0;
  let sumSquares = 0;
  let shortest = Number.POSITIVE_INFINITY;
  let longest = 0;

  for (let slot = 0; slot < pools.capacity; slot += 1) {
    if ((pools.alive[slot] ?? 0) === 0) continue;
    const length = pools.sizeCurrent[slot] ?? 0;
    population += 1;
    sum += length;
    sumSquares += length * length;
    if (length < fraction * traitAt(pools, slot, T.size)) juveniles += 1;
    if (length < shortest) shortest = length;
    if (length > longest) longest = length;
  }

  const mean = population > 0 ? sum / population : 0;
  const variance = population > 0 ? Math.max(0, sumSquares / population - mean * mean) : 0;
  return {
    population,
    juvenileFraction: population > 0 ? juveniles / population : 0,
    meanLengthCm: mean,
    lengthCv: mean > 0 ? Math.sqrt(variance) / mean : 0,
    shortestCm: population > 0 ? shortest : 0,
    longestCm: longest,
  };
}

describe.skipIf(process.env.LONG_SIM !== '1')('ontogeny cliff screen (45 generations, 3 seeds)', () => {
  for (const seed of SEEDS) {
    it(`survives ${GENERATIONS} generations with a real size structure on seed ${seed}`, async () => {
      const config = resolveSimConfig(OVERRIDES);
      const { modules } = buildModules(config);
      const sim = createSim({ seed, config: OVERRIDES, modules });

      const ticks = GENERATIONS * config.time.generationTicks;
      for (let done = 0; done < ticks; done += CHUNK_TICKS) {
        sim.step(Math.min(CHUNK_TICKS, ticks - done));
        await yieldToReporter();
      }

      const summary = summarise(sim);
      console.log(
        `[ontogeny cliff ${seed}] n=${summary.population} juvenile=${summary.juvenileFraction.toFixed(3)} ` +
          `meanLen=${summary.meanLengthCm.toFixed(2)}cm cv=${summary.lengthCv.toFixed(3)} ` +
          `range=[${summary.shortestCm.toFixed(2)}, ${summary.longestCm.toFixed(2)}] ` +
          `births=${sim.diagnostics.birthsApplied} dropped=${sim.diagnostics.birthsDropped}`,
      );

      // Survival, and by a margin: an axis that leaves 3 fish standing has not
      // left a world standing. Achieved 709–1192 across these three seeds.
      expect(summary.population).toBeGreaterThan(300);
      // The slot cap is a memory bound, not an ecological one (P3).
      expect(sim.diagnostics.birthsDropped).toBe(0);

      // An age structure exists in both directions: juveniles are being
      // recruited, and they are not the whole population. Achieved 0.31–0.36.
      expect(summary.juvenileFraction).toBeGreaterThan(0.2);
      expect(summary.juvenileFraction).toBeLessThan(0.6);

      // Realised length spreads far wider than the ~0.06–0.10 trait CV the
      // pre-ontogeny world had, which is the whole point of the axis: the
      // predation size window finally has bodies on both sides of it. Achieved
      // 0.45–0.52.
      expect(summary.lengthCv).toBeGreaterThan(0.35);
      expect(summary.shortestCm).toBeLessThan(0.5 * summary.meanLengthCm);
      expect(summary.longestCm).toBeGreaterThan(1.5 * summary.meanLengthCm);
    }, 600_000);
  }
});
