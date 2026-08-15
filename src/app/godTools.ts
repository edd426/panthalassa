/**
 * The experiment bench — god tools with a face on them (overnight wave, X1).
 *
 * Everything here already existed as a `SimCommand`; the probe scenarios have
 * been raising ridges and dropping meteors through this exact path since WP-A5.
 * What was missing was a way to run an experiment *while watching*: wall off
 * two halves of the ocean at a permeability you choose, let them diverge, then
 * drop the wall and see what the mixed population does. That is one command
 * pair (`raiseBarrier`/`lowerBarrier`) and a slider, and it is the reason this
 * panel exists.
 *
 * Three parts, deliberately separated:
 *
 *  - **Pure model** (top of the file): shape construction from two clicked
 *    points, command payload builders, the barrier ledger, the armed-mode
 *    reducer. No DOM, no worker, no wall clock — this is what `godTools.test.ts`
 *    runs in the node environment.
 *  - **The wall overlay**: absolutely-positioned bands over the canvas. The
 *    renderer does not draw barriers (nothing in `src/render/**` reads
 *    `BarrierState`), and an invisible wall makes the whole experiment
 *    unreadable, so the bench draws its own until a render layer takes it over.
 *  - **`GodTools`**: the DOM, built into the empty `<section id="bench">` that
 *    index.html reserves, in the station-log register (small-caps labels,
 *    hairline rules, phosphor values) off index.html's `:root` tokens.
 *
 * Presentation rules apply: wall-clock time is legal here, sim RNG is not
 * touched, and every command goes through the same gated send `main.ts` uses.
 */

import type { SimEvent } from '../contracts/events';
import type { CladeArchetype, DiscreteLocusId } from '../contracts/genome';
import { DISCRETE_LOCUS_BY_ID, cladeArchetypeFor } from '../contracts/genome';
import type { SimCommand } from '../contracts/protocol';
import type { BarrierShape, DisturbanceRegion, SimConfig } from '../contracts/types';

// ---------------------------------------------------------------------------
// Pure model
// ---------------------------------------------------------------------------

export interface WorldPoint {
  readonly x: number;
  readonly y: number;
}

/** Permeability is a fraction of open water; anything else is a bug in the slider. */
export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function clampToWorld(point: WorldPoint, widthWu: number, heightWu: number): WorldPoint {
  const x = Number.isFinite(point.x) ? point.x : 0;
  const y = Number.isFinite(point.y) ? point.y : 0;
  return {
    x: x < 0 ? 0 : x > widthWu ? widthWu : x,
    y: y < 0 ? 0 : y > heightWu ? heightWu : y,
  };
}

/**
 * The wall two clicks describe.
 *
 * The axis the clicks are furthest apart on is the axis the wall runs along, so
 * two points one above the other give a north–south ridge. A ridge spans the
 * whole world on that axis — which is the point: a partial fence is not an
 * experiment, it is a detour. The clicks' spread on the *minor* axis sets the
 * thickness, floored at `minThicknessWu` so a careless double-click still
 * produces a wall wide enough for the barrier mask to resolve (the mask is
 * rasterised at `fieldCellSizeWu`, so a sub-cell ridge would quantise away).
 */
export function barrierShapeFromPoints(a: WorldPoint, b: WorldPoint, minThicknessWu: number): BarrierShape {
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  const floor = Math.max(1, minThicknessWu);
  if (dy >= dx) {
    return { kind: 'verticalRidge', xWu: (a.x + b.x) / 2, thicknessWu: Math.max(floor, dx) };
  }
  return { kind: 'horizontalRidge', yWu: (a.y + b.y) / 2, thicknessWu: Math.max(floor, dy) };
}

export interface BenchBarrier {
  readonly id: string;
  readonly permeability: number;
  readonly raisedTick: number;
  /** Carried so the overlay can draw the band; the sim owns the real mask. */
  readonly shape: BarrierShape;
}

/**
 * A wall the bench knows about. Raises are recorded optimistically when the
 * command is sent and then reconciled by the `barrierChange` event the sim
 * raises, which carries the authoritative `raisedTick` — hence `raised` on an
 * id already present replaces rather than appends, matching the engine, which
 * splices out a same-id spec before pushing the new one. The same path picks up
 * walls the bench never issued (a probe script, the console handle).
 */
export type BarrierLedgerAction =
  | {
      readonly kind: 'raised';
      readonly id: string;
      readonly permeability: number;
      readonly raisedTick: number;
      readonly shape: BarrierShape;
    }
  | { readonly kind: 'lowered'; readonly id: string }
  | { readonly kind: 'cleared' };

export function reduceBarriers(ledger: readonly BenchBarrier[], action: BarrierLedgerAction): readonly BenchBarrier[] {
  switch (action.kind) {
    case 'raised': {
      const entry: BenchBarrier = {
        id: action.id,
        permeability: clampUnit(action.permeability),
        raisedTick: action.raisedTick,
        shape: action.shape,
      };
      const existing = ledger.findIndex((barrier) => barrier.id === action.id);
      if (existing < 0) return [...ledger, entry];
      const next = [...ledger];
      next[existing] = entry;
      return next;
    }
    case 'lowered':
      return ledger.filter((barrier) => barrier.id !== action.id);
    case 'cleared':
      return [];
  }
}

export interface ShockPreset {
  readonly label: string;
  /** °C for thermal, productivity multiplier for a crash, cleared fraction for kelp. */
  readonly magnitude: number;
  /** Authored in generations, like the disturbance config; the builder converts. */
  readonly durationGenerations: number;
}

