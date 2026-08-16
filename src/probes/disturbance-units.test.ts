import { describe, expect, it } from 'vitest';

import { carrionIntake, dietEfficiencyCarrion, dietEfficiencyPrey, grazingIntake } from '../contracts/formulas';
import { TRAIT_COUNT, TRAIT_INDEX } from '../contracts/traits';
import { resolveSimConfig } from '../contracts/types';
import { createSim } from '../sim/engine';
import { planktonProductivityMultiplierAt, thermalShockOffsetC, updateDisturbances } from '../sim/ecology/disturbances';
import { decayCarrion } from '../sim/ecology/resources';
import { buildModules } from './harness';
import { scenarioByName } from './scenarios';

function makeSim(seed: string, overrides = {}) {
  const config = resolveSimConfig(overrides);
  const { modules } = buildModules(config);
  return createSim({ seed, config: overrides, modules });
}

const QUIET_DISTURBANCES = {
  disturbance: {
    thermalRatePerGeneration: 0,
    planktonCrashRatePerGeneration: 0,
    kelpStormRatePerGeneration: 0,
  },
} as const;

describe('disturbance scheduler', () => {
  it('fires at the configured per-generation Poisson rate within statistical tolerance', () => {
    const overrides = {
      world: { initialPopulation: 2, slotCapacity: 8 },
      disturbance: {
        thermalRatePerGeneration: 2,
        planktonCrashRatePerGeneration: 0,
        kelpStormRatePerGeneration: 0,
        thermalDurationMinGenerations: 0.01,
        thermalDurationMaxGenerations: 0.01,
      },
    };
    const sim = makeSim('scheduler-rate', overrides);
    const generations = 100;
    const ticks = generations * sim.state.config.time.generationTicks;
    for (let tick = 1; tick <= ticks; tick += 1) {
      sim.state.tick = tick;
      updateDisturbances(sim.state);
    }
    const count = sim.state.events.filter((event) => event.kind === 'thermalShock').length;
    const expected = generations * 2;
    expect(count).toBeGreaterThan(expected * 0.75);
    expect(count).toBeLessThan(expected * 1.25);
  });

  it('decays a thermal jump to zero over its active clock', () => {
    const sim = makeSim('thermal-decay', QUIET_DISTURBANCES);
    sim.state.disturbance.thermal.push({
      kind: 'thermal', startedTick: 0, magnitudeC: 4, durationTicks: 100, remainingTicks: 100,
    });
    expect(thermalShockOffsetC(sim.state)).toBe(4);
    for (let tick = 1; tick <= 50; tick += 1) {
      sim.state.tick = tick;
      updateDisturbances(sim.state);
    }
    expect(thermalShockOffsetC(sim.state)).toBeGreaterThan(0);
    expect(thermalShockOffsetC(sim.state)).toBeLessThan(1);
    for (let tick = 51; tick <= 100; tick += 1) {
      sim.state.tick = tick;
      updateDisturbances(sim.state);
    }
    expect(thermalShockOffsetC(sim.state)).toBe(0);
  });

  it('applies a regional plankton crash inside its disc and not outside', () => {
    const sim = makeSim('regional-crash', QUIET_DISTURBANCES);
    sim.state.disturbance.planktonCrashes.push({
      kind: 'planktonCrash',
      startedTick: 0,
      productivityMultiplier: 0.25,
      durationTicks: 900,
      remainingTicks: 900,
      region: { kind: 'disc', xWu: 500, yWu: 500, radiusWu: 100 },
    });
    expect(planktonProductivityMultiplierAt(sim.state, 500, 500)).toBe(0.25);
    expect(planktonProductivityMultiplierAt(sim.state, 900, 500)).toBe(1);
  });
});

