/**
 * The recorder: `StatsApi` over the sim.
 *
 * The engine calls the `on*` hooks at stage boundaries and `sample` every
 * `sampling.sampleIntervalTicks`. One sample walks the living population exactly
 * once and derives every column of a `SampleRow` from that single pass —
 * population structure, trait moments on the latent scale, additive variance
 * from the cached genotypic values, allele frequencies at all twelve discrete
 * loci, and the popgen estimates — because a sample that walked the pool five
 * times would be the most expensive thing in the tick budget at 256×.
 *
 * ## What this mutates on `SimState`
 *
 * `deathCounts`, `matingCount` and `crossSpeciesMatingCount` are documented in
 * `types.ts` as "since the last sample row, reset by the recorder", so `sample`
 * zeroes them on the way out. Nothing else on `SimState` is written here — a
 * `sweepCrossedHalf` detected during a sample goes into the recorder's own
 * buffer for the engine to collect with `drainRaisedEvents()`, and the species
 * detector separately allocates tags from `nextSpeciesTag`.
 */

import type { StatsApi } from '../contracts/apis';
import type { SimEvent } from '../contracts/events';
import { CLADE_ARCHETYPES, DISCRETE_LOCI, discreteGenotype } from '../contracts/genome';
import type { DiscreteLocusId } from '../contracts/genome';
import type {
  AncestryRecord,
  GroupCount,
  PhylogenyNode,
  PopgenSample,
  ProbeSeriesLine,
  ResourceSample,
  SampleRow,
  TraitSample,
} from '../contracts/stats';
import { TRAIT_COUNT, TRAIT_INDEX, TRAIT_KEYS } from '../contracts/traits';
import type { TraitKey } from '../contracts/traits';
import { DEATH_CAUSES, archetypeFromCode, demeAt, demeCount } from '../contracts/types';
import type {
  CladeId,
  DeathCause,
  OrganismId,
  SimConfig,
  SimState,
  SpeciesTag,
} from '../contracts/types';
import { AncestryStore, PhylogenyStore } from './ancestry';
import type { LineageSummary, SpeciesObservation } from './ancestry';
import { PopgenEngine, meanExpectedHeterozygosity, neutralAlleleFrequencies } from './popgen';
import { GrowableColumn, Welford } from './shared';
import { thermalShockOffsetC } from '../sim/ecology/disturbances';

export interface StatsOptions {
  readonly config: SimConfig;
}

/** The recorder's own surface, beyond the frozen `StatsApi` the engine sees. */
export interface StatsRecorderApi extends StatsApi {
  /** Named scalar series in plot-ready form; see `columnNames`. */
  column(name: string): Float64Array | null;
  columnNames(): readonly string[];
  /** Rows after `sinceTick` as JSONL `ProbeSeriesLine`s, for `runs/`. */
  toJsonl(scenario: string, seed: string, sinceTick?: number): string;
  /** Per-lineage counts for everything the ancestry GC has compacted away. */
  lineageSummaries(): readonly LineageSummary[];
  ancestry(id: OrganismId): AncestryRecord | undefined;
  /** Ancestral path from an organism upward, for the inspector. */
  lineage(id: OrganismId, maxRecords?: number): readonly AncestryRecord[];
  /** True when nothing on the path from `id` to its founders has been collected. */
  hasCompleteAncestry(id: OrganismId): boolean;
  /** Mean allelic value and allelic variance per quantitative locus. */
  quantLocusMoments(state: SimState): { readonly mean: Float64Array; readonly variance: Float64Array };
  readonly estimators: PopgenEngine;
}

interface SpeciesAccumulator {
  count: number;
  clades: Map<CladeId, number>;
  archetypes: number[];
}

interface FrequencySnapshot {
  readonly tick: number;
  readonly frequencies: number[][];
}

interface TrackedSweep {
  readonly locus: DiscreteLocusId;
  readonly allele: number;
  readonly introducedTick: number;
  fired: boolean;
}