export type ShockKind = 'thermal' | 'planktonCrash' | 'kelpStorm';

export function shockCommand(
  shock: ShockKind,
  preset: ShockPreset,
  generationTicks: number,
  region: DisturbanceRegion | null,
): SimCommand {
  return {
    kind: 'triggerDisturbance',
    shock,
    magnitude: preset.magnitude,
    durationTicks: Math.max(1, Math.round(preset.durationGenerations * generationTicks)),
    region,
  };
}

/** Both macro loci are 0 in the founders, so an injected clade allele is read against 0. */
export const ANCESTRAL_MACRO_ALLELE = 0;

export interface CladeFoundingEdit {
  readonly locus: DiscreteLocusId;
  readonly value: number;
}

/**
 * The single-locus edit that makes an injected organism express `target`.
 *
 * `introduceMutant` writes **one** allele copy at **one** locus, and the
 * expressed archetype is `cladeArchetypeFor(max(A), max(B))` — highest allele
 * dominant. So the edit has to reach the target from the ancestral background
 * at the *other* macro-locus, and the pair is derived from `CLADE_MACRO_TABLE`
 * here rather than written down, because a retuned table would otherwise leave
 * these buttons quietly founding undulators.
 *
 * The background assumption is the population's, not the injected organism's:
 * the genome is copied from a random living individual, so a world that has
 * already discovered a macro-allele on the other locus can express something
 * else. That is a real outcome of a real genome, not a mis-sent command.
 */
export function foundingEditFor(target: CladeArchetype): CladeFoundingEdit | null {
  const macroA = DISCRETE_LOCUS_BY_ID.cladeMacroA;
  for (let allele = 1; allele < macroA.alleleCount; allele += 1) {
    if (cladeArchetypeFor(allele, ANCESTRAL_MACRO_ALLELE) === target) return { locus: macroA.id, value: allele };
  }
  const macroB = DISCRETE_LOCUS_BY_ID.cladeMacroB;
  for (let allele = 1; allele < macroB.alleleCount; allele += 1) {
    if (cladeArchetypeFor(ANCESTRAL_MACRO_ALLELE, allele) === target) return { locus: macroB.id, value: allele };
  }
  return null;
}

export const FOUNDING_EDITS: Readonly<Record<'radialDrifter' | 'armoredCrawler', CladeFoundingEdit | null>> =
  Object.freeze({
    radialDrifter: foundingEditFor('radialDrifter'),
    armoredCrawler: foundingEditFor('armoredCrawler'),
  });

export const ARMED_MODES = [
  'wall',
  'meteor',
  'planktonCrash',
  'kelpStorm',
  'foundRadialDrifter',
  'foundArmoredCrawler',
] as const;

export type ArmedMode = (typeof ARMED_MODES)[number];

export interface ArmedState {
  readonly mode: ArmedMode | null;
  /** The wall's first point; null in every other mode and before the first click. */
  readonly firstPoint: WorldPoint | null;
}

export const DISARMED: ArmedState = Object.freeze({ mode: null, firstPoint: null });

export interface BenchSettings {
  /** Id the next `raiseBarrier` will carry; the bench numbers walls W1, W2, … */
  readonly barrierId: string;
  readonly permeability: number;
  readonly wallThicknessWu: number;
  readonly meteorRadiusWu: number;
  readonly generationTicks: number;
  readonly planktonCrash: ShockPreset;
  readonly planktonCrashRadiusWu: number;
  readonly kelpStorm: ShockPreset;
  readonly kelpStormRadiusWu: number;
  /** Individuals per founding. One is a coin flip against drift; a cohort is watchable. */
  readonly foundingCount: number;
}

export type ArmedAction =
  | { readonly kind: 'arm'; readonly mode: ArmedMode }
  | { readonly kind: 'click'; readonly point: WorldPoint }
  | { readonly kind: 'cancel' };

export interface ArmedResult {
  readonly state: ArmedState;
  /** The command the action completed, or null when the mode is still collecting clicks. */
  readonly command: SimCommand | null;
}

function foundingCommand(mode: ArmedMode, point: WorldPoint, count: number): SimCommand | null {
  const edit =
    mode === 'foundRadialDrifter'
      ? FOUNDING_EDITS.radialDrifter
      : mode === 'foundArmoredCrawler'
        ? FOUNDING_EDITS.armoredCrawler
        : null;
  if (edit === null) return null;
  return { kind: 'introduceMutant', count, locus: edit.locus, value: edit.value, x: point.x, y: point.y };
}

/**
 * Armed-mode state machine: arm → click (→ click, for a wall) → command, then
 * disarm. Cancel returns to idle without a command, which is what `esc` sends.
 *
 * Every mode disarms itself after firing. A god tool that stayed armed would
 * turn the next ordinary click — the one meant to inspect an animal — into a
 * second meteor.
 */
