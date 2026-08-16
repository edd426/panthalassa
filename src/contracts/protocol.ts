/**
 * Worker message protocol — FROZEN CONTRACT (see CLAUDE.md).
 *
 * The sim runs in a Web Worker (browser) or in-process (probes). The main
 * thread never touches `SimState`: it asks for a **sample slice** to draw, a
 * **selection dump** to inspect, or a **series** to chart, and it sends
 * commands. That boundary is what stops presentation code from accidentally
 * consuming sim RNG or mutating pools mid-tick.
 *
 * Request/response messages carry a `requestId` the worker echoes. Pushes
 * (`events`, `ticked`) have none.
 *
 * God-tool commands exist from day one, before any UI: probe scenarios drive
 * `raiseBarrier` (P8), `introduceMutant` and `trackSweep` (P10) and `meteor`
 * through exactly the same path the eventual buttons will.
 */

import type { SimEvent } from './events';
import type { CladeArchetype, DiscreteLocusId, Karyotype, QuantLocusId } from './genome';
import type { AncestryRecord, PhylogenyNode, SampleRow } from './stats';
import type {
  BarrierShape,
  CladeId,
  DemeId,
  DisturbanceRegion,
  OrganismId,
  SimConfigOverrides,
  SimSnapshot,
  Sex,
  SlotIndex,
  SpeciesTag,
} from './types';
import type { TraitKey } from './traits';

// ---------------------------------------------------------------------------
// Sample slice: the transferable render feed
// ---------------------------------------------------------------------------

/**
 * Floats per organism in a sample slice. The buffer is a `Float32Array` of
 * `count * SAMPLE_SLICE_STRIDE`, transferred (not copied) to the main thread,
 * so the worker allocates a fresh one each request and the renderer hands the
 * previous buffer back on the next request when it can.
 */
export const SAMPLE_SLICE_STRIDE = 17;

export const SAMPLE_SLICE = Object.freeze({
  /** Pool slot; stable frame to frame while the organism lives, so the renderer can interpolate. */
  slot: 0,
  x: 1,
  y: 2,
  /** Display hue, degrees. */
  hue: 3,
  /** Body length, cm. */
  size: 4,
  speciesTag: 5,
  cladeId: 6,
  /** Index into `CLADE_ARCHETYPES`. */
  archetype: 7,
  /** Energy as a fraction of this organism's storage ceiling, 0..1. */
  energyFraction: 8,
  /**
   * The four expressed morphology traits (contracts v1.5, Phase B): the
   * renderer draws each body from its own evolving parameters, because
   * morphology evolution is the spectacle — deriving these from archetype
   * typicals would paint fabricated variation. Unbounded like every trait;
   * the renderer clamps to `CLADE_SCHEMA` renderRange at draw time.
   */
  segmentCount: 9,
  finPairs: 10,
  bodyAspect: 11,
  armorPlating: 12,
  /**
   * Expressed diet and defense (contracts v1.6, R5): the two traits with real
   * standing divergence — diet ratchets whole logits and defense answers
   * selection — so creature *form* (jaw, spination) can be drawn from where the
   * evolution actually happens rather than from the near-static morphology
   * channels alone. Unbounded; the renderer clamps at draw time.
   */
  diet: 13,
  defense: 14,
  /**
   * G-wave (contracts v1.8, G5): `size` (channel 4) already carries realised
   * length since G2, so juveniles draw small for free; these two finish the
   * on-screen story. `lifeStage` is 1 when `isMature` (age floor AND, with
   * ontogeny on, the length floor) — a juvenile is a life stage, not merely a
   * small adult. `conspicuousness` drives saturation/contrast at draw time.
   * `toxicity` is deliberately NOT on the slice: if the watcher could see who
   * is toxic, the mimicry read would be given away for free — it appears in
   * the inspector and the charts only.
   */
  lifeStage: 15,
  conspicuousness: 16,
});

export interface SampleSlice {
  readonly tick: number;
  readonly count: number;
  /** Length `count * SAMPLE_SLICE_STRIDE`. Transferred; the sender must not read it afterwards. */
  readonly buffer: Float32Array;
  /** Echo of the requested trait channel, when one was asked for. */
  readonly traitKey?: TraitKey;
  /**
   * Expressed values of `traitKey`, length `count`, same organism order as
   * `buffer`. Transferred. Lets the renderer colour dots by any trait (v1.4,
   * from the user's first watch: identity colours alone say nothing).
   */
  readonly traitValues?: Float32Array;
}

