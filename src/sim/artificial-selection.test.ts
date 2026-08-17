/**
 * X3 — the bench breeding programme (`setArtificialSelection`).
 *
 * The command multiplies a male's mating-lottery ticket by
 * `exp(Σ wᵢ · latentᵢ)`. The claims that matter: an empty regime is *exactly*
 * inert (not merely small — the off path must multiply nothing), the on-path
 * factor is the formula against the male's latent traits, a violent slider
 * cannot push the lottery to Infinity, and the regime survives a
 * snapshot/restore round-trip because a restored world must keep breeding the
 * way it was told to.
 */

import { describe, expect, it } from 'vitest';

import { TRAIT_COUNT, TRAIT_INDEX, TRAIT_META } from '../contracts/traits';
import type { SlotIndex } from '../contracts/types';
import { SEX_FEMALE, SEX_MALE, resolveSimConfig } from '../contracts/types';
import { buildModules } from '../probes/harness';
import { createSim } from './engine';
import type { SimHandleInternal } from './engine';
import { createMating } from './mating';

function latentDeviation(sim: SimHandleInternal, slot: SlotIndex, trait: 'size' | 'speedCap'): number {
  return (sim.pools.traitsLatent[slot * TRAIT_COUNT + TRAIT_INDEX[trait]] ?? 0) - TRAIT_META[trait].baseline;
}

function makeSim(seed: string): SimHandleInternal {
  const config = resolveSimConfig({});
  const { modules } = buildModules(config);
  return createSim({ seed, modules });
}

function firstFemaleAndMale(sim: SimHandleInternal): [SlotIndex, SlotIndex] {
  let female = -1;
  let male = -1;
  for (let slot = 0; slot < sim.pools.capacity; slot += 1) {
    if ((sim.pools.alive[slot] ?? 0) !== 1) continue;
    const sex = sim.pools.sex[slot];
    if (sex === SEX_FEMALE && female < 0) female = slot;
    if (sex === SEX_MALE && male < 0) male = slot;
    if (female >= 0 && male >= 0) return [female, male];
  }
  throw new Error('founder pool is missing a sex');
}

describe('artificial selection: the bench outranks the lottery', () => {
  it('an empty regime is exactly inert', () => {
    const sim = makeSim('as-inert');
    const mating = createMating();
    const [female, male] = firstFemaleAndMale(sim);

    const plain = mating.acceptanceWeight(sim.state, female, male);
    sim.command({ kind: 'setArtificialSelection', terms: [] });
    expect(mating.acceptanceWeight(sim.state, female, male)).toBe(plain);
  });

  it('multiplies the ticket by exp(weight · latent) and clears back to plain', () => {
    const sim = makeSim('as-formula');
    const mating = createMating();
    const [female, male] = firstFemaleAndMale(sim);

    const plain = mating.acceptanceWeight(sim.state, female, male);
    const latentSize = latentDeviation(sim, male, 'size');

    sim.command({ kind: 'setArtificialSelection', terms: [{ trait: 'size', weight: 1.5 }] });
    const bred = mating.acceptanceWeight(sim.state, female, male);
    expect(bred / plain).toBeCloseTo(Math.exp(1.5 * latentSize), 10);

    // Two terms sum in the exponent.
    const latentSpeed = latentDeviation(sim, male, 'speedCap');
    sim.command({
      kind: 'setArtificialSelection',
      terms: [
        { trait: 'size', weight: 1.5 },
        { trait: 'speedCap', weight: -0.7 },
      ],
    });
    expect(mating.acceptanceWeight(sim.state, female, male) / plain).toBeCloseTo(
      Math.exp(1.5 * latentSize - 0.7 * latentSpeed),
      10,
    );

    sim.command({ kind: 'setArtificialSelection', terms: [] });
    expect(mating.acceptanceWeight(sim.state, female, male)).toBe(plain);
  });

  it('a violent weight cannot overflow the lottery', () => {
    const sim = makeSim('as-clamp');
    const mating = createMating();
    const [female, male] = firstFemaleAndMale(sim);

    const plain = mating.acceptanceWeight(sim.state, female, male);
    sim.command({ kind: 'setArtificialSelection', terms: [{ trait: 'size', weight: 1e9 }] });
    const weight = mating.acceptanceWeight(sim.state, female, male);
    expect(Number.isFinite(weight)).toBe(true);
    // The exponent clamp is ±10, so the multiplier saturates at e^10.
    expect(weight / plain).toBeCloseTo(Math.exp(10), 6);
  });

  it('survives a snapshot/restore round-trip, hash and all', () => {
    const sim = makeSim('as-restore');
    sim.step(50);
    sim.command({
      kind: 'setArtificialSelection',
      terms: [
        { trait: 'armorPlating', weight: 2 },
        { trait: 'size', weight: -1 },
      ],
    });
    sim.step(50);

    const snapshot = sim.snapshot();
    const config = resolveSimConfig({});
    const { modules } = buildModules(config);
    const restored = createSim({ seed: 'as-restore', modules, snapshot });

    expect(restored.state.artificialSelection.terms).toEqual([
      { trait: 'armorPlating', weight: 2 },
      { trait: 'size', weight: -1 },
    ]);
    expect(restored.stateHash()).toBe(sim.stateHash());

    // And the regime keeps steering the restored world identically.
    sim.step(100);
    restored.step(100);
    expect(restored.stateHash()).toBe(sim.stateHash());
  });
});