export function reduceArmed(state: ArmedState, action: ArmedAction, settings: BenchSettings): ArmedResult {
  switch (action.kind) {
    case 'arm':
      return { state: { mode: action.mode, firstPoint: null }, command: null };
    case 'cancel':
      return { state: DISARMED, command: null };
    case 'click': {
      const point = action.point;
      switch (state.mode) {
        case null:
          return { state, command: null };
        case 'wall': {
          if (state.firstPoint === null) return { state: { mode: 'wall', firstPoint: point }, command: null };
          return {
            state: DISARMED,
            command: {
              kind: 'raiseBarrier',
              barrierId: settings.barrierId,
              shape: barrierShapeFromPoints(state.firstPoint, point, settings.wallThicknessWu),
              permeability: clampUnit(settings.permeability),
            },
          };
        }
        case 'meteor':
          return {
            state: DISARMED,
            command: { kind: 'meteor', x: point.x, y: point.y, radiusWu: settings.meteorRadiusWu },
          };
        case 'planktonCrash':
          return {
            state: DISARMED,
            command: shockCommand('planktonCrash', settings.planktonCrash, settings.generationTicks, {
              kind: 'disc',
              xWu: point.x,
              yWu: point.y,
              radiusWu: settings.planktonCrashRadiusWu,
            }),
          };
        case 'kelpStorm':
          return {
            state: DISARMED,
            command: shockCommand('kelpStorm', settings.kelpStorm, settings.generationTicks, {
              kind: 'disc',
              xWu: point.x,
              yWu: point.y,
              radiusWu: settings.kelpStormRadiusWu,
            }),
          };
        case 'foundRadialDrifter':
        case 'foundArmoredCrawler':
          return { state: DISARMED, command: foundingCommand(state.mode, point, settings.foundingCount) };
      }
    }
  }
}

/** The line the bench prints while a mode is armed; empty when it is not. */
export function armedStatus(state: ArmedState): string {
  switch (state.mode) {
    case null:
      return '';
    case 'wall':
      return state.firstPoint === null
        ? 'WALL: click two points · esc cancels'
        : 'WALL: click the second point · esc cancels';
    case 'meteor':
      return 'METEOR: click the impact point · esc cancels';
    case 'planktonCrash':
      return 'CRASH: click the region centre · esc cancels';
    case 'kelpStorm':
      return 'STORM: click the region centre · esc cancels';
    case 'foundRadialDrifter':
      return 'FOUND: click where the drifters appear · esc cancels';
    case 'foundArmoredCrawler':
      return 'FOUND: click where the crawlers appear · esc cancels';
  }
}

/** Thousands-grouped integer, matching the station log's tick register. */
export function grouped(value: number): string {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  const digits = Math.abs(rounded).toString();
  let out = '';
  for (let index = 0; index < digits.length; index += 1) {
    const fromEnd = digits.length - index;
    out += digits[index] ?? '';
    if (fromEnd > 1 && fromEnd % 3 === 1) out += ',';
  }
  return sign + out;
}

export function signedFixed(value: number, digits: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * Shock presets, authored inside the ranges the disturbance scheduler already
 * draws from (`DisturbanceConfig`), so a fired shock is a strong sample of the
 * natural regime rather than a different physics. "Deep" sits at the far end of
 * each range, which is where the interesting selection happens.
 */
const THERMAL_PRESETS: readonly ShockPreset[] = [
  { label: '+2°C · 10 gen', magnitude: 2, durationGenerations: 10 },
  { label: '+5°C · 30 gen', magnitude: 5, durationGenerations: 30 },
  { label: '−4°C · 20 gen', magnitude: -4, durationGenerations: 20 },
];

const CRASH_PRESETS: readonly ShockPreset[] = [
  { label: '×0.50 · 5 gen', magnitude: 0.5, durationGenerations: 5 },
  { label: '×0.20 · 20 gen', magnitude: 0.2, durationGenerations: 20 },
];

const STORM_PRESETS: readonly ShockPreset[] = [
  { label: '80% · 8 gen', magnitude: 0.8, durationGenerations: 8 },
  { label: '100% · 20 gen', magnitude: 1, durationGenerations: 20 },
];

/** Thickness floor for a drawn wall, in barrier-mask cells (P8's ridge is 3). */
const WALL_MIN_CELLS = 3;

const CLIMATE_LIMIT_C = 6;

const METEOR_MIN_WU = 50;
const METEOR_MAX_WU = 400;
const METEOR_DEFAULT_WU = 200;

/**
 * How many individuals a founding injects. A single mutant is a 1/2N allele
 * with a coin-flip fate — correct for P10's sweep measurement, useless as a way
 * to meet a body plan — so the button drops a cohort at one point instead.
 */
const FOUNDING_COUNT = 12;

const WALL_AGE_REFRESH_MS = 500;

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className !== undefined && className !== '') element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function rule(): HTMLElement {
  return el('div', 'gt-rule');
}

function sectionHead(text: string): HTMLElement {
  return el('div', 'gt-head label', text);
}

const STYLE_ID = 'gt-style';