export class StatsRecorder implements StatsRecorderApi {
  readonly estimators: PopgenEngine;

  private readonly config: SimConfig;

  private readonly ancestryStore: AncestryStore;
  private readonly phylogenyStore: PhylogenyStore;

  /**
   * Rows are kept for the whole run. At 200 ticks a row a 600-generation probe
   * produces under 3000 of them; an ambient run that goes for days is what
   * Phase C's persistence layer is for, and truncating here would silently break
   * a probe window instead.
   */
  private readonly rows: SampleRow[] = [];
  private readonly rowTicks = new GrowableColumn();
  private readonly columns = new Map<string, GrowableColumn>();

  private readonly latentMoments: Welford[] = [];
  private readonly genotypicMoments: Welford[] = [];
  private readonly discreteCounts: Float64Array[] = [];

  private readonly frequencyHistory: FrequencySnapshot[] = [];
  private readonly sweeps = new Map<string, TrackedSweep>();
  /** Events raised by `sample()`, waiting for the engine's `drainRaisedEvents()`. */
  private raised: SimEvent[] = [];

  constructor(options: StatsOptions) {
    this.config = options.config;
    this.estimators = new PopgenEngine(options.config);
    this.ancestryStore = new AncestryStore(options.config);
    this.phylogenyStore = new PhylogenyStore();
    this.estimators.useBreederSource(this.ancestryStore);

    for (let index = 0; index < TRAIT_COUNT; index += 1) {
      this.latentMoments.push(new Welford());
      this.genotypicMoments.push(new Welford());
    }
    for (const locus of DISCRETE_LOCI) this.discreteCounts.push(new Float64Array(locus.alleleCount));
  }

  // -- hooks ----------------------------------------------------------------

  /**
   * Pedigree entry, parentage log, and the newborn's phenotype.
   *
   * The phenotype is taken **here**, at the birth, rather than the first time
   * the organism turns up alive in a `sample()` walk. Waiting conditioned the
   * midparent regression on surviving two hundred ticks, and juvenile mortality
   * in this model is trait-dependent, so the slope was an estimate of
   * heritability among survivors — biased by exactly the selection P13 exists
   * to notice (Gate A-1 defect 8). Nor can the phenotype be recovered later:
   * the pool's free list is LIFO, so a dead juvenile's slot is overwritten
   * within a tick or two.
   *
   * `traitsLatent`/`traitOffset` are a borrowed view of a live pool column,
   * valid only for this call; `observe` copies out of it. Absent — the staged
   * optional form, and the god-mutant path until the engine's riders land — no
   * phenotype is recorded rather than a fabricated one, and the sample walk
   * remains the fallback for anyone still alive at the next boundary.
   */
  onBirth(record: AncestryRecord, traitsLatent?: Float32Array, traitOffset?: number): void {
    this.ancestryStore.record(record);
    this.estimators.recordBirth(record.id, record.motherId, record.fatherId, record.birthTick);
    if (traitsLatent === undefined || traitOffset === undefined) return;
    this.estimators.observe(record.id, record.motherId, record.fatherId, traitsLatent, traitOffset);
  }

  onDeath(id: OrganismId, tick: number, cause: DeathCause): void {
    this.ancestryStore.markDead(id, tick, cause);
  }

  onMating(motherId: OrganismId, fatherId: OrganismId, tick: number): void {
    this.estimators.recordMating(motherId, fatherId, tick);
  }

  onEvent(event: SimEvent): void {
    this.phylogenyStore.consume(event);
    switch (event.kind) {
      case 'cladeFounding':
        this.ancestryStore.pin(event.founderId);
        break;
      case 'mutantIntroduced':
        this.ancestryStore.pin(event.id);
        break;
      case 'sweepCrossedHalf': {
        // Idempotent: if the engine replays a sweep event we must not raise it
        // again from the next sample.
        const tracked = this.sweeps.get(sweepKey(event.locus, event.allele));
        if (tracked !== undefined) tracked.fired = true;
        break;
      }
      default:
        break;
    }
  }

