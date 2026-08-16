import { describe, expect, it } from 'vitest';

import {
  ANTAGONISTIC_LOCI,
  AUTOSOME_IDS,
  CHROMOSOMES,
  CLADE_ARCHETYPES,
  CLADE_MACRO_TABLE,
  CLADE_SCHEMA,
  DISCRETE_EFFECTS,
  DISCRETE_LOCI,
  DISCRETE_LOCUS_COUNT,
  MAP_LENGTH_CM,
  PLEIOTROPY,
  QUANT_LOCI,
  QUANT_LOCUS_COUNT,
  SEX_LOCUS,
  W_BY_LOCUS,
  W_ROWS_BY_TRAIT,
  cladeArchetypeFor,
  createEmptyGenome,
  founderGeneticVariance,
} from './genome';
import { SIM_EVENT_KINDS } from './events';
import { SIM_MODULE_NAMES } from './apis';
import type { EcologyApi, GeneticsApi, MatingApi, SimModules, SpatialIndex, StatsApi } from './apis';
import { SAMPLE_SLICE, SAMPLE_SLICE_STRIDE } from './protocol';
import {
  CIRCULAR_TRAIT_KEYS,
  FOCAL_TRAIT_KEYS,
  TRAIT_COUNT,
  TRAIT_INDEX,
  TRAIT_KEYS,
  TRAIT_META,
  applyTraitLink,
  hueDelta,
  invertTraitLink,
} from './traits';
import { DEFAULT_SIM_CONFIG, DEATH_CAUSES, demeAt, demeCount, resolveSimConfig } from './types';

describe('locus table shape', () => {
  it('has 68 quantitative loci, 18 discrete loci and a sex locus (v1.7: A5/A6 appended)', () => {
    expect(QUANT_LOCI).toHaveLength(68);
    expect(QUANT_LOCUS_COUNT).toBe(68);
    expect(DISCRETE_LOCI).toHaveLength(18);
    expect(DISCRETE_LOCUS_COUNT).toBe(18);
    expect(SEX_LOCUS.chromosome).toBe('XY');
  });

  it('keeps the pre-G-wave layout frozen: indices 0..47 / 0..11 name the same loci as v1.6', () => {
    // Append-only is the layout contract (CLAUDE.md G0 conventions): these
    // spot pins fail if anyone interleaves or reorders instead of appending.
    expect(QUANT_LOCI[0]?.id).toBe('q01');
    expect(QUANT_LOCI[47]?.id).toBe('q48');
    expect(QUANT_LOCI[48]?.id).toBe('q49');
    expect(QUANT_LOCI[48]?.chromosome).toBe('A5');
    expect(DISCRETE_LOCI[11]?.id).toBe('neutralD');
    expect(DISCRETE_LOCI[12]?.chromosome).toBe('A5');
  });

  it('spreads the loci over the autosomes: 12q+3d on A1-A5, 8q+3d on A6', () => {
    for (const chromosome of AUTOSOME_IDS) {
      const quant = chromosome === 'A6' ? 8 : 12;
      expect(QUANT_LOCI.filter((locus) => locus.chromosome === chromosome)).toHaveLength(quant);
      expect(DISCRETE_LOCI.filter((locus) => locus.chromosome === chromosome)).toHaveLength(3);
      expect(CHROMOSOMES[chromosome].loci).toHaveLength(quant + 3);
    }
  });

  it('places every locus at a map position inside [0, 100] cM', () => {
    for (const locus of [...QUANT_LOCI, ...DISCRETE_LOCI]) {
      expect(locus.positionCm).toBeGreaterThanOrEqual(0);
      expect(locus.positionCm).toBeLessThanOrEqual(MAP_LENGTH_CM);
    }
  });

  it('gives every locus on a chromosome a distinct position, in ascending order', () => {
    for (const chromosome of AUTOSOME_IDS) {
      const positions = CHROMOSOMES[chromosome].loci.map((ref) => ref.positionCm);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(new Set(positions).size).toBe(positions.length);
    }
  });

  it('indexes loci contiguously from zero (the allele-array layout contract)', () => {
    expect(QUANT_LOCI.map((locus) => locus.index)).toEqual(QUANT_LOCI.map((_, index) => index));
    expect(DISCRETE_LOCI.map((locus) => locus.index)).toEqual(DISCRETE_LOCI.map((_, index) => index));
    expect(new Set(QUANT_LOCI.map((locus) => locus.id)).size).toBe(68);
    expect(new Set(DISCRETE_LOCI.map((locus) => locus.id)).size).toBe(18);
  });

  it('derives every mutation sigma from the founder sd, so founders and mutants share a scale', () => {
    for (const locus of QUANT_LOCI) {
      expect(locus.founderSd).toBeGreaterThan(0);
      expect(locus.mutSigma).toBeCloseTo(locus.founderSd * 0.75, 10);
    }
  });

  it('keeps the tightly linked hitchhiking blocks tight', () => {
    const gap = (a: string, b: string): number => {
      const first = QUANT_LOCI.find((locus) => locus.id === a)?.positionCm ?? 0;
      const second = QUANT_LOCI.find((locus) => locus.id === b)?.positionCm ?? 0;
      return Math.abs(second - first);
    };
    expect(gap('q07', 'q08')).toBeLessThanOrEqual(2);
    expect(gap('q29', 'q30')).toBeLessThanOrEqual(2);
  });
});

