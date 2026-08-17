/**
 * The bench's pure model. Everything under test here is DOM-free on purpose —
 * the vitest environment is node, and the parts of a god tool that can be wrong
 * in a way you would not notice on screen are the payloads, not the pixels: a
 * wall raised on the wrong axis, a permeability that never reached [0,1], a
 * clade button that founds undulators because the macro table moved under it.
 */

import { describe, expect, it } from 'vitest';
import type { CladeArchetype } from '../contracts/genome';
import { DISCRETE_LOCUS_BY_ID, cladeArchetypeFor } from '../contracts/genome';
import type { BarrierShape } from '../contracts/types';
import { resolveSimConfig } from '../contracts/types';
import type { ArmedState, BenchBarrier, BenchSettings, ShockPreset } from './godTools';
import {
  ANCESTRAL_MACRO_ALLELE,
  DISARMED,
  FOUNDING_EDITS,
  armedStatus,
  barrierShapeFromPoints,
  breedingCommand,
  clampToWorld,
  clampUnit,
  foundingEditFor,
  grouped,
  reduceArmed,
  reduceBarriers,
  retuneBarrierCommands,
  shockCommand,
  signedFixed,
} from './godTools';

const config = resolveSimConfig({});

const CRASH: ShockPreset = { label: '×0.20 · 20 gen', magnitude: 0.2, durationGenerations: 20 };
const STORM: ShockPreset = { label: '80% · 8 gen', magnitude: 0.8, durationGenerations: 8 };

function settings(overrides: Partial<BenchSettings> = {}): BenchSettings {
  return {
    barrierId: 'W1',
    permeability: 0,
    wallThicknessWu: 3 * config.world.fieldCellSizeWu,
    meteorRadiusWu: 200,
    generationTicks: config.time.generationTicks,
    planktonCrash: CRASH,
    planktonCrashRadiusWu: config.disturbance.planktonCrashRadiusWu,
    kelpStorm: STORM,
    kelpStormRadiusWu: config.disturbance.kelpStormSwathWidthWu,
    foundingCount: 12,
    ...overrides,
  };
}

const wall = (id: string, permeability: number, raisedTick: number): BenchBarrier => ({
  id,
  permeability,
  raisedTick,
  shape: { kind: 'verticalRidge', xWu: 1000, thicknessWu: 75 },
});

describe('barrierShapeFromPoints', () => {
  it('builds a vertical ridge when the two points are stacked, at their mid-x', () => {
    const shape = barrierShapeFromPoints({ x: 980, y: 100 }, { x: 1020, y: 1100 }, 75);
    expect(shape.kind).toBe('verticalRidge');
    if (shape.kind !== 'verticalRidge') throw new Error('unreachable');
    expect(shape.xWu).toBe(1000);
    // The minor-axis spread is the thickness once it clears the floor.
    expect(shape.thicknessWu).toBe(75);
  });

  it('builds a horizontal ridge when the two points are side by side', () => {
    const shape = barrierShapeFromPoints({ x: 100, y: 600 }, { x: 1900, y: 700 }, 75);
    expect(shape.kind).toBe('horizontalRidge');
    if (shape.kind !== 'horizontalRidge') throw new Error('unreachable');
    expect(shape.yWu).toBe(650);
    expect(shape.thicknessWu).toBe(100);
  });

  it('floors thickness so a near-double-click still resolves in the barrier mask', () => {
    const floor = 3 * config.world.fieldCellSizeWu;
    const shape = barrierShapeFromPoints({ x: 500, y: 300 }, { x: 501, y: 900 }, floor);
    if (shape.kind !== 'verticalRidge') throw new Error('expected a vertical ridge');
    expect(shape.thicknessWu).toBe(floor);
  });

  it('produces a value the frozen BarrierShape union accepts', () => {
    // Assignability is the contract check: a shape the union does not admit
    // fails to compile here rather than at the worker seam.
    const shape: BarrierShape = barrierShapeFromPoints({ x: 10, y: 20 }, { x: 30, y: 900 }, 75);
    expect(['verticalRidge', 'horizontalRidge', 'rect']).toContain(shape.kind);
    expect(Number.isFinite(shape.kind === 'rect' ? shape.widthWu : shape.thicknessWu)).toBe(true);
  });
});