  trackSweep(locus: DiscreteLocusId, allele: number, tick: number): void {
    const key = sweepKey(locus, allele);
    if (this.sweeps.has(key)) return;
    this.sweeps.set(key, { locus, allele, introducedTick: tick, fired: false });
  }

  /**
   * Hand the engine anything `sample()` raised. Empty on every tick that did not
   * sample, and empty again immediately after — the engine merges these into the
   * tick's event list and must not feed them back through `onEvent`, since the
   * sweep tracker has already marked them fired.
   */
  drainRaisedEvents(): readonly SimEvent[] {
    if (this.raised.length === 0) return [];
    const drained = this.raised;
    this.raised = [];
    return drained;
  }

  // -- sampling -------------------------------------------------------------

  sample(state: SimState, tick: number): SampleRow {
    const { config } = this;
    const pop = state.pop;
    const genotypic = pop.traitsGenotypic;

    for (const accumulator of this.latentMoments) accumulator.reset();
    for (const accumulator of this.genotypicMoments) accumulator.reset();
    for (const counts of this.discreteCounts) counts.fill(0);

    const demes = new Float64Array(demeCount(config));
    const archetypes = new Array<number>(CLADE_ARCHETYPES.length).fill(0);
    const bySpecies = new Map<SpeciesTag, SpeciesAccumulator>();
    const byClade = new Map<CladeId, number>();

    const dietIndex = TRAIT_INDEX.diet;
    const attackIndex = TRAIT_INDEX.attack;
    const defenseIndex = TRAIT_INDEX.defense;
    let predators = 0;
    let dietSum = 0;
    let attackSum = 0;
    let defenseSum = 0;
    let population = 0;
    let genomeCopies = 0;

    for (let slot = 0; slot < pop.capacity; slot += 1) {
      if (pop.alive[slot] !== 1) continue;
      population += 1;
      const id = pop.id[slot] ?? 0;
      const base = slot * TRAIT_COUNT;

      for (let traitIndex = 0; traitIndex < TRAIT_COUNT; traitIndex += 1) {
        this.latentMoments[traitIndex]?.push(pop.traitsLatent[base + traitIndex] ?? 0);
        this.genotypicMoments[traitIndex]?.push(genotypic[base + traitIndex] ?? 0);
      }

      // Expressed `diet` is the logistic share, so the guild boundary is 0.5.
      const expressedDiet = pop.traits[base + dietIndex] ?? 0;
      if (expressedDiet > 0.5) predators += 1;
      dietSum += expressedDiet;
      attackSum += pop.traitsLatent[base + attackIndex] ?? 0;
      defenseSum += pop.traitsLatent[base + defenseIndex] ?? 0;

      const deme = demeAt(pop.x[slot] ?? 0, pop.y[slot] ?? 0, config);
      if (deme >= 0 && deme < demes.length) demes[deme] = (demes[deme] ?? 0) + 1;

      const archetypeCode = pop.archetype[slot] ?? 0;
      if (archetypeCode < archetypes.length) archetypes[archetypeCode] = (archetypes[archetypeCode] ?? 0) + 1;

      const cladeId = pop.cladeId[slot] ?? 0;
      byClade.set(cladeId, (byClade.get(cladeId) ?? 0) + 1);

      const tag = pop.speciesTag[slot] ?? 0;
      let species = bySpecies.get(tag);
      if (species === undefined) {
        species = { count: 0, clades: new Map(), archetypes: new Array<number>(CLADE_ARCHETYPES.length).fill(0) };
        bySpecies.set(tag, species);
      }
      species.count += 1;
      species.clades.set(cladeId, (species.clades.get(cladeId) ?? 0) + 1);
      if (archetypeCode < species.archetypes.length) {
        species.archetypes[archetypeCode] = (species.archetypes[archetypeCode] ?? 0) + 1;
      }

      const genome = pop.genomes[slot];
      if (genome !== undefined) {
        genomeCopies += 2;
        for (let locusIndex = 0; locusIndex < DISCRETE_LOCI.length; locusIndex += 1) {
          const counts = this.discreteCounts[locusIndex];
          if (counts === undefined) continue;
          const [first, second] = discreteGenotype(genome, locusIndex);
          if (first < counts.length) counts[first] = (counts[first] ?? 0) + 1;
          if (second < counts.length) counts[second] = (counts[second] ?? 0) + 1;
        }
      }

      // The fallback path. `onBirth` is where a phenotype normally enters, so
      // this is a no-op for anyone already cached; it exists for organisms the
      // engine introduced without a latent view.
      this.estimators.observe(id, pop.motherId[slot] ?? 0, pop.fatherId[slot] ?? 0, pop.traitsLatent, base);
    }

    const generation = tick / config.time.generationTicks;
    const windowStart = tick - config.time.generationTicks;

    const traits = {} as Record<TraitKey, TraitSample>;
    for (let traitIndex = 0; traitIndex < TRAIT_COUNT; traitIndex += 1) {
      const key = TRAIT_KEYS[traitIndex] as TraitKey;
      const latent = this.latentMoments[traitIndex];
      const phenotypicVariance = latent?.variance ?? 0;
      const additiveVariance = this.genotypicMoments[traitIndex]?.variance ?? 0;
      traits[key] = {
        mean: latent?.mean ?? 0,
        sd: latent?.sd ?? 0,
        additiveVariance,
        phenotypicVariance,
        heritability: phenotypicVariance > 0 ? additiveVariance / phenotypicVariance : Number.NaN,
      };
    }

    const discreteAlleleFreq = {} as Record<DiscreteLocusId, readonly number[]>;
    for (let locusIndex = 0; locusIndex < DISCRETE_LOCI.length; locusIndex += 1) {
      const locus = DISCRETE_LOCI[locusIndex];
      const counts = this.discreteCounts[locusIndex];
      if (locus === undefined || counts === undefined) continue;
      const row = new Array<number>(counts.length).fill(0);
      if (genomeCopies > 0) {
        for (let allele = 0; allele < counts.length; allele += 1) row[allele] = (counts[allele] ?? 0) / genomeCopies;
      }
      discreteAlleleFreq[locus.id] = row;
    }

    const neutralFrequencies = neutralAlleleFrequencies(state);
    const popgen = this.popgenSample(state, tick, neutralFrequencies);
    this.pushFrequencySnapshot(tick, neutralFrequencies);
    this.raiseSweepEvents(tick, discreteAlleleFreq);

    const deaths = {} as Record<DeathCause, number>;
    for (const cause of DEATH_CAUSES) {
      deaths[cause] = state.deathCounts[cause] ?? 0;
      state.deathCounts[cause] = 0;
    }
    const matings = state.matingCount;
    const crossSpeciesMatings = state.crossSpeciesMatingCount;
    state.matingCount = 0;
    state.crossSpeciesMatingCount = 0;

    const populationBySpecies: GroupCount[] = [...bySpecies.entries()]
      .map(([tag, accumulator]) => ({ tag, count: accumulator.count }))
      .sort((a, b) => a.tag - b.tag);
    const populationByClade: GroupCount[] = [...byClade.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => a.tag - b.tag);

    this.phylogenyStore.observe(tick, speciesObservations(bySpecies));

    const row: SampleRow = {
      tick,
      generation,
      population,
      populationBySpecies,
      populationByClade,
      populationByDeme: Array.from(demes),
      populationByArchetype: archetypes,
      traits,
      discreteAlleleFreq,
      quantLociWithVariance: this.estimators.quantLociWithVariance(state),
      deaths,
      matings,
      crossSpeciesMatings,
      assortmentIndex: this.estimators.assortmentIndex(windowStart),
      hueAssortment: this.estimators.hueAssortment(windowStart),
      resources: this.resourceSample(state),
      popgen,
      guilds: {
        predatorFraction: population > 0 ? predators / population : 0,
        filtererFraction: population > 0 ? (population - predators) / population : 0,
        meanAttack: population > 0 ? attackSum / population : 0,
        meanDefense: population > 0 ? defenseSum / population : 0,
      },
    };

    this.append(row);
    this.appendScalar('resources.carrionTotal', carrionTotal(state));
    this.appendScalar('disturbances.thermalCount', state.disturbance.thermal.length);
    this.appendScalar('disturbances.planktonCrashCount', state.disturbance.planktonCrashes.length);
    this.appendScalar('disturbances.kelpStormCount', state.disturbance.kelpStorms.length);
    this.appendScalar('disturbances.thermalOffsetC', thermalShockOffsetC(state));
    this.appendScalar('guilds.meanDiet', population > 0 ? dietSum / population : 0);
    return row;
  }