describe('carrion field and scavenging', () => {
  it('deposits the configured fraction of death biomass and halves it on schedule', () => {
    const overrides = {
      ...QUIET_DISTURBANCES,
      world: { widthWu: 200, heightWu: 120, initialPopulation: 20, slotCapacity: 32, fieldCellSizeWu: 20 },
      carrion: { depositFraction: 0.3, decayHalfLifeGenerations: 1 },
    };
    const sim = makeSim('carrion-conservation', overrides);
    let biomass = 0;
    for (let slot = 0; slot < sim.state.pop.capacity; slot += 1) {
      if (sim.state.pop.alive[slot] !== 1) continue;
      biomass += sim.state.pop.traits[slot * TRAIT_COUNT + TRAIT_INDEX.size] ?? 0;
    }
    sim.command({ kind: 'meteor', x: 100, y: 60, radiusWu: 1_000 });
    const deposited = sim.state.field.carrion.reduce((sum, value) => sum + value, 0);
    expect(deposited).toBeCloseTo(biomass * 0.3, 4);
    decayCarrion(sim.state, sim.state.config.time.generationTicks);
    const decayed = sim.state.field.carrion.reduce((sum, value) => sum + value, 0);
    expect(decayed).toBeCloseTo(deposited / 2, 4);
  });

  it('makes scavenging a famine bridge, not a destination: mid-diet carrion wins only at scarcity', () => {
    // Re-scoped with the maxIntake 0.7 → 0.5 lever (task #18). At 0.7 mid-diet
    // scavenging beat hunting even at abundance, which is exactly the D5
    // pathology: the on-ramp functioned as a terminal strategy and carrying
    // capacity blew past the P3 band. At 0.5 the crossover moves to scarcity —
    // carrion pays the intermediate-diet step only when live channels are
    // starved (post-crash, the re-evolvability window), and the live channel
    // is richer everywhere at abundance.
    const config = resolveSimConfig();
    const mid = 0.5;
    const intakeAt = (diet: number, resource: number): { carrion: number; prey: number } => ({
      carrion: carrionIntake(1, dietEfficiencyCarrion(diet, config), resource, config),
      prey: grazingIntake(config.resources.grazingMaxIntake, dietEfficiencyPrey(diet, config), resource, config),
    });
    expect(config.carrion.qScav).toBeLessThan(1);
    const scarceMid = intakeAt(mid, 1);
    expect(scarceMid.carrion).toBeGreaterThan(scarceMid.prey);
    const richMid = intakeAt(mid, 10);
    expect(richMid.carrion).toBeLessThan(richMid.prey);
    const richHigh = intakeAt(1, 10);
    expect(richHigh.carrion).toBeLessThan(richHigh.prey);
  });
});

describe('disturbance continuity and scenario setup', () => {
  it('preserves the disturbances-off golden trajectory hash', () => {
    const overrides = {
      world: { widthWu: 240, heightWu: 160, initialPopulation: 24, slotCapacity: 48, fieldCellSizeWu: 20 },
      // enableCarrion off too since the v1.7 split: this arm's meaning (no
      // shocks AND no recycling) predates the split and the hash pins it.
      toggles: { enableDisturbances: false, enableCarrion: false },
    };
    const sim = makeSim('disturbance-off-golden', overrides);
    sim.step(50);
    // Re-baselined twice on 2026-08-16, deliberately, in one wave:
    // - G0 (was d60c12703108a788): genome creation moved to per-chromosome/
    //   per-birth forked RNG streams — a real, one-time trajectory change.
    // - G1 (was 2937150f89939ef6): the v1.7 layout append (68 loci, 23 traits)
    //   grew the hashed arrays. NOT a trajectory change: the pre-G-wave
    //   content (positions, energies, ids, the first 18 traits) is verified
    //   byte-equal against G0 source in DESIGN.md "G1 — off-arm equivalence".
    // Prior re-baseline: 2026-08-10 (was 6922907c6421d7bf), tick-boundary
    // spatial rebuild. Any OTHER change here means the off arm is not inert.
    expect(sim.stateHash()).toBe('67c311b3a0e40aa6');
    expect(sim.state.field.carrion.reduce((sum, value) => sum + value, 0)).toBe(0);
    expect(sim.state.disturbance.thermal).toHaveLength(0);
  });

  it('round-trips carrion and active shocks through a snapshot', () => {
    const sim = makeSim('active-shock-snapshot', QUIET_DISTURBANCES);
    sim.command({ kind: 'triggerDisturbance', shock: 'thermal', magnitude: -3, durationTicks: 500 });
    sim.command({
      kind: 'triggerDisturbance',
      shock: 'planktonCrash',
      magnitude: 0.3,
      durationTicks: 700,
      region: { kind: 'disc', xWu: 200, yWu: 200, radiusWu: 100 },
    });
    sim.state.field.carrion[0] = 12.5;
    sim.step(3);
    const snapshot = sim.snapshot();
    const { modules } = buildModules(sim.state.config);
    const restored = createSim({ seed: sim.state.seed, config: QUIET_DISTURBANCES, modules, snapshot });
    expect(restored.stateHash()).toBe(snapshot.stateHash);
    expect(restored.state.disturbance.thermal).toEqual(sim.state.disturbance.thermal);
    expect(restored.state.field.carrion).toEqual(sim.state.field.carrion);
  });

  it('starts P16 with no expressed-diet predator guild', () => {
    const scenario = scenarioByName('re-evolvability');
    const config = resolveSimConfig(scenario.overrides);
    const { modules } = buildModules(config);
    const sim = createSim({ seed: 'p16-founders', config: scenario.overrides, modules });
    let predators = 0;
    for (let slot = 0; slot < sim.state.pop.capacity; slot += 1) {
      if (sim.state.pop.alive[slot] !== 1) continue;
      if ((sim.state.pop.traits[slot * TRAIT_COUNT + TRAIT_INDEX.diet] ?? 0) > 0.5) predators += 1;
    }
    expect(predators).toBe(0);
  });
});
