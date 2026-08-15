/**
 * The tick loop (WP-A3).
 *
 * The engine depends on nothing but `src/contracts/**` and its own three
 * siblings (`organisms`, `mating`, `snapshot`). Genetics, ecology, the spatial
 * index and stats arrive through `createSim({ modules })` as the interfaces in
 * `apis.ts`; naming a sibling module path here would end the parallel build.
 *
 * ## Determinism
 *
 * One `SeededRng` is created from the seed and then **never advanced**: every
 * stage draws from `rng.fork(label)`, and `fork` is pure (it hashes the parent
 * state with the label instead of consuming entropy). Putting the tick in the
 * label gives each stage of each tick its own stream, so a stage that draws a
 * variable number of samples — predation rolls, clutch sizes — cannot
 * desynchronise the stages after it, and adding a new consumer cannot shift the
 * trajectory of the ones already there. It also means the RNG carries no hidden
 * cross-tick state for a snapshot to lose.
 *
 * Everything else follows from three rules: walk slots ascending and skip the
 * dead, never iterate a container ordered by death history, and apply births
 * and deaths only at stage boundaries.
 *
 * ## Tick stages
 *
 * 1. environment (climate, fields, resource regrowth)
 * 2. behaviour decisions, staggered by slot
 * 3. movement integration, with barrier slide
 * 4. spatial index rebuild
 * 5. feeding
 * 6. predation attempts → kill queue
 * 7. metabolism and hazards → death queue; **queues applied here**
 * 8. reproduction → birth queue; **queue applied here**
 * 9. recording (species detector, event forwarding, time-series sample)
 *
 * Stage 2 reads the index built at the end of the previous tick, which is why
 * the rebuild sits after movement rather than before decisions.
 */

import type {
  BehaviorDecision,
  CreateSim,
  CreateSimOptions,
  EcologyApi,
  GeneticsApi,
  KillSink,
  DeathSink,
  MatingApi,
  SimModules,
  SpatialIndex,
  StatsApi,
  SimHandle,
} from '../contracts/apis';
import type {
  BirthEvent,
  CladeFoundingEvent,
  DeathEvent,
  MutantIntroducedEvent,
  MutationRecord,
  SimEvent,
} from '../contracts/events';
import { thermalPerformance } from '../contracts/formulas';
import type { CladeArchetype, DiscreteLocusId, Genome, QuantLocusId } from '../contracts/genome';
import {
  ANCESTRAL_ARCHETYPE,
  DISCRETE_LOCI,
  QUANT_LOCI,
  W_BY_LOCUS,
  discreteAlleleIndex,
  quantAlleleIndex,
} from '../contracts/genome';
import type {
  DiscreteLocusDump,
  GenomeLocusDump,
  OrganismDump,
  SampleSlice,
  SimCommand,
} from '../contracts/protocol';
import { SAMPLE_SLICE, SAMPLE_SLICE_STRIDE } from '../contracts/protocol';
import type { AncestryRecord, PhylogenyNode, SampleRow } from '../contracts/stats';
import type { TraitKey } from '../contracts/traits';
import { TRAIT_COUNT, TRAIT_INDEX, TRAIT_KEYS, unpackTraits } from '../contracts/traits';
import type {
  BarrierSpec,
  BarrierState,
  ClimateState,
  DeathCause,
  DemeId,
  DisturbanceRegion,
  DisturbanceState,
  MechanismToggles,
  OrganismId,
  ResourceField,
  SimConfig,
  SimConfigOverrides,
  SimSnapshot,
  SimState,
  SlotIndex,
  SpeciesBookkeeping,
} from '../contracts/types';
import {
  BEHAVIOR_WANDER,
  DEATH_CAUSES,
  NO_ORGANISM,
  NO_SLOT,
  SEX_FEMALE,
  archetypeFromCode,
  archetypeToCode,
  demeAt,
  karyotypeToSex,
  resolveSimConfig,
  sexFromCode,
  sexToCode,
} from '../contracts/types';
import { createMating, isFemaleReady, maternalClutchCost, paternalClutchCost } from './mating';
import type { EnginePools } from './organisms';
import { OrganismStore, T, energyCapacityOf, traitAt } from './organisms';
import { SeededRng } from './rng';
import { applySnapshot, computeStateHash, serializeSnapshot } from './snapshot';

/** Distance a newborn is scattered from its mother, world units. */
const BIRTH_SCATTER_WU = 6;

/** Founder energy as a fraction of storage capacity; they start as adults, not as hatchlings. */
const FOUNDER_ENERGY_FRACTION = 0.6;

/** How far the barrier-eviction scan walks before giving up, in barrier cells. */
const EVICTION_SCAN_CELLS = 64;

/** Ancestry generations `select` walks for the inspector. */
const DUMP_ANCESTOR_GENERATIONS = 3;

/**
 * `thermalPerformance` split into its two factors, with the expensive one cached.
 *
 * The generalist tax `(tWidthRef / tWidth)^κ` is a `Math.pow` with a fractional
 * exponent — tens of nanoseconds — and it is a pure function of `tWidth`, which
 * is written at birth and never changes. Only the tolerance factor depends on
 * where the organism is standing. Splitting them turns one pow per organism per
 * tick into one pow per organism per lifetime.
 *
 * The tax is read back out of the frozen formula at the performance peak, where
 * the tolerance factor is exactly 1, so this stays a memo of `formulas.ts`
 * rather than a second copy of it, and the product is bit-identical to calling
 * `thermalPerformance` directly.
 */
function thermalTaxOf(tOpt: number, tWidth: number, config: SimConfig): number {
  return thermalPerformance(tOpt, tOpt, tWidth, config);
}

/** The tolerance factor of {@link thermalPerformance}; multiply by {@link thermalTaxOf}. */
function thermalToleranceOf(temperatureC: number, tOpt: number, tWidth: number): number {
  const z = (temperatureC - tOpt) / Math.max(1e-3, tWidth);
  return Math.exp(-z * z);
}

/** Counters that describe the engine's own behaviour rather than the world's; not part of the hash or the snapshot. */
export interface SimDiagnostics {
  /** Births the slot cap refused. P3 wants this at zero for a healthy run; it must never be silent. */
  birthsDropped: number;
  birthsApplied: number;
  matingsRealized: number;
  deathsApplied: number;
  /** Kill-sink entries that named a victim already claimed by an earlier kill or already dead. */
  predationKillsIgnored: number;
}

/**
 * `SimHandle` plus the engine-internal surfaces the determinism probe needs.
 * Structurally still a `SimHandle`, so `createSimAsContract` typechecks.
 */
export interface SimHandleInternal extends SimHandle {
  readonly pools: EnginePools;
  readonly diagnostics: Readonly<SimDiagnostics>;
}

/** `SimState` with a swappable config, which `setToggle` needs and the contract's `readonly` forbids. */
interface EngineState extends Omit<SimState, 'config'> {
  config: SimConfig;
}

interface PendingBirth {
  readonly genome: Genome;
  readonly mutations: readonly MutationRecord[];
  readonly motherId: OrganismId;
  readonly fatherId: OrganismId;
  readonly parentArchetype: CladeArchetype;
  readonly parentCladeId: number;
  readonly speciesTag: number;
  readonly x: number;
  readonly y: number;
}

const CAUSE_CODE: Readonly<Record<DeathCause, number>> = Object.freeze({
  starvation: 0,
  predation: 1,
  temperature: 2,
  senescence: 3,
  catastrophe: 4,
});

const NO_CAUSE = -1;

class KillQueue implements KillSink {
  predators: Int32Array;
  victims: Int32Array;
  yields: Float64Array;
  count = 0;

  constructor(capacity: number) {
    this.predators = new Int32Array(capacity);
    this.victims = new Int32Array(capacity);
    this.yields = new Float64Array(capacity);
  }

  reset(): void {
    this.count = 0;
  }

  push(predatorSlot: SlotIndex, victimSlot: SlotIndex, energyYield: number): void {
    if (this.count === this.predators.length) this.grow();
    this.predators[this.count] = predatorSlot;
    this.victims[this.count] = victimSlot;
    this.yields[this.count] = energyYield;
    this.count += 1;
  }