  // -- series ---------------------------------------------------------------

  series(sinceTick: number): readonly SampleRow[] {
    const first = this.firstRowAfter(sinceTick);
    return first >= this.rows.length ? [] : this.rows.slice(first);
  }

  column(name: string): Float64Array | null {
    const column = this.columns.get(name);
    return column === undefined ? null : column.slice(0);
  }

  columnNames(): readonly string[] {
    return [...this.columns.keys()].sort();
  }

  toJsonl(scenario: string, seed: string, sinceTick = -1): string {
    const lines: string[] = [];
    for (const row of this.series(sinceTick)) {
      const line: ProbeSeriesLine = { scenario, seed, row };
      lines.push(JSON.stringify(line));
    }
    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
  }

  // -- ancestry -------------------------------------------------------------

  ancestry(id: OrganismId): AncestryRecord | undefined {
    return this.ancestryStore.get(id);
  }

  lineage(id: OrganismId, maxRecords = 32): readonly AncestryRecord[] {
    return this.ancestryStore.lineage(id, maxRecords);
  }

  hasCompleteAncestry(id: OrganismId): boolean {
    return this.ancestryStore.hasCompleteAncestry(id);
  }

  lineageSummaries(): readonly LineageSummary[] {
    return this.ancestryStore.lineageSummaries();
  }

