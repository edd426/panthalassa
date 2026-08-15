/**
 * Zero-onramp entry point (WP-A6).
 *
 * Opening the page starts a seeded world immediately: no menu, no tutorial, no
 * "press start". The seed comes from `?seed=` when present and is otherwise
 * drawn once and written back into the URL, so a world worth watching can be
 * shared or reopened. `Math.random` here is the one place it is allowed —
 * picking a seed string is presentation, and the value reaches the sim only as
 * the seed the whole trajectory is a pure function of.
 *
 * The main thread owns no simulation state. It holds the latest sample slice,
 * a running tally folded out of `SampleRow`s, and whichever organism was last
 * clicked; everything else lives behind the worker protocol.
 */

import { SPEED_MULTIPLIERS } from '../contracts/protocol';
import type {
  ErrorMessage,
  EventsMessage,
  FieldSliceField,
  OrganismDump,
  PhylogenyMessage,
  SimCommand,
  SnapshotMessage,
  TickedMessage,
} from '../contracts/protocol';
import type { DeathCause, SimConfigOverrides } from '../contracts/types';
import { DEATH_CAUSES, resolveSimConfig } from '../contracts/types';
import { COLOUR_MODES, FIELD_OVERLAYS, traitKeyForMode } from '../render/contracts';
import type { ColourMode, FieldOverlay, FieldRaster, SliceView, WorldRenderer } from '../render/contracts';
import { createRenderer, rendererKind } from '../render/renderer';
import { TrendCharts, appendTrendRow, createTrendSeries, resetTrendSeries } from './charts';
import { Hud, describeEvent } from './hud';
import { SimClient } from './workerClient';

/** LOD cap on the render feed; the slot capacity, so nothing is hidden in Phase A. */
const MAX_DOTS = 4096;

/** How often the tallies are refreshed. Rows themselves arrive every 200 ticks. */
const SERIES_POLL_MS = 400;

/**
 * Field-underlay refresh. Contracts v1.3 gave overlays their own
 * `fieldSliceRequest`, so this is one raster rather than a whole snapshot and
 * can run often enough to watch grazing pressure move across the field.
 */
const FIELD_POLL_MS = 500;

/**
 * The rasters the Phase B water is drawn from. Polled one per tick in rotation
 * rather than all three at once: each one refreshes every 1.5 s, which is well
 * inside how fast plankton, kelp or the climate walk actually move, and the
 * worker never sees three field requests land on the same frame.
 */
const AMBIENCE_FIELDS: readonly FieldSliceField[] = ['plankton', 'kelp', 'temperature'];

/** Click tolerance, screen pixels, converted to world units at the current zoom. */
const SELECT_RADIUS_PX = 16;

const MAX_FEED_LINES = 8;

/**
 * How long a finished world sits on screen before reseeding itself. Ambient
 * mode should keep going without a keypress; anyone actually at the keyboard
 * cancels it by touching any key.
 */
const AUTO_RESTART_MS = 30_000;

/** Minimum gap between chart redraws. Rows land every 200 ticks; faster is redundant. */
const CHART_REDRAW_MS = 700;

/**
 * The god tools have no key binding in Phase A — the keyboard is deliberately
 * four keys wide — so this console handle is the only way to reach the command
 * path before there are buttons for it. `window.panthalassa.command({ kind:
 * 'meteor', x: 1000, y: 600, radiusWu: 200 })` from devtools drives exactly the
 * message a WP-C2 button will.
 */
interface PanthalassaDebugApi {
  readonly seed: string;
  command(command: SimCommand): Promise<TickedMessage>;
  step(ticks: number): Promise<TickedMessage>;
  snapshot(): Promise<SnapshotMessage>;
  phylogeny(): Promise<PhylogenyMessage>;
}

declare global {
  interface Window {
    panthalassa?: PanthalassaDebugApi;
  }
}

const overrides: SimConfigOverrides = {};
const config = resolveSimConfig(overrides);

function requireElement<T extends Element>(id: string, kind: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof kind)) throw new Error(`missing #${id} in index.html`);
  return element;
}

const canvas = requireElement('world', HTMLCanvasElement);
// Top-level await: the GPU context is asynchronous, and every call site below
// wants a renderer that is already up. A machine without WebGPU or WebGL gets
// the Phase A canvas renderer back from here, wearing the same interface.
const renderer: WorldRenderer = await createRenderer(canvas, config);
const chartCanvas = requireElement('charts', HTMLCanvasElement);
const charts = new TrendCharts(chartCanvas);
const hud = new Hud(
  requireElement('status', HTMLElement),
  requireElement('panel', HTMLElement),
  requireElement('banner', HTMLElement),
);

function drawSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}

let seed = new URLSearchParams(window.location.search).get('seed') ?? drawSeed();

let tick = 0;
let population = 0;
let carrionBiomass = 0;
let speedIndex = 1;
let paused = false;
let overlay: FieldOverlay = 'off';

/** True once the worker holds an initialised sim. Input before that is local-only. */
let live = false;

/**
 * Bumped on every reseed. Replies from the previous world are still in flight
 * when the new one is seeded, and a stale sample slice or series row folded into
 * the fresh tallies would make the new world look like a continuation of the
 * dead one.
 */
let epoch = 0;

/** Tick the population reached zero, or null while anything is still alive. */
let extinctionTick: number | null = null;
let extinctionGeneration = 0;

/**
 * Arms the extinction detector. Population is legitimately 0 between `init`
 * being sent and the founders existing, and that is not an extinction.
 */
let sawPopulation = false;

/** Wall-clock deadline for the ambient auto-reseed; 0 once cancelled or absent. */
let autoRestartAt = 0;

let slice: SliceView | null = null;
let recyclable: Float32Array | undefined;
let sliceInFlight = false;

let field: FieldRaster | null = null;
let selection: OrganismDump | null = null;

let colourMode: ColourMode = 'identity';
/**
 * Temperature raster kept for `adaptedness`, which needs the water a dot is
 * sitting in whether or not temperature happens to be the visible overlay.
 */
let temperatureField: FieldRaster | null = null;
/** Ambience feeds; the renderer treats them as scenery and tolerates them lagging. */
let planktonField: FieldRaster | null = null;
let kelpField: FieldRaster | null = null;
let ambienceCursor = 0;

const trends = createTrendSeries();
let chartsOpen = false;
let chartsDirty = false;
let chartsDrawnAt = 0;

let lastRowTick = -1;
let matings = 0;
const deaths: Record<DeathCause, number> = Object.fromEntries(
  DEATH_CAUSES.map((cause) => [cause, 0]),
) as Record<DeathCause, number>;
let speciesCount = 0;
let cladeCount = 0;

const feed: string[] = [];
let framesPerSecond = 0;
let lastFrameAt = 0;

function note(line: string): void {
  feed.push(line);
  if (feed.length > MAX_FEED_LINES * 4) feed.splice(0, feed.length - MAX_FEED_LINES);
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown failure';
  console.error('[panthalassa]', error);
  note(`error: ${message}`);
}

function speedMultiplier(): number {
  return SPEED_MULTIPLIERS[speedIndex] ?? 1;
}

const client = new SimClient({
  onTicked(message: TickedMessage): void {
    tick = message.tick;
    population = message.population;
    for (const event of message.events) note(describeEvent(event));
    // The same events drive the renderer's flourishes; it stamps its own
    // arrival time, because a shockwave decays on the wall clock, not on ticks.
    renderer.pushEvents(message.events);

    // Every `ticked` carries the population — the frame-loop pushes and the
    // acknowledgement a command replies with alike — so a meteor that empties
    // the ocean is caught on the same path as a starvation spiral, without the
    // god tools needing to know extinction exists.
    if (population > 0) sawPopulation = true;
    else if (sawPopulation && extinctionTick === null) beginExtinction();
  },
  onEvents(message: EventsMessage): void {
    for (const event of message.events) note(describeEvent(event));
    renderer.pushEvents(message.events);
  },
  onError(message: ErrorMessage): void {
    console.error('[panthalassa] worker error', message.message, message.stack);
    note(`worker error: ${message.message}`);
  },
});

/**
 * Every send is gated on `live`. The world is seeded asynchronously and the
 * page accepts keys and clicks from the first frame, so an ungated send would
 * hand the worker a command before `init` and turn an impatient keypress into
 * a console error.
 */
function applySpeed(): void {
  if (!live) return;
  client.setSpeed(paused ? 0 : speedMultiplier()).catch(fail);
}

/**
 * Stop the world and put the banner up.
 *
 * Pausing is not cosmetic: an empty ocean still costs a full tick loop of
 * field updates and resource regrowth every frame, and the user watching a
 * finished run should not be paying for it.
 */