// ---------------------------------------------------------------------------
// Selection dump
// ---------------------------------------------------------------------------

export interface GenomeLocusDump {
  readonly locus: QuantLocusId;
  readonly label: string;
  readonly maternal: number;
  readonly paternal: number;
  /** Which traits this locus feeds, and by how much. */
  readonly loads: readonly { readonly trait: TraitKey; readonly weight: number }[];
}

export interface DiscreteLocusDump {
  readonly locus: DiscreteLocusId;
  readonly label: string;
  readonly maternal: number;
  readonly paternal: number;
}

/** Everything the inspector shows for one organism. Built on demand; never in the tick loop. */
export interface OrganismDump {
  readonly id: OrganismId;
  readonly slot: SlotIndex;
  readonly sex: Sex;
  readonly karyotype: Karyotype;
  readonly ageTicks: number;
  readonly birthTick: number;
  readonly x: number;
  readonly y: number;
  readonly energy: number;
  readonly energyCapacity: number;
  readonly speciesTag: SpeciesTag;
  readonly cladeId: CladeId;
  readonly archetype: CladeArchetype;
  readonly deme: DemeId;
  readonly motherId: OrganismId;
  readonly fatherId: OrganismId;
  readonly traits: Readonly<Record<TraitKey, number>>;
  readonly traitsLatent: Readonly<Record<TraitKey, number>>;
  /** Raw genotypic contribution, environment excluded — the naturalist's breeding value. */
  readonly traitsGenotypic: Readonly<Record<TraitKey, number>>;
  /** Population percentile of each expressed trait, 0..1 — context is what makes a number readable. */
  readonly traitPercentiles: Readonly<Record<TraitKey, number>>;
  readonly quantLoci: readonly GenomeLocusDump[];
  readonly discreteLoci: readonly DiscreteLocusDump[];
  /** Up to a few generations of pedigree, for the ancestry walk. */
  readonly ancestors: readonly AncestryRecord[];
}

// ---------------------------------------------------------------------------
// Commands (god tools; also how probe scenarios perturb the world)
// ---------------------------------------------------------------------------

export type SimCommand =
  | { readonly kind: 'raiseBarrier'; readonly barrierId: string; readonly shape: BarrierShape; readonly permeability: number }
  | { readonly kind: 'lowerBarrier'; readonly barrierId: string }
  | { readonly kind: 'setClimateTarget'; readonly targetOffsetC: number }
  | { readonly kind: 'meteor'; readonly x: number; readonly y: number; readonly radiusWu: number }
  | {
      readonly kind: 'introduceMutant';
      /** How many individuals to inject; P10 uses 1 (frequency 1/2N). */
      readonly count: number;
      readonly locus: QuantLocusId | DiscreteLocusId;
      /** Allele-unit offset for a quantitative locus, allele index for a discrete one. */
      readonly value: number;
      readonly x?: number;
      readonly y?: number;
    }
  /** Register an allele whose frequency the recorder should follow, so it can raise `sweepCrossedHalf`. */
  | { readonly kind: 'trackSweep'; readonly locus: DiscreteLocusId; readonly allele: number }
  | {
      readonly kind: 'triggerDisturbance';
      readonly shock: 'thermal' | 'planktonCrash' | 'kelpStorm';
      /** °C for thermal, productivity multiplier for crash, cleared fraction for kelp. */
      readonly magnitude: number;
      readonly durationTicks: number;
      /** Null/absent means a global plankton crash; kelp storms require a region. */
      readonly region?: DisturbanceRegion | null;
    }
  | { readonly kind: 'setToggle'; readonly toggle: string; readonly value: boolean };

// ---------------------------------------------------------------------------
// Main → worker
// ---------------------------------------------------------------------------

export interface InitMessage {
  readonly type: 'init';
  readonly requestId: number;
  readonly seed: string;
  readonly config: SimConfigOverrides;
  /** Restore instead of generating founders. */
  readonly snapshot?: SimSnapshot;
}

export interface StepMessage {
  readonly type: 'step';
  readonly requestId: number;
  readonly ticks: number;
}

/** 0 pauses; 1…256 are the watch speeds. The worker turns this into ticks per frame. */
export interface SetSpeedMessage {
  readonly type: 'setSpeed';
  readonly requestId: number;
  readonly multiplier: number;
}

export interface SnapshotRequestMessage {
  readonly type: 'snapshotRequest';
  readonly requestId: number;
}

