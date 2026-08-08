/**
 * The sim's host thread (WP-A6).
 *
 * Everything in `src/sim` and `src/stats` is instantiated here and nowhere
 * else. The main thread never imports the engine: it speaks
 * `contracts/protocol.ts` and receives sample slices, selection dumps and
 * sample rows. That seam is what stops presentation code from consuming sim
 * RNG or reading a pool mid-tick.
 *
 * This file is presentation-side by the CLAUDE.md file list (`src/app/**`), so
 * it may read a wall clock — and it has to, because it decides *how many* ticks
 * to run per frame. A clock reading only ever bounds the batch size; it never
 * reaches `SimState`, and the trajectory of tick N is identical whether the
 * batch that produced it was 1 tick or 256.
 *
 * ## Speed
 *
 * `setSpeed(multiplier)` is the whole transport: 0 pauses, 1…256 are the watch
 * speeds, and the worker runs up to `multiplier` ticks per 1/30 s frame. Each
 * frame is split into small chunks and abandoned once the tick budget is spent,
 * so a 256× frame that the machine cannot afford degrades into a slower world
 * rather than a worker that stops answering `sampleSliceRequest` and `select`.
 */

import type { SimHandle, SimModules } from '../contracts/apis';
import type { SimEvent } from '../contracts/events';
import { isNarrativeEvent } from '../contracts/events';
import type { MainToWorkerMessage, WorkerToMainMessage } from '../contracts/protocol';
import type { SimConfigOverrides } from '../contracts/types';
import { resolveSimConfig } from '../contracts/types';
import { createEcology } from '../sim/ecology';
import { createMating, createSim } from '../sim/engine';
import { createGenetics } from '../sim/genetics';
import { createSpatialIndex } from '../sim/spatial';
import type { StatsRecorderApi } from '../stats';
import { createStats } from '../stats';

/**
 * The slice of `DedicatedWorkerGlobalScope` this file uses. Declared locally
 * because `lib.webworker` and `lib.dom` cannot both be in `tsconfig.lib` — this
 * is a typing shim for two platform methods, not a second source of truth for
 * anything in `contracts/`.
 */
interface WorkerScope {
  postMessage(message: WorkerToMainMessage, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<MainToWorkerMessage>) => void): void;
}

const scope = globalThis as unknown as WorkerScope;

/** Wall-clock frame period the speed multiplier is denominated in (`time.ticksPerSecond` at 1×). */
const FRAME_INTERVAL_MS = 1000 / 30;

/**
 * How long one frame may spend inside `step()`. Below the frame period, so the
 * worker always returns to its message queue and stays clickable at 256×.
 */
const FRAME_TICK_BUDGET_MS = 20;

/** Ticks per `step()` call inside a frame; the budget is checked between chunks. */
const TICK_CHUNK = 8;

/** `requestId` on pushes the main thread did not ask for. Main-thread ids start at 1. */
const PUSH_REQUEST_ID = 0;

/**
 * Narrative events per push. A generation raises thousands of births and
 * deaths — `events.ts` says outright that those are the recorder's, not the
 * reader's — so only `NARRATIVE_EVENT_KINDS` cross the boundary and the HUD's
 * death tallies come from `SampleRow.deaths` instead.
 */
const MAX_EVENTS_PER_PUSH = 48;

let handle: SimHandle | null = null;
let stats: StatsRecorderApi | null = null;
let speedMultiplier = 0;
let frameTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Events already pushed from `state.events` that the next `step()` will return
 * again. `command()` raises events immediately but the engine only drains its
 * queue inside a tick, so a god command issued while paused would otherwise be
 * invisible until the world resumed.
 */
let forwardedPending = 0;

function post(message: WorkerToMainMessage, transfer?: Transferable[]): void {
  scope.postMessage(message, transfer);
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'unknown worker failure';
}