const STYLE_TEXT = `
#bench {
  position: fixed;
  left: 14px;
  bottom: 12px;
  z-index: 5;
  width: 33ch;
  max-height: 62vh;
  overflow-y: auto;
  padding: 9px 12px 11px;
  font: 11px/1.45 var(--mono);
  color: var(--ink);
  background: var(--glass-dense);
  border: 1px solid var(--hairline-soft);
  border-left: 1px solid var(--hairline);
  backdrop-filter: blur(3px);
  scrollbar-width: thin;
  scrollbar-color: var(--hairline) transparent;
}

#bench::-webkit-scrollbar { width: 8px; }
#bench::-webkit-scrollbar-thumb { background: var(--hairline); }

.gt-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 11px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ink);
}

.gt-keys { font-size: 10px; letter-spacing: 0.06em; color: var(--ink-dim); }
.gt-kbd { color: var(--phosphor); }

.gt-rule {
  height: 1px;
  margin: 7px 0 5px;
  background: linear-gradient(90deg, var(--hairline), transparent);
}

.gt-head { margin-bottom: 3px; }

.gt-row {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 3px 0;
}

.gt-row--wrap { flex-wrap: wrap; }
.gt-grow { flex: 1 1 auto; min-width: 0; }

.gt-value {
  color: var(--phosphor);
  font-variant-numeric: tabular-nums;
  min-width: 5ch;
  text-align: right;
}

.gt-note { display: block; font-size: 10px; color: var(--ink-dim); opacity: 0.8; }

/* The armed prompt is the one line that must be read mid-click, so it carries
   the amber the station reserves for a held state. */
.gt-armed {
  display: block;
  margin: 4px 0 2px;
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--amber);
}

.gt-armed[hidden] { display: none; }

.gt-btn {
  flex: 0 0 auto;
  padding: 3px 8px;
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ink);
  background: rgba(111, 242, 196, 0.06);
  border: 1px solid var(--hairline);
  cursor: pointer;
}

.gt-btn:hover { color: var(--abyss); background: var(--phosphor); border-color: var(--phosphor); }
.gt-btn:focus-visible { outline: 1px solid var(--phosphor); outline-offset: 1px; }
.gt-btn[aria-pressed='true'] { color: var(--abyss); background: var(--amber); border-color: var(--amber); }
.gt-btn--armed { color: var(--abyss); background: var(--amber); border-color: var(--amber); }
.gt-btn--drop { padding: 1px 6px; letter-spacing: 0.08em; }

.gt-select {
  flex: 1 1 auto;
  min-width: 0;
  padding: 2px 4px;
  font: inherit;
  font-size: 10px;
  color: var(--ink);
  background: var(--abyss);
  border: 1px solid var(--hairline);
}

.gt-slider {
  flex: 1 1 auto;
  min-width: 0;
  height: 14px;
  accent-color: var(--phosphor);
  background: transparent;
}

.gt-walls { display: block; margin-top: 3px; }

.gt-wall {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 2px 0;
  border-top: 1px solid var(--hairline-soft);
  font-variant-numeric: tabular-nums;
}

.gt-wall-id { color: var(--amber); letter-spacing: 0.1em; }
.gt-wall-body { flex: 1 1 auto; color: var(--ink-dim); }
.gt-empty { display: block; color: var(--ink-dim); opacity: 0.7; }

/* Wall overlay: the sim's barrier mask has no render layer, so the bench draws
   the bands it raised. Never takes pointer events — clicks belong to the water. */
#gt-walls-overlay {
  position: fixed;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.gt-band {
  position: absolute;
  border: 1px solid rgba(240, 183, 71, 0.55);
  background: repeating-linear-gradient(
    135deg,
    rgba(240, 183, 71, 0.22) 0 6px,
    rgba(4, 24, 36, 0.5) 6px 12px
  );
}

.gt-mark {
  position: absolute;
  width: 11px;
  height: 11px;
  margin: -6px 0 0 -6px;
  border: 1px solid var(--amber);
  border-radius: 50%;
}

/* Armed modes retarget the pointer: the next click is an instrument, not a pick. */
body[data-bench-armed='1'] #world { cursor: cell; }
`;

// ---------------------------------------------------------------------------
// Wiring seam
// ---------------------------------------------------------------------------

/** What the bench needs off the renderer; `WorldRenderer` satisfies it structurally. */
export interface BenchViewport {
  toWorld(clientX: number, clientY: number): { x: number; y: number };
  readonly pixelsPerWu: number;
}

export interface BenchDeps {
  /** The `<section id="bench">` index.html reserves. */
  readonly host: HTMLElement;
  readonly config: SimConfig;
  readonly viewport: BenchViewport;
  /** Gated on `live` by main.ts, exactly like every other send. */
  send(command: SimCommand): Promise<unknown>;
  /** Appends one line to the station-log feed. */
  note(line: string): void;
  /** Latest tick the main thread has seen; wall ages are read against it. */
  currentTick(): number;
}

// ---------------------------------------------------------------------------
// The bench
// ---------------------------------------------------------------------------

export class GodTools {
  private readonly deps: BenchDeps;
  private readonly host: HTMLElement;

  private armed: ArmedState = DISARMED;
  private ledger: readonly BenchBarrier[] = [];
  private wallCounter = 0;

  private permeability = 0;
  private climateTargetC = 0;
  private climateObservedC: number | null = null;
  private meteorRadiusWu = METEOR_DEFAULT_WU;
  private crashGlobal = true;

  private readonly armedLine: HTMLElement;
  private readonly permeabilityValue: HTMLElement;
  private readonly climateValue: HTMLElement;
  private readonly climateNow: HTMLElement;
  private readonly meteorValue: HTMLElement;
  private readonly wallList: HTMLElement;
  private readonly wallEmpty: HTMLElement;
  private readonly crashGlobalButton: HTMLButtonElement;
  private readonly thermalSelect: HTMLSelectElement;
  private readonly crashSelect: HTMLSelectElement;
  private readonly stormSelect: HTMLSelectElement;
  private readonly armButtons = new Map<ArmedMode, HTMLButtonElement>();

  private readonly overlay: HTMLElement;
  private overlayFrame = 0;

  /** Bottom-anchored strips (`#charts`, X2's `#trends`) the bench must sit above. */
  private readonly strips: readonly HTMLElement[];

  private readonly wallRows: { readonly barrier: BenchBarrier; readonly body: HTMLElement }[] = [];

