/**
 * The field manual (`h`).
 *
 * Everything the app answers to was already there and unfindable. The bench is
 * six experiments deep behind one unlisted key, and the station log's legend —
 * whose own comment says a binding missing from it is a feature that does not
 * exist — did not name `g` at all. This overlay is the answer to "what can I
 * actually do here", and it is the only place the bench's *workflow* is
 * written down: which tools arm a click, what two clicks mean, and what each
 * experiment is for.
 *
 * Two rules keep it honest rather than decorative:
 *
 *  - **Nothing is retyped that the code already states.** The overlay cycles,
 *    the colour modes, the speed range, the archetype descriptions and the
 *    disturbance radii are read from the contracts and from `SimConfig`, so a
 *    retune moves the manual with it.
 *  - **`ARMED_TOOLS` is keyed by `ArmedMode`.** A seventh bench tool fails the
 *    typecheck here until it is documented, which is the gate a prose file
 *    could never have. That is also why this module needs no test: its
 *    coverage claim is checked by `npm run build`.
 *
 * Pure presentation: no sim RNG, no commands, no worker traffic. The panel
 * builds its DOM on first open, because a manual nobody presses `h` for should
 * not cost anything at startup.
 */

import { CLADE_SCHEMA } from '../contracts/genome';
import { SPEED_MULTIPLIERS } from '../contracts/protocol';
import type { SimConfig } from '../contracts/types';
import { COLOUR_MODES, FIELD_OVERLAYS } from '../render/contracts';
import { ARMED_MODES } from './godTools';
import type { ArmedMode } from './godTools';

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export interface HelpEntry {
  /** What is printed in the left column: a key, a chord, or a bench control's name. */
  readonly term: string;
  readonly what: string;
  /** Second line, dimmer: the caveat, or what the experiment is for. */
  readonly note?: string;
  /** Bench tools are named in amber, the way the bench names them. */
  readonly tool?: boolean;
}

export interface HelpSection {
  readonly title: string;
  readonly lead?: string;
  readonly entries: readonly HelpEntry[];
}

/** A bench tool that arms a click, plus the two lines it needs. */
interface ArmedToolHelp {
  readonly name: string;
  readonly how: string;
  readonly shows: string;
}

/**
 * Where each tool sits in the bench, top to bottom. The manual is read against
 * the panel, so it follows the panel's order rather than `ARMED_MODES`' — but
 * the list itself is still built by walking `ARMED_MODES`, so a mode that
 * nobody ranks is documented in the wrong place rather than dropped.
 */
const ARMED_RANK: Readonly<Record<ArmedMode, number>> = {
  wall: 0,
  planktonCrash: 1,
  kelpStorm: 2,
  meteor: 3,
  foundRadialDrifter: 4,
  foundArmoredCrawler: 5,
};

function armedTools(config: SimConfig): Readonly<Record<ArmedMode, ArmedToolHelp>> {
  const crashRadius = Math.round(config.disturbance.planktonCrashRadiusWu);
  const stormRadius = Math.round(config.disturbance.kelpStormSwathWidthWu);
  return {
    wall: {
      name: 'Raise wall',
      how: 'Set MIGRATION (0 sealed · 1 open water · between is a slow crossing), then arm and click two points. The axis your clicks are furthest apart on is the axis the ridge runs along — two points one above the other give a north–south wall — and the ridge always spans the whole ocean on that axis; the spread on the other axis sets its thickness. Releasing the slider also retunes every standing wall. Walls list as W1, W2 … with their permeability and age; each band carries its number on the map, clicking a row flashes its wall, and DROP lowers one.',
      shows: 'Wall the ocean in two, let the halves diverge (Fst, in the deep-history panel), then drop the wall and watch what the mixed population does.',
    },
    planktonCrash: {
      name: 'Plankton crash',
      how: `Pick a preset, then GLOBAL or REGION. Global fires straight from the button; region arms — click the centre of a disc of radius ${crashRadius} wu. Productivity is multiplied by the preset for its number of generations.`,
      shows: 'Starve the bottom of the food chain and watch the diet axis and the loss ledger move.',
    },
    kelpStorm: {
      name: 'Kelp storm',
      how: `Always regional: arm, click the centre. Strips the preset's fraction of the kelp over a disc of radius ${stormRadius} wu at once; the forest regrows slowly from its holdfasts.`,
      shows: 'Kelp is shelter, not food — cover cuts the local kill chance. Strip a forest and everything hiding in it is suddenly catchable; watch pred in the loss ledger.',
    },
    meteor: {
      name: 'Meteor',
      how: 'Set the radius, arm, click the impact point. Everything inside the disc dies at once, counted as catastrophe in the loss ledger.',
      shows: 'A bottleneck with no warning: which clade refills the ocean, and how much variance it lost getting there.',
    },
    foundRadialDrifter: {
      name: CLADE_SCHEMA.radialDrifter.label,
      how: 'Arm, click where the cohort should appear. The bench copies a living genome and edits one macro-locus allele onto it, so the founders are this population plus one body plan.',
      shows: CLADE_SCHEMA.radialDrifter.description,
    },
    foundArmoredCrawler: {
      name: CLADE_SCHEMA.armoredCrawler.label,
      how: 'Same path as the drifter, on the other macro-allele. A world that has already discovered a macro-allele of its own can express something else — that is a real genome, not a mis-sent command.',
      shows: CLADE_SCHEMA.armoredCrawler.description,
    },
  };
}

