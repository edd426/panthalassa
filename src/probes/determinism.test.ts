/**
 * P1 and the engine's structural invariants (WP-A3's acceptance probe).
 *
 * The engine talks to genetics, ecology, the spatial index and stats only
 * through `apis.ts`, so it can be exercised end to end before any of those
 * packages exist. The stubs below are the injected implementations: deliberately
 * *not* trivial, because a stub that never births, kills or moves anything would
 * let the queue, pool and free-list machinery pass untested. They run a real
 * consumer–resource loop (logistic plankton, type-II grazing, metabolic burn,
 * starvation, a predation kernel and Gompertz senescence) with the real
 * `formulas.ts` maths, so the population churns through slots for the whole run.
 *
 * They are stubs in one sense only: the genetics is a simplified free-recombination
 * meiosis rather than A1's cM map, and the fields are coarse. Nothing here is
 * asserting anything about the *model* — that is A5's probe suite against the
 * real modules. What is asserted here is that the engine is a pure function of
 * (config, seed) and that births and deaths land only at stage boundaries.
 *
 * WP-A5 replaces `makeStubModules` with the real `SimModules`; the assertions
 * carry over unchanged.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import type {
  BehaviorDecision,
  DeathSink,
  EcologyApi,
  GeneticsApi,
  KillSink,
  MeiosisResult,
  PhenotypeContext,
  PhenotypeResult,
  PopgenEstimators,
  SimModules,
  SpatialIndex,
  SpeciesDetectionResult,
  StatsApi,
} from '../contracts/apis';
import type { SimEvent } from '../contracts/events';
import {
  grazingIntake,
  metabolicCostPerTick,
  predationKillProbability,
  senescenceHazard,
  temperatureHazard,
} from '../contracts/formulas';
import type { DiscreteLocusId, Genome, QuantLocusId } from '../contracts/genome';
import {
  CLADE_SCHEMA,
  DISCRETE_LOCI,
  DISCRETE_LOCUS_BY_ID,
  QUANT_LOCI,
  QUANT_LOCUS_BY_ID,
  QUANT_LOCUS_COUNT,
  DISCRETE_LOCUS_COUNT,
  W_ROWS_BY_TRAIT,
  expressedCladeArchetype,
  founderGeneticVariance,
} from '../contracts/genome';
import type { AncestryRecord, PhylogenyNode, SampleRow, TraitSample } from '../contracts/stats';
import type { TraitKey } from '../contracts/traits';
import { TRAIT_COUNT, TRAIT_INDEX, TRAIT_KEYS, TRAIT_META, applyTraitLink, hueDelta } from '../contracts/traits';
import type {
  DeathCause,
  OrganismId,
  RandomSource,
  SimConfig,
  SimConfigOverrides,
  SimState,
  SlotIndex,
} from '../contracts/types';
import {
  BEHAVIOR_FORAGE,
  BEHAVIOR_PURSUE,
  DEATH_CAUSES,
  NO_SLOT,
  demeAt,
  demeCount,
  resolveSimConfig,
} from '../contracts/types';
import { createSim } from '../sim/engine';
import type { SimHandleInternal } from '../sim/engine';
import { createMating } from '../sim/mating';
import type { EnginePools } from '../sim/organisms';

// ===========================================================================
// Stub: spatial index (WP-A2's seat)
// ===========================================================================

/** Uniform grid with a counting sort; neighbour lists come back in ascending slot order. */
class StubSpatial implements SpatialIndex {
  readonly maxQueryRadiusWu: number;

  private readonly cellSizeWu: number;
  private cols = 0;
  private rows = 0;
  private counts = new Int32Array(0);
  private starts = new Int32Array(1);
  private cursor = new Int32Array(0);
  private items = new Int32Array(0);
  private xs = new Float64Array(0);
  private ys = new Float64Array(0);
  private readonly gathered: number[] = [];

  constructor(cellSizeWu: number) {
    this.cellSizeWu = cellSizeWu;
    this.maxQueryRadiusWu = cellSizeWu * 8;
  }

  build(state: SimState): void {
    const pop = state.pop;
    const cols = Math.max(1, Math.ceil(state.config.world.widthWu / this.cellSizeWu));
    const rows = Math.max(1, Math.ceil(state.config.world.heightWu / this.cellSizeWu));
    if (cols !== this.cols || rows !== this.rows) {
      this.cols = cols;
      this.rows = rows;
      this.counts = new Int32Array(cols * rows);
      this.cursor = new Int32Array(cols * rows);
      this.starts = new Int32Array(cols * rows + 1);
    }
    if (this.items.length < pop.capacity) {
      this.items = new Int32Array(pop.capacity);
      this.xs = new Float64Array(pop.capacity);
      this.ys = new Float64Array(pop.capacity);
    }

    this.counts.fill(0);
    for (let slot = 0; slot < pop.capacity; slot += 1) {
      if ((pop.alive[slot] ?? 0) === 0) continue;
      const cell = this.cellOf(pop.x[slot] ?? 0, pop.y[slot] ?? 0);
      this.counts[cell] = (this.counts[cell] ?? 0) + 1;
    }

    let running = 0;
    for (let cell = 0; cell < this.counts.length; cell += 1) {
      this.starts[cell] = running;
      running += this.counts[cell] ?? 0;
    }
    this.starts[this.counts.length] = running;
    this.cursor.fill(0);

    for (let slot = 0; slot < pop.capacity; slot += 1) {
      if ((pop.alive[slot] ?? 0) === 0) continue;
      const x = pop.x[slot] ?? 0;
      const y = pop.y[slot] ?? 0;
      const cell = this.cellOf(x, y);
      const at = (this.starts[cell] ?? 0) + (this.cursor[cell] ?? 0);
      this.cursor[cell] = (this.cursor[cell] ?? 0) + 1;
      this.items[at] = slot;
      this.xs[at] = x;
      this.ys[at] = y;
    }
  }

  queryNeighbors(x: number, y: number, radiusWu: number, out: Int32Array): number {
    const gathered = this.gathered;
    gathered.length = 0;
    const radiusSq = radiusWu * radiusWu;

    const minCol = Math.max(0, Math.floor((x - radiusWu) / this.cellSizeWu));
    const maxCol = Math.min(this.cols - 1, Math.floor((x + radiusWu) / this.cellSizeWu));
    const minRow = Math.max(0, Math.floor((y - radiusWu) / this.cellSizeWu));
    const maxRow = Math.min(this.rows - 1, Math.floor((y + radiusWu) / this.cellSizeWu));

    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = minCol; col <= maxCol; col += 1) {
        const cell = row * this.cols + col;
        const end = this.starts[cell + 1] ?? 0;
        for (let at = this.starts[cell] ?? 0; at < end; at += 1) {
          const dx = (this.xs[at] ?? 0) - x;
          const dy = (this.ys[at] ?? 0) - y;
          if (dx * dx + dy * dy <= radiusSq) gathered.push(this.items[at] ?? NO_SLOT);
        }
      }
    }

    // Bucket order depends on insertion history, which is the classic
    // determinism leak; sorting is the contract.
    gathered.sort((a, b) => a - b);
    const written = Math.min(gathered.length, out.length);
    for (let index = 0; index < written; index += 1) out[index] = gathered[index] ?? NO_SLOT;
    return written;
  }

  private cellOf(x: number, y: number): number {
    const col = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSizeWu)));
    const row = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cellSizeWu)));
    return row * this.cols + col;
  }
}

// ===========================================================================
// Stub: genetics (WP-A1's seat)
// ===========================================================================

const T_SIZE = TRAIT_INDEX.size;
const T_DIET = TRAIT_INDEX.diet;
const T_ATTACK = TRAIT_INDEX.attack;
const T_DEFENSE = TRAIT_INDEX.defense;
const T_SPEED = TRAIT_INDEX.speedCap;
const T_TOPT = TRAIT_INDEX.tOpt;
const T_TWIDTH = TRAIT_INDEX.tWidth;
const T_HUE = TRAIT_INDEX.displayHue;
const T_METEFF = TRAIT_INDEX.metabolicEff;
const T_ARMOR = TRAIT_INDEX.armorPlating;