export interface SampleSliceRequestMessage {
  readonly type: 'sampleSliceRequest';
  readonly requestId: number;
  /** Cap for LOD; the worker takes the first N in slot order when the population exceeds it. */
  readonly maxOrganisms?: number;
  /** Buffer handed back for reuse; the worker may ignore it. */
  readonly recycle?: Float32Array;
  /** Also deliver this trait's expressed values per organism (`SampleSlice.traitValues`). */
  readonly traitKey?: TraitKey;
}

export interface SelectMessage {
  readonly type: 'select';
  readonly requestId: number;
  readonly x: number;
  readonly y: number;
  readonly radiusWu: number;
}

export interface SeriesRequestMessage {
  readonly type: 'seriesRequest';
  readonly requestId: number;
  /** Only rows strictly after this tick. */
  readonly sinceTick: number;
}

export interface PhylogenyRequestMessage {
  readonly type: 'phylogenyRequest';
  readonly requestId: number;
}

export interface CommandMessage {
  readonly type: 'command';
  readonly requestId: number;
  readonly command: SimCommand;
}

export type FieldSliceField = 'plankton' | 'kelp' | 'temperature';

/**
 * Fetch one resource/temperature raster for an overlay. Exists so field
 * underlays do not ride `snapshotRequest`, which serialises every pool column
 * and genome just to paint a background (contracts v1.3, from WP-A6).
 */
export interface FieldSliceRequestMessage {
  readonly type: 'fieldSliceRequest';
  readonly requestId: number;
  readonly field: FieldSliceField;
}

export type MainToWorkerMessage =
  | InitMessage
  | StepMessage
  | SetSpeedMessage
  | SnapshotRequestMessage
  | SampleSliceRequestMessage
  | SelectMessage
  | SeriesRequestMessage
  | PhylogenyRequestMessage
  | CommandMessage
  | FieldSliceRequestMessage;

export type MainToWorkerType = MainToWorkerMessage['type'];

// ---------------------------------------------------------------------------
// Worker → main
// ---------------------------------------------------------------------------

export interface ReadyMessage {
  readonly type: 'ready';
  readonly requestId: number;
  readonly tick: number;
  readonly population: number;
}

export interface TickedMessage {
  readonly type: 'ticked';
  /** Echo of the requesting message's id; `0` for the worker's autonomous frame-loop pushes. */
  readonly requestId: number;
  readonly tick: number;
  readonly population: number;
  /** Narrative events raised during the step, in tick order. */
  readonly events: readonly SimEvent[];
}

export interface SnapshotMessage {
  readonly type: 'snapshot';
  readonly requestId: number;
  readonly snapshot: SimSnapshot;
  readonly stateHash: string;
}

export interface SampleSliceMessage {
  readonly type: 'sampleSlice';
  readonly requestId: number;
  readonly slice: SampleSlice;
}

export interface SelectionMessage {
  readonly type: 'selection';
  readonly requestId: number;
  /** null when the click hit open water. */
  readonly organism: OrganismDump | null;
}

export interface SeriesMessage {
  readonly type: 'series';
  readonly requestId: number;
  readonly rows: readonly SampleRow[];
}

export interface PhylogenyMessage {
  readonly type: 'phylogeny';
  readonly requestId: number;
  readonly nodes: readonly PhylogenyNode[];
}

export interface EventsMessage {
  readonly type: 'events';
  readonly tick: number;
  readonly events: readonly SimEvent[];
}

export interface FieldSliceMessage {
  readonly type: 'fieldSlice';
  readonly requestId: number;
  readonly field: FieldSliceField;
  readonly cols: number;
  readonly rows: number;
  readonly cellSizeWu: number;
  /** Row-major cells; a copy — transfer the buffer. */
  readonly values: Float32Array;
}

export interface ErrorMessage {
  readonly type: 'error';
  readonly requestId: number | null;
  readonly message: string;
  readonly stack?: string;
}

export type WorkerToMainMessage =
  | ReadyMessage
  | TickedMessage
  | SnapshotMessage
  | SampleSliceMessage
  | SelectionMessage
  | SeriesMessage
  | PhylogenyMessage
  | EventsMessage
  | FieldSliceMessage
  | ErrorMessage;

export type WorkerToMainType = WorkerToMainMessage['type'];

/** Watch speeds the HUD offers; the worker runs `multiplier` ticks per 1/30 s frame. */
export const SPEED_MULTIPLIERS = [0, 1, 2, 4, 8, 16, 32, 64, 128, 256] as const;