  constructor(deps: BenchDeps) {
    this.deps = deps;
    this.host = deps.host;

    if (document.getElementById(STYLE_ID) === null) {
      const style = el('style');
      style.id = STYLE_ID;
      style.textContent = STYLE_TEXT;
      document.head.append(style);
    }

    this.overlay = el('div');
    this.overlay.id = 'gt-walls-overlay';
    // Painted in tree order, immediately after the canvas: above the water,
    // below every panel. A z-index instead would hoist the bands over the
    // station log and the specimen label, which are the things being read.
    const world = document.getElementById('world');
    if (world?.parentElement != null) world.after(this.overlay);
    else document.body.append(this.overlay);

    const title = el('div', 'gt-title');
    title.append(el('span', '', 'Experiment bench'));
    const keys = el('span', 'gt-keys');
    keys.append(el('span', 'gt-kbd', 'g'), document.createTextNode(' bench · '), el('span', 'gt-kbd', 'esc'));
    keys.append(document.createTextNode(' cancel'));
    title.append(keys);
    this.host.append(title);

    this.armedLine = el('div', 'gt-armed');
    this.armedLine.hidden = true;
    this.host.append(this.armedLine);

    // ---- walls -----------------------------------------------------------
    this.host.append(rule(), sectionHead('Walls'));

    const migrationRow = el('div', 'gt-row');
    migrationRow.append(el('span', 'label', 'migration'));
    const migration = el('input', 'gt-slider');
    migration.type = 'range';
    migration.min = '0';
    migration.max = '1';
    migration.step = '0.01';
    migration.value = '0';
    this.permeabilityValue = el('span', 'gt-value', '0.00');
    migration.addEventListener('input', () => {
      this.permeability = clampUnit(Number(migration.value));
      this.permeabilityValue.textContent = this.permeability.toFixed(2);
    });
    // Same reason as the presets: the digits belong to the watch speed.
    migration.addEventListener('change', () => migration.blur());
    migrationRow.append(migration, this.permeabilityValue);
    this.host.append(migrationRow);
    this.host.append(el('span', 'gt-note', '0 = sealed · 1 = open water · between = a slow crossing'));

    const raiseRow = el('div', 'gt-row');
    raiseRow.append(this.armButton('wall', 'Raise wall', 'gt-grow'));
    this.host.append(raiseRow);

    this.wallList = el('div', 'gt-walls');
    this.wallEmpty = el('span', 'gt-empty', 'no walls standing');
    this.host.append(this.wallEmpty, this.wallList);

    // ---- climate ---------------------------------------------------------
    this.host.append(rule(), sectionHead('Climate'));

    const climateRow = el('div', 'gt-row');
    climateRow.append(el('span', 'label', 'target'));
    const climate = el('input', 'gt-slider');
    climate.type = 'range';
    climate.min = String(-CLIMATE_LIMIT_C);
    climate.max = String(CLIMATE_LIMIT_C);
    climate.step = '0.5';
    climate.value = '0';
    this.climateValue = el('span', 'gt-value', '+0.0');
    climate.addEventListener('input', () => {
      this.climateTargetC = Number(climate.value);
      this.climateValue.textContent = signedFixed(this.climateTargetC, 1);
    });
    climate.addEventListener('change', () => climate.blur());
    climateRow.append(climate, this.climateValue);
    this.host.append(climateRow);

    const climateApply = el('div', 'gt-row');
    this.climateNow = el('span', 'gt-note gt-grow', 'now —');
    climateApply.append(this.climateNow, this.button('Apply', () => this.applyClimate()));
    this.host.append(climateApply);

    // ---- disturbances ----------------------------------------------------
    this.host.append(rule(), sectionHead('Disturbance'));

    this.thermalSelect = this.presetSelect(THERMAL_PRESETS);
    const thermalRow = el('div', 'gt-row');
    thermalRow.append(this.thermalSelect, this.button('Thermal', () => this.fireThermal()));
    this.host.append(thermalRow);

    this.crashSelect = this.presetSelect(CRASH_PRESETS);
    const crashRow = el('div', 'gt-row');
    this.crashGlobalButton = this.button('Global', () => this.toggleCrashScope());
    this.crashGlobalButton.setAttribute('aria-pressed', 'true');
    crashRow.append(this.crashSelect, this.crashGlobalButton);
    const crashFire = el('div', 'gt-row');
    const crashButton = this.button('Plankton crash', () => this.firePlanktonCrash(), 'gt-grow');
    // Registered as the crash's arm button so it lights up in the regional case,
    // even though the global case fires straight from it.
    this.armButtons.set('planktonCrash', crashButton);
    crashFire.append(crashButton);
    this.host.append(crashRow, crashFire);

    this.stormSelect = this.presetSelect(STORM_PRESETS);
    const stormRow = el('div', 'gt-row');
    stormRow.append(this.stormSelect, this.armButton('kelpStorm', 'Kelp storm'));
    this.host.append(stormRow);
    this.host.append(el('span', 'gt-note', 'kelp storms are always regional — click to place'));

    // ---- meteor ----------------------------------------------------------
    this.host.append(rule(), sectionHead('Meteor'));
    const meteorRow = el('div', 'gt-row');
    meteorRow.append(el('span', 'label', 'radius'));
    const meteor = el('input', 'gt-slider');
    meteor.type = 'range';
    meteor.min = String(METEOR_MIN_WU);
    meteor.max = String(METEOR_MAX_WU);
    meteor.step = '10';
    meteor.value = String(METEOR_DEFAULT_WU);
    this.meteorValue = el('span', 'gt-value', `${METEOR_DEFAULT_WU}`);
    meteor.addEventListener('input', () => {
      this.meteorRadiusWu = Number(meteor.value);
      this.meteorValue.textContent = String(Math.round(this.meteorRadiusWu));
    });
    meteor.addEventListener('change', () => meteor.blur());
    meteorRow.append(meteor, this.meteorValue);
    const meteorFire = el('div', 'gt-row');
    meteorFire.append(this.armButton('meteor', 'Meteor', 'gt-grow'));
    this.host.append(meteorRow, meteorFire);

    // ---- clade founding --------------------------------------------------
    this.host.append(rule(), sectionHead('Found a clade'));
    const cladeRow = el('div', 'gt-row gt-row--wrap');
    cladeRow.append(
      this.armButton('foundRadialDrifter', 'Radial drifter'),
      this.armButton('foundArmoredCrawler', 'Armoured crawler'),
    );
    this.host.append(cladeRow);
    this.host.append(
      el('span', 'gt-note', `${FOUNDING_COUNT} individuals, macro-locus edited on a living genome`),
    );

    // The trend strip and X2's panel are bottom-anchored and open on a keypress,
    // so the bench lifts above whichever is up rather than being buried by it.
    this.strips = ['charts', 'trends']
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element instanceof HTMLElement);
    const observer = new MutationObserver(() => this.syncBottomOffset());
    for (const strip of this.strips) observer.observe(strip, { attributes: true, attributeFilter: ['hidden'] });
    window.addEventListener('resize', () => this.syncBottomOffset());
    this.syncBottomOffset();