class StubGenetics implements GeneticsApi {
  /** Reused scratch, exactly as the contract permits — this is what makes the engine's copy-on-write discipline testable. */
  private readonly traits = new Float32Array(TRAIT_COUNT);
  private readonly latent = new Float32Array(TRAIT_COUNT);
  private readonly genotypic = new Float32Array(TRAIT_COUNT);
  private readonly mutationScratch: { locus: QuantLocusId | DiscreteLocusId; delta: number; fatTail: boolean }[] = [];
  private envSd: Float64Array | undefined;
  private gxeTraits: Set<TraitKey> | undefined;

  buildFounderGenome(rng: RandomSource, config: SimConfig, sex?: 'female' | 'male'): Genome {
    const quant = new Float32Array(QUANT_LOCUS_COUNT * 2);
    const scale = config.genetics.founderSdScale;
    for (let locus = 0; locus < QUANT_LOCUS_COUNT; locus += 1) {
      const sd = (QUANT_LOCI[locus]?.founderSd ?? 0) * scale;
      quant[locus] = rng.normal(0, sd);
      quant[QUANT_LOCUS_COUNT + locus] = rng.normal(0, sd);
    }
    const discrete = new Uint8Array(DISCRETE_LOCUS_COUNT * 2);
    for (let locus = 0; locus < DISCRETE_LOCUS_COUNT; locus += 1) {
      const spec = DISCRETE_LOCI[locus];
      if (spec === undefined) continue;
      // Clade macro-loci start ancestral so every founder is an undulator and a
      // new body plan has to be discovered rather than seeded.
      const draw = (): number => (spec.kind === 'cladeMacro' ? 0 : rng.int(0, spec.alleleCount - 1));
      discrete[locus] = draw();
      discrete[DISCRETE_LOCUS_COUNT + locus] = draw();
    }
    const karyotype = sex === undefined ? (rng.chance(0.5) ? 'XY' : 'XX') : sex === 'male' ? 'XY' : 'XX';
    return { quant, discrete, karyotype };
  }

  makeOffspringGenome(
    rng: RandomSource,
    mother: Genome,
    father: Genome,
    config: SimConfig,
  ): MeiosisResult {
    const quant = new Float32Array(QUANT_LOCUS_COUNT * 2);
    const discrete = new Uint8Array(DISCRETE_LOCUS_COUNT * 2);
    const genetics = config.genetics;
    const mutate = config.toggles.enableMutation;
    this.mutationScratch.length = 0;
    let macroMutated = false;

    for (let locus = 0; locus < QUANT_LOCUS_COUNT; locus += 1) {
      const spec = QUANT_LOCI[locus];
      const sigma = (spec?.mutSigma ?? 0) * genetics.mutationSigmaScale;
      for (const [parent, offset] of [
        [mother, 0],
        [father, QUANT_LOCUS_COUNT],
      ] as const) {
        const haplotype = rng.chance(0.5) ? 0 : QUANT_LOCUS_COUNT;
        let allele = parent.quant[haplotype + locus] ?? 0;
        if (mutate && rng.chance(genetics.quantMutationRate)) {
          const fatTail = rng.chance(genetics.mutationFatTailFraction);
          const delta = fatTail
            ? rng.laplace(0, sigma * genetics.mutationFatTailScaleRatio)
            : rng.normal(0, sigma);
          allele += delta;
          if (spec !== undefined) this.mutationScratch.push({ locus: spec.id, delta, fatTail });
        }
        quant[offset + locus] = allele;
      }
    }

    for (let locus = 0; locus < DISCRETE_LOCUS_COUNT; locus += 1) {
      const spec = DISCRETE_LOCI[locus];
      if (spec === undefined) continue;
      const rate = spec.kind === 'cladeMacro' ? genetics.cladeMacroMutationRate : genetics.discreteMutationRate;
      for (const [parent, offset] of [
        [mother, 0],
        [father, DISCRETE_LOCUS_COUNT],
      ] as const) {
        const haplotype = rng.chance(0.5) ? 0 : DISCRETE_LOCUS_COUNT;
        let allele = parent.discrete[haplotype + locus] ?? 0;
        if (mutate && rng.chance(rate)) {
          allele = rng.int(0, spec.alleleCount - 1);
          if (spec.kind === 'cladeMacro') macroMutated = true;
          this.mutationScratch.push({ locus: spec.id, delta: allele, fatTail: false });
        }
        discrete[offset + locus] = allele;
      }
    }

    // The father's gamete decides sex.
    const karyotype = rng.chance(0.5) ? 'XY' : 'XX';
    return { genome: { quant, discrete, karyotype }, mutations: this.mutationScratch, macroMutated };
  }

  computePhenotype(
    genome: Genome,
    rng: RandomSource,
    config: SimConfig,
    context: PhenotypeContext,
  ): PhenotypeResult {
    const archetype = expressedCladeArchetype(genome);
    const shift = CLADE_SCHEMA[archetype].traitBaselineShift;
    const envSd = this.environmentSd(config);
    this.gxeTraits ??= new Set<TraitKey>(config.genetics.gxeTraits);
    const gxe = this.gxeTraits;

    for (let index = 0; index < TRAIT_COUNT; index += 1) {
      const key = TRAIT_KEYS[index] as TraitKey;
      let genotypic = 0;
      for (const row of W_ROWS_BY_TRAIT[key]) {
        genotypic +=
          row.weight * ((genome.quant[row.locusIndex] ?? 0) + (genome.quant[QUANT_LOCUS_COUNT + row.locusIndex] ?? 0));
      }
      // Additive, matching the real module — never the multiplicative form
      // Gate A-1 rejected; a stub is still a place the defect could hide.
      const gxeShift = gxe.has(key) ? config.genetics.gxeSensitivity * context.localTemperatureAnomalyZ : 0;

      const baseline = config.genetics.traitBaselineOverrides[key] ?? TRAIT_META[key].baseline;
      const deviation = rng.normal(0, envSd[index] ?? 0);
      const latent = baseline + (shift[key] ?? 0) + genotypic + gxeShift + deviation;

      this.genotypic[index] = genotypic;
      this.latent[index] = latent;
      this.traits[index] = applyTraitLink(key, latent);
    }

    return { traits: this.traits, traitsLatent: this.latent, genotypicValues: this.genotypic, archetype };
  }

  applyAlleleEdit(
    genome: Genome,
    locus: QuantLocusId | DiscreteLocusId,
    value: number,
    config: SimConfig,
  ): Genome {
    const quant = genome.quant.slice();
    const discrete = genome.discrete.slice();
    const quantLocus = (QUANT_LOCUS_BY_ID as Partial<Record<string, { index: number }>>)[locus];
    const discreteLocus = (DISCRETE_LOCUS_BY_ID as Partial<Record<string, { index: number; alleleCount: number }>>)[
      locus
    ];

    if (quantLocus !== undefined) {
      // Homozygous edit: both copies move, so the injected effect is the full
      // `value` in trait units rather than half of it.
      quant[quantLocus.index] = (quant[quantLocus.index] ?? 0) + value;
      const paternal = QUANT_LOCUS_COUNT + quantLocus.index;
      quant[paternal] = (quant[paternal] ?? 0) + value;
    } else if (discreteLocus !== undefined) {
      const allele = Math.min(discreteLocus.alleleCount - 1, Math.max(0, Math.round(value)));
      discrete[discreteLocus.index] = allele;
      discrete[DISCRETE_LOCUS_COUNT + discreteLocus.index] = allele;
    } else {
      throw new Error(
        `Allele edit named unknown locus '${locus}'; this genome has ${QUANT_LOCUS_COUNT} quantitative and ` +
          `${DISCRETE_LOCUS_COUNT} discrete loci at mutation rate ${config.genetics.quantMutationRate}.`,
      );
    }
    return { quant, discrete, karyotype: genome.karyotype };
  }

  /** `envSd = sqrt(Vg·(1 − h²)/h²)`, so the founder heritability target stays honest when `founderSdScale` moves. */
  private environmentSd(config: SimConfig): Float64Array {
    if (this.envSd !== undefined) return this.envSd;
    const sd = new Float64Array(TRAIT_COUNT);
    const h2 = Math.min(0.999, Math.max(0.001, config.genetics.targetFounderHeritability));
    for (let index = 0; index < TRAIT_COUNT; index += 1) {
      const key = TRAIT_KEYS[index] as TraitKey;
      const vg = founderGeneticVariance(key, config.genetics.founderSdScale);
      sd[index] = Math.sqrt((vg * (1 - h2)) / h2) * config.genetics.environmentDeviationScale;
    }
    this.envSd = sd;
    return sd;
  }
}