  private grow(): void {
    const size = Math.max(16, this.predators.length * 2);
    const predators = new Int32Array(size);
    const victims = new Int32Array(size);
    const energies = new Float64Array(size);
    predators.set(this.predators);
    victims.set(this.victims);
    energies.set(this.yields);
    this.predators = predators;
    this.victims = victims;
    this.yields = energies;
  }
}

class DeathQueue implements DeathSink {
  slots: Int32Array;
  causes: Int32Array;
  killers: Int32Array;
  count = 0;

  constructor(capacity: number) {
    this.slots = new Int32Array(capacity);
    this.causes = new Int32Array(capacity);
    this.killers = new Int32Array(capacity);
  }

  reset(): void {
    this.count = 0;
  }

  push(slot: SlotIndex, cause: DeathCause, killerSlot: SlotIndex): void {
    if (this.count === this.slots.length) this.grow();
    this.slots[this.count] = slot;
    this.causes[this.count] = CAUSE_CODE[cause];
    this.killers[this.count] = killerSlot;
    this.count += 1;
  }

  private grow(): void {
    const size = Math.max(16, this.slots.length * 2);
    const slots = new Int32Array(size);
    const causes = new Int32Array(size);
    const killers = new Int32Array(size);
    slots.set(this.slots);
    causes.set(this.causes);
    killers.set(this.killers);
    this.slots = slots;
    this.causes = causes;
    this.killers = killers;
  }
}

function makeField(config: SimConfig): ResourceField {
  const cellSizeWu = Math.max(1, config.world.fieldCellSizeWu);
  const cols = Math.max(1, Math.ceil(config.world.widthWu / cellSizeWu));
  const rows = Math.max(1, Math.ceil(config.world.heightWu / cellSizeWu));
  return {
    cols,
    rows,
    cellSizeWu,
    plankton: new Float32Array(cols * rows),
    carrion: new Float32Array(cols * rows),
    kelp: new Float32Array(cols * rows),
    carryingCapacity: new Float32Array(cols * rows),
    temperature: new Float32Array(cols * rows),
  };
}

function makeBarriers(config: SimConfig): BarrierState {
  const cellSizeWu = Math.max(1, config.world.fieldCellSizeWu);
  const cols = Math.max(1, Math.ceil(config.world.widthWu / cellSizeWu));
  const rows = Math.max(1, Math.ceil(config.world.heightWu / cellSizeWu));
  const mask = new Uint8Array(cols * rows).fill(255);
  return { cols, rows, cellSizeWu, mask, specs: [] };
}

function makeClimate(): ClimateState {
  return { meanOffsetC: 0, targetOffsetC: 0, seasonPhaseTicks: 0 };
}

function makeDisturbance(): DisturbanceState {
  return { thermal: [], planktonCrashes: [], kelpStorms: [] };
}

function inDisturbanceRegion(region: DisturbanceRegion, x: number, y: number): boolean {
  if (region.kind === 'disc') {
    const dx = x - region.xWu;
    const dy = y - region.yWu;
    return dx * dx + dy * dy <= region.radiusWu * region.radiusWu;
  }
  return (
    x >= region.xWu &&
    y >= region.yWu &&
    x < region.xWu + region.widthWu &&
    y < region.yWu + region.heightWu
  );
}

function emptyDeathCounts(): Record<DeathCause, number> {
  const counts = {} as Record<DeathCause, number>;
  for (const cause of DEATH_CAUSES) counts[cause] = 0;
  return counts;
}

/** 0 = impassable land, 1 = open water; anything between drags a step through. */
function permeabilityAt(barriers: BarrierState, x: number, y: number): number {
  const col = Math.floor(x / barriers.cellSizeWu);
  const row = Math.floor(y / barriers.cellSizeWu);
  if (col < 0 || row < 0 || col >= barriers.cols || row >= barriers.rows) return 1;
  return (barriers.mask[row * barriers.cols + col] ?? 255) / 255;
}

class PanthalassaSim implements SimHandleInternal {
  readonly state: EngineState;
  readonly pools: EnginePools;
  readonly diagnostics: SimDiagnostics = {
    birthsDropped: 0,
    birthsApplied: 0,
    matingsRealized: 0,
    deathsApplied: 0,
    predationKillsIgnored: 0,
  };

  private readonly store: OrganismStore;
  private readonly rng: SeededRng;
  private readonly genetics: GeneticsApi;
  private readonly ecology: EcologyApi;
  private readonly spatial: SpatialIndex;
  private readonly mating: MatingApi;
  private readonly stats: StatsApi;

  private configOverrides: SimConfigOverrides;

  private readonly kills: KillQueue;
  private readonly deaths: DeathQueue;
  private readonly pendingCause: Int32Array;
  private readonly pendingKiller: Int32Array;
  /** Slots holding a verdict this tick, in claim order; {@link applyDeaths} sorts before emitting. */
  private readonly pendingSlots: Int32Array;
  private pendingCount = 0;

  /** Per-slot memo of the generalist tax, keyed on `tWidth`; see {@link thermalTaxOf}. */
  private readonly thermalTaxWidth: Float32Array;
  private readonly thermalTaxValue: Float32Array;
  /** Config the tax memo was filled against; `setToggle` swaps the identity and invalidates it. */
  private thermalTaxConfig: SimConfig | undefined;
  private readonly births: PendingBirth[] = [];
  private readonly decision: BehaviorDecision = {
    mode: BEHAVIOR_WANDER,
    steerX: 0,
    steerY: 0,
    speedFraction: 0,
    targetSlot: NO_SLOT,
  };

  /** Species bookkeeping the extinction event needs and `SimSnapshot` has no room for. */
  private readonly speciesFirstTick = new Map<number, number>();
  private readonly speciesPeak = new Map<number, number>();

