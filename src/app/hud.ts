/**
 * The text the watcher actually reads — R/V Panthalassa's station chrome.
 *
 * Three surfaces, one register. The **station log** (`#status`) answers "is
 * anything happening": tick, generation, population, losses by every channel,
 * matings, species count, speed, and a running feed of narrative events. The
 * **specimen label** (`#panel`) is what one clicked organism turns out to be:
 * catalogue number, morphometry, loci, pedigree. The **all-stations notice**
 * (`#banner`) is the one thing the corner text cannot carry, because an empty
 * ocean looks exactly like a paused one.
 *
 * Losses and matings are cumulative sums over `SampleRow`s rather than a count
 * of forwarded events: a generation raises thousands of birth and death events
 * and `events.ts` reserves those for the recorder, so the recorder is where the
 * tallies come from. That also means the loss table only moves every
 * `sampling.sampleIntervalTicks` ticks, which the row-tick note makes plain.
 *
 * `render` runs every frame, so the DOM is built once in the constructor and
 * only text nodes change afterwards — and only the ones whose value actually
 * moved. Nothing here reads layout or writes markup after construction.
 */

import type { SimEvent } from '../contracts/events';
import type { OrganismDump } from '../contracts/protocol';
import { TRAIT_KEYS, TRAIT_META } from '../contracts/traits';
import type { DeathCause } from '../contracts/types';
import { DEATH_CAUSES } from '../contracts/types';
// The same mapping the renderer paints with, so the word this panel prints for
// a signal and the saturation on screen can never disagree.
import { conspicuousnessSignal } from '../render/contracts';
import type { ColourLegend, FieldOverlay } from './crudeRenderer';

/**
 * What the banner says when the run is over. Extinction is the one state the
 * corner text cannot carry: an empty ocean looks exactly like a paused one, and
 * the whole point of the ambient view is that you are not staring at it.
 */
export interface ExtinctionNotice {
  readonly tick: number;
  readonly generation: number;
  /** Final tallies, so the banner says what killed the world and not just that it died. */
  readonly deaths: Readonly<Record<DeathCause, number>>;
  /** Whole seconds until an automatic reseed, or null once the countdown is cancelled. */
  readonly autoRestartInSeconds: number | null;
}

/**
 * What the sample slice knows about the inspected organism and the selection
 * dump does not: whether it has matured, and how long it actually is.
 *
 * These ride the slice rather than `OrganismDump` because they are per-tick
 * state (`sizeCurrent` and the maturity test), and the dump is a genome-and-
 * pedigree document. `main.ts` looks the organism's slot up in the slice it is
 * already holding, so no extra worker round trip is spent on them.
 */
export interface SpecimenStage {
  /** 1 mature, 0 juvenile. */
  readonly lifeStage: number;
  /** Realised body length, cm — against the dump's `size` trait, which is the target. */
  readonly realisedLengthCm: number;
}

export interface HudModel {
  readonly seed: string;
  readonly tick: number;
  readonly generation: number;
  readonly population: number;
  readonly speedMultiplier: number;
  readonly paused: boolean;
  readonly speciesCount: number;
  readonly cladeCount: number;
  readonly deaths: Readonly<Record<DeathCause, number>>;
  readonly matings: number;
  readonly carrionBiomass: number;
  readonly overlay: FieldOverlay;
  readonly framesPerSecond: number;
  /** Tick of the newest `SampleRow` folded into the tallies; −1 before the first row. */
  readonly lastRowTick: number;
  readonly events: readonly string[];
  /** null while anything is still alive. */
  readonly extinction: ExtinctionNotice | null;
  /**
   * What the dots are coloured by. Printed as words because a ramp that is only
   * a ramp says nothing: the reader needs the quantity and its endpoints.
   */
  readonly colour: ColourLegend;
  readonly chartsOpen: boolean;
}

const TRAIT_LABEL_WIDTH = 14;

/** How many feed lines the log keeps on screen. */
const FEED_LINES = 8;