function beginExtinction(): void {
  extinctionTick = tick;
  extinctionGeneration = tick / Math.max(1, config.time.generationTicks);
  paused = true;
  applySpeed();
  autoRestartAt = Date.now() + AUTO_RESTART_MS;
  note(`extinct at tick ${tick} (generation ${extinctionGeneration.toFixed(2)})`);

  // The running tallies only advance when a `SampleRow` lands, every 200 ticks,
  // so whatever killed the last organisms is missing from them — a meteor at
  // tick 287 shows as "catastrophe 0" on the banner announcing the world it
  // ended. `SimSnapshot.deathCounts` is exactly that unsampled remainder, and
  // the recorder zeroes it per row, so adding it cannot double-count.
  const forEpoch = epoch;
  client
    .snapshot()
    .then((reply) => {
      if (forEpoch !== epoch) return;
      for (const cause of DEATH_CAUSES) deaths[cause] += reply.snapshot.deathCounts[cause];
    })
    .catch(fail);
}

/** Start over in a brand-new world without reloading the page. */
function reseed(): void {
  const next = drawSeed();
  note(`reseeding as ${next}…`);
  startWorld(next);
}

function requestSlice(): void {
  if (!live || sliceInFlight) return;
  sliceInFlight = true;
  const forEpoch = epoch;
  const handBack = recyclable;
  recyclable = undefined;
  const wantTrait = traitKeyForMode(colourMode);
  client
    .sampleSlice(MAX_DOTS, handBack, wantTrait ?? undefined)
    .then((next) => {
      sliceInFlight = false;
      if (forEpoch !== epoch) return;
      // The buffer being drawn is only offered back for reuse once a newer one
      // has replaced it; the worker transfers it away, so handing back the live
      // one would detach the array mid-frame.
      if (slice !== null) recyclable = slice.buffer;
      slice = {
        count: next.count,
        buffer: next.buffer,
        // The tick tells the renderer's interpolator that two slices describe
        // the same world, which is every slice while the watch is paused.
        tick: next.tick,
        ...(next.traitValues === undefined ? {} : { traitValues: next.traitValues }),
        ...(next.traitKey === undefined ? {} : { traitKey: next.traitKey }),
      };
    })
    .catch((error: unknown) => {
      sliceInFlight = false;
      fail(error);
    });
}

function pollSeries(): void {
  if (!live) return;
  const forEpoch = epoch;
  client
    .series(lastRowTick)
    .then((rows) => {
      if (forEpoch !== epoch) return;
      let received = false;
      for (const row of rows) {
        if (row.tick <= lastRowTick) continue;
        received = true;
        lastRowTick = row.tick;
        for (const cause of DEATH_CAUSES) deaths[cause] += row.deaths[cause];
        matings += row.matings;
        speciesCount = row.populationBySpecies.length;
        cladeCount = row.populationByClade.length;
        // The same rows feed the charts, flattened into number columns on
        // arrival so a long run holds arrays of floats rather than the objects.
        appendTrendRow(trends, row);
        chartsDirty = true;
      }
      if (received) {
        client
          .snapshot()
          .then((reply) => {
            if (forEpoch !== epoch) return;
            carrionBiomass = reply.snapshot.carrion.reduce((sum, value) => sum + value, 0);
          })
          .catch(fail);
      }
    })
    .catch(fail);
}

function fetchField(which: FieldSliceField, assign: (raster: FieldRaster) => void): void {
  const forEpoch = epoch;
  client
    .fieldSlice(which)
    .then((reply) => {
      if (forEpoch !== epoch) return;
      assign({
        field: reply.field,
        cols: reply.cols,
        rows: reply.rows,
        cellSizeWu: reply.cellSizeWu,
        values: reply.values,
      });
    })
    .catch(fail);
}

function pollField(): void {
  if (!live) return;

  if (overlay !== 'off') {
    const requested = overlay;
    // The key may have cycled while this was in flight; a late reply must not
    // paint plankton over a temperature overlay.
    fetchField(requested, (raster) => {
      if (overlay === requested) field = raster;
    });
  }

  // The ambience and `adaptedness` both need rasters the visible overlay is not
  // showing — adaptedness compares each organism's tOpt against the water it is
  // actually in — so these are fetched on their own rotation rather than
  // aliased to the overlay raster, which would break the moment `f` was pressed.
  const which = AMBIENCE_FIELDS[ambienceCursor % AMBIENCE_FIELDS.length] ?? 'temperature';
  ambienceCursor += 1;
  fetchField(which, (raster) => {
    if (raster.field === 'plankton') planktonField = raster;
    else if (raster.field === 'kelp') kelpField = raster;
    else temperatureField = raster;
  });

  // One extra request while adaptedness has nothing to compare against, so the
  // mode is not blank for a full turn of the rotation after the key is pressed.
  if (colourMode === 'adaptedness' && temperatureField === null && which !== 'temperature') {
    fetchField('temperature', (raster) => {
      temperatureField = raster;
    });
  }
}