function postError(requestId: number | null, error: unknown): void {
  const message = describe(error);
  const stack = error instanceof Error ? error.stack : undefined;
  post(stack === undefined ? { type: 'error', requestId, message } : { type: 'error', requestId, message, stack });
}

function requireHandle(): SimHandle {
  if (handle === null) throw new Error('sim not initialised: send an `init` message first');
  return handle;
}

function cap(events: readonly SimEvent[]): readonly SimEvent[] {
  return events.length > MAX_EVENTS_PER_PUSH ? events.slice(events.length - MAX_EVENTS_PER_PUSH) : events;
}

/**
 * Filter one `step()` return down to what the feed shows.
 *
 * The engine already merges `StatsApi.drainRaisedEvents()` into the tick's
 * output, so the extra drain here is normally empty; it is kept because the
 * recorder — not the engine — is the owner of those events, and swallowing a
 * `sweepCrossedHalf` because two layers each assumed the other forwarded it is
 * exactly the failure this shell exists to prevent.
 */
function collectEvents(raised: readonly SimEvent[]): SimEvent[] {
  const fresh = forwardedPending > 0 ? raised.slice(forwardedPending) : raised;
  forwardedPending = 0;

  const narrative = fresh.filter(isNarrativeEvent);
  for (const event of stats?.drainRaisedEvents() ?? []) {
    if (isNarrativeEvent(event)) narrative.push(event);
  }
  return narrative;
}

function postTicked(requestId: number, events: readonly SimEvent[]): void {
  const sim = requireHandle();
  post({
    type: 'ticked',
    requestId,
    tick: sim.state.tick,
    population: sim.state.liveCount,
    events: cap(events),
  });
}

/** Push whatever a command just raised, and remember not to forward it twice. */
function flushCommandEvents(): void {
  const sim = requireHandle();
  const queued = sim.state.events;
  const fresh = queued.slice(forwardedPending).filter(isNarrativeEvent);
  forwardedPending = queued.length;
  if (fresh.length > 0) post({ type: 'events', tick: sim.state.tick, events: cap(fresh) });
}

function stopLoop(): void {
  if (frameTimer !== null) {
    clearTimeout(frameTimer);
    frameTimer = null;
  }
}

function startLoop(): void {
  if (frameTimer === null && handle !== null && speedMultiplier > 0) {
    frameTimer = setTimeout(runFrame, 0);
  }
}

function runFrame(): void {
  frameTimer = null;
  const sim = handle;
  if (sim === null || speedMultiplier <= 0) return;

  const startedAt = performance.now();
  const deadline = startedAt + FRAME_TICK_BUDGET_MS;
  const events: SimEvent[] = [];
  let remaining = Math.floor(speedMultiplier);

  try {
    while (remaining > 0) {
      const chunk = Math.min(remaining, TICK_CHUNK);
      for (const event of collectEvents(sim.step(chunk))) events.push(event);
      remaining -= chunk;
      if (performance.now() >= deadline) break;
    }
  } catch (error) {
    speedMultiplier = 0;
    postError(null, error);
    return;
  }

  postTicked(PUSH_REQUEST_ID, events);
  frameTimer = setTimeout(runFrame, Math.max(0, FRAME_INTERVAL_MS - (performance.now() - startedAt)));
}

function initialise(message: Extract<MainToWorkerMessage, { type: 'init' }>): void {
  stopLoop();
  speedMultiplier = 0;
  forwardedPending = 0;

  // A restore carries its own overrides; the engine prefers them over the
  // `config` field, so the recorder has to resolve the same pair or the two
  // would disagree about `sampleIntervalTicks` on the very first row.
  const overrides: SimConfigOverrides = message.snapshot?.configOverrides ?? message.config;
  const config = resolveSimConfig(overrides);

  const recorder = createStats({ config });
  const modules: SimModules = {
    genetics: createGenetics(),
    ecology: createEcology(),
    spatial: createSpatialIndex(config),
    mating: createMating(),
    stats: recorder,
  };

  const sim = createSim(
    message.snapshot === undefined
      ? { seed: message.seed, config: message.config, modules }
      : { seed: message.seed, config: message.config, modules, snapshot: message.snapshot },
  );

  handle = sim;
  stats = recorder;
  post({ type: 'ready', requestId: message.requestId, tick: sim.state.tick, population: sim.state.liveCount });
}