// ===========================================================================
// Stub: ecology (WP-A2's seat)
// ===========================================================================

/** Per-tick plankton drifting into a cell as a fraction of its K; keeps a grazed-bare cell recoverable. */
const PLANKTON_RECRUITMENT = 0.0015;

interface EcologyOptions {
  /** No feeding, no predation, no hazards, no steering — for accounting tests that need a still world. */
  readonly quiet?: boolean;
  /** Called on every per-organism entry point, for the mid-stage-mutation probe. */
  readonly watch?: (state: SimState, stage: string) => void;
}

class StubEcology implements EcologyApi {
  private readonly options: EcologyOptions;
  private reefX: Float64Array = new Float64Array(0);
  private reefY: Float64Array = new Float64Array(0);
  private hueHistogram = new Float64Array(0);
  private demeTotals = new Float64Array(0);
  private readonly neighbors = new Int32Array(128);

  constructor(options: EcologyOptions = {}) {
    this.options = options;
  }

  initFields(state: SimState, rng: RandomSource): void {
    const config = state.config;
    const count = Math.max(1, config.resources.reefCount);
    this.reefX = new Float64Array(count);
    this.reefY = new Float64Array(count);
    for (let index = 0; index < count; index += 1) {
      this.reefX[index] = rng.next() * config.world.widthWu;
      this.reefY[index] = rng.next() * config.world.heightWu;
    }
    this.hueHistogram = new Float64Array(demeCount(config) * config.predation.hueBinCount);
    this.demeTotals = new Float64Array(demeCount(config));

    this.writeTemperature(state);
    this.writeCarryingCapacity(state);

    const field = state.field;
    for (let cell = 0; cell < field.plankton.length; cell += 1) {
      field.plankton[cell] = field.carryingCapacity[cell] ?? 0;
      field.kelp[cell] = Math.min(config.resources.kelpCoverMax, this.reefProximity(state, cell));
    }
  }

  updateFields(state: SimState, rng: RandomSource): void {
    const config = state.config;
    const climate = state.climate;
    climate.seasonPhaseTicks = (climate.seasonPhaseTicks + 1) % Math.max(1, config.thermal.seasonPeriodTicks);

    if (config.toggles.enableClimateWalk) {
      // Ornstein–Uhlenbeck: mean-reverting red noise, the standing variance pump.
      const tau = Math.max(1, config.thermal.climateTauTicks);
      const drift = (climate.targetOffsetC - climate.meanOffsetC) / tau;
      const diffusion = config.thermal.climateSigmaC * Math.sqrt(2 / tau) * rng.normal();
      climate.meanOffsetC += drift + diffusion;
    }

    this.writeTemperature(state);
    // K is derived from the climate every tick rather than cached across ticks.
    // `SimSnapshot` carries plankton and kelp but not `carryingCapacity`, so a
    // restored run only resumes bit-identically if K is a pure function of
    // state that the snapshot does carry.
    this.writeCarryingCapacity(state);
    this.buildHueHistogram(state);
  }

  regrowResources(state: SimState): void {
    const field = state.field;
    const rate = state.config.resources.planktonGrowthRate;
    const kelpRate = state.config.resources.kelpGrowthRate;
    const kelpMax = state.config.resources.kelpCoverMax;
    for (let cell = 0; cell < field.plankton.length; cell += 1) {
      const k = field.carryingCapacity[cell] ?? 0;
      const p = field.plankton[cell] ?? 0;
      // Logistic growth from exactly zero is exactly zero: a cell grazed bare
      // would never recover and the whole field would ratchet to dead. The
      // recruitment term is plankton drifting in from neighbouring water.
      field.plankton[cell] = k <= 0 ? 0 : Math.min(k, p + rate * p * (1 - p / k) + k * PLANKTON_RECRUITMENT);
      const target = Math.min(kelpMax, this.reefProximity(state, cell));
      field.kelp[cell] = (field.kelp[cell] ?? 0) + kelpRate * (target - (field.kelp[cell] ?? 0));
    }
  }

  decideBehavior(
    state: SimState,
    slot: SlotIndex,
    spatial: SpatialIndex,
    rng: RandomSource,
    out: BehaviorDecision,
  ): void {
    this.options.watch?.(state, 'decideBehavior');
    if (this.options.quiet === true) {
      out.mode = BEHAVIOR_FORAGE;
      out.steerX = 0;
      out.steerY = 0;
      out.speedFraction = 0;
      out.targetSlot = NO_SLOT;
      return;
    }

    const pop = state.pop;
    const x = pop.x[slot] ?? 0;
    const y = pop.y[slot] ?? 0;
    const angle = rng.next() * Math.PI * 2;

    // Predators steer at the lowest-numbered neighbour in range; everyone else
    // wanders. The neighbour scan is here so the spatial index is exercised in
    // the stage that reads the previous tick's build.
    let target = NO_SLOT;
    if ((pop.traits[slot * TRAIT_COUNT + T_DIET] ?? 0) > 0.5) {
      const found = spatial.queryNeighbors(x, y, state.config.behavior.neighborScanRadiusWu, this.neighbors);
      for (let index = 0; index < found; index += 1) {
        const candidate = this.neighbors[index] ?? NO_SLOT;
        if (candidate !== slot && (pop.alive[candidate] ?? 0) === 1) {
          target = candidate;
          break;
        }
      }
    }

    if (target !== NO_SLOT) {
      out.mode = BEHAVIOR_PURSUE;
      out.steerX = (pop.x[target] ?? 0) - x;
      out.steerY = (pop.y[target] ?? 0) - y;
      out.speedFraction = state.config.behavior.pursueSpeedMultiplier;
      out.targetSlot = target;
      return;
    }

    out.mode = BEHAVIOR_FORAGE;
    out.steerX = Math.cos(angle);
    out.steerY = Math.sin(angle);
    out.speedFraction = 0.3 + 0.5 * rng.next();
    out.targetSlot = NO_SLOT;
  }

  applyFeeding(state: SimState, slot: SlotIndex, rng: RandomSource): number {
    this.options.watch?.(state, 'applyFeeding');
    if (this.options.quiet === true) return 0;

    const pop = state.pop;
    const field = state.field;
    const config = state.config;
    const cell = this.cellOf(state, pop.x[slot] ?? 0, pop.y[slot] ?? 0);
    const available = field.plankton[cell] ?? 0;

    const diet = pop.traits[slot * TRAIT_COUNT + T_DIET] ?? 0;
    const bite = config.resources.grazingMaxIntake * (0.85 + 0.3 * rng.next());
    const efficiency = Math.pow(Math.max(0, 1 - diet), config.metabolism.dietConvexity);
    const intake = grazingIntake(bite, efficiency, available, config);

    field.plankton[cell] = Math.max(0, available - intake);
    return intake * Math.max(0, pop.traits[slot * TRAIT_COUNT + T_METEFF] ?? 0);
  }

  tryPredation(
    state: SimState,
    slot: SlotIndex,
    spatial: SpatialIndex,
    rng: RandomSource,
    kills: KillSink,
  ): void {
    this.options.watch?.(state, 'tryPredation');
    if (this.options.quiet === true) return;

    const pop = state.pop;
    const config = state.config;
    const base = slot * TRAIT_COUNT;
    const diet = pop.traits[base + T_DIET] ?? 0;
    if (diet <= 0.5) return;
    // `gutFill` is the satiation/handling clock. Without it a predator attempts
    // a kill every tick and the guild eats the world out in thirty ticks —
    // exactly the predator–prey crash the plan lists as risk 2.
    if ((pop.gutFill[slot] ?? 0) > 0) return;

    const x = pop.x[slot] ?? 0;
    const y = pop.y[slot] ?? 0;
    const found = spatial.queryNeighbors(x, y, config.predation.attemptRadiusWu, this.neighbors);
    for (let index = 0; index < found; index += 1) {
      const victim = this.neighbors[index] ?? NO_SLOT;
      if (victim === slot || (pop.alive[victim] ?? 0) === 0) continue;
      const victimBase = victim * TRAIT_COUNT;

      const probability = predationKillProbability(
        pop.traits[base + T_ATTACK] ?? 0,
        pop.traits[victimBase + T_DEFENSE] ?? 0,
        pop.traits[base + T_SIZE] ?? 1,
        pop.traits[victimBase + T_SIZE] ?? 1,
        pop.traits[base + T_SPEED] ?? 0,
        pop.traits[victimBase + T_SPEED] ?? 0,
        this.kelpCoverAt(state, pop.x[victim] ?? 0, pop.y[victim] ?? 0),
        this.hueMorphFrequencyAt(state, pop.x[victim] ?? 0, pop.y[victim] ?? 0, pop.traits[victimBase + T_HUE] ?? 0),
        config,
      );
      if (rng.chance(probability)) {
        kills.push(slot, victim, config.predation.energyPerPreySize * (pop.traits[victimBase + T_SIZE] ?? 0));
        pop.gutFill[slot] = config.predation.satiationTicks;
      } else {
        pop.gutFill[slot] = config.predation.handlingTicks;
      }
      // One attempt per attempt-window, successful or not.
      return;
    }
  }