function frame(timestamp: number): void {
  if (lastFrameAt > 0) {
    const delta = timestamp - lastFrameAt;
    if (delta > 0) framesPerSecond = framesPerSecond * 0.9 + (1000 / delta) * 0.1;
  }
  lastFrameAt = timestamp;

  let restartInSeconds: number | null = null;
  if (extinctionTick !== null && autoRestartAt > 0) {
    const remainingMs = autoRestartAt - Date.now();
    if (remainingMs <= 0) reseed();
    else restartInSeconds = Math.ceil(remainingMs / 1000);
  }

  renderer.draw({
    slice,
    overlay,
    field,
    // The halo marks where the dump was taken, and does not swim after its
    // subject. A slice carries slots, not ids, and a slot is reused the tick
    // after its occupant dies — following one would eventually ring a different
    // animal while the panel described the dead one.
    selected: selection === null ? null : { x: selection.x, y: selection.y },
    colourMode,
    temperature: temperatureField,
    plankton: planktonField,
    kelp: kelpField,
    // The watch speed the sim is actually being run at. The LOD spends it as
    // budget: at 64x the same population goes past far faster than any spine
    // chain can be drawn for, so detail has to come down.
    speedMultiplier: speedMultiplier(),
    paused,
  });

  // Charts redraw on new data at a few frames per second, not per frame: the
  // underlying rows only land every 200 ticks, so anything faster is redrawing
  // an identical picture.
  if (chartsOpen && chartsDirty && timestamp - chartsDrawnAt > CHART_REDRAW_MS) {
    charts.draw(trends);
    chartsDirty = false;
    chartsDrawnAt = timestamp;
  }

  hud.render({
    seed,
    tick,
    generation: tick / Math.max(1, config.time.generationTicks),
    population,
    speedMultiplier: speedMultiplier(),
    paused,
    speciesCount,
    cladeCount,
    deaths,
    matings,
    carrionBiomass,
    overlay,
    framesPerSecond,
    lastRowTick,
    events: feed,
    colour: renderer.colourLegend,
    chartsOpen,
    extinction:
      extinctionTick === null
        ? null
        : {
            tick: extinctionTick,
            generation: extinctionGeneration,
            deaths,
            autoRestartInSeconds: restartInSeconds,
          },
  });

  requestSlice();
  window.requestAnimationFrame(frame);
}

window.addEventListener('resize', () => {
  renderer.resize();
  if (chartsOpen) {
    charts.resize();
    charts.draw(trends);
  }
});

canvas.addEventListener('click', (event: MouseEvent) => {
  if (!live) return;
  // A drag-pan ends in a click event on the canvas. Selecting whatever happened
  // to be under the pointer when the pan stopped is never what was meant.
  if (renderer.isDragClick(event)) return;
  const world = renderer.toWorld(event.clientX, event.clientY);
  const radiusWu = Math.max(6, SELECT_RADIUS_PX / renderer.pixelsPerWu);
  client
    .select(world.x, world.y, radiusWu)
    .then((organism) => {
      selection = organism;
      console.log('[panthalassa] selection', organism);
      hud.showSelection(organism);
    })
    .catch(fail);
});

function cycleOverlay(): void {
  const next = (FIELD_OVERLAYS.indexOf(overlay) + 1) % FIELD_OVERLAYS.length;
  overlay = FIELD_OVERLAYS[next] ?? 'off';
  if (overlay === 'off') field = null;
  else pollField();
}

function cycleColourMode(): void {
  const next = (COLOUR_MODES.indexOf(colourMode) + 1) % COLOUR_MODES.length;
  colourMode = COLOUR_MODES[next] ?? 'identity';
  // The next slice carries the new trait channel; ask for the water grid now so
  // adaptedness is not blank for the first half second.
  if (colourMode === 'adaptedness' && temperatureField === null) pollField();
}

function toggleCharts(): void {
  chartsOpen = !chartsOpen;
  chartCanvas.hidden = !chartsOpen;
  if (chartsOpen) {
    // The canvas has no layout box while hidden, so it can only be sized once
    // it is on screen.
    charts.resize();
    charts.draw(trends);
    chartsDirty = false;
  }
}