describe('discrete loci', () => {
  it('has 2 clade macros, 6 pigments, 2 preference modifiers, 6 neutral markers and the 2 strategy macros', () => {
    const byKind = (kind: string): number => DISCRETE_LOCI.filter((locus) => locus.kind === kind).length;
    expect(byKind('cladeMacro')).toBe(2);
    expect(byKind('pigment')).toBe(6);
    expect(byKind('preferenceModifier')).toBe(2);
    expect(byKind('neutralMarker')).toBe(6);
    expect(byKind('lifeHistoryMacro')).toBe(1);
    expect(byKind('toxinMacro')).toBe(1);
  });

  it('gives the strategy macros no effect at their ancestral allele (the mean-preserving rule)', () => {
    for (const id of ['lifeHistoryMacro', 'toxinMacro'] as const) {
      expect(DISCRETE_EFFECTS.some((effect) => effect.locus === id && effect.allele === 0)).toBe(false);
      expect(DISCRETE_EFFECTS.some((effect) => effect.locus === id)).toBe(true);
    }
  });

  it('gives neutral markers k = 8 alleles', () => {
    for (const locus of DISCRETE_LOCI.filter((entry) => entry.kind === 'neutralMarker')) {
      expect(locus.alleleCount).toBe(8);
    }
  });

  it('only ever references allele indices that exist', () => {
    for (const effect of DISCRETE_EFFECTS) {
      const locus = DISCRETE_LOCI.find((entry) => entry.id === effect.locus);
      expect(locus).toBeDefined();
      expect(effect.allele).toBeGreaterThanOrEqual(0);
      expect(effect.allele).toBeLessThan(locus?.alleleCount ?? 0);
    }
  });

  it('leaves neutral markers truly neutral — zero rows in every effect table', () => {
    const neutralIds = new Set(DISCRETE_LOCI.filter((locus) => locus.kind === 'neutralMarker').map((locus) => locus.id));
    expect(neutralIds.size).toBe(6);
    for (const effect of DISCRETE_EFFECTS) {
      expect(neutralIds.has(effect.locus)).toBe(false);
    }
    // And nothing in W can reach them either: W is indexed by quantitative locus.
    const quantIds = new Set<string>(QUANT_LOCI.map((locus) => locus.id));
    for (const entry of PLEIOTROPY) {
      expect(quantIds.has(entry.locus)).toBe(true);
      expect(neutralIds.has(entry.locus as never)).toBe(false);
    }
  });

  it('leaves clade macro-loci out of the trait effect table (they act through CLADE_SCHEMA)', () => {
    const macroIds = new Set(DISCRETE_LOCI.filter((locus) => locus.kind === 'cladeMacro').map((locus) => locus.id));
    for (const effect of DISCRETE_EFFECTS) {
      expect(macroIds.has(effect.locus)).toBe(false);
    }
  });
});