  phylogeny(): readonly PhylogenyNode[] {
    return this.phylogenyStore.snapshot();
  }

  collectAncestry(state: SimState): void {
    this.ancestryStore.collect(state);
    this.estimators.pruneCaches((id) => this.ancestryStore.has(id));
  }

  quantLocusMoments(state: SimState): { readonly mean: Float64Array; readonly variance: Float64Array } {
    return this.estimators.quantLocusMoments(state);
  }

  // -- internals ------------------------------------------------------------

  private popgenSample(
    state: SimState,
    tick: number,
    neutralFrequencies: readonly (readonly number[])[],
  ): PopgenSample {
    // Null until a full window of history exists, and null again for any window
    // the estimator cannot identify an Ne from. `population` is no longer part
    // of it: nothing here is bounded by census size any more (Gate A-1 defect 5).
    const baseline = this.temporalBaseline(tick);
    let neTemporal: number | null = null;
    if (baseline !== null) {
      const generationsElapsed = (tick - baseline.tick) / this.config.time.generationTicks;
      neTemporal = this.estimators.temporalNeOrNull(baseline.frequencies, neutralFrequencies, generationsElapsed);
    }

    return {
      neDemographic: this.estimators.demographicNe(state),
      neTemporal,
      fstDemes: this.estimators.fst(state, 'deme') ?? Number.NaN,
      fstBarrier: this.estimators.fst(state, 'barrier'),
      meanHeterozygosity: meanExpectedHeterozygosity(neutralFrequencies),
      midparentH2Size: this.estimators.midparentHeritability('size'),
    };
  }