describe('clamping', () => {
  it('holds permeability inside [0,1] and treats a non-number as sealed', () => {
    expect(clampUnit(-3)).toBe(0);
    expect(clampUnit(0.25)).toBe(0.25);
    expect(clampUnit(1.4)).toBe(1);
    expect(clampUnit(Number.NaN)).toBe(0);
  });

  it('clamps a click to the world rectangle', () => {
    const inside = clampToWorld({ x: 100, y: 200 }, 2000, 1200);
    expect(inside).toEqual({ x: 100, y: 200 });
    expect(clampToWorld({ x: -40, y: 5000 }, 2000, 1200)).toEqual({ x: 0, y: 1200 });
  });

  it('clamps permeability on the way into the raiseBarrier payload', () => {
    const armed: ArmedState = { mode: 'wall', firstPoint: { x: 900, y: 100 } };
    const result = reduceArmed(armed, { kind: 'click', point: { x: 900, y: 1100 } }, settings({ permeability: 2.5 }));
    expect(result.command?.kind).toBe('raiseBarrier');
    if (result.command?.kind !== 'raiseBarrier') throw new Error('unreachable');
    expect(result.command.permeability).toBe(1);
  });
});

describe('barrier ledger', () => {
  it('appends a raise, replaces a same-id raise, and drops on lower', () => {
    let ledger = reduceBarriers([], { kind: 'raised', id: 'W1', permeability: 0, raisedTick: 100, shape: wall('W1', 0, 100).shape });
    expect(ledger).toHaveLength(1);

    ledger = reduceBarriers(ledger, { kind: 'raised', id: 'W2', permeability: 0.5, raisedTick: 200, shape: wall('W2', 0.5, 200).shape });
    expect(ledger.map((barrier) => barrier.id)).toEqual(['W1', 'W2']);

    // The engine splices a same-id spec out before pushing the new one, so the
    // ledger must not grow a second row for a re-raise.
    ledger = reduceBarriers(ledger, { kind: 'raised', id: 'W1', permeability: 0.9, raisedTick: 300, shape: wall('W1', 0.9, 300).shape });
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({ id: 'W1', permeability: 0.9, raisedTick: 300 });

    ledger = reduceBarriers(ledger, { kind: 'lowered', id: 'W1' });
    expect(ledger.map((barrier) => barrier.id)).toEqual(['W2']);

    expect(reduceBarriers(ledger, { kind: 'cleared' })).toEqual([]);
  });

  it('clamps a permeability arriving from outside the bench', () => {
    const ledger = reduceBarriers([], {
      kind: 'raised',
      id: 'p8-ridge',
      permeability: 7,
      raisedTick: 45_000,
      shape: { kind: 'verticalRidge', xWu: 1000, thicknessWu: 75 },
    });
    expect(ledger[0]?.permeability).toBe(1);
  });

  it('lowering an unknown id is a no-op', () => {
    const ledger = [wall('W1', 0, 10)];
    expect(reduceBarriers(ledger, { kind: 'lowered', id: 'W9' })).toEqual(ledger);
  });
});