  metabolismAndHazards(state: SimState, slot: SlotIndex, rng: RandomSource, deaths: DeathSink): void {
    this.options.watch?.(state, 'metabolismAndHazards');
    if (this.options.quiet === true) return;

    const pop = state.pop;
    const config = state.config;
    const base = slot * TRAIT_COUNT;
    const x = pop.x[slot] ?? 0;
    const y = pop.y[slot] ?? 0;
    const temperature = this.temperatureAt(state, x, y);

    // The realised absolute speed is recovered from the velocity the engine
    // integrated, which is what `OrganismPools` exposes — ecology never needs to
    // see the engine's private steering columns.
    const speedWuPerTick = Math.hypot(pop.vx[slot] ?? 0, pop.vy[slot] ?? 0);
    const burn = metabolicCostPerTick(
      pop.traits[base + T_SIZE] ?? 0,
      speedWuPerTick,
      pop.traits[base + T_ARMOR] ?? 0,
      0,
      config,
    );
    pop.gutFill[slot] = Math.max(0, (pop.gutFill[slot] ?? 0) - 1);
    const energy = (pop.energy[slot] ?? 0) - burn;
    pop.energy[slot] = energy;

    if (energy <= 0) {
      deaths.push(slot, 'starvation', NO_SLOT);
      return;
    }
    const thermal = temperatureHazard(temperature, pop.traits[base + T_TOPT] ?? 0, pop.traits[base + T_TWIDTH] ?? 0, config);
    if (rng.chance(thermal)) {
      deaths.push(slot, 'temperature', NO_SLOT);
      return;
    }
    if (rng.chance(senescenceHazard(pop.ageTicks[slot] ?? 0, config))) {
      deaths.push(slot, 'senescence', NO_SLOT);
    }
  }

  temperatureAt(state: SimState, x: number, y: number): number {
    return state.field.temperature[this.cellOf(state, x, y)] ?? 0;
  }

  temperatureAnomalyZAt(state: SimState, x: number, y: number): number {
    const thermal = state.config.thermal;
    const spread = Math.max(1e-3, Math.abs(thermal.northC - thermal.southC) / 4);
    const mean = (thermal.northC + thermal.southC) / 2;
    return (this.temperatureAt(state, x, y) - mean) / spread;
  }

  kelpCoverAt(state: SimState, x: number, y: number): number {
    return state.field.kelp[this.cellOf(state, x, y)] ?? 0;
  }

  hueMorphFrequencyAt(state: SimState, x: number, y: number, hueDeg: number): number {
    const bins = Math.max(1, state.config.predation.hueBinCount);
    if (!state.config.toggles.enableFrequencyDependentPredation) return 1 / bins;
    const deme = demeAt(x, y, state.config);
    const total = this.demeTotals[deme] ?? 0;
    if (total <= 0) return 1 / bins;
    const bin = Math.min(bins - 1, Math.max(0, Math.floor((((hueDeg % 360) + 360) % 360) / (360 / bins))));
    return (this.hueHistogram[deme * bins + bin] ?? 0) / total;
  }

  rebuildBarrierMask(state: SimState): void {
    const barriers = state.barriers;
    barriers.mask.fill(255);
    for (const spec of barriers.specs) {
      const value = Math.round(Math.min(1, Math.max(0, spec.permeability)) * 255);
      for (let row = 0; row < barriers.rows; row += 1) {
        for (let col = 0; col < barriers.cols; col += 1) {
          const cx = (col + 0.5) * barriers.cellSizeWu;
          const cy = (row + 0.5) * barriers.cellSizeWu;
          let inside = false;
          switch (spec.shape.kind) {
            case 'verticalRidge':
              inside = Math.abs(cx - spec.shape.xWu) <= spec.shape.thicknessWu / 2;
              break;
            case 'horizontalRidge':
              inside = Math.abs(cy - spec.shape.yWu) <= spec.shape.thicknessWu / 2;
              break;
            case 'rect':
              inside =
                cx >= spec.shape.xWu &&
                cx <= spec.shape.xWu + spec.shape.widthWu &&
                cy >= spec.shape.yWu &&
                cy <= spec.shape.yWu + spec.shape.heightWu;
              break;
          }
          if (inside) barriers.mask[row * barriers.cols + col] = value;
        }
      }
    }
  }

  // -- internals ------------------------------------------------------------

  private cellOf(state: SimState, x: number, y: number): number {
    const field = state.field;
    const col = Math.min(field.cols - 1, Math.max(0, Math.floor(x / field.cellSizeWu)));
    const row = Math.min(field.rows - 1, Math.max(0, Math.floor(y / field.cellSizeWu)));
    return row * field.cols + col;
  }

  private writeTemperature(state: SimState): void {
    const field = state.field;
    const thermal = state.config.thermal;
    const season = state.config.toggles.enableSeasonality
      ? thermal.seasonAmplitudeC *
        Math.sin((2 * Math.PI * state.climate.seasonPhaseTicks) / Math.max(1, thermal.seasonPeriodTicks))
      : 0;
    for (let row = 0; row < field.rows; row += 1) {
      const fraction = field.rows <= 1 ? 0 : row / (field.rows - 1);
      const latitudinal = thermal.northC + (thermal.southC - thermal.northC) * fraction;
      for (let col = 0; col < field.cols; col += 1) {
        field.temperature[row * field.cols + col] = latitudinal + season + state.climate.meanOffsetC;
      }
    }
  }

  private writeCarryingCapacity(state: SimState): void {
    const field = state.field;
    const resources = state.config.resources;
    for (let row = 0; row < field.rows; row += 1) {
      const fraction = field.rows <= 1 ? 0 : row / (field.rows - 1);
      const light = 1 - resources.lightGradientStrength * fraction;
      for (let col = 0; col < field.cols; col += 1) {
        const cell = row * field.cols + col;
        const mismatch = (field.temperature[cell] ?? 0) - resources.planktonOptimumC;
        const suitability = Math.exp(-(mismatch * mismatch) / (2 * resources.thermalSuitabilityWidthC ** 2));
        field.carryingCapacity[cell] = Math.max(
          0,
          resources.planktonCarryingCapacityBase * Math.max(0, light) * suitability,
        );
      }
    }
  }

  private buildHueHistogram(state: SimState): void {
    if (!state.config.toggles.enableFrequencyDependentPredation) return;
    const bins = Math.max(1, state.config.predation.hueBinCount);
    this.hueHistogram.fill(0);
    this.demeTotals.fill(0);
    const pop = state.pop;
    for (let slot = 0; slot < pop.capacity; slot += 1) {
      if ((pop.alive[slot] ?? 0) === 0) continue;
      const deme = pop.demeId[slot] ?? 0;
      const hue = pop.traits[slot * TRAIT_COUNT + T_HUE] ?? 0;
      const bin = Math.min(bins - 1, Math.max(0, Math.floor((((hue % 360) + 360) % 360) / (360 / bins))));
      this.hueHistogram[deme * bins + bin] = (this.hueHistogram[deme * bins + bin] ?? 0) + 1;
      this.demeTotals[deme] = (this.demeTotals[deme] ?? 0) + 1;
    }
  }

