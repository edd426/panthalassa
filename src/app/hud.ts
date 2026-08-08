/**
 * The text the watcher actually reads (WP-A6).
 *
 * Two blocks of monospace: a status corner that answers "is anything happening"
 * (tick, generation, population, deaths by every channel, matings, species
 * count, speed) and a selection panel that dumps one organism's genome and
 * phenotype when it is clicked.
 *
 * Deaths and matings are cumulative sums over `SampleRow`s rather than a count
 * of forwarded events: a generation raises thousands of birth and death events
 * and `events.ts` reserves those for the recorder, so the recorder is where the
 * tallies come from. That also means the death table only moves every
 * `sampling.sampleIntervalTicks` ticks, which the row-tick readout makes plain.
 */

import type { SimEvent } from '../contracts/events';
import type { OrganismDump } from '../contracts/protocol';
import { TRAIT_KEYS, TRAIT_META } from '../contracts/traits';
import type { DeathCause } from '../contracts/types';
import { DEATH_CAUSES } from '../contracts/types';
import type { FieldOverlay } from './crudeRenderer';

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
  readonly overlay: FieldOverlay;
  readonly framesPerSecond: number;
  /** Tick of the newest `SampleRow` folded into the tallies; −1 before the first row. */
  readonly lastRowTick: number;
  readonly events: readonly string[];
}

const TRAIT_LABEL_WIDTH = 14;

function fixed(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

/** One line of feed text per narrative event. Births and deaths never reach here. */
export function describeEvent(event: SimEvent): string {
  switch (event.kind) {
    case 'speciesSplit':
      return `t${event.tick} species ${event.parentTag} split → ${event.childTags[0]}/${event.childTags[1]} (cross ${fixed(event.crossMatingRate, 3)}, ${event.sizes[0]}/${event.sizes[1]})`;
    case 'speciesExtinction':
      return `t${event.tick} species ${event.tag} extinct after ${event.lifetimeTicks} ticks (peak ${event.peakPopulation})`;
    case 'cladeFounding':
      return `t${event.tick} clade ${event.cladeId} founded: ${event.parentArchetype} → ${event.archetype} (org ${event.founderId})`;
    case 'sweepCrossedHalf':
      return `t${event.tick} sweep ${event.locus}/${event.allele} crossed 0.5 (${fixed(event.frequency, 3)}) in ${fixed(event.generationsElapsed, 1)} gens`;
    case 'climateEvent':
      return `t${event.tick} climate ${event.cause}: ${fixed(event.meanOffsetC, 2)}°C (Δ${fixed(event.deltaC, 2)})`;
    case 'barrierChange':
      return `t${event.tick} barrier ${event.barrier.id} ${event.change} (${event.barrier.shape.kind})`;
    case 'meteor':
      return `t${event.tick} meteor at ${Math.round(event.x)},${Math.round(event.y)} r${Math.round(event.radiusWu)} killed ${event.killed}`;
    case 'mutantIntroduced':
      return `t${event.tick} mutant ${event.id} introduced (${event.source}) in deme ${event.deme}`;
    case 'birth':
    case 'death':
      return `t${event.tick} ${event.kind} ${event.id}`;
  }
}

export class Hud {
  private readonly status: HTMLElement;
  private readonly panel: HTMLElement;

  constructor(status: HTMLElement, panel: HTMLElement) {
    this.status = status;
    this.panel = panel;
    this.panel.textContent = 'click a dot to inspect it';
  }

  render(model: HudModel): void {
    const speed = model.paused ? 'PAUSED' : `${model.speedMultiplier}x`;
    const deathTotal = DEATH_CAUSES.reduce((sum, cause) => sum + model.deaths[cause], 0);
    const deathLine = DEATH_CAUSES.map((cause) => `${cause.slice(0, 5)} ${model.deaths[cause]}`).join('  ');

    const lines = [
      `PANTHALASSA  seed=${model.seed}`,
      `tick ${model.tick}   gen ${fixed(model.generation, 2)}   pop ${model.population}`,
      `speed ${speed}   ${fixed(model.framesPerSecond, 0)} fps   overlay ${model.overlay}`,
      `species ${model.speciesCount}   clades ${model.cladeCount}`,
      `deaths ${deathTotal}   ${deathLine}`,
      `matings ${model.matings}   (tallies from sample rows, last t${model.lastRowTick})`,
      '',
      'space pause · 1-9 speed 1..256x · f field overlay · click inspect',
    ];

    if (model.events.length > 0) {
      lines.push('', ...model.events.slice(-8));
    }

    this.status.textContent = lines.join('\n');
  }

  showSelection(dump: OrganismDump | null): void {
    this.panel.textContent = dump === null ? 'no organism there — click a dot' : formatDump(dump);
  }
}

function formatDump(dump: OrganismDump): string {
  const lines: string[] = [
    `organism ${dump.id}   slot ${dump.slot}`,
    `${dump.sex} (${dump.karyotype})   ${dump.archetype}`,
    `age ${dump.ageTicks} ticks   born t${dump.birthTick}`,
    `energy ${fixed(dump.energy, 2)} / ${fixed(dump.energyCapacity, 2)}`,
    `species ${dump.speciesTag}   clade ${dump.cladeId}   deme ${dump.deme}`,
    `position ${fixed(dump.x, 1)}, ${fixed(dump.y, 1)}`,
    `mother ${dump.motherId}   father ${dump.fatherId}`,
    '',
    `${pad('trait', TRAIT_LABEL_WIDTH)}${padStart('expressed', 11)}${padStart('latent', 11)}${padStart('genotypic', 11)}${padStart('pct', 6)}  unit`,
  ];

  // Three scales, deliberately side by side: expressed is what the ecology
  // reads, latent is what selection acts on, and genotypic is the breeding
  // value with the birth environment excluded. Seeing latent and genotypic
  // diverge is seeing V_E, which is the whole reason the dump carries both.
  for (const trait of TRAIT_KEYS) {
    lines.push(
      pad(trait, TRAIT_LABEL_WIDTH) +
        padStart(fixed(dump.traits[trait], 3), 11) +
        padStart(fixed(dump.traitsLatent[trait], 3), 11) +
        padStart(fixed(dump.traitsGenotypic[trait], 3), 11) +
        padStart(fixed(dump.traitPercentiles[trait] * 100, 0), 6) +
        `  ${TRAIT_META[trait].unit}`,
    );
  }

  lines.push('', 'quantitative loci (maternal / paternal → trait loads)');
  for (const locus of dump.quantLoci) {
    const loads = locus.loads.map((load) => `${load.trait} ${fixed(load.weight, 2)}`).join(', ');
    lines.push(
      `${pad(locus.locus, 6)}${padStart(fixed(locus.maternal, 3), 9)}${padStart(fixed(locus.paternal, 3), 9)}   ${loads}`,
    );
  }

  lines.push('', 'discrete loci (maternal / paternal)');
  for (const locus of dump.discreteLoci) {
    lines.push(`${pad(locus.locus, 6)}${padStart(String(locus.maternal), 5)}${padStart(String(locus.paternal), 5)}   ${locus.label}`);
  }

  lines.push('', `ancestors retained: ${dump.ancestors.length}`);
  for (const ancestor of dump.ancestors) {
    const fate = ancestor.deathTick === null ? 'alive' : `died t${ancestor.deathTick} (${ancestor.deathCause ?? '—'})`;
    lines.push(
      `  ${ancestor.id} ${ancestor.sex} born t${ancestor.birthTick} ${fate}  species ${ancestor.speciesTag} clade ${ancestor.cladeId}`,
    );
  }

  return lines.join('\n');
}