describe('clade founding', () => {
  it('derives a locus/allele pair that provably expresses each archetype', () => {
    for (const target of ['radialDrifter', 'armoredCrawler'] as const) {
      const edit = foundingEditFor(target);
      expect(edit).not.toBeNull();
      if (edit === null) throw new Error('unreachable');

      // `introduceMutant` edits one copy at one locus, and the highest allele is
      // dominant, so the pair is read against the ancestral allele at the other
      // macro-locus — which is what the whole population carries.
      const expressed: CladeArchetype =
        edit.locus === 'cladeMacroA'
          ? cladeArchetypeFor(edit.value, ANCESTRAL_MACRO_ALLELE)
          : cladeArchetypeFor(ANCESTRAL_MACRO_ALLELE, edit.value);
      expect(expressed).toBe(target);

      const locus = DISCRETE_LOCUS_BY_ID[edit.locus];
      expect(locus.kind).toBe('cladeMacro');
      // The engine rejects an allele index outside [0, alleleCount).
      expect(edit.value).toBeGreaterThanOrEqual(0);
      expect(edit.value).toBeLessThan(locus.alleleCount);
    }
  });

  it('the ancestral background really is undulator, so the pairs are read correctly', () => {
    expect(cladeArchetypeFor(ANCESTRAL_MACRO_ALLELE, ANCESTRAL_MACRO_ALLELE)).toBe('undulator');
  });

  it('the buttons carry those pairs into the introduceMutant payload', () => {
    const armed: ArmedState = { mode: 'foundRadialDrifter', firstPoint: null };
    const result = reduceArmed(armed, { kind: 'click', point: { x: 640, y: 480 } }, settings());
    expect(result.state).toEqual(DISARMED);
    if (result.command?.kind !== 'introduceMutant') throw new Error('expected an introduceMutant');
    expect(result.command).toMatchObject({
      count: 12,
      locus: FOUNDING_EDITS.radialDrifter?.locus,
      value: FOUNDING_EDITS.radialDrifter?.value,
      x: 640,
      y: 480,
    });
  });
});

describe('armed-mode reducer', () => {
  it('walks a wall from arm through two clicks to a payload, then disarms', () => {
    let state = DISARMED;
    let result = reduceArmed(state, { kind: 'arm', mode: 'wall' }, settings());
    state = result.state;
    expect(state.mode).toBe('wall');
    expect(result.command).toBeNull();
    expect(armedStatus(state)).toContain('click two points');

    result = reduceArmed(state, { kind: 'click', point: { x: 1000, y: 120 } }, settings());
    state = result.state;
    expect(result.command).toBeNull();
    expect(state.firstPoint).toEqual({ x: 1000, y: 120 });
    expect(armedStatus(state)).toContain('second point');

    result = reduceArmed(state, { kind: 'click', point: { x: 1040, y: 1080 } }, settings({ permeability: 0.25 }));
    expect(result.state).toEqual(DISARMED);
    expect(armedStatus(result.state)).toBe('');
    if (result.command?.kind !== 'raiseBarrier') throw new Error('expected a raiseBarrier');
    expect(result.command.barrierId).toBe('W1');
    expect(result.command.permeability).toBe(0.25);
    expect(result.command.shape).toEqual({ kind: 'verticalRidge', xWu: 1020, thicknessWu: 75 });
  });

  it('cancel drops a half-drawn wall without issuing anything', () => {
    const half: ArmedState = { mode: 'wall', firstPoint: { x: 500, y: 500 } };
    const result = reduceArmed(half, { kind: 'cancel' }, settings());
    expect(result.state).toEqual(DISARMED);
    expect(result.command).toBeNull();
  });

  it('ignores clicks while nothing is armed', () => {
    const result = reduceArmed(DISARMED, { kind: 'click', point: { x: 1, y: 2 } }, settings());
    expect(result.state).toEqual(DISARMED);
    expect(result.command).toBeNull();
  });

  it('arming a second mode replaces the first, first point and all', () => {
    const half: ArmedState = { mode: 'wall', firstPoint: { x: 500, y: 500 } };
    const result = reduceArmed(half, { kind: 'arm', mode: 'meteor' }, settings());
    expect(result.state).toEqual({ mode: 'meteor', firstPoint: null });
  });

  it('fires a meteor on one click at the clicked point', () => {
    const result = reduceArmed(
      { mode: 'meteor', firstPoint: null },
      { kind: 'click', point: { x: 700, y: 300 } },
      settings({ meteorRadiusWu: 350 }),
    );
    expect(result.state).toEqual(DISARMED);
    expect(result.command).toEqual({ kind: 'meteor', x: 700, y: 300, radiusWu: 350 });
  });

  it('places a regional crash and a kelp storm as discs', () => {
    const crash = reduceArmed(
      { mode: 'planktonCrash', firstPoint: null },
      { kind: 'click', point: { x: 400, y: 400 } },
      settings(),
    );
    if (crash.command?.kind !== 'triggerDisturbance') throw new Error('expected a disturbance');
    expect(crash.command.shock).toBe('planktonCrash');
    expect(crash.command.region).toEqual({
      kind: 'disc',
      xWu: 400,
      yWu: 400,
      radiusWu: config.disturbance.planktonCrashRadiusWu,
    });

    const storm = reduceArmed(
      { mode: 'kelpStorm', firstPoint: null },
      { kind: 'click', point: { x: 120, y: 90 } },
      settings(),
    );
    if (storm.command?.kind !== 'triggerDisturbance') throw new Error('expected a disturbance');
    // The engine throws on a region-less kelp storm, so this one is never null.
    expect(storm.command.region).not.toBeNull();
    expect(storm.command.magnitude).toBe(STORM.magnitude);
  });
});

