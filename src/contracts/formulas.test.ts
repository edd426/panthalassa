import { describe, expect, it } from 'vitest';

import {
  dietEfficiencyPlankton,
  dietEfficiencyPrey,
  grazingIntake,
  logistic,
  metabolicCostPerTick,
  predationKillProbability,
  senescenceHazard,
  softplusFloor,
  temperatureHazard,
  thermalPerformance,
} from './formulas';
import { DEFAULT_SIM_CONFIG as CONFIG, resolveSimConfig } from './types';

describe('metabolicCostPerTick', () => {
  it('increases in speed fraction', () => {
    let last = metabolicCostPerTick(12, 0, 0.6, 0, CONFIG);
    for (const speed of [0.2, 0.4, 0.6, 0.8, 1]) {
      const cost = metabolicCostPerTick(12, speed, 0.6, 0, CONFIG);
      expect(cost).toBeGreaterThan(last);
      last = cost;
    }
  });

  it('is quadratic in speed, so doubling speed more than doubles the extra bill', () => {
    const base = metabolicCostPerTick(12, 0, 0.6, 0, CONFIG);
    const half = metabolicCostPerTick(12, 0.5, 0.6, 0, CONFIG) - base;
    const full = metabolicCostPerTick(12, 1, 0.6, 0, CONFIG) - base;
    expect(full / half).toBeCloseTo(4, 6);
  });

  it('charges for absolute speed: same speed costs the same regardless of any cap, and wariness is billed', () => {
    // The Gate A-1 defect was fraction-of-cap pricing, which made a bigger
    // speedCap deliver more wu/tick for the same bill. Absolute pricing means
    // the bill depends only on realised speed.
    const atSpeed = (v: number) => metabolicCostPerTick(12, v, 0.6, 0, CONFIG) - metabolicCostPerTick(12, 0, 0.6, 0, CONFIG);
    expect(atSpeed(3.6)).toBeCloseTo(16 * atSpeed(0.9), 6);
    expect(metabolicCostPerTick(12, 1, 0.6, 80, CONFIG)).toBeGreaterThan(metabolicCostPerTick(12, 1, 0.6, 40, CONFIG));
  });

  it('increases in size and in armour', () => {
    expect(metabolicCostPerTick(20, 0.5, 0.6, 0, CONFIG)).toBeGreaterThan(metabolicCostPerTick(12, 0.5, 0.6, 0, CONFIG));
    expect(metabolicCostPerTick(12, 0.5, 2, 0, CONFIG)).toBeGreaterThan(metabolicCostPerTick(12, 0.5, 0.6, 0, CONFIG));
  });

  it('scales sublinearly with size (Kleiber-ish), so mass is not a pure penalty', () => {
    const small = metabolicCostPerTick(10, 0, 0, 0, CONFIG);
    const big = metabolicCostPerTick(20, 0, 0, 0, CONFIG);
    expect(big / small).toBeLessThan(2);
    expect(big / small).toBeCloseTo(Math.pow(2, 0.75), 6);
  });

  it('never returns a negative cost', () => {
    for (const armor of [0, 0.5, 5]) {
      for (const size of [0, 1, 40]) {
        expect(metabolicCostPerTick(size, 1, armor, -5, CONFIG)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('thermalPerformance', () => {
  it('peaks when the water matches tOpt', () => {
    const peak = thermalPerformance(18, 18, 6, CONFIG);
    expect(thermalPerformance(14, 18, 6, CONFIG)).toBeLessThan(peak);
    expect(thermalPerformance(22, 18, 6, CONFIG)).toBeLessThan(peak);
  });

  it('falls off symmetrically', () => {
    expect(thermalPerformance(13, 18, 6, CONFIG)).toBeCloseTo(thermalPerformance(23, 18, 6, CONFIG), 12);
  });

  it('taxes the generalist at its peak and rewards it away from the optimum', () => {
    const specialistPeak = thermalPerformance(18, 18, 3, CONFIG);
    const generalistPeak = thermalPerformance(18, 18, 12, CONFIG);
    expect(generalistPeak).toBeLessThan(specialistPeak);

    const specialistFar = thermalPerformance(28, 18, 3, CONFIG);
    const generalistFar = thermalPerformance(28, 18, 12, CONFIG);
    expect(generalistFar).toBeGreaterThan(specialistFar);
  });

  it('removes the tradeoff entirely when the tax exponent is zero', () => {
    const noTax = resolveSimConfig({ thermal: { generalistTaxExponent: 0 } });
    expect(thermalPerformance(18, 18, 3, noTax)).toBeCloseTo(thermalPerformance(18, 18, 12, noTax), 12);
  });

  it('stays finite at a degenerate width', () => {
    expect(Number.isFinite(thermalPerformance(18, 18, 0, CONFIG))).toBe(true);
  });
});

describe('diet efficiency', () => {
  it('is convex, so the generalist is worse at both jobs than a specialist is at one', () => {
    const specialist = dietEfficiencyPlankton(0, CONFIG) + dietEfficiencyPrey(0, CONFIG);
    const generalist = dietEfficiencyPlankton(0.5, CONFIG) + dietEfficiencyPrey(0.5, CONFIG);
    expect(generalist).toBeLessThan(specialist);
    // Disruptive selection: the midpoint is the worst place on the axis.
    for (const diet of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const total = dietEfficiencyPlankton(diet, CONFIG) + dietEfficiencyPrey(diet, CONFIG);
      expect(total).toBeLessThanOrEqual(specialist + 1e-12);
    }
    const midpoint = dietEfficiencyPlankton(0.5, CONFIG) + dietEfficiencyPrey(0.5, CONFIG);
    for (const diet of [0.1, 0.2, 0.8, 0.9]) {
      expect(dietEfficiencyPlankton(diet, CONFIG) + dietEfficiencyPrey(diet, CONFIG)).toBeGreaterThan(midpoint);
    }
  });

  it('goes flat when the convexity exponent is 1 — the mechanism switched off', () => {
    const linear = resolveSimConfig({ metabolism: { dietConvexity: 1 } });
    for (const diet of [0, 0.25, 0.5, 0.75, 1]) {
      expect(dietEfficiencyPlankton(diet, linear) + dietEfficiencyPrey(diet, linear)).toBeCloseTo(1, 12);
    }
  });

  it('moves in opposite directions as diet shifts', () => {
    expect(dietEfficiencyPrey(0.9, CONFIG)).toBeGreaterThan(dietEfficiencyPrey(0.1, CONFIG));
    expect(dietEfficiencyPlankton(0.9, CONFIG)).toBeLessThan(dietEfficiencyPlankton(0.1, CONFIG));
  });
});

describe('grazingIntake', () => {
  it('saturates: half the asymptote at the half-saturation biomass', () => {
    const half = CONFIG.resources.grazingHalfSaturation;
    expect(grazingIntake(1, 1, half, CONFIG)).toBeCloseTo(0.5, 12);
  });

  it('increases in resource but never exceeds the asymptote', () => {
    let last = grazingIntake(0.55, 1, 0, CONFIG);
    for (const resource of [1, 3, 10, 100, 10_000]) {
      const intake = grazingIntake(0.55, 1, resource, CONFIG);
      expect(intake).toBeGreaterThan(last);
      expect(intake).toBeLessThan(0.55);
      last = intake;
    }
    expect(grazingIntake(0.55, 1, 1e9, CONFIG)).toBeCloseTo(0.55, 6);
  });

  it('yields nothing from an empty cell', () => {
    expect(grazingIntake(0.55, 1, 0, CONFIG)).toBe(0);
  });

  it('scales with diet efficiency', () => {
    expect(grazingIntake(1, 0.25, 10, CONFIG)).toBeCloseTo(0.25 * grazingIntake(1, 1, 10, CONFIG), 12);
  });
});

describe('predationKillProbability', () => {
  const call = (overrides: Partial<Record<string, number>> = {}): number =>
    predationKillProbability(
      overrides.attack ?? 0,
      overrides.defense ?? 0,
      overrides.sizePredator ?? 20,
      overrides.sizeVictim ?? 11,
      overrides.speedPredator ?? 2,
      overrides.speedVictim ?? 2,
      overrides.cover ?? 0,
      overrides.patternMatchFreq ?? 1 / 12,
      CONFIG,
    );

  it('is a probability', () => {
    for (const attack of [-10, -1, 0, 1, 10]) {
      const p = call({ attack });
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
  });

  it('increases in attack minus defense', () => {
    let last = call({ attack: -3 });
    for (const attack of [-2, -1, 0, 1, 2, 3]) {
      const p = call({ attack });
      expect(p).toBeGreaterThan(last);
      last = p;
    }
    expect(call({ defense: 3 })).toBeLessThan(call({ defense: -3 }));
    // Only the difference matters.
    expect(call({ attack: 2, defense: 1 })).toBeCloseTo(call({ attack: 1, defense: 0 }), 12);
  });

  it('peaks at the size window and falls off either side', () => {
    const optimum = CONFIG.predation.sizeRatioOptimum;
    const peak = call({ sizeVictim: 20 * optimum });
    expect(call({ sizeVictim: 20 * optimum * 0.3 })).toBeLessThan(peak);
    expect(call({ sizeVictim: 20 * optimum * 2.5 })).toBeLessThan(peak);
  });

  it('rewards a faster predator and protects a faster victim', () => {
    expect(call({ speedPredator: 3 })).toBeGreaterThan(call({ speedPredator: 1 }));
    expect(call({ speedVictim: 3 })).toBeLessThan(call({ speedVictim: 1 }));
  });

  it('shelters prey under kelp cover', () => {
    expect(call({ cover: 1 })).toBeLessThan(call({ cover: 0 }));
  });

  it('eats the commonest morph more and protects the rare one', () => {
    const common = call({ patternMatchFreq: 0.8 });
    const neutral = call({ patternMatchFreq: 1 / 12 });
    const rare = call({ patternMatchFreq: 0.01 });
    expect(common).toBeGreaterThan(neutral);
    expect(rare).toBeLessThan(neutral);
  });

  it('is centred, so switching frequency dependence off does not also change mean predation', () => {
    // At the even-population frequency the term contributes exactly nothing,
    // which is what makes A7's toggle-off comparison attributable.
    const off = resolveSimConfig({ predation: { frequencyDependenceCoef: 0 } });
    const withMechanism = call({ patternMatchFreq: 1 / 12 });
    const withoutMechanism = predationKillProbability(0, 0, 20, 11, 2, 2, 0, 1 / 12, off);
    expect(withMechanism).toBeCloseTo(withoutMechanism, 12);
  });
});

describe('hazards', () => {
  it('leaves senescence flat before onset and exponential after', () => {
    const onset = CONFIG.senescence.onsetTicks;
    expect(senescenceHazard(0, CONFIG)).toBeCloseTo(CONFIG.senescence.gompertzA, 12);
    expect(senescenceHazard(onset, CONFIG)).toBeCloseTo(CONFIG.senescence.gompertzA, 12);
    let last = senescenceHazard(onset, CONFIG);
    for (const age of [onset + 300, onset + 900, onset + 1800, onset + 3600]) {
      const hazard = senescenceHazard(age, CONFIG);
      expect(hazard).toBeGreaterThan(last);
      last = hazard;
    }
  });

  it('charges nothing for temperature inside the tolerance window', () => {
    expect(temperatureHazard(18, 18, 6, CONFIG)).toBe(0);
    expect(temperatureHazard(23, 18, 6, CONFIG)).toBe(0);
    expect(temperatureHazard(12, 18, 6, CONFIG)).toBe(0);
  });

  it('charges quadratically outside it, symmetrically', () => {
    const near = temperatureHazard(26, 18, 6, CONFIG);
    const far = temperatureHazard(30, 18, 6, CONFIG);
    expect(near).toBeGreaterThan(0);
    expect(far / near).toBeCloseTo(9, 6);
    expect(temperatureHazard(10, 18, 6, CONFIG)).toBeCloseTo(temperatureHazard(26, 18, 6, CONFIG), 12);
  });

  it('lets a wider tolerance buy a smaller thermal hazard', () => {
    expect(temperatureHazard(28, 18, 12, CONFIG)).toBeLessThan(temperatureHazard(28, 18, 4, CONFIG));
  });
});

describe('numeric helpers', () => {
  it('keeps softplusFloor above the floor and strictly increasing across the reachable range', () => {
    let last = softplusFloor(-8, 1);
    expect(last).toBeGreaterThan(1);
    for (let value = -7.5; value <= 30; value += 0.5) {
      const result = softplusFloor(value, 1);
      expect(result).toBeGreaterThan(1);
      expect(result).toBeGreaterThan(last);
      last = result;
    }
    expect(softplusFloor(20, 1)).toBeCloseTo(20, 6);
  });

  it('never returns below the floor, even where float64 flattens onto it', () => {
    for (const value of [-1e6, -100, -20, 0, 20, 1e6]) {
      const result = softplusFloor(value, 1);
      expect(result).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(result)).toBe(true);
    }
  });

  it('computes a standard logistic', () => {
    expect(logistic(0)).toBeCloseTo(0.5, 12);
    expect(logistic(-40)).toBeGreaterThan(0);
    expect(logistic(40)).toBeLessThanOrEqual(1);
    expect(logistic(2) + logistic(-2)).toBeCloseTo(1, 12);
  });
});