describe('pleiotropy matrix W', () => {
  it('loads every quantitative locus on 1 to 3 traits', () => {
    for (const locus of QUANT_LOCI) {
      const rows = W_BY_LOCUS[locus.id];
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.length).toBeLessThanOrEqual(3);
      expect(new Set(rows.map((row) => row.trait)).size).toBe(rows.length);
      for (const row of rows) expect(row.weight).not.toBe(0);
    }
  });

  it('leaves no trait without genetic input', () => {
    for (const trait of TRAIT_KEYS) {
      expect(W_ROWS_BY_TRAIT[trait].length).toBeGreaterThanOrEqual(2);
      expect(founderGeneticVariance(trait)).toBeGreaterThan(0);
    }
  });

  it('keeps the by-trait and by-locus views consistent', () => {
    const byTraitTotal = TRAIT_KEYS.reduce((sum, trait) => sum + W_ROWS_BY_TRAIT[trait].length, 0);
    const byLocusTotal = QUANT_LOCI.reduce((sum, locus) => sum + W_BY_LOCUS[locus.id].length, 0);
    expect(byTraitTotal).toBe(PLEIOTROPY.length);
    expect(byLocusTotal).toBe(PLEIOTROPY.length);
  });

  it('carries at least 4 antagonistic loci — opposed signs on two directional traits', () => {
    expect(ANTAGONISTIC_LOCI.length).toBeGreaterThanOrEqual(4);
    for (const id of ANTAGONISTIC_LOCI) {
      const directional = W_BY_LOCUS[id].filter((entry) => TRAIT_META[entry.trait].fitnessSense === 'directional');
      expect(directional.some((entry) => entry.weight > 0)).toBe(true);
      expect(directional.some((entry) => entry.weight < 0)).toBe(true);
    }
  });

  it('authors the named tradeoffs: armour vs speed, thermal breadth vs efficiency, attack vs defense', () => {
    const weight = (locus: string, trait: string): number =>
      PLEIOTROPY.find((entry) => entry.locus === locus && entry.trait === trait)?.weight ?? 0;

    expect(weight('q06', 'armorPlating')).toBeGreaterThan(0);
    expect(weight('q06', 'speedCap')).toBeLessThan(0);

    expect(weight('q15', 'tWidth')).toBeGreaterThan(0);
    expect(weight('q15', 'metabolicEff')).toBeLessThan(0);

    expect(weight('q29', 'attack')).toBeGreaterThan(0);
    expect(weight('q29', 'defense')).toBeLessThan(0);
  });

  it('couples diet to display and display to preference — the magic-trait route', () => {
    const q36 = W_BY_LOCUS.q36.map((entry) => entry.trait);
    expect(q36).toContain('diet');
    expect(q36).toContain('displayHue');
    const q38 = W_BY_LOCUS.q38.map((entry) => entry.trait);
    expect(q38).toContain('displayHue');
    expect(q38).toContain('prefTarget');
  });
});