  private reefProximity(state: SimState, cell: number): number {
    const field = state.field;
    const col = cell % field.cols;
    const row = Math.floor(cell / field.cols);
    const x = (col + 0.5) * field.cellSizeWu;
    const y = (row + 0.5) * field.cellSizeWu;
    const radius = Math.max(1, state.config.resources.kelpReefRadiusWu);
    let best = 0;
    for (let index = 0; index < this.reefX.length; index += 1) {
      const distance = Math.hypot(x - (this.reefX[index] ?? 0), y - (this.reefY[index] ?? 0));
      best = Math.max(best, Math.max(0, 1 - distance / radius));
    }
    return best;
  }
}

// ===========================================================================
// Stub: stats (WP-A4's seat)
// ===========================================================================

interface StatsTrace {
  births: number;
  deaths: number;
  matings: number;
  events: number;
  /** Deaths by channel; the mortality mix is what tells a stub apart from a slaughterhouse. */
  readonly byCause: Record<DeathCause, number>;
  /** Only populated when `trackIds` is on; the id-monotonicity probe reads these. */
  readonly bornIds: number[];
  readonly diedIds: Set<OrganismId>;
  readonly bornIdSet: Set<OrganismId>;
}

function zeroTraitSample(): TraitSample {
  return { mean: 0, sd: 0, additiveVariance: 0, phenotypicVariance: 0, heritability: 0 };
}

class StubStats implements StatsApi {
  readonly estimators: PopgenEstimators;
  readonly trace: StatsTrace = {
    births: 0,
    deaths: 0,
    matings: 0,
    events: 0,
    byCause: { starvation: 0, predation: 0, temperature: 0, senescence: 0, catastrophe: 0 },
    bornIds: [],
    diedIds: new Set<OrganismId>(),
    bornIdSet: new Set<OrganismId>(),
  };

  lastMating: { motherId: OrganismId; fatherId: OrganismId; tick: number } | undefined;
  lastEventKind: SimEvent['kind'] | undefined;

  private readonly trackIds: boolean;
  private readonly rows: SampleRow[] = [];
  private readonly records = new Map<OrganismId, AncestryRecord>();
  private readonly sweeps: { locus: DiscreteLocusId; allele: number; tick: number }[] = [];
  private readonly heritabilities = new Map<TraitKey, number>();
  private assignments = new Int32Array(0);

  constructor(trackIds = false) {
    this.trackIds = trackIds;
    this.estimators = {
      fst: (state, grouping) => (grouping === 'barrier' && state.barriers.specs.length === 0 ? null : 0),
      midparentHeritability: (trait) => this.heritabilities.get(trait) ?? null,
      temporalNe: (earlier, later, generationsElapsed, censusSize) =>
        earlier.length === 0 || later.length === 0 ? censusSize : censusSize / Math.max(1, generationsElapsed),
      demographicNe: (state) => state.liveCount,
      detectSpecies: (state): SpeciesDetectionResult => {
        if (this.assignments.length !== state.pop.capacity) this.assignments = new Int32Array(state.pop.capacity);
        for (let slot = 0; slot < state.pop.capacity; slot += 1) {
          this.assignments[slot] = (state.pop.alive[slot] ?? 0) === 1 ? (state.pop.speciesTag[slot] ?? 0) : -1;
        }
        return { assignments: this.assignments, splits: [], extinctions: [] };
      },
    };
  }

  onBirth(record: AncestryRecord): void {
    this.trace.births += 1;
    if (this.trackIds) {
      this.trace.bornIds.push(record.id);
      this.trace.bornIdSet.add(record.id);
      this.records.set(record.id, record);
    }
  }

  onDeath(id: OrganismId, tick: number, cause: DeathCause): void {
    this.trace.deaths += 1;
    this.trace.byCause[cause] += 1;
    if (!this.trackIds) return;
    this.trace.diedIds.add(id);
    const record = this.records.get(id);
    if (record !== undefined) this.records.set(id, { ...record, deathTick: tick, deathCause: cause });
  }

  onMating(motherId: OrganismId, fatherId: OrganismId, tick: number): void {
    this.trace.matings += 1;
    this.lastMating = { motherId, fatherId, tick };
  }

  onEvent(event: SimEvent): void {
    this.trace.events += 1;
    this.lastEventKind = event.kind;
  }

  sample(state: SimState, tick: number): SampleRow {
    const traits = {} as Record<TraitKey, TraitSample>;
    for (const key of TRAIT_KEYS) traits[key] = zeroTraitSample();
    const discreteAlleleFreq = {} as Record<DiscreteLocusId, readonly number[]>;
    for (const locus of DISCRETE_LOCI) discreteAlleleFreq[locus.id] = new Array<number>(locus.alleleCount).fill(0);
    const deaths = {} as Record<DeathCause, number>;
    for (const cause of DEATH_CAUSES) deaths[cause] = state.deathCounts[cause];

    const row: SampleRow = {
      tick,
      generation: tick / state.config.time.generationTicks,
      population: state.liveCount,
      populationBySpecies: [],
      populationByClade: [],
      populationByDeme: new Array<number>(demeCount(state.config)).fill(0),
      populationByArchetype: [0, 0, 0],
      traits,
      discreteAlleleFreq,
      quantLociWithVariance: 1,
      deaths,
      matings: state.matingCount,
      crossSpeciesMatings: state.crossSpeciesMatingCount,
      assortmentIndex: 0,
      hueAssortment: 0,
      resources: { planktonTotal: 0, kelpTotal: 0, meanTemperatureC: 0, climateOffsetC: state.climate.meanOffsetC },
      popgen: {
        neDemographic: 0,
        neTemporal: 0,
        fstDemes: 0,
        fstBarrier: null,
        meanHeterozygosity: 0,
        midparentH2Size: null,
      },
      guilds: { predatorFraction: 0, filtererFraction: 0, meanAttack: 0, meanDefense: 0 },
    };

    // The recorder owns these tallies; resetting here is what the real one does.
    for (const cause of DEATH_CAUSES) state.deathCounts[cause] = 0;
    state.matingCount = 0;
    state.crossSpeciesMatingCount = 0;

    this.rows.push(row);
    return row;
  }

  series(sinceTick: number): readonly SampleRow[] {
    return this.rows.filter((row) => row.tick > sinceTick);
  }

  ancestry(id: OrganismId): AncestryRecord | undefined {
    return this.records.get(id);
  }

  phylogeny(): readonly PhylogenyNode[] {
    return [];
  }

  collectAncestry(state: SimState): void {
    if (!this.trackIds) return;
    // Keep the map bounded over a long run: living organisms only, which is all
    // the id-reuse probe needs from it.
    const living = new Set<OrganismId>();
    const pop = state.pop;
    for (let slot = 0; slot < pop.capacity; slot += 1) {
      if ((pop.alive[slot] ?? 0) === 1) living.add(pop.id[slot] ?? 0);
    }
    for (const id of [...this.records.keys()]) {
      if (!living.has(id)) this.records.delete(id);
    }
  }

  trackSweep(locus: DiscreteLocusId, allele: number, tick: number): void {
    this.sweeps.push({ locus, allele, tick });
  }

  drainRaisedEvents(): readonly SimEvent[] {
    return [];
  }

  get trackedSweeps(): readonly { locus: DiscreteLocusId; allele: number; tick: number }[] {
    return this.sweeps;
  }
}

// ===========================================================================
// Harness
// ===========================================================================

interface HarnessOptions {
  readonly ecology?: EcologyOptions;
  readonly trackIds?: boolean;
}

interface Harness {
  readonly sim: SimHandleInternal;
  readonly stats: StubStats;
  readonly pools: EnginePools;
}

/** The parallel-build seam: everything the engine needs, none of it the real modules. */
function makeStubModules(config: SimConfig, options: HarnessOptions): { modules: SimModules; stats: StubStats } {
  const stats = new StubStats(options.trackIds ?? false);
  const modules: SimModules = {
    genetics: new StubGenetics(),
    ecology: new StubEcology(options.ecology ?? {}),
    spatial: new StubSpatial(config.world.spatialCellSizeWu),
    mating: createMating(),
    stats,
  };
  return { modules, stats };
}

function makeHarness(seed: string, overrides: SimConfigOverrides, options: HarnessOptions = {}): Harness {
  const config = resolveSimConfig(overrides);
  const { modules, stats } = makeStubModules(config, options);
  const sim = createSim({ seed, config: overrides, modules });
  return { sim, stats, pools: sim.pools };
}

/**
 * Small, fast, and demographically self-limiting: plankton is the only energy
 * source and grazing depletes it, so the population regulates itself without a
 * population cap doing the work.
 */