  constructor(options: CreateSimOptions) {
    const modules: SimModules = options.modules;
    this.genetics = modules.genetics;
    this.ecology = modules.ecology;
    this.spatial = modules.spatial;
    this.mating = modules.mating;
    this.stats = modules.stats;

    const restoring = options.snapshot;
    this.configOverrides = restoring?.configOverrides ?? options.config ?? {};
    const config = resolveSimConfig(this.configOverrides);
    const seed = restoring?.seed ?? options.seed;

    this.rng = new SeededRng(seed);
    const capacity = restoring?.capacity ?? config.world.slotCapacity;
    this.store = new OrganismStore(capacity);
    this.pools = this.store;

    this.state = {
      config,
      seed,
      tick: 0,
      rngState: this.rng.getState(),
      nextOrganismId: NO_ORGANISM + 1,
      nextSpeciesTag: 1,
      nextCladeId: 1,
      liveCount: 0,
      pop: this.store,
      field: makeField(config),
      climate: makeClimate(),
      disturbance: makeDisturbance(),
      barriers: makeBarriers(config),
      events: [],
      deathCounts: emptyDeathCounts(),
      matingCount: 0,
      crossSpeciesMatingCount: 0,
    };

    this.kills = new KillQueue(64);
    this.deaths = new DeathQueue(64);
    this.pendingCause = new Int32Array(capacity).fill(NO_CAUSE);
    this.pendingKiller = new Int32Array(capacity).fill(NO_SLOT);
    this.pendingSlots = new Int32Array(capacity);
    this.thermalTaxWidth = new Float32Array(capacity).fill(Number.NaN);
    this.thermalTaxValue = new Float32Array(capacity);

    // Reefs and the initial resource field come from the same stream whether we
    // are starting fresh or restoring, so a restored world has the same
    // ecology-internal geometry as the run it was captured from.
    this.ecology.initFields(this.state, this.rng.fork('init:fields'));

    if (restoring === undefined) {
      this.seedFounders();
    } else {
      applySnapshot(this.state, this.store, restoring);
      for (const entry of restoring.species) {
        this.speciesFirstTick.set(entry.tag, entry.firstTick);
        this.speciesPeak.set(entry.tag, entry.peakPopulation);
      }
      this.ecology.rebuildBarrierMask(this.state);
    }

    this.spatial.build(this.state);
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private seedFounders(): void {
    const config = this.state.config;
    const rng = this.rng.fork('init:founders');
    const target = Math.min(config.world.initialPopulation, this.store.capacity);

    for (let index = 0; index < target; index += 1) {
      const slot = this.store.allocate();
      if (slot === NO_SLOT) break;

      // Exactly balanced rather than drawn, so a founder sex-ratio accident
      // cannot masquerade as a demographic result in the first generations.
      const sex = index % 2 === 0 ? 'female' : 'male';
      const genome = this.genetics.buildFounderGenome(rng, config, sex);
      const x = rng.next() * config.world.widthWu;
      const y = rng.next() * config.world.heightWu;

      const id = this.state.nextOrganismId;
      this.state.nextOrganismId += 1;

      // A random starting age spreads the founders across the life cycle;
      // otherwise the whole population matures and breeds in lockstep and the
      // first several generations are a standing wave rather than a population.
      const age = rng.int(0, Math.max(0, config.time.maturityTicks));

      this.writeOrganism(slot, {
        id,
        motherId: NO_ORGANISM,
        fatherId: NO_ORGANISM,
        genome,
        x,
        y,
        parentArchetype: ANCESTRAL_ARCHETYPE,
        parentCladeId: 0,
        speciesTag: 0,
        rng,
        ageTicks: age,
        birthTick: -age,
        energy: config.metabolism.birthEnergy,
        emitCladeFounding: false,
      });
      // Founders arrive as established adults, so they carry an adult's
      // reserves rather than a newborn's. Seeding a population of hatchlings
      // with random adult ages produces a starvation crash in the first
      // hundred ticks that has nothing to do with the model.
      this.store.energy[slot] = FOUNDER_ENERGY_FRACTION * energyCapacityOf(this.store, slot, config);

      this.stats.onBirth(this.ancestryOf(slot, -age), this.store.traitsLatent, slot * TRAIT_COUNT);
    }

    this.state.liveCount = this.store.liveCount;
    this.speciesFirstTick.set(0, 0);
    this.speciesPeak.set(0, this.state.liveCount);
  }

  /**
   * Fill one slot. `computePhenotype` runs here and nowhere else: the phenotype
   * is cached in the pools at birth and the tick loop never reads a genome.
   */
  private writeOrganism(
    slot: SlotIndex,
    spec: {
      id: OrganismId;
      motherId: OrganismId;
      fatherId: OrganismId;
      genome: Genome;
      x: number;
      y: number;
      parentArchetype: CladeArchetype;
      parentCladeId: number;
      speciesTag: number;
      rng: SeededRng;
      ageTicks: number;
      birthTick: number;
      energy: number;
      emitCladeFounding: boolean;
    },
  ): CladeArchetype {
    const state = this.state;
    const config = state.config;
    const pools = this.store;

    const anomalyZ = config.toggles.enableSpatialGxE
      ? this.ecology.temperatureAnomalyZAt(state, spec.x, spec.y)
      : 0;
    const phenotype = this.genetics.computePhenotype(spec.genome, spec.rng, config, {
      localTemperatureAnomalyZ: anomalyZ,
      parentArchetype: spec.parentArchetype,
    });

    const base = slot * TRAIT_COUNT;
    pools.traits.set(phenotype.traits, base);
    pools.traitsLatent.set(phenotype.traitsLatent, base);
    pools.traitsGenotypic.set(phenotype.genotypicValues, base);

    let cladeId = spec.parentCladeId;
    if (phenotype.archetype !== spec.parentArchetype) {
      cladeId = state.nextCladeId;
      state.nextCladeId += 1;
      if (spec.emitCladeFounding) {
        const event: CladeFoundingEvent = {
          kind: 'cladeFounding',
          tick: state.tick,
          cladeId,
          parentCladeId: spec.parentCladeId,
          archetype: phenotype.archetype,
          parentArchetype: spec.parentArchetype,
          founderId: spec.id,
          x: spec.x,
          y: spec.y,
        };
        state.events.push(event);
      }
    }

    pools.id[slot] = spec.id;
    pools.motherId[slot] = spec.motherId;
    pools.fatherId[slot] = spec.fatherId;
    pools.sex[slot] = sexToCode(karyotypeToSex(spec.genome.karyotype));
    pools.archetype[slot] = archetypeToCode(phenotype.archetype);
    pools.cladeId[slot] = cladeId;
    pools.speciesTag[slot] = spec.speciesTag;
    pools.demeId[slot] = demeAt(spec.x, spec.y, config);
    pools.x[slot] = spec.x;
    pools.y[slot] = spec.y;
    pools.vx[slot] = 0;
    pools.vy[slot] = 0;
    pools.energy[slot] = spec.energy;
    pools.gutFill[slot] = 0;
    pools.birthTick[slot] = spec.birthTick;
    pools.ageTicks[slot] = spec.ageTicks;
    pools.lastMatingTick[slot] = spec.birthTick;
    pools.behaviorState[slot] = BEHAVIOR_WANDER;
    pools.behaviorTimer[slot] = 0;
    pools.targetSlot[slot] = NO_SLOT;
    pools.steerX[slot] = 0;
    pools.steerY[slot] = 0;
    pools.speedFraction[slot] = 0;
    pools.genomes[slot] = spec.genome;

    return phenotype.archetype;
  }

  private ancestryOf(slot: SlotIndex, birthTick: number): AncestryRecord {
    const pools = this.store;
    return {
      id: pools.id[slot] ?? NO_ORGANISM,
      motherId: pools.motherId[slot] ?? NO_ORGANISM,
      fatherId: pools.fatherId[slot] ?? NO_ORGANISM,
      birthTick,
      deathTick: null,
      deathCause: null,
      birthX: pools.x[slot] ?? 0,
      birthY: pools.y[slot] ?? 0,
      speciesTag: pools.speciesTag[slot] ?? 0,
      cladeId: pools.cladeId[slot] ?? 0,
      sex: sexFromCode(pools.sex[slot] ?? SEX_FEMALE),
    };
  }

  // -------------------------------------------------------------------------
  // SimHandle
  // -------------------------------------------------------------------------

  step(ticks: number): readonly SimEvent[] {
    const drained: SimEvent[] = [];
    for (let index = 0; index < ticks; index += 1) {
      this.runTick();
      for (const event of this.state.events) drained.push(event);
      this.state.events.length = 0;
    }
    return drained;
  }

  stateHash(): string {
    return computeStateHash(this.state, this.store);
  }

  snapshot(): SimSnapshot {
    const species: SpeciesBookkeeping[] = [...this.speciesFirstTick.keys()]
      .sort((a, b) => a - b)
      .map((tag) => ({
        tag,
        firstTick: this.speciesFirstTick.get(tag) ?? 0,
        peakPopulation: this.speciesPeak.get(tag) ?? 0,
      }));
    return serializeSnapshot(this.state, this.store, this.configOverrides, species, this.stateHash());
  }

  sampleSlice(maxOrganisms?: number, recycle?: Float32Array, traitKey?: TraitKey): SampleSlice {
    const pools = this.store;
    const config = this.state.config;
    const limit = maxOrganisms === undefined ? this.state.liveCount : Math.max(0, Math.floor(maxOrganisms));
    const count = Math.min(this.state.liveCount, limit);
    const length = count * SAMPLE_SLICE_STRIDE;
    const buffer = recycle !== undefined && recycle.length === length ? recycle : new Float32Array(length);
    const traitIndex = traitKey === undefined ? -1 : TRAIT_INDEX[traitKey];
    const traitValues = traitIndex >= 0 ? new Float32Array(count) : undefined;

    let written = 0;
    for (let slot = 0; slot < pools.capacity && written < count; slot += 1) {
      if ((pools.alive[slot] ?? 0) === 0) continue;
      const base = written * SAMPLE_SLICE_STRIDE;
      buffer[base + SAMPLE_SLICE.slot] = slot;
      buffer[base + SAMPLE_SLICE.x] = pools.x[slot] ?? 0;
      buffer[base + SAMPLE_SLICE.y] = pools.y[slot] ?? 0;
      buffer[base + SAMPLE_SLICE.hue] = traitAt(pools, slot, T.displayHue);
      buffer[base + SAMPLE_SLICE.size] = traitAt(pools, slot, T.size);
      buffer[base + SAMPLE_SLICE.speciesTag] = pools.speciesTag[slot] ?? 0;
      buffer[base + SAMPLE_SLICE.cladeId] = pools.cladeId[slot] ?? 0;
      buffer[base + SAMPLE_SLICE.archetype] = pools.archetype[slot] ?? 0;
      buffer[base + SAMPLE_SLICE.energyFraction] =
        (pools.energy[slot] ?? 0) / energyCapacityOf(pools, slot, config);
      buffer[base + SAMPLE_SLICE.segmentCount] = traitAt(pools, slot, T.segmentCount);
      buffer[base + SAMPLE_SLICE.finPairs] = traitAt(pools, slot, T.finPairs);
      buffer[base + SAMPLE_SLICE.bodyAspect] = traitAt(pools, slot, T.bodyAspect);
      buffer[base + SAMPLE_SLICE.armorPlating] = traitAt(pools, slot, T.armorPlating);
      if (traitValues !== undefined) traitValues[written] = pools.traits[slot * TRAIT_COUNT + traitIndex] ?? 0;
      written += 1;
    }

    if (traitValues === undefined || traitKey === undefined) {
      return { tick: this.state.tick, count: written, buffer };
    }
    return { tick: this.state.tick, count: written, buffer, traitKey, traitValues };
  }

  select(x: number, y: number, radiusWu: number): OrganismDump | null {
    const pools = this.store;
    const radiusSq = radiusWu * radiusWu;
    let best = NO_SLOT;
    let bestDistanceSq = Infinity;

    for (let slot = 0; slot < pools.capacity; slot += 1) {
      if ((pools.alive[slot] ?? 0) === 0) continue;
      const dx = (pools.x[slot] ?? 0) - x;
      const dy = (pools.y[slot] ?? 0) - y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq <= radiusSq && distanceSq < bestDistanceSq) {
        best = slot;
        bestDistanceSq = distanceSq;
      }
    }
    if (best === NO_SLOT) return null;
    return this.dumpOrganism(best);
  }