describe('trait vocabulary', () => {
  it('indexes traits contiguously', () => {
    expect(TRAIT_KEYS).toHaveLength(TRAIT_COUNT);
    expect(new Set(TRAIT_KEYS).size).toBe(TRAIT_COUNT);
    expect(TRAIT_KEYS.map((key) => TRAIT_INDEX[key])).toEqual(TRAIT_KEYS.map((_, index) => index));
  });

  it('describes every trait with a unit and never with a bounded 0-10 scale', () => {
    for (const key of TRAIT_KEYS) {
      const meta = TRAIT_META[key];
      expect(meta.unit.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
      // No trait may have an upper link: ceilings must come from cost tradeoffs.
      expect(['identity', 'softplus', 'logistic', 'circular']).toContain(meta.link);
    }
  });

  it('names the four focal traits the probes are denominated in', () => {
    expect([...FOCAL_TRAIT_KEYS].sort()).toEqual(['defense', 'diet', 'size', 'tOpt']);
    expect([...CIRCULAR_TRAIT_KEYS].sort()).toEqual(['displayHue', 'prefTarget']);
  });

  it('keeps the softplus link strictly increasing and positive rather than clamping', () => {
    const previous = applyTraitLink('size', -20);
    expect(previous).toBeGreaterThan(0);
    let last = previous;
    for (let latent = -19; latent <= 40; latent += 1) {
      const value = applyTraitLink('size', latent);
      expect(value).toBeGreaterThan(last);
      last = value;
    }
    // Well above the knee it is indistinguishable from the identity.
    expect(applyTraitLink('size', 12)).toBeCloseTo(12, 5);
  });

  it('round-trips the invertible links', () => {
    for (const latent of [0.5, 3, 12, 40]) {
      expect(invertTraitLink('size', applyTraitLink('size', latent))).toBeCloseTo(latent, 4);
    }
    for (const latent of [-3, -0.5, 0, 0.5, 3]) {
      expect(invertTraitLink('diet', applyTraitLink('diet', latent))).toBeCloseTo(latent, 4);
    }
  });

  it('keeps diet strictly inside (0,1) across the reachable latent range', () => {
    // ±20 latent units is ~30 population SDs; the float64 logistic only
    // saturates past ~36, which selection cannot reach.
    let last = applyTraitLink('diet', -21);
    for (let latent = -20; latent <= 20; latent += 0.5) {
      const value = applyTraitLink('diet', latent);
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(1);
      expect(value).toBeGreaterThan(last);
      last = value;
    }
    expect(applyTraitLink('diet', 0)).toBeCloseTo(0.5, 12);
  });

  it('wraps circular traits and measures signed hue differences', () => {
    expect(applyTraitLink('displayHue', 370)).toBeCloseTo(10, 6);
    expect(applyTraitLink('displayHue', -10)).toBeCloseTo(350, 6);
    expect(hueDelta(10, 350)).toBeCloseTo(20, 6);
    expect(hueDelta(350, 10)).toBeCloseTo(-20, 6);
  });
});

describe('clade archetypes', () => {
  it('starts every founder as an undulator', () => {
    expect(cladeArchetypeFor(0, 0)).toBe('undulator');
  });

  it('reaches all three archetypes from the 4x4 macro table', () => {
    expect(CLADE_MACRO_TABLE).toHaveLength(4);
    for (const row of CLADE_MACRO_TABLE) expect(row).toHaveLength(4);
    const reachable = new Set(CLADE_MACRO_TABLE.flat());
    for (const archetype of CLADE_ARCHETYPES) expect(reachable.has(archetype)).toBe(true);
  });

  it('keeps a clade founding rare — most macro combinations stay ancestral', () => {
    const cells = CLADE_MACRO_TABLE.flat();
    expect(cells.filter((archetype) => archetype === 'undulator').length).toBeGreaterThan(cells.length / 2);
  });

  it('describes every archetype with morphology interpretations and render ranges', () => {
    for (const archetype of CLADE_ARCHETYPES) {
      const schema = CLADE_SCHEMA[archetype];
      expect(schema.archetype).toBe(archetype);
      for (const channel of [schema.segmentCount, schema.finPairs, schema.bodyAspect]) {
        expect(channel.interpretation.length).toBeGreaterThan(0);
        expect(channel.renderRange[0]).toBeLessThan(channel.renderRange[1]);
        expect(channel.typical).toBeGreaterThanOrEqual(channel.renderRange[0]);
        expect(channel.typical).toBeLessThanOrEqual(channel.renderRange[1]);
      }
    }
  });

  it('gives the ancestral clade no baseline shift and the derived clades a real bargain', () => {
    expect(Object.keys(CLADE_SCHEMA.undulator.traitBaselineShift)).toHaveLength(0);
    expect(CLADE_SCHEMA.radialDrifter.traitBaselineShift.speedCap ?? 0).toBeLessThan(0);
    expect(CLADE_SCHEMA.radialDrifter.traitBaselineShift.metabolicEff ?? 0).toBeGreaterThan(0);
    expect(CLADE_SCHEMA.armoredCrawler.traitBaselineShift.defense ?? 0).toBeGreaterThan(0);
    expect(CLADE_SCHEMA.armoredCrawler.traitBaselineShift.speedCap ?? 0).toBeLessThan(0);
  });
});

describe('genome layout', () => {
  it('allocates two haplotypes of every locus', () => {
    const genome = createEmptyGenome('XX');
    expect(genome.quant).toHaveLength(136);
    expect(genome.discrete).toHaveLength(36);
    expect(genome.karyotype).toBe('XX');
  });
});

describe('SimConfig', () => {
  it('matches the locked world and life-history decisions', () => {
    expect(DEFAULT_SIM_CONFIG.world.widthWu).toBe(2000);
    expect(DEFAULT_SIM_CONFIG.world.heightWu).toBe(1200);
    expect(DEFAULT_SIM_CONFIG.world.slotCapacity).toBe(4096);
    expect(DEFAULT_SIM_CONFIG.time.maturityTicks).toBe(600);
    expect(DEFAULT_SIM_CONFIG.time.generationTicks).toBe(900);
    expect(DEFAULT_SIM_CONFIG.time.maturityTicks).toBeLessThan(DEFAULT_SIM_CONFIG.time.generationTicks);
    expect(DEFAULT_SIM_CONFIG.genetics.crossoverLambda).toBe(1);
    expect(DEFAULT_SIM_CONFIG.metabolism.dietConvexity).toBeGreaterThan(1);
  });

  it('correlates the climate walk over tens of generations', () => {
    const generations = DEFAULT_SIM_CONFIG.thermal.climateTauTicks / DEFAULT_SIM_CONFIG.time.generationTicks;
    expect(generations).toBeGreaterThanOrEqual(20);
    expect(generations).toBeLessThanOrEqual(80);
  });

  it('enables every variance mechanism by default and lets each be switched off alone', () => {
    // v1.7: the G-wave biology toggles ship dark — off is their default until
    // the G2/G3 campaigns land and tune them. Everything else defaults on.
    const dark = new Set(['enableOntogeny', 'enableAposematism']);
    for (const [key, value] of Object.entries(DEFAULT_SIM_CONFIG.toggles)) {
      expect(value).toBe(!dark.has(key));
    }
    const off = resolveSimConfig({ toggles: { enableClimateWalk: false } });
    expect(off.toggles.enableClimateWalk).toBe(false);
    expect(off.toggles.enableMutation).toBe(true);
    expect(off.toggles.enableSpatialGxE).toBe(true);
    expect(off.toggles.enableFrequencyDependentPredation).toBe(true);
  });

  it('merges overrides group-wise and leaves untouched groups at their defaults', () => {
    const config = resolveSimConfig({ world: { initialPopulation: 42 } });
    expect(config.world.initialPopulation).toBe(42);
    expect(config.world.widthWu).toBe(2000);
    expect(config.thermal).toEqual(DEFAULT_SIM_CONFIG.thermal);
    // The defaults must not be mutated by a resolve.
    expect(DEFAULT_SIM_CONFIG.world.initialPopulation).toBe(600);
  });

  it('maps positions onto the deme grid', () => {
    expect(demeCount(DEFAULT_SIM_CONFIG)).toBe(12);
    expect(demeAt(0, 0, DEFAULT_SIM_CONFIG)).toBe(0);
    expect(demeAt(1999, 1199, DEFAULT_SIM_CONFIG)).toBe(11);
    expect(demeAt(-50, -50, DEFAULT_SIM_CONFIG)).toBe(0);
    expect(demeAt(5000, 5000, DEFAULT_SIM_CONFIG)).toBe(11);
  });
});

describe('measurement contracts', () => {
  it('names five endogenous mortality channels plus catastrophe', () => {
    // 'toxin' appended in v1.7.2 for G-B: a predator killed by eating a toxic
    // victim. Whether it joins P7's endogenous death-mix accounting is a G4
    // decision (src/probes/metrics.ts ENDOGENOUS_DEATH_CAUSES is its own list).
    expect([...DEATH_CAUSES].sort()).toEqual([
      'catastrophe',
      'predation',
      'senescence',
      'starvation',
      'temperature',
      'toxin',
    ]);
  });

  it('declares every event kind exactly once', () => {
    expect(new Set(SIM_EVENT_KINDS).size).toBe(SIM_EVENT_KINDS.length);
    expect(SIM_EVENT_KINDS).toContain('speciesSplit');
    expect(SIM_EVENT_KINDS).toContain('cladeFounding');
    expect(SIM_EVENT_KINDS).toContain('sweepCrossedHalf');
  });

  it('names every injectable module, and nothing else', () => {
    // The annotation is the real assertion: it stops compiling the moment
    // SIM_MODULE_NAMES and the keys of SimModules disagree.
    const names: readonly (keyof SimModules)[] = SIM_MODULE_NAMES;
    expect([...names].sort()).toEqual(['ecology', 'genetics', 'mating', 'spatial', 'stats']);
  });

  it('declares module interfaces the engine can be written against', () => {
    // Interfaces erase at runtime, so this is a compile-time check that each
    // API exists and is structurally satisfiable. A stub that typechecks here
    // is a stub WP-A3 can drive its engine tests with.
    const stub = {
      genetics: {} as GeneticsApi,
      ecology: {} as EcologyApi,
      spatial: {} as SpatialIndex,
      mating: {} as MatingApi,
      stats: {} as StatsApi,
    } satisfies SimModules;
    expect(Object.keys(stub).sort()).toEqual([...SIM_MODULE_NAMES].sort());
  });

  it('packs the render sample slice without overlapping fields', () => {
    const offsets = Object.values(SAMPLE_SLICE);
    expect(new Set(offsets).size).toBe(offsets.length);
    expect(offsets).toHaveLength(SAMPLE_SLICE_STRIDE);
    for (const offset of offsets) {
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(SAMPLE_SLICE_STRIDE);
    }
  });
});