const CHURN_CONFIG: SimConfigOverrides = {
  world: {
    widthWu: 1200,
    heightWu: 800,
    slotCapacity: 1024,
    initialPopulation: 300,
    spatialCellSizeWu: 60,
    fieldCellSizeWu: 40,
  },
  time: { maturityTicks: 150, generationTicks: 400 },
  mating: {
    matingCooldownTicks: 150,
    surveyRadiusWu: 90,
    clutchLambda: 2,
    femaleReadyEnergyFraction: 0.65,
  },
  metabolism: { reproductionEnergyCost: 6, baseRate: 0.009 },
  resources: {
    planktonCarryingCapacityBase: 12,
    planktonGrowthRate: 0.15,
    grazingMaxIntake: 0.5,
  },
  predation: { baseLogit: -4.5, attemptRadiusWu: 35 },
  // The stub wanders instead of climbing the temperature gradient, so the full
  // 8–26 °C span would kill everything parked at either edge. Narrowing it
  // keeps the thermal channel alive without making it the only one.
  thermal: { northC: 21, southC: 13, seasonAmplitudeC: 1.5, climateSigmaC: 1 },
  sampling: { sampleIntervalTicks: 500 },
  speciation: { detectorIntervalTicks: 2000 },
};

const HASH_INTERVAL = 1000;
const LONG_TICKS = 20_000;
const SNAPSHOT_TICK = 7_000;

interface Trail {
  readonly ticks: number[];
  readonly hashes: string[];
}

function runCollectingHashes(sim: SimHandleInternal, totalTicks: number, fromTick = 0): Trail {
  const trail: Trail = { ticks: [], hashes: [] };
  let tick = fromTick;
  while (tick < totalTicks) {
    const step = Math.min(HASH_INTERVAL, totalTicks - tick);
    sim.step(step);
    tick += step;
    trail.ticks.push(tick);
    trail.hashes.push(sim.stateHash());
  }
  return trail;
}

// ===========================================================================
// Probes
// ===========================================================================

describe('P1 determinism', () => {
  let runA: Trail;
  let runB: Trail;
  let restored: Trail;
  let simA: SimHandleInternal;
  let restoreTick = -1;
  let restoreHash = '';
  let capturedHash = '';

  // The whole 20k-tick campaign runs once; every assertion below reads its
  // output. Nothing is asserted in here, so a break names the probe it broke
  // rather than collapsing the suite into one unexplained skip.
  beforeAll(() => {
    const a = makeHarness('determinism-seed', CHURN_CONFIG);
    simA = a.sim;

    // Run A to the snapshot point, capture, then continue to the end.
    const firstLeg = runCollectingHashes(simA, SNAPSHOT_TICK);
    const snapshot = structuredClone(simA.snapshot());
    const secondLeg = runCollectingHashes(simA, LONG_TICKS, SNAPSHOT_TICK);
    runA = {
      ticks: [...firstLeg.ticks, ...secondLeg.ticks],
      hashes: [...firstLeg.hashes, ...secondLeg.hashes],
    };

    const b = makeHarness('determinism-seed', CHURN_CONFIG);
    runB = runCollectingHashes(b.sim, LONG_TICKS);

    const { modules } = makeStubModules(resolveSimConfig(CHURN_CONFIG), {});
    const restoredSim = createSim({ seed: 'determinism-seed', config: CHURN_CONFIG, modules, snapshot });
    restoreTick = restoredSim.state.tick;
    restoreHash = restoredSim.stateHash();
    capturedHash = snapshot.stateHash;
    restored = runCollectingHashes(restoredSim, LONG_TICKS, SNAPSHOT_TICK);
  }, 600_000);

  it('the run was worth hashing: the population survived and churned through slots', () => {
    expect(simA.state.liveCount).toBeGreaterThan(0);
    expect(simA.diagnostics.birthsApplied).toBeGreaterThan(1000);
    expect(simA.diagnostics.deathsApplied).toBeGreaterThan(1000);
    // Ids outran the slot capacity many times over, so slots were recycled hard.
    expect(simA.state.nextOrganismId).toBeGreaterThan(simA.pools.capacity * 4);
  });

  it('same seed, two fresh sims: identical stateHash every 1,000 ticks', () => {
    expect(runB.ticks).toEqual(runA.ticks);
    expect(runB.hashes).toEqual(runA.hashes);
    expect(runA.hashes).toHaveLength(LONG_TICKS / HASH_INTERVAL);
    // A hash that never changes would make the comparison vacuous.
    expect(new Set(runA.hashes).size).toBeGreaterThan(LONG_TICKS / HASH_INTERVAL - 2);
  });

  it('a restored sim resumes at the captured tick with the captured hash', () => {
    expect(restoreTick).toBe(SNAPSHOT_TICK);
    expect(restoreHash).toBe(capturedHash);
  });

  it('snapshot at 7,000 → restore → run to 20,000 reproduces the uninterrupted trail', () => {
    const tail = runA.ticks.filter((tick) => tick > SNAPSHOT_TICK);
    expect(restored.ticks).toEqual(tail);
    expect(restored.hashes).toEqual(runA.hashes.slice(runA.ticks.length - tail.length));
  });
});

describe('stage boundaries', () => {
  it('births and deaths never land in the middle of a per-organism stage', () => {
    let expectedLiveCount = -1;
    const stageSignatures = new Map<string, string>();
    let currentTick = -1;
    const violations: string[] = [];

    const signatureOf = (state: SimState): string => {
      const pop = state.pop;
      let alive = 0;
      let idSum = 0;
      for (let slot = 0; slot < pop.capacity; slot += 1) {
        if ((pop.alive[slot] ?? 0) === 0) continue;
        alive += 1;
        idSum += (pop.id[slot] ?? 0) * (slot + 1);
      }
      return `${alive}:${idSum}`;
    };

    const watch = (state: SimState, stage: string): void => {
      if (state.tick !== currentTick) {
        // First per-organism callback of a new tick: this is the baseline.
        currentTick = state.tick;
        expectedLiveCount = state.liveCount;
        stageSignatures.clear();
        stageSignatures.set('tick', signatureOf(state));
      }
      if (state.liveCount !== expectedLiveCount) {
        violations.push(`tick ${state.tick} stage ${stage}: liveCount ${state.liveCount} != ${expectedLiveCount}`);
      }
      if (!stageSignatures.has(stage)) {
        const signature = signatureOf(state);
        if (signature !== stageSignatures.get('tick')) {
          violations.push(`tick ${state.tick} stage ${stage}: pool signature changed mid-tick`);
        }
        stageSignatures.set(stage, signature);
      }
    };

    const harness = makeHarness('stage-boundaries', CHURN_CONFIG, { ecology: { watch } });
    harness.sim.step(600);

    expect(violations).toEqual([]);
    // The probe is only meaningful if the queues actually had work to apply.
    expect(harness.sim.diagnostics.birthsApplied).toBeGreaterThan(0);
    expect(harness.sim.diagnostics.deathsApplied).toBeGreaterThan(0);
  }, 120_000);
});