  /**
   * Field totals and the area-weighted mean water temperature.
   *
   * Every cell of the field is the same area, so the plain mean over
   * `field.temperature` *is* the area weighting. Ecology owns that array and
   * refreshes it each tick; stats reads it and never recomputes the thermal
   * model, which is what keeps one source of truth for temperature.
   */
  private resourceSample(state: SimState): ResourceSample {
    let planktonTotal = 0;
    for (let index = 0; index < state.field.plankton.length; index += 1) {
      planktonTotal += state.field.plankton[index] ?? 0;
    }
    let kelpTotal = 0;
    for (let index = 0; index < state.field.kelp.length; index += 1) {
      kelpTotal += state.field.kelp[index] ?? 0;
    }
    let temperatureTotal = 0;
    const cells = state.field.temperature.length;
    for (let index = 0; index < cells; index += 1) {
      temperatureTotal += state.field.temperature[index] ?? 0;
    }
    const meanTemperatureC = cells > 0 ? temperatureTotal / cells : Number.NaN;

    return {
      planktonTotal,
      kelpTotal,
      meanTemperatureC,
      climateOffsetC: state.climate.meanOffsetC,
    };
  }

  private pushFrequencySnapshot(tick: number, frequencies: number[][]): void {
    this.frequencyHistory.push({ tick, frequencies });
    const span = this.temporalWindowTicks() * 2;
    while (this.frequencyHistory.length > 2 && (this.frequencyHistory[0]?.tick ?? 0) < tick - span) {
      this.frequencyHistory.shift();
    }
  }

  private temporalWindowTicks(): number {
    return this.config.sampling.temporalNeWindowGenerations * this.config.time.generationTicks;
  }

  /**
   * Newest snapshot at least a full `temporalNeWindowGenerations` back, or null.
   *
   * No short-window fallback. Substituting the oldest snapshot we happen to hold
   * measured drift over whatever span existed — a couple of sample intervals
   * early in a run — while labelling it with the configured window, which reads
   * as a wildly low Ne for the first several generations of every run and then
   * silently changes estimand once history catches up (Gate A-1 defect 5).
   * `PopgenSample.neTemporal` is nullable so this can say "not yet".
   */
  private temporalBaseline(tick: number): FrequencySnapshot | null {
    const target = tick - this.temporalWindowTicks();
    let best: FrequencySnapshot | null = null;
    for (const snapshot of this.frequencyHistory) {
      if (snapshot.tick <= target) best = snapshot;
    }
    return best;
  }

  /**
   * Raise `sweepCrossedHalf` for any tracked allele that has just passed 0.5.
   *
   * Fires once per tracked allele: P10 asks how long a beneficial allele took to
   * reach half, and an allele that oscillates around the threshold would
   * otherwise report that answer repeatedly.
   */
  private raiseSweepEvents(tick: number, frequencies: Readonly<Record<DiscreteLocusId, readonly number[]>>): void {
    for (const tracked of this.sweeps.values()) {
      if (tracked.fired) continue;
      const frequency = frequencies[tracked.locus]?.[tracked.allele] ?? 0;
      if (frequency < 0.5) continue;
      tracked.fired = true;
      this.raised.push({
        kind: 'sweepCrossedHalf',
        tick,
        locus: tracked.locus,
        allele: tracked.allele,
        frequency,
        introducedTick: tracked.introducedTick,
        generationsElapsed: (tick - tracked.introducedTick) / this.config.time.generationTicks,
      });
    }
  }

  private append(row: SampleRow): void {
    this.rows.push(row);
    this.rowTicks.push(row.tick);
    for (const [name, value] of scalarColumns(row)) {
      this.appendScalar(name, value);
    }
  }

  private appendScalar(name: string, value: number): void {
    let column = this.columns.get(name);
    if (column === undefined) {
      column = new GrowableColumn();
      this.columns.set(name, column);
    }
    column.push(value);
  }

  /** Index into `rows` of the first row strictly after `sinceTick`. */
  private firstRowAfter(sinceTick: number): number {
    let low = 0;
    let high = this.rowTicks.size;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.rowTicks.at(middle) > sinceTick) high = middle;
      else low = middle + 1;
    }
    return low;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sweepKey(locus: DiscreteLocusId, allele: number): string {
  return `${locus}:${allele}`;
}