/** The watch, the readouts, the run — every key `main.ts` and the camera answer to. */
function keySections(): readonly HelpSection[] {
  return [
    {
      title: 'Watching',
      entries: [
        { term: 'space', what: 'pause and resume; the picture keeps drawing, the world stops' },
        {
          term: '1 … 9',
          what: `sim speed ${SPEED_MULTIPLIERS[1]}× to ${SPEED_MULTIPLIERS[9]}× — and unpause`,
          note: 'World time, not playback: the animals keep swimming at believable rates however fast the ticks go.',
        },
        { term: 'wheel', what: 'zoom on the pointer' },
        { term: 'drag', what: 'pan; let go while moving and the camera glides' },
        { term: 'dbl-click / 0', what: 'fit the whole sea' },
        {
          term: 'click',
          what: 'inspect the animal under the pointer — the specimen label fills the right-hand panel',
          note: 'The halo marks where the reading was taken and does not follow the animal; the panel is a snapshot of that click.',
        },
      ],
    },
    {
      title: 'Readouts',
      entries: [
        { term: 'f', what: `field underlay: ${FIELD_OVERLAYS.join(' → ')}` },
        {
          term: 'c',
          what: `colour the dots by: ${COLOUR_MODES.join(' → ')}`,
          note: 'The station log names the quantity and its endpoints — a ramp with no legend says nothing.',
        },
        {
          term: 't',
          what: 'deep history: the whole run, panel per reading',
          note: 'Drag across a panel to zoom into a range, double-click to reset. The strip keeps every row, so zooming in shows detail rather than a magnified summary.',
        },
      ],
    },
    {
      title: 'Tools and the run',
      entries: [
        { term: 'g', what: 'the experiment bench, bottom left' },
        { term: 'h', what: 'this manual' },
        { term: 'esc', what: 'close this manual; otherwise put down an armed bench tool' },
        {
          term: 'r',
          what: 'seed a brand-new world — only after extinction',
          note: 'Deliberately inert while anything is alive. A finished world reseeds itself after 30 s; any key stands that down so it waits for you.',
        },
      ],
    },
  ];
}

function benchSection(config: SimConfig): HelpSection {
  const tools = armedTools(config);
  const entries: HelpEntry[] = [
    {
      term: 'Climate',
      what: 'Move the TARGET slider, then APPLY. The world walks toward that offset rather than jumping to it, and `now` reads back the sampled offset off the latest sample row — not the last target anyone asked for.',
      note: 'Ramp the water and watch whether thermal optimum tracks it, or whether the losses go thermal first.',
      tool: true,
    },
    {
      term: 'Breeding',
      what: 'Pick up to three traits with signed weights, APPLY. Every female’s suitor lottery is multiplied by exp(Σ weight · his deviation from typical) — you are the peahen, stacked on top of her own taste. CLEAR ends the programme; it also ends with the world.',
      note: 'Artificial selection: breed for size or armour and watch the response in the deep history — or run different programmes against a wall and drop it.',
      tool: true,
    },
    {
      term: 'Thermal shock',
      what: 'Pick a preset and fire. Global, immediate, and it lasts the preset’s number of generations.',
      note: 'A step rather than a ramp: who survives the transient, and what the population looks like afterwards.',
      tool: true,
    },
  ];
  const ordered = [...ARMED_MODES].sort((a, b) => ARMED_RANK[a] - ARMED_RANK[b]);
  for (const mode of ordered) {
    const tool = tools[mode];
    entries.push({ term: tool.name, what: tool.how, note: tool.shows, tool: true });
  }
  return {
    title: 'The experiment bench · g',
    lead:
      'Every order here goes down the same command path the probe scenarios use, and lands in the station log with the event the sim answers with. ' +
      'A tool that needs a place on the map arms first: the cursor changes, the next click on the water is the instrument and not a specimen pick, and the tool disarms itself the moment it fires. ' +
      'Press esc, or its button again, to put it down.',
    entries,
  };
}

function beyondSection(): HelpSection {
  return {
    title: 'Beyond the keyboard',
    entries: [
      {
        term: '?seed=',
        what: 'reopen a world you have seen before; the seed of the running world is always in the URL and in the log header',
      },
      {
        term: '?ontogeny=1',
        what: 'run the juvenile axis on — juveniles grow into their target length instead of being born at it',
      },
      { term: '?aposematism=1', what: 'run the warning-signal axis on' },
      {
        term: '?sexualSelection=1',
        what: 'run the ornament axis on — heritable mate preference for a costly display; c → ornament colours by it, and the breeding bench’s ornament row comes alive',
      },
      { term: '?renderer=crude', what: 'the Phase A canvas picture, on purpose, without the GPU' },
      {
        term: 'console',
        what: 'window.panthalassa.command(…) drives the same commands the bench sends, plus step(), snapshot() and phylogeny()',
      },
    ],
  };
}