describe('mating', () => {
  const MATING_CONFIG: SimConfigOverrides = {
    world: { widthWu: 200, heightWu: 200, slotCapacity: 512, initialPopulation: 24, spatialCellSizeWu: 100, fieldCellSizeWu: 50 },
    time: { maturityTicks: 0 },
    mating: { surveyRadiusWu: 300, matingCooldownTicks: 0, maxSuitorsSurveyed: 8, clutchLambda: 2 },
  };

  it('acceptanceWeight matches the analytic Gaussian × condition on a constructed case', () => {
    const harness = makeHarness('mating-weight', MATING_CONFIG, { ecology: { quiet: true } });
    const state = harness.sim.state;
    const pools = harness.pools;
    const config = state.config;
    const mating = createMating();

    const female = 0;
    const male = 1;
    const writeTrait = (slot: number, key: TraitKey, value: number): void => {
      pools.traits[slot * TRAIT_COUNT + TRAIT_INDEX[key]] = value;
    };

    writeTrait(female, 'prefTarget', 200);
    writeTrait(female, 'choosiness', 1.25);
    writeTrait(male, 'displayHue', 245);
    // Body length is two quantities since G2: the `size` trait is the genetic
    // target and `sizeCurrent` is how long he actually is. The condition term
    // divides by his storage ceiling, which is set by the latter, so the
    // fixture writes both to keep meaning "a 10 cm male".
    writeTrait(male, 'size', 10);
    pools.sizeCurrent[male] = 10;
    pools.energy[male] = 13.2;

    const sigma = config.mating.prefSigmaBaseDeg / (config.mating.choosinessScale * 1.25);
    const delta = hueDelta(245, 200);
    const display = Math.exp(-(delta * delta) / (2 * sigma * sigma));
    const condition = 13.2 / (config.metabolism.maxEnergyPerSize * 10);
    const expected = display * (1 - config.mating.conditionWeight + config.mating.conditionWeight * condition);

    expect(mating.acceptanceWeight(state, female, male)).toBeCloseTo(expected, 6);
    expect(delta).toBeCloseTo(45, 6);

    // Hue is circular: 355° is 25° from 20°, not 335°.
    writeTrait(female, 'prefTarget', 20);
    writeTrait(male, 'displayHue', 355);
    const wrapped = Math.exp(-(25 * 25) / (2 * sigma * sigma));
    expect(mating.acceptanceWeight(state, female, male)).toBeCloseTo(
      wrapped * (1 - config.mating.conditionWeight + config.mating.conditionWeight * condition),
      6,
    );
  });

  it('with assortative mating switched off the display term drops out', () => {
    const harness = makeHarness('mating-toggle', MATING_CONFIG, { ecology: { quiet: true } });
    const pools = harness.pools;
    pools.traits[0 * TRAIT_COUNT + TRAIT_INDEX.prefTarget] = 200;
    pools.traits[0 * TRAIT_COUNT + TRAIT_INDEX.choosiness] = 4;
    pools.traits[1 * TRAIT_COUNT + TRAIT_INDEX.displayHue] = 20;
    pools.traits[1 * TRAIT_COUNT + TRAIT_INDEX.size] = 10;
    // See above: realised length is what the storage ceiling reads (G2).
    pools.sizeCurrent[1] = 10;
    pools.energy[1] = 22;

    const mating = createMating();
    const before = mating.acceptanceWeight(harness.sim.state, 0, 1);
    expect(before).toBeLessThan(0.01);

    harness.sim.command({ kind: 'setToggle', toggle: 'enableAssortativeMating', value: false });
    const config = harness.sim.state.config;
    const condition = 22 / (config.metabolism.maxEnergyPerSize * 10);
    expect(mating.acceptanceWeight(harness.sim.state, 0, 1)).toBeCloseTo(
      1 - config.mating.conditionWeight + config.mating.conditionWeight * condition,
      6,
    );
  });

  it('conserves energy: parents are debited per config and offspring get exactly birthEnergy', () => {
    const harness = makeHarness('mating-energy', MATING_CONFIG, { ecology: { quiet: true } });
    const sim = harness.sim;
    const pools = harness.pools;
    const config = sim.state.config;

    // Every founder mature, off cooldown, and full, so reproduction is the only
    // thing that can move energy this tick.
    const parentIds = new Set<number>();
    let energyBefore = 0;
    for (let slot = 0; slot < pools.capacity; slot += 1) {
      if ((pools.alive[slot] ?? 0) === 0) continue;
      const capacity = config.metabolism.maxEnergyPerSize * Math.max(1e-3, pools.traits[slot * TRAIT_COUNT + T_SIZE] ?? 0);
      pools.energy[slot] = capacity;
      pools.ageTicks[slot] = config.time.maturityTicks + 1;
      pools.lastMatingTick[slot] = -1000;
      // Read back rather than trusting the float64 value: the column is Float32.
      energyBefore += pools.energy[slot] ?? 0;
      parentIds.add(pools.id[slot] ?? 0);
    }

    sim.step(1);

    const offspring = sim.diagnostics.birthsApplied;
    expect(offspring).toBeGreaterThan(0);
    expect(sim.diagnostics.birthsDropped).toBe(0);
    expect(sim.diagnostics.deathsApplied).toBe(0);

    let parentEnergyAfter = 0;
    let offspringEnergyAfter = 0;
    let offspringCounted = 0;
    for (let slot = 0; slot < pools.capacity; slot += 1) {
      if ((pools.alive[slot] ?? 0) === 0) continue;
      const energy = pools.energy[slot] ?? 0;
      if (parentIds.has(pools.id[slot] ?? 0)) {
        parentEnergyAfter += energy;
      } else {
        offspringCounted += 1;
        offspringEnergyAfter += energy;
        // Exactly the configured endowment: no partial inheritance, no bonus.
        expect(energy).toBeCloseTo(config.metabolism.birthEnergy, 5);
      }
    }

    expect(offspringCounted).toBe(offspring);
    const expectedDebit =
      config.metabolism.reproductionEnergyCost * offspring * (1 + config.mating.paternalCostFraction);
    expect(energyBefore - parentEnergyAfter).toBeCloseTo(expectedDebit, 2);
    // The endowment is the only energy the birth path creates, and it is exact.
    expect(offspringEnergyAfter).toBeCloseTo(config.metabolism.birthEnergy * offspring, 5);
    expect(parentEnergyAfter).toBeGreaterThan(0);
  });
});

describe('raiseBarrier', () => {
  it('a raised wall is not crossed over 2,000 ticks; movement slides along it', () => {
    const RIDGE_X = 600;
    const config: SimConfigOverrides = {
      ...CHURN_CONFIG,
      world: { ...CHURN_CONFIG.world, widthWu: 1200, heightWu: 800 },
    };
    const harness = makeHarness('barrier', config);
    const sim = harness.sim;
    const pools = harness.pools;

    sim.step(400);
    sim.command({
      kind: 'raiseBarrier',
      barrierId: 'ridge',
      shape: { kind: 'verticalRidge', xWu: RIDGE_X, thicknessWu: 120 },
      permeability: 0,
    });

    const barriers = sim.state.barriers;
    const blockedAt = (x: number, y: number): boolean => {
      const col = Math.min(barriers.cols - 1, Math.max(0, Math.floor(x / barriers.cellSizeWu)));
      const row = Math.min(barriers.rows - 1, Math.max(0, Math.floor(y / barriers.cellSizeWu)));
      return (barriers.mask[row * barriers.cols + col] ?? 255) === 0;
    };

    const sideOf = new Map<number, boolean>();
    const crossings: string[] = [];
    const insideWall: string[] = [];
    let west = 0;
    let east = 0;

    const inspect = (): void => {
      for (let slot = 0; slot < pools.capacity; slot += 1) {
        if ((pools.alive[slot] ?? 0) === 0) continue;
        const id = pools.id[slot] ?? 0;
        const x = pools.x[slot] ?? 0;
        const y = pools.y[slot] ?? 0;
        if (blockedAt(x, y)) insideWall.push(`id ${id} at (${x.toFixed(1)}, ${y.toFixed(1)}) tick ${sim.state.tick}`);
        const side = x < RIDGE_X;
        const known = sideOf.get(id);
        if (known === undefined) {
          sideOf.set(id, side);
          if (side) west += 1;
          else east += 1;
        } else if (known !== side) {
          crossings.push(`id ${id} crossed at tick ${sim.state.tick} (x=${x.toFixed(1)})`);
          sideOf.set(id, side);
        }
      }
    };

    inspect();
    for (let step = 0; step < 400; step += 1) {
      sim.step(5);
      inspect();
    }

    expect(sim.state.tick).toBe(2400);
    expect(insideWall.slice(0, 5)).toEqual([]);
    expect(crossings.slice(0, 5)).toEqual([]);
    // Both sides had to be populated for the assertion to mean anything.
    expect(west).toBeGreaterThan(10);
    expect(east).toBeGreaterThan(10);
    expect(sim.state.liveCount).toBeGreaterThan(0);
  }, 300_000);
});

