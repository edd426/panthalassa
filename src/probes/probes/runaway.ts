/**
 * P20 (Fisherian runaway) — the reading taken off the S-wave arm.
 *
 * `warn`. What it **asserts** is the wiring: on the armed arm both S-wave
 * traits must carry live additive variance (A7 expressed, the estimator
 * seeing it) — the inverse of the dark-chromosome pin in
 * `genetics-units.test.ts`. What it **reports** is the biology: the genotypic
 * ornament–preference correlation against the authored q71 null (the same
 * analytic-null construction as P18), and detected runaway episodes —
 * sustained co-directional excursions of the ornament and preference means.
 * Episodes are reported rather than asserted because, per the P16/P19 ruling,
 * a signature this contingent needs a base-rate panel before any bar is
 * defensible; the detector existing *before* the tuning campaign is the
 * user's stated precondition for this axis (STATUS.md, 2026-08-17).
 */

import { founderGeneticVariance } from '../../contracts/genome';
import type { ProbeReport, SampleRow } from '../../contracts/stats';
import { TRAIT_COUNT, TRAIT_INDEX } from '../../contracts/traits';
import type { TraitKey } from '../../contracts/traits';
import type { RunResult } from '../harness';
import { lastGeneration, postBurnIn } from '../metrics';
import type { ProbeDefinition } from '../probe';
import { makeReport, notEvaluable, statusFor, worstStatus } from '../probe';
import { SEXUAL_SELECTION_SCENARIO } from '../scenarios';
import { authoredTraitCorrelation, couplingBar, gatesOf } from './aposematism';

// ---------------------------------------------------------------------------
// Episode detection
// ---------------------------------------------------------------------------

/**
 * Excursion floors, in analytic founder **genotypic** SD units of each trait
 * (`√founderGeneticVariance`, the same scale the null is built on — latent
 * means move on top of a ≈0-mean environmental deviation, so genotypic SD is
 * the honest yardstick). One full SD of ornament movement is far beyond drift
 * over a few hundred generations at these population sizes; the preference
 * floor is half that because the preference is dragged indirectly, through
 * the genetic correlation, and lags by construction.
 */
const ORNAMENT_EXCURSION_SD = 1.0;
const PREF_EXCURSION_SD = 0.5;

export interface RunawayEpisode {
  readonly startGeneration: number;
  readonly endGeneration: number;
  /** Signed ornament-mean movement over the episode, founder genotypic SDs. */
  readonly ornamentMoveSd: number;
  /** Signed preference-mean movement over the same interval, founder genotypic SDs. */
  readonly prefMoveSd: number;
}

interface Anchor {
  readonly generation: number;
  readonly ornament: number;
  readonly pref: number;
}

/**
 * Sustained co-directional excursions of the two means.
 *
 * A two-sided hysteresis walk: track the running ornament minimum and maximum
 * since the last event; when the current row sits {@link ORNAMENT_EXCURSION_SD}
 * above the tracked minimum (or below the maximum), and the preference mean
 * has moved the same direction by {@link PREF_EXCURSION_SD} from that same
 * anchor row, record an episode and restart both anchors here. An ornament
 * excursion the preference did not follow resets the anchors without
 * recording — escalation alone is directional selection, not runaway; the
 * *pair* moving is the Fisher signature.
 */
export function detectRunawayEpisodes(
  rows: readonly SampleRow[],
  ornamentSd: number,
  prefSd: number,
): readonly RunawayEpisode[] {
  const episodes: RunawayEpisode[] = [];
  if (ornamentSd <= 0 || prefSd <= 0) return episodes;

  let low: Anchor | null = null;
  let high: Anchor | null = null;

  for (const row of rows) {
    const ornament = row.traits.ornament.mean;
    const pref = row.traits.ornamentPref.mean;
    const here: Anchor = { generation: row.generation, ornament, pref };
    if (low === null || high === null) {
      low = here;
      high = here;
      continue;
    }
    if (ornament < low.ornament) low = here;
    if (ornament > high.ornament) high = here;

    const up = (ornament - low.ornament) / ornamentSd;
    const down = (high.ornament - ornament) / ornamentSd;
    const fired: Anchor | null = up >= ORNAMENT_EXCURSION_SD ? low : down >= ORNAMENT_EXCURSION_SD ? high : null;
    if (fired === null) continue;

    const ornamentMoveSd = (ornament - fired.ornament) / ornamentSd;
    const prefMoveSd = (pref - fired.pref) / prefSd;
    if (Math.sign(prefMoveSd) === Math.sign(ornamentMoveSd) && Math.abs(prefMoveSd) >= PREF_EXCURSION_SD) {
      episodes.push({
        startGeneration: fired.generation,
        endGeneration: row.generation,
        ornamentMoveSd,
        prefMoveSd,
      });
    }
    low = here;
    high = here;
  }

  return episodes;
}

// ---------------------------------------------------------------------------
// The measured correlation (P18's construction, generic over the trait pair)
// ---------------------------------------------------------------------------

export interface PairCorrelation {
  readonly r: number;
  readonly population: number;
}

