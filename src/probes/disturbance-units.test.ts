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

  it('makes mid-diet scavenging beat convex hunting while the high-end live channel stays richer', () => {
    const config = resolveSimConfig();
    const resource = 10;
    const mid = 0.5;
    const midCarrion = carrionIntake(1, dietEfficiencyCarrion(mid, config), resource, config);
    const midPrey = grazingIntake(
      config.resources.grazingMaxIntake,
      dietEfficiencyPrey(mid, config),
      resource,
      config,
    );
    const highCarrion = carrionIntake(1, dietEfficiencyCarrion(1, config), resource, config);
    const highPrey = grazingIntake(
      config.resources.grazingMaxIntake,
      dietEfficiencyPrey(1, config),
      resource,
      config,
    );
    expect(config.carrion.qScav).toBeLessThan(1);
    expect(midCarrion).toBeGreaterThan(midPrey);
    expect(highCarrion).toBeLessThan(highPrey);
  });
});

describe('disturbance continuity and scenario setup', () => {
  it('preserves the disturbances-off golden trajectory hash', () => {
    const overrides = {
      world: { widthWu: 240, heightWu: 160, initialPopulation: 24, slotCapacity: 48, fieldCellSizeWu: 20 },
      toggles: { enableDisturbances: false },
    };
    const sim = makeSim('disturbance-off-golden', overrides);
    sim.step(50);
    // Re-baselined 2026-08-10 (was 6922907c6421d7bf, the pre-D-wave value)
    // when the spatial grid moved to a tick-boundary rebuild for P1 restore
    // equivalence — a deliberate trajectory change. Any OTHER change to this
    // value means the disturbances-off arm is no longer inert.
    expect(sim.stateHash()).toBe('d60c12703108a788');
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