describe('slot cap', () => {
  const CAP_CONFIG: SimConfigOverrides = {
    world: { widthWu: 200, heightWu: 200, slotCapacity: 64, initialPopulation: 40, spatialCellSizeWu: 100, fieldCellSizeWu: 50 },
    time: { maturityTicks: 0 },
    mating: { surveyRadiusWu: 300, matingCooldownTicks: 0, clutchLambda: 6 },
  };

  function runToCap(seed: string): SimHandleInternal {
    const harness = makeHarness(seed, CAP_CONFIG, { ecology: { quiet: true } });
    const pools = harness.pools;
    const config = harness.sim.state.config;
    for (let tick = 0; tick < 12; tick += 1) {
      for (let slot = 0; slot < pools.capacity; slot += 1) {
        if ((pools.alive[slot] ?? 0) === 0) continue;
        pools.energy[slot] =
          config.metabolism.maxEnergyPerSize * Math.max(1e-3, pools.traits[slot * TRAIT_COUNT + T_SIZE] ?? 0);
        pools.ageTicks[slot] = config.time.maturityTicks + 1;
        pools.lastMatingTick[slot] = -1000;
      }
      harness.sim.step(1);
    }
    return harness.sim;
  }

  it('drops births at a full pool, counts them, and never corrupts a slot', () => {
    const sim = runToCap('slot-cap');
    const pools = sim.pools;

    expect(sim.diagnostics.birthsDropped).toBeGreaterThan(0);
    expect(sim.state.liveCount).toBe(64);

    let alive = 0;
    const ids = new Set<number>();
    for (let slot = 0; slot < pools.capacity; slot += 1) {
      if ((pools.alive[slot] ?? 0) === 0) {
        continue;
      }
      alive += 1;
      const id = pools.id[slot] ?? 0;
      expect(id).toBeGreaterThan(0);
      expect(ids.has(id)).toBe(false);
      ids.add(id);
      expect(pools.genomes[slot]).toBeDefined();
    }
    expect(alive).toBe(sim.state.liveCount);
    expect(ids.size).toBe(64);
  });

  it('drops the same number of births on a re-run of the same seed', () => {
    expect(runToCap('slot-cap').diagnostics.birthsDropped).toBe(runToCap('slot-cap').diagnostics.birthsDropped);
    expect(runToCap('slot-cap-b').stateHash()).toBe(runToCap('slot-cap-b').stateHash());
  });
});

describe('organism identity', () => {
  it('ids are never reused even as slots recycle hard', () => {
    const config: SimConfigOverrides = {
      ...CHURN_CONFIG,
      world: { ...CHURN_CONFIG.world, slotCapacity: 256, initialPopulation: 120 },
    };
    const harness = makeHarness('identity', config, { trackIds: true });
    const sim = harness.sim;
    const pools = harness.pools;

    const slotOccupants = new Map<number, Set<number>>();
    const everSeenLive = new Set<number>();
    const reusedAfterDeath: string[] = [];

    for (let checkpoint = 0; checkpoint < 20; checkpoint += 1) {
      sim.step(200);
      const liveIds = new Set<number>();
      for (let slot = 0; slot < pools.capacity; slot += 1) {
        if ((pools.alive[slot] ?? 0) === 0) continue;
        const id = pools.id[slot] ?? 0;
        expect(liveIds.has(id)).toBe(false);
        liveIds.add(id);
        everSeenLive.add(id);
        if (harness.stats.trace.diedIds.has(id)) {
          reusedAfterDeath.push(`id ${id} alive in slot ${slot} at tick ${sim.state.tick} after dying`);
        }
        let occupants = slotOccupants.get(slot);
        if (occupants === undefined) {
          occupants = new Set<number>();
          slotOccupants.set(slot, occupants);
        }
        occupants.add(id);
      }
    }

    expect(reusedAfterDeath.slice(0, 5)).toEqual([]);

    // Ids were handed out strictly increasing and never twice.
    const bornIds = harness.stats.trace.bornIds;
    expect(bornIds.length).toBeGreaterThan(500);
    expect(harness.stats.trace.bornIdSet.size).toBe(bornIds.length);
    for (let index = 1; index < bornIds.length; index += 1) {
      expect(bornIds[index]).toBeGreaterThan(bornIds[index - 1] ?? 0);
    }

    // And the probe only means something because slots really were recycled.
    let recycledSlots = 0;
    for (const occupants of slotOccupants.values()) {
      if (occupants.size > 1) recycledSlots += 1;
    }
    expect(recycledSlots).toBeGreaterThan(20);
    expect(everSeenLive.size).toBeGreaterThan(pools.capacity);
  }, 300_000);
});

describe('stateHash sensitivity', () => {
  it('notices a change to any part of the world it claims to cover', () => {
    const harness = makeHarness('hash-sensitivity', CHURN_CONFIG);
    harness.sim.step(300);
    const pools = harness.pools;

    let live = NO_SLOT;
    for (let slot = 0; slot < pools.capacity && live === NO_SLOT; slot += 1) {
      if ((pools.alive[slot] ?? 0) === 1) live = slot;
    }
    expect(live).not.toBe(NO_SLOT);

    const perturbations: { readonly name: string; readonly apply: () => void; readonly undo: () => void }[] = [];
    const push = (name: string, read: () => number, write: (value: number) => void): void => {
      const original = read();
      perturbations.push({ name, apply: () => write(original + 1), undo: () => write(original) });
    };

    push('position', () => pools.x[live] ?? 0, (v) => (pools.x[live] = v));
    push('energy', () => pools.energy[live] ?? 0, (v) => (pools.energy[live] = v));
    push('speciesTag', () => pools.speciesTag[live] ?? 0, (v) => (pools.speciesTag[live] = v));
    push(
      'expressed trait',
      () => pools.traits[live * TRAIT_COUNT + T_SIZE] ?? 0,
      (v) => (pools.traits[live * TRAIT_COUNT + T_SIZE] = v),
    );
    push(
      'genotypic value',
      () => pools.traitsGenotypic[live * TRAIT_COUNT + T_SIZE] ?? 0,
      (v) => (pools.traitsGenotypic[live * TRAIT_COUNT + T_SIZE] = v),
    );
    push('genome allele', () => pools.genomes[live]?.quant[0] ?? 0, (v) => {
      const genome = pools.genomes[live];
      if (genome !== undefined) genome.quant[0] = v;
    });
    push('plankton', () => harness.sim.state.field.plankton[0] ?? 0, (v) => (harness.sim.state.field.plankton[0] = v));
    push('climate', () => harness.sim.state.climate.meanOffsetC, (v) => (harness.sim.state.climate.meanOffsetC = v));
    push('tick', () => harness.sim.state.tick, (v) => (harness.sim.state.tick = v));
    push('nextOrganismId', () => harness.sim.state.nextOrganismId, (v) => (harness.sim.state.nextOrganismId = v));

    const baseline = harness.sim.stateHash();
    const blind: string[] = [];
    for (const perturbation of perturbations) {
      perturbation.apply();
      if (harness.sim.stateHash() === baseline) blind.push(perturbation.name);
      perturbation.undo();
      expect(harness.sim.stateHash()).toBe(baseline);
    }
    expect(blind).toEqual([]);
  }, 120_000);

  it('separates two seeds', () => {
    const a = makeHarness('seed-alpha', CHURN_CONFIG);
    const b = makeHarness('seed-beta', CHURN_CONFIG);
    expect(a.sim.stateHash()).not.toBe(b.sim.stateHash());
    a.sim.step(1000);
    b.sim.step(1000);
    expect(a.sim.stateHash()).not.toBe(b.sim.stateHash());
  }, 120_000);
});

describe('snapshot format', () => {
  it('round-trips through structuredClone and preserves the slot layout verbatim', () => {
    const harness = makeHarness('snapshot-shape', CHURN_CONFIG);
    harness.sim.step(1500);

    const snapshot = structuredClone(harness.sim.snapshot());
    expect(snapshot.capacity).toBe(harness.pools.capacity);
    expect(snapshot.genomes).toHaveLength(snapshot.capacity);
    expect(snapshot.liveCount + snapshot.freeSlots.length).toBe(snapshot.capacity);
    expect(new Set(snapshot.freeSlots).size).toBe(snapshot.freeSlots.length);

    const alive = snapshot.columns.alive as Uint8Array;
    for (const slot of snapshot.freeSlots) {
      expect(alive[slot]).toBe(0);
      expect(snapshot.genomes[slot]).toBeNull();
    }
    let liveInColumns = 0;
    for (let slot = 0; slot < snapshot.capacity; slot += 1) {
      if ((alive[slot] ?? 0) === 1) {
        liveInColumns += 1;
        expect(snapshot.genomes[slot]).not.toBeNull();
      }
    }
    expect(liveInColumns).toBe(snapshot.liveCount);
    expect(snapshot.stateHash).toBe(harness.sim.stateHash());
  }, 120_000);
});