function carrionTotal(state: SimState): number {
  let total = 0;
  for (let index = 0; index < state.field.carrion.length; index += 1) total += state.field.carrion[index] ?? 0;
  return total;
}

function speciesObservations(bySpecies: ReadonlyMap<SpeciesTag, SpeciesAccumulator>): SpeciesObservation[] {
  const observations: SpeciesObservation[] = [];
  for (const [tag, accumulator] of bySpecies) {
    let modalClade: CladeId = 0;
    let modalCladeCount = -1;
    for (const [cladeId, count] of accumulator.clades) {
      // Ties go to the lower clade id so the attribution is reproducible.
      if (count > modalCladeCount || (count === modalCladeCount && cladeId < modalClade)) {
        modalClade = cladeId;
        modalCladeCount = count;
      }
    }
    let modalArchetype = 0;
    for (let code = 1; code < accumulator.archetypes.length; code += 1) {
      if ((accumulator.archetypes[code] ?? 0) > (accumulator.archetypes[modalArchetype] ?? 0)) modalArchetype = code;
    }
    observations.push({
      tag,
      count: accumulator.count,
      cladeId: modalClade,
      archetype: archetypeFromCode(modalArchetype),
    });
  }
  return observations.sort((a, b) => a.tag - b.tag);
}

/**
 * The scalars kept as growable columns.
 *
 * Every trait gets `mean`, `sd` and `additiveVariance`; `phenotypicVariance` and
 * `heritability` are omitted because they are `sd²` and `V_A/V_P`, so storing
 * them would be storing the same numbers twice. Everything else lives on the
 * retained `SampleRow`, which stays the contract — these columns exist only
 * because a plot wants a contiguous array rather than a field plucked out of
 * three thousand objects.
 */
function* scalarColumns(row: SampleRow): Generator<readonly [string, number]> {
  yield ['tick', row.tick];
  yield ['generation', row.generation];
  yield ['population', row.population];
  yield ['matings', row.matings];
  yield ['crossSpeciesMatings', row.crossSpeciesMatings];
  yield ['assortmentIndex', row.assortmentIndex ?? Number.NaN];
  yield ['hueAssortment', row.hueAssortment ?? Number.NaN];
  yield ['quantLociWithVariance', row.quantLociWithVariance];
  for (const cause of DEATH_CAUSES) yield [`deaths.${cause}`, row.deaths[cause]];
  yield ['resources.planktonTotal', row.resources.planktonTotal];
  yield ['resources.kelpTotal', row.resources.kelpTotal];
  yield ['resources.meanTemperatureC', row.resources.meanTemperatureC];
  yield ['resources.climateOffsetC', row.resources.climateOffsetC];
  yield ['popgen.neDemographic', row.popgen.neDemographic];
  yield ['popgen.neTemporal', row.popgen.neTemporal ?? Number.NaN];
  yield ['popgen.fstDemes', row.popgen.fstDemes];
  yield ['popgen.fstBarrier', row.popgen.fstBarrier ?? Number.NaN];
  yield ['popgen.meanHeterozygosity', row.popgen.meanHeterozygosity];
  yield ['popgen.midparentH2Size', row.popgen.midparentH2Size ?? Number.NaN];
  yield ['guilds.predatorFraction', row.guilds.predatorFraction];
  yield ['guilds.filtererFraction', row.guilds.filtererFraction];
  yield ['guilds.meanAttack', row.guilds.meanAttack];
  yield ['guilds.meanDefense', row.guilds.meanDefense];
  for (const key of TRAIT_KEYS) {
    const sample = row.traits[key];
    if (sample === undefined) continue;
    yield [`traits.${key}.mean`, sample.mean];
    yield [`traits.${key}.sd`, sample.sd];
    yield [`traits.${key}.additiveVariance`, sample.additiveVariance];
  }
}