/** Cells in the percentile meter; also its printed width in characters. */
const METER_CELLS = 10;

/**
 * Station shorthand for the loss channels. `DeathCause` names are prose; the log
 * line is read at a glance, from across the room, and has to stay one line wide.
 */
const LOSS_ABBREVIATION: Readonly<Record<DeathCause, string>> = {
  starvation: 'starv',
  predation: 'pred',
  temperature: 'therm',
  senescence: 'age',
  catastrophe: 'cat',
  toxin: 'tox',
};

const SEX_GLYPH = { female: '♀', male: '♂' } as const;

function fixed(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

/**
 * A percentile as a filled bar plus its number. Position is the channel that
 * reads at a glance; the number is there for when the reader wants to be exact.
 */
function meter(fraction: number): string {
  if (!Number.isFinite(fraction)) return pad('—', METER_CELLS) + padStart('—', 4);
  const filled = Math.max(0, Math.min(METER_CELLS, Math.round(fraction * METER_CELLS)));
  return '█'.repeat(filled) + '░'.repeat(METER_CELLS - filled) + padStart(fixed(fraction * 100, 0), 4);
}

/** One line of feed text per narrative event. Births and deaths never reach here. */
export function describeEvent(event: SimEvent): string {
  switch (event.kind) {
    case 'speciesSplit':
      return `t${event.tick} split · species ${event.parentTag} → ${event.childTags[0]}/${event.childTags[1]} (cross ${fixed(event.crossMatingRate, 3)}, ${event.sizes[0]}/${event.sizes[1]})`;
    case 'speciesExtinction':
      return `t${event.tick} lost · species ${event.tag} after ${event.lifetimeTicks} ticks (peak ${event.peakPopulation})`;
    case 'cladeFounding':
      return `t${event.tick} clade ${event.cladeId} founded · ${event.parentArchetype} → ${event.archetype} (org ${event.founderId})`;
    case 'sweepCrossedHalf':
      return `t${event.tick} sweep · ${event.locus}/${event.allele} crossed 0.5 (${fixed(event.frequency, 3)}) in ${fixed(event.generationsElapsed, 1)} gens`;
    case 'climateEvent':
      return `t${event.tick} climate ${event.cause} · ${fixed(event.meanOffsetC, 2)}°C (Δ${fixed(event.deltaC, 2)})`;
    case 'barrierChange':
      return `t${event.tick} barrier ${event.barrier.id} ${event.change} · ${event.barrier.shape.kind}`;
    case 'meteor':
      return `t${event.tick} meteor · ${Math.round(event.x)},${Math.round(event.y)} r${Math.round(event.radiusWu)} killed ${event.killed}`;
    case 'mutantIntroduced':
      return `t${event.tick} mutant ${event.id} introduced · ${event.source}, deme ${event.deme}`;
    case 'thermalShock':
      return `t${event.tick} thermal shock · ${event.magnitudeC >= 0 ? '+' : ''}${fixed(event.magnitudeC, 1)}°C (${event.durationTicks} ticks remaining)`;
    case 'planktonCrash':
      return `t${event.tick} plankton crash · ×${fixed(event.productivityMultiplier, 2)} ${event.region === null ? 'global' : event.region.kind} (${event.durationTicks} ticks remaining)`;
    case 'kelpStorm':
      return `t${event.tick} kelp storm · cleared ${fixed(event.clearFraction * 100, 0)}% ${event.region.kind} (${event.durationTicks} ticks remaining)`;
    case 'toxinInvention':
      return `t${event.tick} toxin invented · org ${event.id} load ${fixed(event.toxicity, 2)}${event.viaMacroLocus ? ' (macro-locus)' : ''}`;
    case 'birth':
    case 'death':
      return `t${event.tick} ${event.kind} ${event.id}`;
  }
}

/**
 * One updatable text node.
 *
 * The guard is the whole point: at 60 fps most of these strings are identical
 * frame to frame, and assigning an unchanged value to `Text.data` still marks
 * the node dirty.
 */
class Field {
  readonly node: Text;
  private last: string;

  constructor(initial = '') {
    this.node = document.createTextNode(initial);
    this.last = initial;
  }

  set(value: string): void {
    if (value === this.last) return;
    this.last = value;
    this.node.data = value;
  }
}

function span(className: string, text?: string): HTMLSpanElement {
  const element = document.createElement('span');
  if (className !== '') element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function div(className: string, text?: string): HTMLDivElement {
  const element = document.createElement('div');
  if (className !== '') element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/**
 * The key legend. Every binding the app answers to is named here — the reader
 * has no other way to discover them, so a binding missing from this list is a
 * feature that does not exist.
 *
 * "sim speed" rather than "speed": the multiplier is ticks of world per frame,
 * and the creature layer deliberately does not scale its body animation by it,
 * so at 256× the animals still swim at believable rates. Calling it playback
 * speed would promise a picture the renderer does not draw.
 */
const KEY_BINDINGS: readonly (readonly [string, string])[] = [
  ['space', 'pause'],
  ['1-9', 'sim speed 1..256×'],
  ['f', 'field'],
  ['c', 'colour'],
  ['t', 'trends'],
  ['wheel', 'zoom'],
  ['drag', 'pan'],
  ['dbl / 0', 'fit'],
  ['click', 'inspect'],
];

export class Hud {
  private readonly banner: HTMLElement;

  // Station log fields.
  private readonly seedField = new Field();
  private readonly tickField = new Field();
  private readonly generationField = new Field();
  private readonly populationField = new Field();
  private readonly speciesField = new Field();
  private readonly speedField = new Field();
  private readonly speedValue: HTMLElement;
  private readonly cladeField = new Field();
  private readonly fpsField = new Field();
  private readonly matingField = new Field();
  private readonly lossTotalField = new Field();
  private readonly lossBreakdownField = new Field();
  private readonly carrionField = new Field();
  private readonly rowNoteField = new Field();
  private readonly overlayField = new Field();
  private readonly colourModeField = new Field();
  private readonly colourDescField = new Field();
  private readonly colourStopsField = new Field();
  private readonly colourStops: HTMLElement;
  private readonly trendsOpenField = new Field();
  private readonly feedRule: HTMLElement;
  private readonly feedLines: readonly { readonly element: HTMLElement; readonly field: Field }[];

  // Specimen label.
  private readonly panelEmpty: HTMLElement;
  private readonly panelBody: HTMLElement;
  private readonly catalogueField = new Field();
  private readonly specimenSubField = new Field();
  private readonly recordField = new Field();
  private readonly lifeField = new Field();
  private readonly traitsField = new Field();
  private readonly quantField = new Field();
  private readonly discreteField = new Field();
  private readonly pedigreeField = new Field();
  private readonly pedigreeCountField = new Field();
  private specimenPing: HTMLElement;

  // All-stations notice.
  private readonly bannerGeneration = new Field();
  private readonly bannerTick = new Field();
  private readonly bannerTally: Readonly<Record<DeathCause, Field>>;
  private readonly bannerCountdown: HTMLElement;
  private readonly bannerCountdownField = new Field();

  private paused = false;

  constructor(status: HTMLElement, panel: HTMLElement, banner: HTMLElement) {
    this.banner = banner;

    // ---- station log -----------------------------------------------------
    const head = span('st-head');
    head.append(span('st-ship', 'R/V Panthalassa'));
    const seed = span('');
    seed.append(span('label', 'seed '));
    const seedValue = span('st-seed-value');
    seedValue.append(this.seedField.node);
    seed.append(seedValue);
    head.append(seed);

    const vitals = span('st-grid');
    this.bindPair(vitals, 'tick', this.tickField);
    this.bindPair(vitals, 'gen', this.generationField);
    this.bindPair(vitals, 'pop', this.populationField);
    this.bindPair(vitals, 'species', this.speciesField);
    this.speedValue = this.bindPair(vitals, 'speed', this.speedField);
    this.bindPair(vitals, 'clades', this.cladeField);
    this.bindPair(vitals, 'fps', this.fpsField);
    this.bindPair(vitals, 'matings', this.matingField);

    const ledger = span('st-grid');
    this.bindPair(ledger, 'losses', this.lossTotalField);
    this.bindPair(ledger, 'carrion', this.carrionField);

    const breakdown = span('st-tally');
    breakdown.append(this.lossBreakdownField.node);
    const rowNote = span('st-note');
    rowNote.append(this.rowNoteField.node);

    const readout = span('st-grid');
    this.bindPair(readout, 'field', this.overlayField);
    this.bindPair(readout, 'colour', this.colourModeField);
    const colourDesc = span('st-desc');
    colourDesc.append(this.colourDescField.node);
    // The identity mode has no ramp to label, so the row is not just empty text —
    // it is absent, and must not leave a blank line ruled into the log.
    const colourStops = span('st-swatches');
    colourStops.append(this.colourStopsField.node);
    colourStops.hidden = true;
    this.colourStops = colourStops;

    const keys = span('st-keys');
    for (const [key, action] of KEY_BINDINGS) {
      const entry = span('');
      entry.append(span('st-kbd', key), document.createTextNode(` ${action}`));
      if (key === 't') entry.append(this.trendsOpenField.node);
      keys.append(entry);
    }

    this.feedRule = span('rule');
    const feed = span('st-feed');
    const feedLines: { readonly element: HTMLElement; readonly field: Field }[] = [];
    for (let index = 0; index < FEED_LINES; index += 1) {
      const field = new Field();
      const element = span('st-feed-line');
      element.append(field.node);
      element.hidden = true;
      feed.append(element);
      feedLines.push({ element, field });
    }
    this.feedLines = feedLines;

    status.replaceChildren(
      head,
      span('rule'),
      vitals,
      span('rule'),
      ledger,
      breakdown,
      rowNote,
      span('rule'),
      readout,
      colourDesc,
      colourStops,
      span('rule'),
      keys,
      this.feedRule,
      feed,
    );

    // ---- specimen label --------------------------------------------------
    this.panelEmpty = span('sp-empty', 'no specimen on the stage — click a dot to bring one up');
    this.specimenPing = span('sp-ping');

    const specimenHead = span('sp-head');
    const catalogue = span('sp-catalogue');
    catalogue.append(this.catalogueField.node);
    specimenHead.append(this.specimenPing, catalogue, span('label', 'specimen label'));

    const specimenSub = span('sp-sub');
    specimenSub.append(this.specimenSubField.node);

    this.panelBody = span('');
    this.panelBody.append(
      specimenHead,
      specimenSub,
      span('rule'),
      this.section('observation', this.recordField, null),
      span('rule'),
      // Above morphometry on purpose. These three readings are the ones the
      // world view cannot answer — a juvenile is only *small* on screen, and
      // toxicity is deliberately absent from the slice so the watcher has to
      // infer it the way the predators do. Buried at row 22 of the trait table
      // they would be findable but never found.
      this.section(
        'life history & chemistry · toxicity is not on the world view — the eye has to infer it',
        this.lifeField,
        null,
      ),
      span('rule'),
      this.section(
        'morphometry',
        this.traitsField,
        pad('trait', TRAIT_LABEL_WIDTH) +
          padStart('expressed', 11) +
          padStart('latent', 11) +
          padStart('genotypic', 11) +
          '  ' +
          pad('percentile', METER_CELLS + 4) +
          '  unit',
      ),
      span('rule'),
      this.section('quantitative loci · maternal / paternal → trait loads', this.quantField, null),
      span('rule'),
      this.section('discrete loci · maternal / paternal', this.discreteField, null),
      span('rule'),
      this.pedigreeSection(),
    );
    this.panelBody.hidden = true;
    panel.replaceChildren(this.panelEmpty, this.panelBody);

    // ---- all-stations notice ---------------------------------------------
    const tally = div('bn-tally');
    const tallyFields = {} as Record<DeathCause, Field>;
    for (const cause of DEATH_CAUSES) {
      const field = new Field();
      tallyFields[cause] = field;
      const value = div('bn-tally-value');
      value.append(field.node);
      tally.append(div('label', cause), value);
    }
    this.bannerTally = tallyFields;

    const bannerSub = div('bn-sub');
    bannerSub.append(
      document.createTextNode('generation '),
      this.bannerGeneration.node,
      document.createTextNode(' · tick '),
      this.bannerTick.node,
    );

    this.bannerCountdown = div('bn-countdown');
    this.bannerCountdown.append(this.bannerCountdownField.node);
    this.bannerCountdown.hidden = true;

    banner.replaceChildren(
      div('bn-ring'),
      div('bn-ring bn-ring--echo'),
      div('bn-eyebrow', 'all stations · R/V Panthalassa'),
      div('bn-title', 'EXTINCT'),
      bannerSub,
      div('bn-rule'),
      tally,
      div('bn-rule'),
      div('bn-hint', 'press R for a new world'),
      this.bannerCountdown,
    );
    banner.hidden = true;
  }

  render(model: HudModel): void {
    this.seedField.set(model.seed);
    this.tickField.set(String(model.tick));
    this.generationField.set(fixed(model.generation, 2));
    this.populationField.set(String(model.population));
    this.speciesField.set(String(model.speciesCount));
    this.speedField.set(model.paused ? 'PAUSED' : `${model.speedMultiplier}×`);
    this.cladeField.set(String(model.cladeCount));
    this.fpsField.set(fixed(model.framesPerSecond, 0));
    this.matingField.set(String(model.matings));

    // Class churn is the expensive kind of DOM write, so it happens on the
    // transition only, not on every frame the run happens to be paused.
    if (model.paused !== this.paused) {
      this.paused = model.paused;
      this.speedValue.classList.toggle('st-value--paused', model.paused);
    }

    let lossTotal = 0;
    for (const cause of DEATH_CAUSES) lossTotal += model.deaths[cause];
    this.lossTotalField.set(String(lossTotal));
    this.lossBreakdownField.set(
      DEATH_CAUSES.map((cause) => `${LOSS_ABBREVIATION[cause]} ${model.deaths[cause]}`).join(' · '),
    );
    this.carrionField.set(fixed(model.carrionBiomass, 1));
    this.rowNoteField.set(`tallied from sample rows · last row t${model.lastRowTick}`);

    this.overlayField.set(model.overlay);
    this.colourModeField.set(model.colour.mode);
    this.colourDescField.set(model.colour.description);
    const hasStops = model.colour.stops.length > 0;
    if (this.colourStops.hidden === hasStops) this.colourStops.hidden = !hasStops;
    if (hasStops) this.colourStopsField.set(model.colour.stops.join('  ▸  '));
    this.trendsOpenField.set(model.chartsOpen ? ' (open)' : '');

    this.renderFeed(model.events);
    this.renderBanner(model.extinction);
  }

  private renderFeed(events: readonly string[]): void {
    const visible = events.slice(-FEED_LINES);
    this.feedRule.hidden = visible.length === 0;
    for (let index = 0; index < this.feedLines.length; index += 1) {
      const line = this.feedLines[index];
      if (line === undefined) continue;
      const text = visible[index];
      const shown = text !== undefined;
      if (line.element.hidden === shown) line.element.hidden = !shown;
      if (shown) line.field.set(text);
    }
  }

  private renderBanner(notice: ExtinctionNotice | null): void {
    if (notice === null) {
      if (!this.banner.hidden) this.banner.hidden = true;
      return;
    }

    this.bannerGeneration.set(fixed(notice.generation, 2));
    this.bannerTick.set(String(notice.tick));
    for (const cause of DEATH_CAUSES) this.bannerTally[cause].set(String(notice.deaths[cause]));

    const seconds = notice.autoRestartInSeconds;
    this.bannerCountdown.hidden = seconds === null;
    if (seconds !== null) this.bannerCountdownField.set(`new world in ${seconds}s — any other key to stay`);

    // Unhiding is what starts the sonar ping: [hidden] is display:none, so the
    // ring animations only run on the frame the notice actually appears.
    if (this.banner.hidden) this.banner.hidden = false;
  }

  showSelection(dump: OrganismDump | null, stage: SpecimenStage | null = null): void {
    if (dump === null) {
      this.panelBody.hidden = true;
      this.panelEmpty.hidden = false;
      this.panelEmpty.textContent = 'nothing there — click a dot to bring a specimen up';
      return;
    }

    this.panelEmpty.hidden = true;
    this.panelBody.hidden = false;

    this.catalogueField.set(`PA-${String(dump.id).padStart(6, '0')}`);
    this.specimenSubField.set(
      `${SEX_GLYPH[dump.sex]} ${dump.sex} (${dump.karyotype}) · ${dump.archetype} · species ${dump.speciesTag} · clade ${dump.cladeId} · deme ${dump.deme}`,
    );
    this.recordField.set(formatRecord(dump));
    this.lifeField.set(formatLifeAndChemistry(dump, stage));
    this.traitsField.set(formatTraits(dump));
    this.quantField.set(formatQuantLoci(dump));
    this.discreteField.set(formatDiscreteLoci(dump));
    this.pedigreeCountField.set(String(dump.ancestors.length));
    this.pedigreeField.set(formatPedigree(dump));
    this.pingSpecimen();
  }

  /** Label/value pair in a log grid; returns the value element for class toggles. */
  private bindPair(grid: HTMLElement, label: string, field: Field): HTMLElement {
    grid.append(span('label', label));
    const value = span('st-value');
    value.append(field.node);
    grid.append(value);
    return value;
  }

  /** A titled block of pre-aligned text, with an optional column header line. */
  private section(title: string, field: Field, header: string | null): HTMLElement {
    const wrapper = span('');
    wrapper.append(span('label sp-section', title));
    if (header !== null) wrapper.append(span('sp-thead', header));
    const table = span('sp-table');
    table.append(field.node);
    wrapper.append(table);
    return wrapper;
  }

  private pedigreeSection(): HTMLElement {
    const wrapper = span('');
    const title = span('label sp-section');
    title.append(document.createTextNode('pedigree · '), this.pedigreeCountField.node, document.createTextNode(' retained'));
    const table = span('sp-table');
    table.append(this.pedigreeField.node);
    wrapper.append(title, table);
    return wrapper;
  }

  /**
   * Restart the focus echo. A CSS animation only replays on a fresh element, so
   * the ring is swapped for a clone rather than poked with a class — which also
   * avoids the forced reflow the class-toggle trick needs.
   */
  private pingSpecimen(): void {
    const fresh = span('sp-ping ping-ring');
    this.specimenPing.replaceWith(fresh);
    this.specimenPing = fresh;
  }
}

function formatRecord(dump: OrganismDump): string {
  return [
    `${pad('slot', 11)}${dump.slot}`,
    `${pad('age', 11)}${dump.ageTicks} ticks   born t${dump.birthTick}`,
    `${pad('energy', 11)}${fixed(dump.energy, 2)} / ${fixed(dump.energyCapacity, 2)}`,
    `${pad('station', 11)}${fixed(dump.x, 1)}, ${fixed(dump.y, 1)}`,
    `${pad('parents', 11)}${SEX_GLYPH.female} ${dump.motherId}   ${SEX_GLYPH.male} ${dump.fatherId}`,
  ].join('\n');
}

function signed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

/**
 * How the drawn signal reads, in the renderer's own terms.
 *
 * Printed next to the number because the number alone does not say what the
 * watcher is looking at: `conspicuousness` is identity-linked and centred on 0,
 * so the sign is the whole story and the label names which way the saturation
 * went. The band matches the point where the mapping stops being a visible
 * change rather than being a round number.
 */
function signalWord(conspicuousness: number): string {
  const signal = conspicuousnessSignal(conspicuousness);
  if (Math.abs(signal) < 0.12) return 'at the baseline';
  return signal > 0 ? 'loud — drawn saturated' : 'cryptic — drawn toward the water';
}

/**
 * The three readings the world view cannot give: stage, toxin load, signal.
 *
 * `stage` needs the slice, and the slice is not always there — a click that
 * lands before the first one, or on an animal that has since died, prints an
 * em dash rather than guessing a stage. Toxicity and conspicuousness come off
 * the dump's expressed vector, so they are exact.
 */
function formatLifeAndChemistry(dump: OrganismDump, stage: SpecimenStage | null): string {
  const target = dump.traits.size;
  const stageLine =
    stage === null
      ? '—  (no sample slice for this organism)'
      : // "immature" rather than "juvenile": the flag is `isMature`, which with
        // ontogeny off is the age test alone, and an animal can be at its full
        // target length and still not have bred. The two lengths beside it say
        // which of the two floors it is short of.
        `${stage.lifeStage < 0.5 ? 'immature' : 'mature'} · ${fixed(stage.realisedLengthCm, 1)} cm realised of ${fixed(target, 1)} cm target`;
  return [
    `${pad('stage', 11)}${stageLine}`,
    `${pad('toxicity', 11)}${padStart(fixed(dump.traits.toxicity, 3), 8)}   ${meter(dump.traitPercentiles.toxicity)}`,
    `${pad('signal', 11)}${padStart(signed(dump.traits.conspicuousness, 3), 8)}   ${meter(dump.traitPercentiles.conspicuousness)}   ${signalWord(dump.traits.conspicuousness)}`,
  ].join('\n');
}

// Three scales, deliberately side by side: expressed is what the ecology reads,
// latent is what selection acts on, and genotypic is the breeding value with the
// birth environment excluded. Seeing latent and genotypic diverge is seeing V_E,
// which is the whole reason the dump carries both.
function formatTraits(dump: OrganismDump): string {
  const lines: string[] = [];
  for (const trait of TRAIT_KEYS) {
    lines.push(
      pad(trait, TRAIT_LABEL_WIDTH) +
        padStart(fixed(dump.traits[trait], 3), 11) +
        padStart(fixed(dump.traitsLatent[trait], 3), 11) +
        padStart(fixed(dump.traitsGenotypic[trait], 3), 11) +
        '  ' +
        meter(dump.traitPercentiles[trait]) +
        `  ${TRAIT_META[trait].unit}`,
    );
  }
  return lines.join('\n');
}

function formatQuantLoci(dump: OrganismDump): string {
  return dump.quantLoci
    .map((locus) => {
      const loads = locus.loads.map((load) => `${load.trait} ${fixed(load.weight, 2)}`).join(', ');
      return `${pad(locus.locus, 6)}${padStart(fixed(locus.maternal, 3), 9)}${padStart(fixed(locus.paternal, 3), 9)}   ${loads}`;
    })
    .join('\n');
}

function formatDiscreteLoci(dump: OrganismDump): string {
  return dump.discreteLoci
    .map(
      (locus) =>
        `${pad(locus.locus, 6)}${padStart(String(locus.maternal), 5)}${padStart(String(locus.paternal), 5)}   ${locus.label}`,
    )
    .join('\n');
}

function formatPedigree(dump: OrganismDump): string {
  return dump.ancestors
    .map((ancestor) => {
      const fate = ancestor.deathTick === null ? 'alive' : `died t${ancestor.deathTick} (${ancestor.deathCause ?? '—'})`;
      return `${padStart(String(ancestor.id), 8)} ${SEX_GLYPH[ancestor.sex]} born t${ancestor.birthTick}  ${pad(fate, 26)}species ${ancestor.speciesTag}  clade ${ancestor.cladeId}`;
    })
    .join('\n');
}