  command(command: SimCommand): void {
    switch (command.kind) {
      case 'raiseBarrier':
        this.raiseBarrier(command.barrierId, command.shape, command.permeability);
        break;
      case 'lowerBarrier':
        this.lowerBarrier(command.barrierId);
        break;
      case 'setClimateTarget': {
        const previous = this.state.climate.targetOffsetC;
        this.state.climate.targetOffsetC = command.targetOffsetC;
        this.state.events.push({
          kind: 'climateEvent',
          tick: this.state.tick,
          cause: 'retarget',
          meanOffsetC: this.state.climate.meanOffsetC,
          deltaC: command.targetOffsetC - previous,
        });
        break;
      }
      case 'meteor':
        this.meteor(command.x, command.y, command.radiusWu);
        break;
      case 'introduceMutant':
        this.introduceMutant(command.count, command.locus, command.value, command.x, command.y);
        break;
      case 'trackSweep':
        this.stats.trackSweep(command.locus, command.allele, this.state.tick);
        break;
      case 'triggerDisturbance':
        this.triggerDisturbance(command.shock, command.magnitude, command.durationTicks, command.region ?? null);
        break;
      case 'setToggle':
        this.setToggle(command.toggle, command.value);
        break;
    }
  }

  series(sinceTick: number): readonly SampleRow[] {
    return this.stats.series(sinceTick);
  }

  phylogeny(): readonly PhylogenyNode[] {
    return this.stats.phylogeny();
  }