/** Pearson r of two traits' **genotypic** values across the living pool. */
export function genotypicCorrelationFromPools(
  run: RunResult,
  first: TraitKey,
  second: TraitKey,
): PairCorrelation | null {
  const pop = run.sim.state.pop;
  const firstIndex = TRAIT_INDEX[first];
  const secondIndex = TRAIT_INDEX[second];
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let slot = 0; slot < pop.capacity; slot += 1) {
    if (pop.alive[slot] !== 1) continue;
    const base = slot * TRAIT_COUNT;
    const x = pop.traitsGenotypic[base + firstIndex] ?? 0;
    const y = pop.traitsGenotypic[base + secondIndex] ?? 0;
    n += 1;
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  if (n < 2) return null;
  const covariance = sxy / n - (sx / n) * (sy / n);
  const vx = sxx / n - (sx / n) ** 2;
  const vy = syy / n - (sy / n) ** 2;
  const denominator = Math.sqrt(Math.max(0, vx) * Math.max(0, vy));
  return { r: denominator > 0 ? covariance / denominator : Number.NaN, population: n };
}

// ---------------------------------------------------------------------------
// P20
// ---------------------------------------------------------------------------

/** Below this many living organisms nothing here is worth reading. */
const MIN_POPULATION = 50;

/**
 * The wiring floor: on the armed arm the recorder's V_A for each S-wave trait
 * must exceed this fraction of the analytic founder value. Not a biology
 * claim — selection may legitimately spend variance — but at 1% the assertion
 * only fails when A7 is dark on an arm that says it is armed, which is the
 * defect this exists to catch.
 */
const VA_FLOOR_FACTOR = 0.01;

function runawayReport(run: RunResult): ProbeReport {
  const gates = gatesOf(run.config);
  const scale = run.config.genetics.founderSdScale;
  const authored = authoredTraitCorrelation('ornament', 'ornamentPref', scale, gates);
  const ornamentVg = founderGeneticVariance('ornament', scale, gates);
  const prefVg = founderGeneticVariance('ornamentPref', scale, gates);

  const shared = {
    probeId: 'P20',
    name: 'Fisherian runaway',
    scenario: run.scenario,
    seed: run.seed,
    severity: 'warn' as const,
    generationsRun: run.generationsRun,
  };
  const threshold = {
    min: VA_FLOOR_FACTOR,
    label: `V_A(ornament) and V_A(ornamentPref) ≥ ${VA_FLOOR_FACTOR} of the analytic founder value (wiring); correlation vs the authored q71 null ${authored.toFixed(3)} and runaway episodes reported, not asserted (no base-rate panel yet)`,
  };

  const rows = postBurnIn(run);
  const final = rows[rows.length - 1];
  if (final === undefined || final.population < MIN_POPULATION) {
    return notEvaluable({
      ...shared,
      threshold,
      detail: `${final?.population ?? 0} living organisms at generation ${lastGeneration(run).toFixed(1)}; below the ${MIN_POPULATION} the reading needs`,
    });
  }

  const vaOrnament = final.traits.ornament.additiveVariance;
  const vaPref = final.traits.ornamentPref.additiveVariance;
  const measured = genotypicCorrelationFromPools(run, 'ornament', 'ornamentPref');
  const bar = measured === null ? Number.NaN : couplingBar(authored, measured.population);
  const episodes = detectRunawayEpisodes(rows, Math.sqrt(ornamentVg), Math.sqrt(prefVg));

  const detail = [
    `V_A ornament ${vaOrnament.toFixed(4)} / pref ${vaPref.toFixed(4)} (founder analytic ${ornamentVg.toFixed(4)} / ${prefVg.toFixed(4)})`,
    measured === null
      ? 'correlation unmeasurable'
      : `genotypic r(ornament, pref) ${measured.r.toFixed(3)} vs authored q71 null ${authored.toFixed(3)} (bar ${bar.toFixed(3)} at n=${measured.population})`,
    episodes.length === 0
      ? 'no runaway episode (reported, not asserted)'
      : `runaway episodes: ${episodes
          .map(
            (episode) =>
              `gen ${episode.startGeneration.toFixed(0)}→${episode.endGeneration.toFixed(0)} (ornament ${episode.ornamentMoveSd.toFixed(1)} SD, pref ${episode.prefMoveSd.toFixed(1)} SD)`,
          )
          .join(', ')}`,
    `mean latent ornament ${final.traits.ornament.mean.toFixed(3)} / pref ${final.traits.ornamentPref.mean.toFixed(3)} at generation ${final.generation.toFixed(1)}`,
  ].join('; ');

  return makeReport({
    ...shared,
    value: measured?.r ?? Number.NaN,
    threshold,
    status: worstStatus([
      statusFor(ornamentVg > 0 ? vaOrnament / ornamentVg : 0, { min: VA_FLOOR_FACTOR, label: '' }, 'warn'),
      statusFor(prefVg > 0 ? vaPref / prefVg : 0, { min: VA_FLOOR_FACTOR, label: '' }, 'warn'),
    ]),
    detail,
    series: {
      ornamentMean: rows.map((row) => row.traits.ornament.mean),
      prefMean: rows.map((row) => row.traits.ornamentPref.mean),
    },
  });
}

export const runawayProbe: ProbeDefinition = {
  id: 'P20',
  name: 'Fisherian runaway',
  scenario: SEXUAL_SELECTION_SCENARIO,
  severity: 'warn',
  evaluate: (runs) => runs.map(runawayReport),
  aggregate: {
    kind: 'k-of-n',
    minPassFraction: 1,
    label: 'the S-wave machinery is live (V_A on both traits) on every armed seed',
  },
};