describe('shockCommand', () => {
  it('converts an authored duration in generations to ticks', () => {
    const command = shockCommand('thermal', { label: '', magnitude: 4, durationGenerations: 15 }, 900, null);
    expect(command).toEqual({
      kind: 'triggerDisturbance',
      shock: 'thermal',
      magnitude: 4,
      durationTicks: 13_500,
      region: null,
    });
  });

  it('never authors a zero-tick disturbance', () => {
    const command = shockCommand('planktonCrash', { label: '', magnitude: 0.5, durationGenerations: 0 }, 900, null);
    if (command.kind !== 'triggerDisturbance') throw new Error('unreachable');
    expect(command.durationTicks).toBe(1);
  });
});

describe('feed formatting', () => {
  it('groups ticks the way the station log prints them', () => {
    expect(grouped(3120)).toBe('3,120');
    expect(grouped(0)).toBe('0');
    expect(grouped(999)).toBe('999');
    expect(grouped(1_234_567)).toBe('1,234,567');
    expect(grouped(-4200)).toBe('-4,200');
  });

  it('signs a climate offset', () => {
    expect(signedFixed(2, 1)).toBe('+2.0');
    expect(signedFixed(-0.25, 2)).toBe('-0.25');
  });
});

describe('retuneBarrierCommands', () => {
  it('re-raises every wall not already at the target, preserving id and shape', () => {
    const ledger = [wall('W1', 0, 100), wall('W2', 0.4, 250)];
    const commands = retuneBarrierCommands(ledger, 1);
    expect(commands).toEqual([
      { kind: 'raiseBarrier', barrierId: 'W1', shape: ledger[0]?.shape, permeability: 1 },
      { kind: 'raiseBarrier', barrierId: 'W2', shape: ledger[1]?.shape, permeability: 1 },
    ]);
  });

  it('skips walls already at the target and clamps the slider value', () => {
    const ledger = [wall('W1', 1, 100), wall('W2', 0.4, 250)];
    expect(retuneBarrierCommands(ledger, 1.7)).toEqual([
      { kind: 'raiseBarrier', barrierId: 'W2', shape: ledger[1]?.shape, permeability: 1 },
    ]);
    expect(retuneBarrierCommands([wall('W1', 0.25, 5)], 0.25)).toEqual([]);
    expect(retuneBarrierCommands([], 0.5)).toEqual([]);
  });
});

describe('breedingCommand', () => {
  it('drops off and zero-weight rows, clamps weights, keeps order', () => {
    const command = breedingCommand([
      { trait: 'size', weight: 1.5 },
      { trait: 'off', weight: 2 },
      { trait: 'speedCap', weight: 0 },
      { trait: 'armorPlating', weight: -9 },
    ]);
    expect(command).toEqual({
      kind: 'setArtificialSelection',
      terms: [
        { trait: 'size', weight: 1.5 },
        { trait: 'armorPlating', weight: -2 },
      ],
    });
  });

  it('all rows off builds the clearing command', () => {
    expect(breedingCommand([{ trait: 'off', weight: 1 }])).toEqual({
      kind: 'setArtificialSelection',
      terms: [],
    });
  });
});