  demeOf(x: number, y: number): DemeId {
    return demeAt(x, y, this.state.config);
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  private runTick(): void {
    const state = this.state;
    state.tick += 1;

    this.stageEnvironment();
    this.stageBehavior();
    this.stageMovement();
    this.spatial.build(state);
    this.stageFeeding();
    this.stagePredation();
    this.stageMetabolism();
    this.applyDeaths();
    this.stageReproduction();
    this.applyBirths();
    // Two builds per tick, deliberately. Feeding/predation/mating consume the
    // post-movement build above — fresh positions, the input set the A7
    // campaign tuned the config against (a boundary-only build left their
    // candidates one stage stale and ran the world into the slot cap: P3
    // FAILED s2/s3 at spec length, births dropped). Behavior next tick
    // consumes THIS boundary build, which is a pure function of end-of-tick
    // SimState — the mid-tick build is not (pre-birth/death membership no
    // snapshot carries), and a restored run then diverges from the
    // uninterrupted one (P1 FAILED s5/s9). Both builds are cheap counting
    // sorts; P12 absorbs the second.
    this.spatial.build(state);
    this.stageRecording();

    state.rngState = this.rng.getState();
  }

  private stageEnvironment(): void {
    const state = this.state;
    const before = state.climate.meanOffsetC;
    this.ecology.updateFields(state, this.rng.fork(`fields:${state.tick}`));
    this.ecology.regrowResources(state);
    const after = state.climate.meanOffsetC;
    // Report on whole-degree crossings. Derived from the two values in hand
    // rather than from a remembered high-water mark, so a restored run narrates
    // the climate identically without the snapshot carrying extra state.
    if (Math.floor(after) !== Math.floor(before)) {
      state.events.push({
        kind: 'climateEvent',
        tick: state.tick,
        cause: 'walk',
        meanOffsetC: after,
        deltaC: after - before,
      });
    }
  }

  private stageBehavior(): void {
    const state = this.state;
    const pools = this.store;
    const rng = this.rng.fork(`behavior:${state.tick}`);
    const stagger = Math.max(1, Math.floor(state.config.time.decisionStaggerTicks));
    const decision = this.decision;

    for (let slot = 0; slot < pools.capacity; slot += 1) {
      if ((pools.alive[slot] ?? 0) === 0) continue;

      pools.ageTicks[slot] = (pools.ageTicks[slot] ?? 0) + 1;
      const timer = pools.behaviorTimer[slot] ?? 0;
      pools.behaviorTimer[slot] = timer >= 65_535 ? 65_535 : timer + 1;

      if ((slot + state.tick) % stagger !== 0) continue;

      decision.mode = pools.behaviorState[slot] ?? BEHAVIOR_WANDER;
      decision.steerX = pools.steerX[slot] ?? 0;
      decision.steerY = pools.steerY[slot] ?? 0;
      decision.speedFraction = pools.speedFraction[slot] ?? 0;
      decision.targetSlot = pools.targetSlot[slot] ?? NO_SLOT;

      this.ecology.decideBehavior(state, slot, this.spatial, rng, decision);

      pools.behaviorState[slot] = decision.mode;
      pools.steerX[slot] = decision.steerX;
      pools.steerY[slot] = decision.steerY;
      pools.speedFraction[slot] = decision.speedFraction;
      pools.targetSlot[slot] = decision.targetSlot;
      pools.behaviorTimer[slot] = 0;
    }
  }

  /**
   * Speed is `speedCap · thermalPerformance · speedFraction`: a fish outside its
   * thermal window swims worse, which is what couples the thermal traits to
   * everything else rather than leaving them a private hazard calculation.
   * Barriers are solid to movement and are resolved by sliding along them —
   * blocked diagonals fall back to the axis that is still open — so a ridge
   * separates two populations without teleporting or trapping anyone.
   */
  private stageMovement(): void {
    const state = this.state;
    const pools = this.store;
    const config = state.config;
    const barriers = state.barriers;
    const maxX = config.world.widthWu - 1e-3;
    const maxY = config.world.heightWu - 1e-3;

    if (this.thermalTaxConfig !== config) {
      this.thermalTaxWidth.fill(Number.NaN);
      this.thermalTaxConfig = config;
    }

    // Column references and the tax memo are loaded once. Reaching through
    // `pools.` and `this.` on every read is a property load per access, and at
    // ten reads per organism per tick that is a measurable share of the stage.
    const { alive, x: posX, y: posY, vx, vy, steerX, steerY, speedFraction, demeId, traits } = pools;
    const taxWidth = this.thermalTaxWidth;
    const taxValue = this.thermalTaxValue;
    const ecology = this.ecology;
    const capacity = pools.capacity;
    // Barriers are only solid where a spec was raised; with none up the mask is
    // uniformly open and the four probes below can only ever answer "open".
    const walled = barriers.specs.length > 0;

    for (let slot = 0; slot < capacity; slot += 1) {
      if ((alive[slot] ?? 0) === 0) continue;

      const x = posX[slot] ?? 0;
      const y = posY[slot] ?? 0;

      const temperature = ecology.temperatureAt(state, x, y);
      const base = slot * TRAIT_COUNT;
      const tOpt = traits[base + T.tOpt] ?? 0;
      const tWidth = traits[base + T.tWidth] ?? 0;
      let tax = taxValue[slot] ?? 0;
      if (taxWidth[slot] !== tWidth) {
        taxWidth[slot] = tWidth;
        taxValue[slot] = thermalTaxOf(tOpt, tWidth, config);
        // Read the memo back rather than keeping the double: a hit returns a
        // float32 and a miss must return the same number, or the first tick
        // after a restore differs from the run the snapshot came from (P1).
        tax = taxValue[slot] ?? 0;
      }
      const performance = thermalToleranceOf(temperature, tOpt, tWidth) * tax;
      const speed = (traits[base + T.speedCap] ?? 0) * performance * Math.max(0, speedFraction[slot] ?? 0);

      let dirX = steerX[slot] ?? 0;
      let dirY = steerY[slot] ?? 0;
      // `Math.hypot` rescales its arguments to survive overflow, which costs an
      // order of magnitude over the plain form and buys nothing here: both
      // components are steering directions bounded by the world size. The rest
      // of the sim already normalises with `sqrt(x² + y²)`.
      let length = Math.sqrt(dirX * dirX + dirY * dirY);
      if (length <= 1e-9) {
        dirX = vx[slot] ?? 0;
        dirY = vy[slot] ?? 0;
        length = Math.sqrt(dirX * dirX + dirY * dirY);
      }
      if (length <= 1e-9) {
        vx[slot] = 0;
        vy[slot] = 0;
        continue;
      }
      const dx = (dirX / length) * speed;
      const dy = (dirY / length) * speed;

      let nx = Math.min(maxX, Math.max(0, x + dx));
      let ny = Math.min(maxY, Math.max(0, y + dy));

      if (walled && permeabilityAt(barriers, x, y) > 0) {
        const target = permeabilityAt(barriers, nx, ny);
        if (target <= 0) {
          if (permeabilityAt(barriers, nx, y) > 0) {
            ny = y;
          } else if (permeabilityAt(barriers, x, ny) > 0) {
            nx = x;
          } else {
            nx = x;
            ny = y;
          }
        } else if (target < 1) {
          const dragX = Math.min(maxX, Math.max(0, x + dx * target));
          const dragY = Math.min(maxY, Math.max(0, y + dy * target));
          if (permeabilityAt(barriers, dragX, dragY) > 0) {
            nx = dragX;
            ny = dragY;
          } else {
            nx = x;
            ny = y;
          }
        }
      }

      vx[slot] = nx - x;
      vy[slot] = ny - y;
      posX[slot] = nx;
      posY[slot] = ny;
      demeId[slot] = demeAt(nx, ny, config);
    }
  }

  private stageFeeding(): void {
    const state = this.state;
    const pools = this.store;
    const config = state.config;
    const rng = this.rng.fork(`feeding:${state.tick}`);

    for (let slot = 0; slot < pools.capacity; slot += 1) {
      if ((pools.alive[slot] ?? 0) === 0) continue;
      const gained = this.ecology.applyFeeding(state, slot, rng);
      const capacity = energyCapacityOf(pools, slot, config);
      pools.energy[slot] = Math.min(capacity, (pools.energy[slot] ?? 0) + gained);
    }
  }

  private stagePredation(): void {
    const state = this.state;
    const pools = this.store;
    const rng = this.rng.fork(`predation:${state.tick}`);
    this.kills.reset();

    for (let slot = 0; slot < pools.capacity; slot += 1) {
      if ((pools.alive[slot] ?? 0) === 0) continue;
      this.ecology.tryPredation(state, slot, this.spatial, rng, this.kills);
    }
  }

  private stageMetabolism(): void {
    const state = this.state;
    const pools = this.store;
    const rng = this.rng.fork(`hazards:${state.tick}`);
    this.deaths.reset();

    for (let slot = 0; slot < pools.capacity; slot += 1) {
      if ((pools.alive[slot] ?? 0) === 0) continue;
      this.ecology.metabolismAndHazards(state, slot, rng, this.deaths);
    }
  }

  /**
   * Record a verdict for one slot, first claim wins. Returns false when the slot
   * is already spoken for, which is how a double kill is detected.
   */
  private markPending(slot: SlotIndex, causeCode: number, killerSlot: SlotIndex): boolean {
    if ((this.pendingCause[slot] ?? NO_CAUSE) !== NO_CAUSE) return false;
    this.pendingCause[slot] = causeCode;
    this.pendingKiller[slot] = killerSlot;
    this.pendingSlots[this.pendingCount] = slot;
    this.pendingCount += 1;
    return true;
  }

  /**
   * Drain both queues into a per-slot verdict, then emit in ascending slot order
   * and free in descending order. Predation is resolved first because it
   * happened first in the tick; a victim already claimed by an earlier kill or
   * already dead is ignored rather than double-counted.
   *
   * The verdicts are gathered into a list and sorted rather than recovered by
   * scanning every slot: a healthy tick kills a handful out of hundreds, and
   * two full sweeps of the pool to find them cost more than the deaths do.
   * Sorting restores the ascending order the emit sequence depends on.
   */
  private applyDeaths(): void {
    const state = this.state;
    const pools = this.store;
    const config = state.config;

    for (let index = 0; index < this.kills.count; index += 1) {
      const victim = this.kills.victims[index] ?? NO_SLOT;
      const predator = this.kills.predators[index] ?? NO_SLOT;
      if (victim < 0 || victim >= pools.capacity || (pools.alive[victim] ?? 0) === 0) {
        this.diagnostics.predationKillsIgnored += 1;
        continue;
      }
      if (!this.markPending(victim, CAUSE_CODE.predation, predator)) {
        this.diagnostics.predationKillsIgnored += 1;
        continue;
      }

      if (predator >= 0 && predator < pools.capacity && (pools.alive[predator] ?? 0) === 1) {
        const capacity = energyCapacityOf(pools, predator, config);
        pools.energy[predator] = Math.min(
          capacity,
          (pools.energy[predator] ?? 0) + (this.kills.yields[index] ?? 0),
        );
      }
    }

    for (let index = 0; index < this.deaths.count; index += 1) {
      const slot = this.deaths.slots[index] ?? NO_SLOT;
      if (slot < 0 || slot >= pools.capacity || (pools.alive[slot] ?? 0) === 0) continue;
      this.markPending(slot, this.deaths.causes[index] ?? CAUSE_CODE.starvation, this.deaths.killers[index] ?? NO_SLOT);
    }

    const pending = this.pendingSlots;
    const pendingCount = this.pendingCount;
    if (pendingCount === 0) {
      state.liveCount = this.store.liveCount;
      return;
    }
    for (let i = 1; i < pendingCount; i += 1) {
      const value = pending[i] ?? 0;
      let j = i - 1;
      while (j >= 0 && (pending[j] ?? 0) > value) {
        pending[j + 1] = pending[j] ?? 0;
        j -= 1;
      }
      pending[j + 1] = value;
    }

    for (let index = 0; index < pendingCount; index += 1) {
      const slot = pending[index] ?? 0;
      const code = this.pendingCause[slot] ?? NO_CAUSE;
      const cause = DEATH_CAUSES[code] ?? 'starvation';
      const id = pools.id[slot] ?? NO_ORGANISM;
      const killerSlot = this.pendingKiller[slot] ?? NO_SLOT;

      const dx = pools.x[slot] ?? 0;
      const dy = pools.y[slot] ?? 0;
      const age = pools.ageTicks[slot] ?? 0;
      const speciesTag = pools.speciesTag[slot] ?? 0;
      this.depositCarrion(dx, dy, traitAt(pools, slot, T.size));
      // `killerId` is genuinely absent for the three non-predation channels;
      // `exactOptionalPropertyTypes` means absent and `undefined` are not the
      // same thing, so the two shapes are built separately.
      const event: DeathEvent =
        killerSlot >= 0 && killerSlot < pools.capacity
          ? {
              kind: 'death',
              tick: state.tick,
              id,
              cause,
              x: dx,
              y: dy,
              ageTicks: age,
              speciesTag,
              killerId: pools.id[killerSlot] ?? NO_ORGANISM,
            }
          : { kind: 'death', tick: state.tick, id, cause, x: dx, y: dy, ageTicks: age, speciesTag };
      state.events.push(event);

      this.stats.onDeath(id, state.tick, cause);
      state.deathCounts[cause] += 1;
      this.diagnostics.deathsApplied += 1;
    }

    for (let index = pendingCount - 1; index >= 0; index -= 1) {
      const slot = pending[index] ?? 0;
      this.pendingCause[slot] = NO_CAUSE;
      this.pendingKiller[slot] = NO_SLOT;
      this.store.release(slot);
    }
    this.pendingCount = 0;

    state.liveCount = this.store.liveCount;
  }

  /**
   * Ready females survey suitors and queue their clutches. Nothing is written
   * to the pools here except the two parents' energy and mating ticks — the
   * offspring land in {@link applyBirths} at the stage boundary.
   *
   * Clutch size is the Poisson draw truncated to what both parents can actually
   * pay for, so energy is conserved by construction rather than by a
   * post-hoc `Math.max(0, …)` that would quietly mint energy.
   */
  private stageReproduction(): void {
    const state = this.state;
    const pools = this.store;
    const config = state.config;
    const rng = this.rng.fork(`repro:${state.tick}`);
    const costPerOffspring = config.metabolism.reproductionEnergyCost;
    this.births.length = 0;

    for (let slot = 0; slot < pools.capacity; slot += 1) {
      if ((pools.alive[slot] ?? 0) === 0) continue;
      if ((pools.sex[slot] ?? 0) !== SEX_FEMALE) continue;
      if (!isFemaleReady(state, slot)) continue;

      const male = this.mating.findMate(state, slot, this.spatial, rng);
      if (male === NO_SLOT) continue;

      let clutch = rng.poisson(config.mating.clutchLambda);
      if (costPerOffspring > 0) {
        const motherBudget = Math.floor((pools.energy[slot] ?? 0) / costPerOffspring);
        const fatherCost = paternalClutchCost(1, config);
        const fatherBudget =
          fatherCost > 0 ? Math.floor((pools.energy[male] ?? 0) / fatherCost) : Number.POSITIVE_INFINITY;
        clutch = Math.min(clutch, motherBudget, fatherBudget);
      }
      if (clutch <= 0) continue;

      pools.energy[slot] = (pools.energy[slot] ?? 0) - maternalClutchCost(clutch, config);
      pools.energy[male] = (pools.energy[male] ?? 0) - paternalClutchCost(clutch, config);
      pools.lastMatingTick[slot] = state.tick;
      pools.lastMatingTick[male] = state.tick;

      const motherId = pools.id[slot] ?? NO_ORGANISM;
      const fatherId = pools.id[male] ?? NO_ORGANISM;
      this.stats.onMating(motherId, fatherId, state.tick);
      state.matingCount += 1;
      this.diagnostics.matingsRealized += 1;
      if ((pools.speciesTag[slot] ?? 0) !== (pools.speciesTag[male] ?? 0)) state.crossSpeciesMatingCount += 1;

      const motherGenome = pools.genomes[slot];
      const fatherGenome = pools.genomes[male];
      if (motherGenome === undefined || fatherGenome === undefined) continue;

      const parentArchetype = archetypeFromCode(pools.archetype[slot] ?? 0);
      const parentCladeId = pools.cladeId[slot] ?? 0;
      const speciesTag = pools.speciesTag[slot] ?? 0;
      const mx = pools.x[slot] ?? 0;
      const my = pools.y[slot] ?? 0;

      for (let offspring = 0; offspring < clutch; offspring += 1) {
        const meiosis = this.genetics.makeOffspringGenome(rng, motherGenome, fatherGenome, config);
        const angle = rng.next() * Math.PI * 2;
        const distance = rng.next() * BIRTH_SCATTER_WU;
        const bx = Math.min(config.world.widthWu - 1e-3, Math.max(0, mx + Math.cos(angle) * distance));
        const by = Math.min(config.world.heightWu - 1e-3, Math.max(0, my + Math.sin(angle) * distance));
        const blocked = permeabilityAt(state.barriers, bx, by) <= 0;

        this.births.push({
          genome: meiosis.genome,
          mutations: [...meiosis.mutations],
          motherId,
          fatherId,
          parentArchetype,
          parentCladeId,
          speciesTag,
          x: blocked ? mx : bx,
          y: blocked ? my : by,
        });
      }
    }
  }

  private applyBirths(): void {
    const state = this.state;
    const config = state.config;
    if (this.births.length === 0) return;
    const rng = this.rng.fork(`birth:${state.tick}`);

    for (const pending of this.births) {
      const slot = this.store.allocate();
      if (slot === NO_SLOT) {
        // The cap is a memory bound, not an ecological one (P3 fails if it
        // binds); dropping loudly is what keeps that distinction measurable.
        this.diagnostics.birthsDropped += 1;
        continue;
      }

      const id = state.nextOrganismId;
      state.nextOrganismId += 1;

      this.writeOrganism(slot, {
        id,
        motherId: pending.motherId,
        fatherId: pending.fatherId,
        genome: pending.genome,
        x: pending.x,
        y: pending.y,
        parentArchetype: pending.parentArchetype,
        parentCladeId: pending.parentCladeId,
        speciesTag: pending.speciesTag,
        rng,
        ageTicks: 0,
        birthTick: state.tick,
        energy: config.metabolism.birthEnergy,
        emitCladeFounding: true,
      });

      this.stats.onBirth(this.ancestryOf(slot, state.tick), this.store.traitsLatent, slot * TRAIT_COUNT);
      const event: BirthEvent = {
        kind: 'birth',
        tick: state.tick,
        id,
        motherId: pending.motherId,
        fatherId: pending.fatherId,
        x: pending.x,
        y: pending.y,
        speciesTag: this.store.speciesTag[slot] ?? 0,
        cladeId: this.store.cladeId[slot] ?? 0,
        mutations: pending.mutations,
      };
      state.events.push(event);
      this.diagnostics.birthsApplied += 1;
    }

    this.births.length = 0;
    state.liveCount = this.store.liveCount;
  }

  private stageRecording(): void {
    const state = this.state;
    const config = state.config;

    if (state.tick % Math.max(1, config.speciation.detectorIntervalTicks) === 0) {
      this.runSpeciesDetection();
    }

    for (const event of state.events) this.stats.onEvent(event);

    if (state.tick % Math.max(1, config.sampling.sampleIntervalTicks) === 0) {
      this.stats.sample(state, state.tick);
      // Events stats raised for itself (today: `sweepCrossedHalf`) join this
      // tick's output but must not be fed back through `onEvent` — the recorder
      // has already accounted for them. Merging after the forwarding loop above
      // is what keeps that true.
      for (const event of this.stats.drainRaisedEvents()) state.events.push(event);
      this.stats.collectAncestry(state);
    }
  }

  private runSpeciesDetection(): void {
    const state = this.state;
    const pools = this.store;
    const result = this.stats.estimators.detectSpecies(state);

    let maxTag = state.nextSpeciesTag - 1;
    for (let slot = 0; slot < pools.capacity; slot += 1) {
      if ((pools.alive[slot] ?? 0) === 0) continue;
      const assigned = result.assignments[slot] ?? -1;
      if (assigned < 0) continue;
      pools.speciesTag[slot] = assigned;
      if (assigned > maxTag) maxTag = assigned;
    }
    state.nextSpeciesTag = maxTag + 1;

    for (const split of result.splits) {
      state.events.push({
        kind: 'speciesSplit',
        tick: state.tick,
        parentTag: split.parentTag,
        childTags: split.childTags,
        crossMatingRate: split.crossMatingRate,
        sizes: split.sizes,
      });
      for (const tag of split.childTags) {
        if (!this.speciesFirstTick.has(tag)) this.speciesFirstTick.set(tag, state.tick);
      }
    }

    const counts = new Map<number, number>();
    for (let slot = 0; slot < pools.capacity; slot += 1) {
      if ((pools.alive[slot] ?? 0) === 0) continue;
      const tag = pools.speciesTag[slot] ?? 0;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
      if (!this.speciesFirstTick.has(tag)) this.speciesFirstTick.set(tag, state.tick);
    }
    for (const [tag, count] of counts) {
      if (count > (this.speciesPeak.get(tag) ?? 0)) this.speciesPeak.set(tag, count);
    }

    for (const tag of result.extinctions) {
      state.events.push({
        kind: 'speciesExtinction',
        tick: state.tick,
        tag,
        lifetimeTicks: state.tick - (this.speciesFirstTick.get(tag) ?? state.tick),
        peakPopulation: this.speciesPeak.get(tag) ?? 0,
      });
      this.speciesFirstTick.delete(tag);
      this.speciesPeak.delete(tag);
    }
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  private raiseBarrier(barrierId: string, shape: BarrierSpec['shape'], permeability: number): void {
    const state = this.state;
    const spec: BarrierSpec = { id: barrierId, shape, permeability, raisedTick: state.tick };
    const existing = state.barriers.specs.findIndex((candidate) => candidate.id === barrierId);
    if (existing >= 0) state.barriers.specs.splice(existing, 1);
    state.barriers.specs.push(spec);

    this.ecology.rebuildBarrierMask(state);
    this.evictFromBarriers();

    state.events.push({ kind: 'barrierChange', tick: state.tick, change: 'raised', barrier: { ...spec } });
  }

  private lowerBarrier(barrierId: string): void {
    const state = this.state;
    const index = state.barriers.specs.findIndex((candidate) => candidate.id === barrierId);
    if (index < 0) return;
    const removed = state.barriers.specs[index];
    state.barriers.specs.splice(index, 1);
    this.ecology.rebuildBarrierMask(state);
    if (removed !== undefined) {
      state.events.push({ kind: 'barrierChange', tick: state.tick, change: 'lowered', barrier: { ...removed } });
    }
  }

  /**
   * Push anyone standing where a barrier just appeared out to the nearest open
   * water. Without this an organism inside the new wall is stuck forever, and
   * P8's "nobody is ever inside the ridge" assertion would be false from tick
   * one for reasons that have nothing to do with the movement rule.
   */
  private evictFromBarriers(): void {
    const state = this.state;
    const pools = this.store;
    const barriers = state.barriers;
    const step = barriers.cellSizeWu;
    const maxX = state.config.world.widthWu - 1e-3;
    const maxY = state.config.world.heightWu - 1e-3;

    for (let slot = 0; slot < pools.capacity; slot += 1) {
      if ((pools.alive[slot] ?? 0) === 0) continue;
      const x = pools.x[slot] ?? 0;
      const y = pools.y[slot] ?? 0;
      if (permeabilityAt(barriers, x, y) > 0) continue;

      let bestX = x;
      let bestY = y;
      let bestDistance = Infinity;
      for (let cell = 1; cell <= EVICTION_SCAN_CELLS && bestDistance === Infinity; cell += 1) {
        const offset = cell * step;
        const candidates: readonly (readonly [number, number])[] = [
          [Math.min(maxX, x + offset), y],
          [Math.max(0, x - offset), y],
          [x, Math.min(maxY, y + offset)],
          [x, Math.max(0, y - offset)],
        ];
        for (const [cx, cy] of candidates) {
          if (permeabilityAt(barriers, cx, cy) <= 0) continue;
          const distance = Math.hypot(cx - x, cy - y);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestX = cx;
            bestY = cy;
          }
        }
      }
      pools.x[slot] = bestX;
      pools.y[slot] = bestY;
      pools.vx[slot] = 0;
      pools.vy[slot] = 0;
      pools.demeId[slot] = demeAt(bestX, bestY, state.config);
    }
  }

  private meteor(x: number, y: number, radiusWu: number): void {
    const state = this.state;
    const pools = this.store;
    const radiusSq = radiusWu * radiusWu;
    let killed = 0;

    for (let slot = 0; slot < pools.capacity; slot += 1) {
      if ((pools.alive[slot] ?? 0) === 0) continue;
      const dx = (pools.x[slot] ?? 0) - x;
      const dy = (pools.y[slot] ?? 0) - y;
      if (dx * dx + dy * dy > radiusSq) continue;
      if (this.markPending(slot, CAUSE_CODE.catastrophe, NO_SLOT)) killed += 1;
    }

    if (killed > 0) {
      this.kills.reset();
      this.deaths.reset();
      this.applyDeaths();
    }
    state.events.push({ kind: 'meteor', tick: state.tick, x, y, radiusWu, killed });
  }

  private depositCarrion(x: number, y: number, biomass: number): void {
    const state = this.state;
    if (!state.config.toggles.enableDisturbances) return;
    const field = state.field;
    const col = Math.floor(x / field.cellSizeWu);
    const row = Math.floor(y / field.cellSizeWu);
    if (col < 0 || row < 0 || col >= field.cols || row >= field.rows) return;
    const cell = row * field.cols + col;
    field.carrion[cell] = (field.carrion[cell] ?? 0) + state.config.carrion.depositFraction * Math.max(0, biomass);
  }

  private triggerDisturbance(
    shock: 'thermal' | 'planktonCrash' | 'kelpStorm',
    magnitude: number,
    durationTicks: number,
    region: DisturbanceRegion | null,
  ): void {
    const state = this.state;
    if (!state.config.toggles.enableDisturbances) return;
    const duration = Math.max(1, Math.round(durationTicks));
    if (shock === 'thermal') {
      state.disturbance.thermal.push({
        kind: 'thermal',
        startedTick: state.tick,
        magnitudeC: magnitude,
        durationTicks: duration,
        remainingTicks: duration,
      });
      state.events.push({ kind: 'thermalShock', tick: state.tick, magnitudeC: magnitude, durationTicks: duration });
      return;
    }
    if (shock === 'planktonCrash') {
      state.disturbance.planktonCrashes.push({
        kind: 'planktonCrash',
        startedTick: state.tick,
        productivityMultiplier: magnitude,
        durationTicks: duration,
        remainingTicks: duration,
        region,
      });
      state.events.push({
        kind: 'planktonCrash',
        tick: state.tick,
        productivityMultiplier: magnitude,
        durationTicks: duration,
        region,
      });
      return;
    }
    if (region === null) throw new Error('A scripted kelp storm requires a region.');
    state.disturbance.kelpStorms.push({
      kind: 'kelpStorm',
      startedTick: state.tick,
      clearFraction: magnitude,
      durationTicks: duration,
      remainingTicks: duration,
      region,
    });
    this.clearKelp(region, magnitude);
    state.events.push({ kind: 'kelpStorm', tick: state.tick, clearFraction: magnitude, durationTicks: duration, region });
  }

  private clearKelp(region: DisturbanceRegion, fraction: number): void {
    const field = this.state.field;
    for (let row = 0; row < field.rows; row += 1) {
      const y = (row + 0.5) * field.cellSizeWu;
      for (let col = 0; col < field.cols; col += 1) {
        const x = (col + 0.5) * field.cellSizeWu;
        if (!inDisturbanceRegion(region, x, y)) continue;
        const cell = row * field.cols + col;
        field.kelp[cell] = (field.kelp[cell] ?? 0) * (1 - fraction);
      }
    }
  }

  /**
   * Inject edited individuals. The genome is copied from a living organism
   * rather than freshly founded, so the edit lands on the population's current
   * genetic background — P10 measures the fate of one allele, not of a founder
   * genotype dropped into a hundred generations of adaptation.
   */
  private introduceMutant(
    count: number,
    locus: QuantLocusId | DiscreteLocusId,
    value: number,
    x?: number,
    y?: number,
  ): void {
    const state = this.state;
    const config = state.config;
    const pools = this.store;
    // `nextOrganismId` is a monotone, snapshot-carried nonce, so the same
    // command at the same tick of a restored run draws the same stream.
    const rng = this.rng.fork(`command:introduceMutant:${state.tick}:${state.nextOrganismId}`);

    const liveSlots: SlotIndex[] = [];
    for (let slot = 0; slot < pools.capacity; slot += 1) {
      if ((pools.alive[slot] ?? 0) === 1) liveSlots.push(slot);
    }

    for (let index = 0; index < count; index += 1) {
      const source = liveSlots.length > 0 ? (liveSlots[rng.int(0, liveSlots.length - 1)] ?? NO_SLOT) : NO_SLOT;
      const base =
        source === NO_SLOT
          ? this.genetics.buildFounderGenome(rng, config, index % 2 === 0 ? 'female' : 'male')
          : (pools.genomes[source] ?? this.genetics.buildFounderGenome(rng, config));
      const genome = this.genetics.applyAlleleEdit(base, locus, value, config);

      const slot = this.store.allocate();
      if (slot === NO_SLOT) {
        this.diagnostics.birthsDropped += 1;
        continue;
      }

      const px = x ?? (source === NO_SLOT ? rng.next() * config.world.widthWu : (pools.x[source] ?? 0));
      const py = y ?? (source === NO_SLOT ? rng.next() * config.world.heightWu : (pools.y[source] ?? 0));
      const id = state.nextOrganismId;
      state.nextOrganismId += 1;

      this.writeOrganism(slot, {
        id,
        motherId: NO_ORGANISM,
        fatherId: NO_ORGANISM,
        genome,
        x: px,
        y: py,
        parentArchetype: source === NO_SLOT ? ANCESTRAL_ARCHETYPE : archetypeFromCode(pools.archetype[source] ?? 0),
        parentCladeId: source === NO_SLOT ? 0 : (pools.cladeId[source] ?? 0),
        speciesTag: source === NO_SLOT ? 0 : (pools.speciesTag[source] ?? 0),
        rng,
        ageTicks: config.time.maturityTicks,
        birthTick: state.tick - config.time.maturityTicks,
        energy: config.metabolism.birthEnergy,
        emitCladeFounding: true,
      });

      this.stats.onBirth(this.ancestryOf(slot, state.tick), this.store.traitsLatent, slot * TRAIT_COUNT);
      const event: MutantIntroducedEvent = {
        kind: 'mutantIntroduced',
        tick: state.tick,
        id,
        source: 'god',
        locus,
        value,
        deme: demeAt(px, py, config),
      };
      state.events.push(event);
    }

    state.liveCount = this.store.liveCount;
  }

  private setToggle(toggle: string, value: boolean): void {
    const current = this.state.config.toggles as unknown as Record<string, boolean>;
    if (!Object.prototype.hasOwnProperty.call(current, toggle)) {
      throw new Error(`Unknown mechanism toggle '${toggle}'.`);
    }
    const merged: Partial<MechanismToggles> = {
      ...(this.configOverrides.toggles ?? {}),
      [toggle]: value,
    };
    this.configOverrides = { ...this.configOverrides, toggles: merged };
    this.state.config = resolveSimConfig(this.configOverrides);
    if (toggle === 'enableDisturbances' && !value) {
      this.state.disturbance.thermal.length = 0;
      this.state.disturbance.planktonCrashes.length = 0;
      this.state.disturbance.kelpStorms.length = 0;
      this.state.field.carrion.fill(0);
    }
  }

  // -------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------

  private dumpOrganism(slot: SlotIndex): OrganismDump {
    const state = this.state;
    const pools = this.store;
    const config = state.config;
    const genome = pools.genomes[slot];

    const traits = unpackTraits(pools.traits, slot);
    const traitsLatent = unpackTraits(pools.traitsLatent, slot);
    const traitsGenotypic = unpackTraits(pools.traitsGenotypic, slot);
    const traitPercentiles = this.traitPercentiles(slot);

    const quantLoci: GenomeLocusDump[] = QUANT_LOCI.map((locus) => ({
      locus: locus.id,
      label: locus.label,
      maternal: genome?.quant[quantAlleleIndex(0, locus.index)] ?? 0,
      paternal: genome?.quant[quantAlleleIndex(1, locus.index)] ?? 0,
      loads: W_BY_LOCUS[locus.id].map((entry) => ({ trait: entry.trait, weight: entry.weight })),
    }));

    const discreteLoci: DiscreteLocusDump[] = DISCRETE_LOCI.map((locus) => ({
      locus: locus.id,
      label: locus.label,
      maternal: genome?.discrete[discreteAlleleIndex(0, locus.index)] ?? 0,
      paternal: genome?.discrete[discreteAlleleIndex(1, locus.index)] ?? 0,
    }));

    const ancestors: AncestryRecord[] = [];
    const seen = new Set<OrganismId>();
    let frontier: OrganismId[] = [pools.motherId[slot] ?? NO_ORGANISM, pools.fatherId[slot] ?? NO_ORGANISM];
    for (let generation = 0; generation < DUMP_ANCESTOR_GENERATIONS; generation += 1) {
      const next: OrganismId[] = [];
      for (const id of frontier) {
        if (id === NO_ORGANISM || seen.has(id)) continue;
        seen.add(id);
        const record = this.stats.ancestry(id);
        if (record === undefined) continue;
        ancestors.push(record);
        next.push(record.motherId, record.fatherId);
      }
      frontier = next;
    }

    return {
      id: pools.id[slot] ?? NO_ORGANISM,
      slot,
      sex: karyotypeToSex(genome?.karyotype ?? 'XX'),
      karyotype: genome?.karyotype ?? 'XX',
      ageTicks: pools.ageTicks[slot] ?? 0,
      birthTick: pools.birthTick[slot] ?? 0,
      x: pools.x[slot] ?? 0,
      y: pools.y[slot] ?? 0,
      energy: pools.energy[slot] ?? 0,
      energyCapacity: energyCapacityOf(pools, slot, config),
      speciesTag: pools.speciesTag[slot] ?? 0,
      cladeId: pools.cladeId[slot] ?? 0,
      archetype: archetypeFromCode(pools.archetype[slot] ?? 0),
      deme: pools.demeId[slot] ?? 0,
      motherId: pools.motherId[slot] ?? NO_ORGANISM,
      fatherId: pools.fatherId[slot] ?? NO_ORGANISM,
      traits,
      traitsLatent,
      traitsGenotypic,
      traitPercentiles,
      quantLoci,
      discreteLoci,
      ancestors,
    };
  }

  /** Rank of this organism's expressed traits within the living population; context is what makes a number readable. */
  private traitPercentiles(slot: SlotIndex): Record<TraitKey, number> {
    const pools = this.store;
    const out = {} as Record<TraitKey, number>;
    const denominator = Math.max(1, this.state.liveCount - 1);

    for (let traitIndex = 0; traitIndex < TRAIT_COUNT; traitIndex += 1) {
      const target = pools.traits[slot * TRAIT_COUNT + traitIndex] ?? 0;
      let below = 0;
      for (let other = 0; other < pools.capacity; other += 1) {
        if (other === slot || (pools.alive[other] ?? 0) === 0) continue;
        if ((pools.traits[other * TRAIT_COUNT + traitIndex] ?? 0) < target) below += 1;
      }
      out[TRAIT_KEYS[traitIndex] as TraitKey] = Math.min(1, below / denominator);
    }
    return out;
  }
}

/** The engine's entry point (WP-A3, wired by WP-A5). */
export function createSim(options: CreateSimOptions): SimHandleInternal {
  return new PanthalassaSim(options);
}

/** Compile-time proof that {@link createSim} still satisfies the frozen `CreateSim` contract. */
export const createSimAsContract: CreateSim = createSim;

/** Re-exported so probes that build a `SimModules` do not have to reach into `mating.ts`. */
export { createMating };