    // Ages are read against the sim tick, which moves whether or not anything
    // in the ledger does. Twice a second is under the eye's threshold for a
    // counter and nowhere near the frame budget.
    window.setInterval(() => {
      if (this.open) this.refreshWallAges();
    }, WALL_AGE_REFRESH_MS);

    this.renderWalls();
  }

  // -------------------------------------------------------------------------
  // Public surface (main.ts)
  // -------------------------------------------------------------------------

  get open(): boolean {
    return !this.host.hidden;
  }

  toggle(): void {
    if (this.open) {
      this.cancelArmed();
      this.host.hidden = true;
      return;
    }
    this.host.hidden = false;
    this.syncBottomOffset();
    this.renderWalls();
  }

  private syncBottomOffset(): void {
    let lift = 0;
    for (const strip of this.strips) {
      if (strip.hidden) continue;
      const height = strip.getBoundingClientRect().height;
      if (height > lift) lift = height;
    }
    this.host.style.bottom = `${12 + lift}px`;
  }

  /**
   * True when the click was an armed instrument and must not reach the
   * inspector. Returning false leaves the ordinary select path untouched, which
   * is the whole contract this seam has with main.ts.
   */
  handleCanvasClick(clientX: number, clientY: number): boolean {
    if (this.armed.mode === null) return false;
    const raw = this.deps.viewport.toWorld(clientX, clientY);
    const world = this.deps.config.world;
    const point = clampToWorld(raw, world.widthWu, world.heightWu);
    const result = reduceArmed(this.armed, { kind: 'click', point }, this.settings());
    this.armed = result.state;
    if (result.command !== null) this.issue(result.command);
    this.syncArmed();
    return true;
  }

  /** `esc`. True when something was actually cancelled, so the key can be swallowed. */
  cancelArmed(): boolean {
    if (this.armed.mode === null) return false;
    this.armed = reduceArmed(this.armed, { kind: 'cancel' }, this.settings()).state;
    this.syncArmed();
    this.deps.note('command cancelled');
    return true;
  }

  /**
   * Sim events, straight off `ticked`/`events`. The bench reads two kinds: a
   * `barrierChange` reconciles the ledger against the world (and picks up walls
   * raised from the console or a probe script), and a climate event keeps the
   * "now" reading honest between sample rows.
   */
  observeEvents(events: readonly SimEvent[]): void {
    let touched = false;
    for (const event of events) {
      if (event.kind === 'barrierChange') {
        const spec = event.barrier;
        this.ledger = reduceBarriers(
          this.ledger,
          event.change === 'raised'
            ? {
                kind: 'raised',
                id: spec.id,
                permeability: spec.permeability,
                raisedTick: spec.raisedTick,
                shape: spec.shape,
              }
            : { kind: 'lowered', id: spec.id },
        );
        touched = true;
      } else if (event.kind === 'climateEvent') {
        this.climateObservedC = event.meanOffsetC;
        this.syncClimateNow();
      }
    }
    if (touched) this.renderWalls();
  }

  /** Latest climate offset off a `SampleRow`; the sampled reading beats the applied target. */
  observeClimate(offsetC: number): void {
    this.climateObservedC = offsetC;
    this.syncClimateNow();
  }

  /** Reseed: the new ocean has no walls, and W-numbering starts over with it. */
  reset(): void {
    this.armed = DISARMED;
    this.ledger = reduceBarriers(this.ledger, { kind: 'cleared' });
    this.wallCounter = 0;
    this.climateObservedC = null;
    this.syncArmed();
    this.syncClimateNow();
    this.renderWalls();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private settings(): BenchSettings {
    const config = this.deps.config;
    return {
      barrierId: `W${this.wallCounter + 1}`,
      permeability: this.permeability,
      wallThicknessWu: WALL_MIN_CELLS * config.world.fieldCellSizeWu,
      meteorRadiusWu: this.meteorRadiusWu,
      generationTicks: config.time.generationTicks,
      planktonCrash: this.selectedPreset(this.crashSelect, CRASH_PRESETS),
      planktonCrashRadiusWu: config.disturbance.planktonCrashRadiusWu,
      kelpStorm: this.selectedPreset(this.stormSelect, STORM_PRESETS),
      kelpStormRadiusWu: config.disturbance.kelpStormSwathWidthWu,
      foundingCount: FOUNDING_COUNT,
    };
  }

  private selectedPreset(select: HTMLSelectElement, presets: readonly ShockPreset[]): ShockPreset {
    const chosen = presets[select.selectedIndex];
    return chosen ?? presets[0] ?? { label: '—', magnitude: 1, durationGenerations: 1 };
  }

  private presetSelect(presets: readonly ShockPreset[]): HTMLSelectElement {
    const select = el('select', 'gt-select');
    for (const preset of presets) {
      const option = el('option', '', preset.label);
      select.append(option);
    }
    select.selectedIndex = 0;
    // The window keydown handler owns the digits and space; a select that kept
    // focus would answer them too and silently change the preset.
    select.addEventListener('change', () => select.blur());
    return select;
  }

  private button(label: string, onClick: () => void, extra?: string): HTMLButtonElement {
    const element = el('button', extra === undefined ? 'gt-btn' : `gt-btn ${extra}`, label);
    element.type = 'button';
    element.addEventListener('click', () => {
      onClick();
      // The window keydown handler owns space and the digits; a button that
      // keeps focus would answer them too, so the next `space` would re-fire
      // this command as well as pausing.
      element.blur();
    });
    return element;
  }

  private armButton(mode: ArmedMode, label: string, extra?: string): HTMLButtonElement {
    const element = this.button(label, () => this.arm(mode), extra);
    this.armButtons.set(mode, element);
    return element;
  }

  private arm(mode: ArmedMode): void {
    // Pressing an armed button again is a cancel — the same button is the only
    // thing the hand is already on when the intent changes.
    const action: ArmedAction = this.armed.mode === mode ? { kind: 'cancel' } : { kind: 'arm', mode };
    this.armed = reduceArmed(this.armed, action, this.settings()).state;
    this.syncArmed();
  }

  private syncArmed(): void {
    const status = armedStatus(this.armed);
    this.armedLine.textContent = status;
    this.armedLine.hidden = status === '';
    if (this.armed.mode === null) delete document.body.dataset['benchArmed'];
    else document.body.dataset['benchArmed'] = '1';
    for (const [mode, element] of this.armButtons) {
      element.classList.toggle('gt-btn--armed', mode === this.armed.mode);
    }
    this.syncOverlay();
  }

  private issue(command: SimCommand): void {
    if (command.kind === 'raiseBarrier') {
      this.wallCounter += 1;
      this.ledger = reduceBarriers(this.ledger, {
        kind: 'raised',
        id: command.barrierId,
        permeability: command.permeability,
        raisedTick: this.deps.currentTick(),
        shape: command.shape,
      });
      this.renderWalls();
    }
    this.deps.note(this.describe(command));
    this.deps.send(command).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.note(`command failed: ${message}`);
      // The raise was recorded optimistically; a wall the sim never heard about
      // must not sit in the list claiming to be standing.
      if (command.kind === 'raiseBarrier') {
        this.ledger = reduceBarriers(this.ledger, { kind: 'lowered', id: command.barrierId });
        this.renderWalls();
      }
    });
  }

  private describe(command: SimCommand): string {
    switch (command.kind) {
      case 'raiseBarrier': {
        const shape = command.shape;
        const where =
          shape.kind === 'verticalRidge'
            ? `x ${grouped(shape.xWu)}`
            : shape.kind === 'horizontalRidge'
              ? `y ${grouped(shape.yWu)}`
              : `rect ${grouped(shape.xWu)},${grouped(shape.yWu)}`;
        return `wall ${command.barrierId} raised · ${where} · permeability ${command.permeability.toFixed(2)}`;
      }
      case 'lowerBarrier': {
        const standing = this.ledger.find((barrier) => barrier.id === command.barrierId);
        const age = standing === undefined ? 0 : Math.max(0, this.deps.currentTick() - standing.raisedTick);
        return `wall ${command.barrierId} dropped after ${grouped(age)} ticks`;
      }
      case 'setClimateTarget':
        return `climate target ${signedFixed(command.targetOffsetC, 1)} °C`;
      case 'meteor':
        return `meteor · ${grouped(command.x)},${grouped(command.y)} · radius ${Math.round(command.radiusWu)} wu`;
      case 'triggerDisturbance': {
        const scope = command.region === null || command.region === undefined ? 'global' : 'regional';
        const magnitude =
          command.shock === 'thermal'
            ? `${signedFixed(command.magnitude, 1)} °C`
            : command.shock === 'planktonCrash'
              ? `×${command.magnitude.toFixed(2)}`
              : `${Math.round(command.magnitude * 100)}% cleared`;
        return `${command.shock} · ${magnitude} · ${scope} · ${grouped(command.durationTicks)} ticks`;
      }
      case 'introduceMutant': {
        const radial = FOUNDING_EDITS.radialDrifter;
        const isRadial = radial !== null && command.locus === radial.locus && command.value === radial.value;
        const archetype = isRadial ? 'radial drifters' : 'armoured crawlers';
        return `founding ${command.count} ${archetype} · ${command.locus} allele ${command.value}`;
      }
      case 'trackSweep':
      case 'setToggle':
        return `command ${command.kind}`;
    }
  }

  private applyClimate(): void {
    this.issue({ kind: 'setClimateTarget', targetOffsetC: this.climateTargetC });
    if (this.climateObservedC === null) this.syncClimateNow();
  }

  private fireThermal(): void {
    const preset = this.selectedPreset(this.thermalSelect, THERMAL_PRESETS);
    this.issue(shockCommand('thermal', preset, this.deps.config.time.generationTicks, null));
  }

  private firePlanktonCrash(): void {
    if (!this.crashGlobal) {
      this.arm('planktonCrash');
      return;
    }
    const settings = this.settings();
    this.issue(shockCommand('planktonCrash', settings.planktonCrash, settings.generationTicks, null));
  }

  private toggleCrashScope(): void {
    this.crashGlobal = !this.crashGlobal;
    this.crashGlobalButton.textContent = this.crashGlobal ? 'Global' : 'Region';
    this.crashGlobalButton.setAttribute('aria-pressed', this.crashGlobal ? 'true' : 'false');
    if (this.crashGlobal && this.armed.mode === 'planktonCrash') this.cancelArmed();
  }

  private syncClimateNow(): void {
    const now =
      this.climateObservedC === null ? 'now —' : `now ${signedFixed(this.climateObservedC, 2)} °C (drifting)`;
    this.climateNow.textContent = now;
  }

  private renderWalls(): void {
    this.wallList.replaceChildren();
    this.wallRows.length = 0;
    this.wallEmpty.hidden = this.ledger.length > 0;
    for (const barrier of this.ledger) {
      const row = el('div', 'gt-wall');
      const body = el('span', 'gt-wall-body');
      row.append(
        el('span', 'gt-wall-id', barrier.id),
        body,
        this.button('Drop', () => this.issue({ kind: 'lowerBarrier', barrierId: barrier.id }), 'gt-btn--drop'),
      );
      this.wallList.append(row);
      this.wallRows.push({ barrier, body });
    }
    this.refreshWallAges();
    this.syncOverlay();
  }

  /**
   * Wall ages advance with the sim, so they are retyped in place rather than by
   * rebuilding the rows: a rebuild between mousedown and mouseup swallows the
   * DROP click that was already underway.
   */
  private refreshWallAges(): void {
    const tick = this.deps.currentTick();
    for (const row of this.wallRows) {
      const age = Math.max(0, tick - row.barrier.raisedTick);
      const text = `perm ${row.barrier.permeability.toFixed(2)} · ${grouped(age)}t`;
      if (row.body.textContent !== text) row.body.textContent = text;
    }
  }

  /**
   * Start or stop the overlay's frame loop. It runs only while there is
   * something to draw, because it reads the camera every frame and the ocean is
   * the only thing on this page allowed to cost that continuously.
   */
  private syncOverlay(): void {
    const wanted = this.ledger.length > 0 || this.armed.firstPoint !== null;
    if (!wanted) {
      if (this.overlayFrame !== 0) {
        window.cancelAnimationFrame(this.overlayFrame);
        this.overlayFrame = 0;
      }
      this.overlay.replaceChildren();
      return;
    }
    if (this.overlayFrame !== 0) return;
    const step = (): void => {
      this.drawOverlay();
      this.overlayFrame = window.requestAnimationFrame(step);
    };
    this.overlayFrame = window.requestAnimationFrame(step);
  }

  /**
   * Paint the standing walls in screen space.
   *
   * The camera is exposed as `toWorld` plus a scale, so the forward transform is
   * recovered by asking what world point sits at the top-left pixel: screen =
   * (world − origin) × pxPerWu. That holds for a pan/zoom camera and would not
   * for a rotating one — there is no rotation in this renderer, and a rotating
   * camera would need a real `toScreen` on the render contract anyway.
   */
  private drawOverlay(): void {
    const viewport = this.deps.viewport;
    const origin = viewport.toWorld(0, 0);
    const scale = viewport.pixelsPerWu;
    if (!Number.isFinite(scale) || scale <= 0) return;
    const world = this.deps.config.world;
    const bands: HTMLElement[] = [];

    for (const barrier of this.ledger) {
      const band = el('div', 'gt-band');
      const shape = barrier.shape;
      let x0 = 0;
      let x1 = world.widthWu;
      let y0 = 0;
      let y1 = world.heightWu;
      if (shape.kind === 'verticalRidge') {
        x0 = shape.xWu - shape.thicknessWu / 2;
        x1 = shape.xWu + shape.thicknessWu / 2;
      } else if (shape.kind === 'horizontalRidge') {
        y0 = shape.yWu - shape.thicknessWu / 2;
        y1 = shape.yWu + shape.thicknessWu / 2;
      } else {
        x0 = shape.xWu;
        x1 = shape.xWu + shape.widthWu;
        y0 = shape.yWu;
        y1 = shape.yWu + shape.heightWu;
      }
      band.style.left = `${(x0 - origin.x) * scale}px`;
      band.style.top = `${(y0 - origin.y) * scale}px`;
      band.style.width = `${Math.max(1, (x1 - x0) * scale)}px`;
      band.style.height = `${Math.max(1, (y1 - y0) * scale)}px`;
      // A leaky wall is drawn faint: the picture should say at a glance whether
      // migration is possible, because that is the whole experiment.
      band.style.opacity = `${0.85 - 0.6 * clampUnit(barrier.permeability)}`;
      bands.push(band);
    }

    const first = this.armed.firstPoint;
    if (first !== null) {
      const mark = el('div', 'gt-mark');
      mark.style.left = `${(first.x - origin.x) * scale}px`;
      mark.style.top = `${(first.y - origin.y) * scale}px`;
      bands.push(mark);
    }

    this.overlay.replaceChildren(...bands);
  }
}
