/**
 * The bench's climate hold and wander controls (`setClimateVariability`,
 * `setToggle enableClimateWalk`).
 *
 * The claims that matter: a σ retune actually reaches `stepClimate` (the
 * config-swap path, not a cached reference), σ = 0 leaves nothing but the
 * deterministic decay toward the target, walk-off pins the offset *exactly*
 * at the target, garbage σ clamps to 0 rather than poisoning the walk with
 * NaN, and the retune survives a snapshot/restore because a restored world
 * must keep the climate it was told to have.
 */

import { describe, expect, it } from 'vitest';

import { resolveSimConfig } from '../contracts/types';
import { buildModules } from '../probes/harness';
import { createSim } from './engine';
import type { SimHandleInternal } from './engine';

function makeSim(seed: string): SimHandleInternal {
  const config = resolveSimConfig({});
  const { modules } = buildModules(config);
  return createSim({ seed, modules });
}

describe('setClimateVariability', () => {
  it('swaps σ into the live config and narrates the retune', () => {
    const sim = makeSim('cv-retune');
    const before = sim.state.config.thermal.climateSigmaC;
    sim.command({ kind: 'setClimateVariability', sigmaC: 0.5 });

    expect(sim.state.config.thermal.climateSigmaC).toBe(0.5);
    const event = sim.state.events.find((e) => e.kind === 'climateEvent' && e.cause === 'retune');
    expect(event).toMatchObject({ sigmaC: 0.5, deltaC: 0.5 - before });
  });

  it('clamps negative and non-finite σ to 0', () => {
    const sim = makeSim('cv-clamp');
    sim.command({ kind: 'setClimateVariability', sigmaC: -3 });
    expect(sim.state.config.thermal.climateSigmaC).toBe(0);
    sim.command({ kind: 'setClimateVariability', sigmaC: Number.NaN });
    expect(sim.state.config.thermal.climateSigmaC).toBe(0);
  });

  it('σ = 0 stills the wander: the offset decays toward the target with no noise', () => {
    const sim = makeSim('cv-still');
    // Let the default walk move the offset off its 0 start, so the decay
    // below has something to decay.
    sim.step(50);
    sim.command({ kind: 'setClimateVariability', sigmaC: 0 });

    const target = sim.state.climate.targetOffsetC;
    const start = sim.state.climate.meanOffsetC;
    const tau = sim.state.config.thermal.climateTauTicks;
    const ticks = 10;
    sim.step(ticks);
    const predicted = target + (start - target) * Math.exp(-ticks / tau);
    expect(sim.state.climate.meanOffsetC).toBeCloseTo(predicted, 12);
  });

  it('walk off pins the offset exactly at the target', () => {
    const sim = makeSim('cv-hold');
    sim.step(50);
    sim.command({ kind: 'setClimateTarget', targetOffsetC: 1.5 });
    sim.command({ kind: 'setToggle', toggle: 'enableClimateWalk', value: false });
    sim.step(3);
    expect(sim.state.climate.meanOffsetC).toBe(1.5);
    sim.step(7);
    expect(sim.state.climate.meanOffsetC).toBe(1.5);
  });

  it('survives a snapshot/restore round-trip', () => {
    const sim = makeSim('cv-restore');
    sim.command({ kind: 'setClimateVariability', sigmaC: 0.75 });
    sim.step(5);
    const snapshot = sim.snapshot();

    const { modules } = buildModules(resolveSimConfig({}));
    const restored = createSim({ seed: 'cv-restore', modules, snapshot });
    expect(restored.state.config.thermal.climateSigmaC).toBe(0.75);
  });
});