window.addEventListener('keydown', (event: KeyboardEvent) => {
  // R is deliberately inert while anything is alive: it wipes a world, and the
  // one thing worse than a run that ends unannounced is a run ended by a
  // mistyped key.
  if (event.key === 'r' || event.key === 'R') {
    if (extinctionTick !== null) reseed();
    return;
  }

  if (extinctionTick !== null) {
    // Anything else stands the ambient restart down — someone is at the
    // keyboard, so the world should wait for them rather than wipe itself.
    if (autoRestartAt > 0) {
      autoRestartAt = 0;
      note('auto-restart cancelled — press R when you want a new world');
    }
    // The field overlays and the trends still read on a dead ocean — watching
    // the plankton recover once the grazers are gone, or reading back the
    // trajectory that ended in this banner, is most of the post-mortem.
    if (event.key === 'f' || event.key === 'F') cycleOverlay();
    else if (event.key === 'c' || event.key === 'C') cycleColourMode();
    else if (event.key === 't' || event.key === 'T') toggleCharts();
    return;
  }

  if (event.code === 'Space') {
    event.preventDefault();
    paused = !paused;
    applySpeed();
    return;
  }
  if (event.key >= '1' && event.key <= '9') {
    speedIndex = Number(event.key);
    paused = false;
    applySpeed();
    return;
  }
  if (event.key === 'f' || event.key === 'F') cycleOverlay();
  else if (event.key === 'c' || event.key === 'C') cycleColourMode();
  else if (event.key === 't' || event.key === 'T') toggleCharts();
});

/**
 * Seed a world, from scratch, in the page that is already running.
 *
 * Everything the main thread remembers about the previous world is cleared
 * here rather than at the call sites, because the failure this guards against
 * is quiet: a fresh ocean still showing the last one's death tallies, or
 * skipping its own first thousand sample rows because `lastRowTick` was left at
 * the tick the old world died on. The worker rebuilds its own sim on `init`.
 */
function startWorld(nextSeed: string): void {
  epoch += 1;
  const forEpoch = epoch;

  live = false;
  carrionBiomass = 0;
  seed = nextSeed;

  tick = 0;
  population = 0;
  sawPopulation = false;
  extinctionTick = null;
  extinctionGeneration = 0;
  autoRestartAt = 0;
  paused = false;

  slice = null;
  recyclable = undefined;
  sliceInFlight = false;
  field = null;
  temperatureField = null;
  planktonField = null;
  kelpField = null;
  selection = null;
  hud.showSelection(null);
  // Ghosts, flourishes and the interpolator all describe the dead world; the
  // camera goes back to the whole sea for the new one.
  renderer.reset();
  // The trend columns describe the dead world; keeping them would draw the new
  // one as a continuation of a population that no longer exists.
  resetTrendSeries(trends);
  chartsDirty = true;

  lastRowTick = -1;
  matings = 0;
  for (const cause of DEATH_CAUSES) deaths[cause] = 0;
  speciesCount = 0;
  cladeCount = 0;
  feed.length = 0;

  const url = new URL(window.location.href);
  if (url.searchParams.get('seed') !== nextSeed) {
    url.searchParams.set('seed', nextSeed);
    window.history.replaceState(null, '', url);
  }

  note(`seeding ${nextSeed}…`);
  // A run on the crude fallback looks like a run with the graphics turned off,
  // so the feed says which renderer is actually drawing and why. Repeated per
  // world because the feed is cleared on reseed.
  const kind = rendererKind();
  if (kind === 'crude-no-gpu') note('no GPU context — drawing with the crude canvas renderer');
  else if (kind === 'crude-init-failed') note('renderer failed to start — drawing with the crude canvas renderer');
  else if (kind === 'crude-requested') note('?renderer=crude — drawing with the crude canvas renderer');
  else if (kind === 'pixi-webgl') note('WebGPU did not answer — running on WebGL');
  else if (kind === 'none') note('no renderer available — the sim is running but the water is blank');

  client
    .init(nextSeed, overrides)
    .then((ready) => {
      if (forEpoch !== epoch) return;
      live = true;
      tick = ready.tick;
      population = ready.population;
      if (ready.population > 0) sawPopulation = true;
      note(`world ${nextSeed} seeded with ${ready.population} founders`);

      window.panthalassa = {
        seed: nextSeed,
        command: (command) => client.command(command),
        step: (ticks) => client.step(ticks),
        snapshot: () => client.snapshot(),
        phylogeny: () => client.phylogeny(),
      };

      // The watch speed survives a reseed on purpose: someone running the
      // aquarium at 64x wants the next world at 64x too.
      applySpeed();
    })
    .catch(fail);
}

// Drawing starts before the world does, so a worker that never reports `ready`
// leaves the HUD on screen saying so instead of a black page with nothing on
// it. Every send is gated on `live`, so an early frame just paints empty water.
window.requestAnimationFrame(frame);
window.setInterval(pollSeries, SERIES_POLL_MS);
window.setInterval(pollField, FIELD_POLL_MS);
startWorld(seed);
