/**
 * G3 — the aposematism cliff screen, in test form (LONG_SIM only).
 *
 * Three seeds, 45 generations, `enableAposematism` on at the authored defaults.
 * A cliff screen asks one question: does the axis leave a world standing? For
 * this axis there is a second, narrower one — does it leave the *existing*
 * ecology alone? Both new traits sit at ≈0 in the founding population by
 * construction, so an on-arm run at 45 generations should look like the off-arm
 * world plus a trace of toxin deaths, and the death mix is where a term that
 * secretly bites would show up.
 *
 * What is deliberately NOT asserted: that toxicity evolves. The axis is inert
 * until a lineage invents chemical defence and a local hue bin gets toxic enough
 * to earn avoidance, and whether 45 generations is long enough for that
 * bootstrap is G6's question, not this screen's. Asserting it here would either
 * pass by luck or fail for the wrong reason.
 *
 * Thresholds sit just under achieved behaviour (CLAUDE.md: a probe that has
 * never failed is not testing anything). The per-seed summary is printed because
 * the numbers, not the pass, are what the tuning campaign reads.
 *
 * Stepped in short chunks with a macrotask between them, for the reason
 * `ontogeny-cliff.test.ts` documents: one long synchronous block starves
 * vitest's worker RPC and the run exits 1 with "3 passed, 1 error". The clock is
 * never read and nothing here feeds the sim; the await is purely a yield.
 */

import { describe, expect, it } from 'vitest';

import type { DeathCause, SimConfigOverrides } from '../contracts/types';
import { DEATH_CAUSES, resolveSimConfig } from '../contracts/types';
import { TRAIT_INDEX } from '../contracts/traits';
import { buildModules } from '../probes/harness';
import { createSim } from './engine';
import type { SimHandleInternal } from './engine';
import { traitAt } from './organisms';

const SEEDS = ['s1', 's2', 's3'] as const;
const GENERATIONS = 45;

/** Ticks per synchronous chunk; ~1 s of work, well inside the RPC timeout. */
const CHUNK_TICKS = 300;

/**
 * The channels the ecology is supposed to run on. `catastrophe` is excluded
 * because it is exogenous — a meteor is authored, not selected for — which is
 * the same split P7 makes.
 */
const ENDOGENOUS: readonly DeathCause[] = DEATH_CAUSES.filter((cause) => cause !== 'catastrophe');

function yieldToReporter(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Authored defaults with the axis on; the point is the defaults, not a rig. */
const OVERRIDES: SimConfigOverrides = { toggles: { enableAposematism: true } };

interface SignalSummary {
  readonly population: number;
  readonly meanToxicity: number;
  readonly maxToxicity: number;
  readonly meanConspicuousness: number;
}

function summarise(sim: SimHandleInternal): SignalSummary {
  const pools = sim.pools;
  let population = 0;
  let toxicity = 0;
  let maxToxicity = 0;
  let conspicuousness = 0;

  for (let slot = 0; slot < pools.capacity; slot += 1) {
    if ((pools.alive[slot] ?? 0) === 0) continue;
    population += 1;
    const load = traitAt(pools, slot, TRAIT_INDEX.toxicity);
    toxicity += load;
    if (load > maxToxicity) maxToxicity = load;
    conspicuousness += traitAt(pools, slot, TRAIT_INDEX.conspicuousness);
  }

  return {
    population,
    meanToxicity: population > 0 ? toxicity / population : 0,
    maxToxicity,
    meanConspicuousness: population > 0 ? conspicuousness / population : 0,
  };
}

describe.skipIf(process.env.LONG_SIM !== '1')('aposematism cliff screen (45 generations, 3 seeds)', () => {
  for (const seed of SEEDS) {
    it(`survives ${GENERATIONS} generations with a sane death mix on seed ${seed}`, async () => {
      const config = resolveSimConfig(OVERRIDES);
      const { modules } = buildModules(config);
      const sim = createSim({ seed, config: OVERRIDES, modules });

      // The axis has to start inert, or nothing downstream of it can be read as
      // an evolved outcome rather than an authored one. Measured before the
      // first tick, on the founders themselves.
      const founding = summarise(sim);
      expect(founding.population).toBeGreaterThan(0);

      // `state.deathCounts` is a per-sample window the recorder zeroes, so the
      // cumulative mix is tallied off the event stream instead.
      const deaths = new Map<DeathCause, number>(DEATH_CAUSES.map((cause) => [cause, 0]));
      let inventions = 0;

      const ticks = GENERATIONS * config.time.generationTicks;
      for (let done = 0; done < ticks; done += CHUNK_TICKS) {
        for (const event of sim.step(Math.min(CHUNK_TICKS, ticks - done))) {
          if (event.kind === 'death') deaths.set(event.cause, (deaths.get(event.cause) ?? 0) + 1);
          else if (event.kind === 'toxinInvention') inventions += 1;
        }
        await yieldToReporter();
      }

      const summary = summarise(sim);
      const total = [...deaths.values()].reduce((sum, count) => sum + count, 0);
      const share = (cause: DeathCause): number => (total > 0 ? (deaths.get(cause) ?? 0) / total : 0);

      console.log(
        `[aposematism cliff ${seed}] n=${summary.population} deaths=${total} ` +
          ENDOGENOUS.map((cause) => `${cause}=${share(cause).toFixed(3)}`).join(' ') +
          ` founding=[tox ${founding.meanToxicity.toFixed(4)}, con ${founding.meanConspicuousness.toFixed(4)}]` +
          ` toxicity=${summary.meanToxicity.toFixed(4)}` +
          ` maxToxicity=${summary.maxToxicity.toFixed(3)} conspicuousness=${summary.meanConspicuousness.toFixed(4)}` +
          ` inventions=${inventions} births=${sim.diagnostics.birthsApplied} dropped=${sim.diagnostics.birthsDropped}`,
      );

      // Survival, and by a margin: an axis that leaves 3 fish standing has not
      // left a world standing. Achieved 1362–1824 across these three seeds.
      expect(summary.population).toBeGreaterThan(1_000);
      // The slot cap is a memory bound, not an ecological one (P3).
      expect(sim.diagnostics.birthsDropped).toBe(0);

      // No channel may run away with the world — P7's rule, applied to the mix
      // this axis can move. Achieved 58k–78k deaths, max share 0.709
      // (predation); toxin itself carries 0.4–0.9%, which is a trace, not a
      // fifth mortality channel.
      expect(total).toBeGreaterThan(50_000);
      for (const cause of ENDOGENOUS) expect(share(cause)).toBeLessThan(0.8);

      // The axis is inert at founding: expressed toxicity starts at the softplus
      // floor of a zero baseline (≈0.104), lifted by the convexity of the link
      // over the founding variance — achieved 0.249–0.275, against 0.33–1.33 at
      // 45 generations. Conspicuousness is identity-linked and starts at 0 to
      // three digits (achieved |mean| ≤ 0.043).
      expect(founding.meanToxicity).toBeLessThan(0.3);
      expect(Math.abs(founding.meanConspicuousness)).toBeLessThan(0.1);
    }, 900_000);
  }
});
