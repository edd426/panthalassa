/**
 * P1 — determinism. A gate from day one.
 *
 * Two assertions, both on `stateHash()`:
 *
 * 1. Two sims built from the same `(config, seed)` agree at every hash
 *    checkpoint. This is the one that catches an ambient-entropy leak, an
 *    iteration over a `Set`, or an unsorted neighbour list.
 * 2. Snapshot at the midpoint, restore into a **fresh module set**, continue —
 *    and land on the same hashes as the run that was never interrupted. This is
 *    the one that catches state the snapshot forgot to carry, which is the
 *    failure mode Phase C's reload-continuity depends on not having.
 *
 * The restore uses fresh genetics and ecology instances on purpose. Both own
 * derived state — scratch buffers, the reef map, the kelp field, the morph grid
 * — that no snapshot carries, and the contract says they must rebuild it from
 * `SimState` alone. Restoring into the *same* module instances would leave that
 * derived state already warm and the probe would pass without testing anything.
 */

import { createSim } from '../../sim/engine';
import type { SimHandleInternal } from '../../sim/engine';
import { resolveSimConfig } from '../../contracts/types';
import type { ProbeReport } from '../../contracts/stats';
import { buildModules } from '../harness';
import type { ProbeDefinition } from '../probe';
import { makeReport } from '../probe';
import { DETERMINISM_SNAPSHOT_TICK, DETERMINISM_TICKS, scenarioByName } from '../scenarios';

interface HashPoint {
  readonly tick: number;
  readonly hash: string;
}

function freshSim(seed: string): SimHandleInternal {
  const scenario = scenarioByName('determinism');
  const config = resolveSimConfig(scenario.overrides);
  const { modules } = buildModules(config);
  return createSim({ seed, config: scenario.overrides, modules });
}

/** Step to `untilTick`, recording a hash every `interval` ticks. */
function runWithHashes(sim: SimHandleInternal, untilTick: number, interval: number): HashPoint[] {
  const points: HashPoint[] = [];
  while (sim.state.tick < untilTick) {
    const next = Math.min(untilTick, Math.floor(sim.state.tick / interval + 1) * interval);
    sim.step(next - sim.state.tick);
    points.push({ tick: sim.state.tick, hash: sim.stateHash() });
  }
  return points;
}

function countMismatches(left: readonly HashPoint[], right: readonly HashPoint[]): number {
  const byTick = new Map(right.map((point) => [point.tick, point.hash]));
  let mismatches = 0;
  for (const point of left) {
    const other = byTick.get(point.tick);
    if (other === undefined || other !== point.hash) mismatches += 1;
  }
  return mismatches;
}

export function snapshotCensusDetail(censusAtSnapshot: number): string {
  return `${censusAtSnapshot} organisms alive at the snapshot (the source handle remains at that tick)`;
}

export function evaluateDeterminism(seed: string): ProbeReport {
  const scenario = scenarioByName('determinism');
  const config = resolveSimConfig(scenario.overrides);
  const interval = Math.max(1, config.sampling.stateHashIntervalTicks);

  const reference = runWithHashes(freshSim(seed), DETERMINISM_TICKS, interval);
  const repeat = runWithHashes(freshSim(seed), DETERMINISM_TICKS, interval);
  const repeatMismatches = countMismatches(reference, repeat);

  // Fresh sim rather than reusing `reference`, which has already run past the
  // snapshot tick; a snapshot taken from a rewound handle would not be the
  // same object.
  const source = freshSim(seed);
  source.step(DETERMINISM_SNAPSHOT_TICK);
  const censusAtSnapshot = source.state.liveCount;
  const snapshot = source.snapshot();
  const snapshotHashMatches = snapshot.stateHash === source.stateHash();

  const { modules: restoredModules } = buildModules(config);
  const restored = createSim({ seed, config: scenario.overrides, modules: restoredModules, snapshot });
  const restoreHashMatches = restored.stateHash() === snapshot.stateHash;
  const continued = runWithHashes(restored, DETERMINISM_TICKS, interval);
  const afterSnapshot = reference.filter((point) => point.tick > DETERMINISM_SNAPSHOT_TICK);
  const restoreMismatches = countMismatches(afterSnapshot, continued);

  // A round-trip over an empty world proves nothing, so it counts against the
  // probe rather than for it. Without this, an ecology that dies before the
  // snapshot tick would turn P1 green.
  const vacuous = censusAtSnapshot === 0;

  const mismatches =
    repeatMismatches +
    restoreMismatches +
    (snapshotHashMatches ? 0 : 1) +
    (restoreHashMatches ? 0 : 1) +
    (vacuous ? 1 : 0);

  const detail = [
    `${reference.length} checkpoints every ${interval} ticks`,
    `repeat ${repeatMismatches === 0 ? 'identical' : `${repeatMismatches} MISMATCHED`}`,
    `restore@${DETERMINISM_SNAPSHOT_TICK} ${restoreMismatches === 0 ? 'identical' : `${restoreMismatches} MISMATCHED`} over ${afterSnapshot.length} checkpoints`,
    snapshotHashMatches ? 'snapshot hash agrees' : 'snapshot hash DISAGREES with live state',
    restoreHashMatches ? 'restored hash agrees' : 'restored hash DISAGREES with snapshot',
    vacuous
      ? `VACUOUS — the world was already empty at tick ${DETERMINISM_SNAPSHOT_TICK}, so the round-trip asserted nothing`
      : snapshotCensusDetail(censusAtSnapshot),
  ].join('; ');

  return makeReport({
    probeId: 'P1',
    name: 'Determinism',
    scenario: 'determinism',
    seed,
    severity: 'gate',
    value: mismatches,
    threshold: { max: 0, label: 'stateHash mismatches = 0' },
    generationsRun: DETERMINISM_TICKS / config.time.generationTicks,
    detail,
  });
}

export const determinismProbe: ProbeDefinition = {
  id: 'P1',
  name: 'Determinism',
  scenario: 'determinism',
  severity: 'gate',
  standalone: true,
  evaluate(_runs, context) {
    const seeds = [...new Set(context.runs.map((run) => run.seed))];
    return (seeds.length > 0 ? seeds : ['p1']).map(evaluateDeterminism);
  },
};