function dispatch(message: MainToWorkerMessage): void {
  switch (message.type) {
    case 'init':
      initialise(message);
      return;

    case 'step': {
      const sim = requireHandle();
      const events: SimEvent[] = [];
      let remaining = Math.max(0, Math.floor(message.ticks));
      while (remaining > 0) {
        const chunk = Math.min(remaining, TICK_CHUNK);
        for (const event of collectEvents(sim.step(chunk))) events.push(event);
        remaining -= chunk;
      }
      postTicked(message.requestId, events);
      return;
    }

    case 'setSpeed': {
      requireHandle();
      speedMultiplier = Number.isFinite(message.multiplier) ? Math.max(0, Math.floor(message.multiplier)) : 0;
      if (speedMultiplier > 0) startLoop();
      else stopLoop();
      postTicked(message.requestId, []);
      return;
    }

    case 'sampleSliceRequest': {
      const sim = requireHandle();
      const slice = sim.sampleSlice(message.maxOrganisms, message.recycle);
      post({ type: 'sampleSlice', requestId: message.requestId, slice }, [slice.buffer.buffer as ArrayBuffer]);
      return;
    }

    case 'select': {
      const sim = requireHandle();
      post({
        type: 'selection',
        requestId: message.requestId,
        organism: sim.select(message.x, message.y, message.radiusWu),
      });
      return;
    }

    case 'seriesRequest': {
      const sim = requireHandle();
      post({ type: 'series', requestId: message.requestId, rows: sim.series(message.sinceTick) });
      return;
    }

    case 'snapshotRequest': {
      const sim = requireHandle();
      post({
        type: 'snapshot',
        requestId: message.requestId,
        snapshot: sim.snapshot(),
        stateHash: sim.stateHash(),
      });
      return;
    }

    case 'phylogenyRequest': {
      const sim = requireHandle();
      post({ type: 'phylogeny', requestId: message.requestId, nodes: sim.phylogeny() });
      return;
    }

    case 'fieldSliceRequest': {
      const sim = requireHandle();
      const field = sim.state.field;
      const source =
        message.field === 'plankton'
          ? field.plankton
          : message.field === 'kelp'
            ? field.kelp
            : field.temperature;
      // A copy, as the contract specifies: the live column keeps being written
      // every tick, and transferring it would tear the field out of the sim.
      const values = new Float32Array(source);
      post(
        {
          type: 'fieldSlice',
          requestId: message.requestId,
          field: message.field,
          cols: field.cols,
          rows: field.rows,
          cellSizeWu: field.cellSizeWu,
          values,
        },
        [values.buffer as ArrayBuffer],
      );
      return;
    }

    case 'command': {
      const sim = requireHandle();
      sim.command(message.command);
      flushCommandEvents();
      postTicked(message.requestId, []);
      return;
    }

    default:
      return assertHandled(message);
  }
}

/**
 * Compile-time exhaustiveness over `MainToWorkerMessage`.
 *
 * Without this the switch simply falls through when the protocol grows a
 * message — which is precisely what happened when contracts v1.3 added
 * `fieldSliceRequest`: the worker typechecked, dropped the request, and left
 * the caller's promise pending forever. A silent hang is the worst failure
 * this seam can produce, so an unknown message is now a build error here and a
 * rejected request at runtime.
 */
function assertHandled(message: never): never {
  throw new Error(`unhandled main→worker message: ${JSON.stringify(message)}`);
}

scope.addEventListener('message', (event: MessageEvent<MainToWorkerMessage>) => {
  const message = event.data;
  try {
    dispatch(message);
  } catch (error) {
    postError(message.requestId, error);
  }
});