export function helpSections(config: SimConfig): readonly HelpSection[] {
  return [...keySections(), benchSection(config), beyondSection()];
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const STYLE_ID = 'hlp-style';

/**
 * Off index.html's `:root` tokens, in the station-log register. The panel sits
 * above the bench (`#bench` is z-index 5) because it is opened to be read, and
 * a manual half behind the instrument it explains is worse than no manual.
 */
const STYLE_TEXT = `
#help {
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 9;
  width: min(86ch, 92vw);
  max-height: 84vh;
  overflow-y: auto;
  padding: 13px 18px 16px;
  font: 11px/1.5 var(--mono);
  color: var(--ink);
  background: var(--glass-dense);
  border: 1px solid var(--hairline-soft);
  border-left: 1px solid var(--hairline);
  backdrop-filter: blur(4px);
  box-shadow: 0 0 70px rgba(2, 11, 17, 0.7);
  scrollbar-width: thin;
  scrollbar-color: var(--hairline) transparent;
}

#help::-webkit-scrollbar { width: 8px; }
#help::-webkit-scrollbar-thumb { background: var(--hairline); }

.hlp-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ink);
}

.hlp-close { font-size: 10px; letter-spacing: 0.06em; color: var(--ink-dim); }
.hlp-kbd { color: var(--phosphor); }

.hlp-lead { display: block; margin: 4px 0 2px; color: var(--ink-dim); }

.hlp-head { display: block; margin-bottom: 2px; }

/* One row: term on the left in a fixed track so the two columns read as a
   table, the sentence on the right, the note under the sentence. */
.hlp-row {
  display: grid;
  grid-template-columns: 15ch 1fr;
  gap: 0 12px;
  margin: 3px 0;
  align-items: baseline;
}

.hlp-term { color: var(--phosphor); letter-spacing: 0.06em; }
.hlp-term--tool { color: var(--amber); }
.hlp-note { grid-column: 2; font-size: 10px; color: var(--ink-dim); opacity: 0.85; }
`;

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

export interface HelpDeps {
  /** The `<div id="help">` index.html reserves. */
  readonly host: HTMLElement;
  /** Read for the disturbance radii the manual quotes. */
  readonly config: SimConfig;
}

export class HelpOverlay {
  private readonly deps: HelpDeps;
  private readonly host: HTMLElement;
  private built = false;

  constructor(deps: HelpDeps) {
    this.deps = deps;
    this.host = deps.host;

    if (document.getElementById(STYLE_ID) === null) {
      const style = el('style');
      style.id = STYLE_ID;
      style.textContent = STYLE_TEXT;
      document.head.append(style);
    }

    // The camera's wheel handler is bound on the window and only ignores the
    // chrome it lists by selector — a list that lives in `src/render` and does
    // not know about this panel. Stopping the wheel here is what lets a long
    // manual scroll instead of zooming the ocean out from under it.
    this.host.addEventListener('wheel', (event: WheelEvent) => event.stopPropagation());
  }

  get open(): boolean {
    return !this.host.hidden;
  }

  toggle(): void {
    if (this.open) {
      this.host.hidden = true;
      return;
    }
    this.build();
    this.host.hidden = false;
    this.host.scrollTop = 0;
  }

  /** `esc`. True when the manual was actually up, so the key can be swallowed. */
  close(): boolean {
    if (!this.open) return false;
    this.host.hidden = true;
    return true;
  }

  private build(): void {
    if (this.built) return;
    this.built = true;

    const title = el('div', 'hlp-title');
    title.append(el('span', '', 'Field manual'));
    const close = el('span', 'hlp-close');
    close.append(el('span', 'hlp-kbd', 'h'), document.createTextNode(' or '), el('span', 'hlp-kbd', 'esc'));
    close.append(document.createTextNode(' closes'));
    title.append(close);

    const nodes: HTMLElement[] = [title];
    for (const section of helpSections(this.deps.config)) {
      nodes.push(el('div', 'rule'), el('div', 'hlp-head label', section.title));
      if (section.lead !== undefined) nodes.push(el('span', 'hlp-lead', section.lead));
      for (const entry of section.entries) {
        const row = el('div', 'hlp-row');
        row.append(
          el('span', entry.tool === true ? 'hlp-term hlp-term--tool' : 'hlp-term', entry.term),
          el('span', '', entry.what),
        );
        if (entry.note !== undefined) row.append(el('span', 'hlp-note', entry.note));
        nodes.push(row);
      }
    }

    this.host.replaceChildren(...nodes);
  }
}
