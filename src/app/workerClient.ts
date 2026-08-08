/**
 * The main thread's half of `contracts/protocol.ts` (WP-A6).
 *
 * Every request gets a `requestId` the worker echoes, so replies can be matched
 * even when a 256× frame delays them behind a batch of ticks. Messages the main
 * thread did not ask for — the loop's `ticked`, a command's `events`, an error
 * with no request attached — go to the push handlers instead.
 *
 * Nothing here imports `src/sim` or `src/stats`: the type of everything that
 * crosses the boundary comes from `contracts/`, which is the point of the seam.
 */

import type { SampleRow } from '../contracts/stats';
import type {
  EventsMessage,
  ErrorMessage,
  FieldSliceField,
  FieldSliceMessage,
  MainToWorkerMessage,
  OrganismDump,
  PhylogenyMessage,
  ReadyMessage,
  SampleSlice,
  SimCommand,
  SnapshotMessage,
  TickedMessage,
  WorkerToMainMessage,
} from '../contracts/protocol';
import type { SimConfigOverrides } from '../contracts/types';

export interface SimClientHandlers {
  /** The worker's autonomous tick push: one per frame while running. */
  onTicked(message: TickedMessage): void;
  /** Events raised outside a step — today, by a god command. */
  onEvents(message: EventsMessage): void;
  /** A failure with no outstanding request to reject. */
  onError(message: ErrorMessage): void;
}

interface PendingRequest {
  resolve(message: WorkerToMainMessage): void;
  reject(error: Error): void;
}

type ReplyOf<K extends WorkerToMainMessage['type']> = Extract<WorkerToMainMessage, { type: K }>;

export class SimClient {
  private readonly worker: Worker;
  private readonly handlers: SimClientHandlers;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;

  constructor(handlers: SimClientHandlers) {
    this.handlers = handlers;
    this.worker = new Worker(new URL('./simWorker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', (event: MessageEvent<WorkerToMainMessage>) => {
      this.receive(event.data);
    });
    this.worker.addEventListener('error', (event: ErrorEvent) => {
      handlers.onError({ type: 'error', requestId: null, message: event.message });
    });
  }

  init(seed: string, config: SimConfigOverrides): Promise<ReadyMessage> {
    return this.expect((requestId) => ({ type: 'init', requestId, seed, config }), 'ready');
  }

  setSpeed(multiplier: number): Promise<TickedMessage> {
    return this.expect((requestId) => ({ type: 'setSpeed', requestId, multiplier }), 'ticked');
  }

  step(ticks: number): Promise<TickedMessage> {
    return this.expect((requestId) => ({ type: 'step', requestId, ticks }), 'ticked');
  }

  /** `recycle` is transferred, so the caller must not touch that buffer again. */
  async sampleSlice(maxOrganisms: number, recycle?: Float32Array): Promise<SampleSlice> {
    const reply = await this.expect(
      (requestId) =>
        recycle === undefined
          ? { type: 'sampleSliceRequest', requestId, maxOrganisms }
          : { type: 'sampleSliceRequest', requestId, maxOrganisms, recycle },
      'sampleSlice',
      recycle === undefined ? [] : [recycle.buffer as ArrayBuffer],
    );
    return reply.slice;
  }

  async select(x: number, y: number, radiusWu: number): Promise<OrganismDump | null> {
    const reply = await this.expect((requestId) => ({ type: 'select', requestId, x, y, radiusWu }), 'selection');
    return reply.organism;
  }

  async series(sinceTick: number): Promise<readonly SampleRow[]> {
    const reply = await this.expect((requestId) => ({ type: 'seriesRequest', requestId, sinceTick }), 'series');
    return reply.rows;
  }

  /** One overlay raster. Cheap next to `snapshot()`, which serialises every pool column. */
  fieldSlice(field: FieldSliceField): Promise<FieldSliceMessage> {
    return this.expect((requestId) => ({ type: 'fieldSliceRequest', requestId, field }), 'fieldSlice');
  }

  snapshot(): Promise<SnapshotMessage> {
    return this.expect((requestId) => ({ type: 'snapshotRequest', requestId }), 'snapshot');
  }

  phylogeny(): Promise<PhylogenyMessage> {
    return this.expect((requestId) => ({ type: 'phylogenyRequest', requestId }), 'phylogeny');
  }

  command(command: SimCommand): Promise<TickedMessage> {
    return this.expect((requestId) => ({ type: 'command', requestId, command }), 'ticked');
  }

  private async expect<K extends WorkerToMainMessage['type']>(
    build: (requestId: number) => MainToWorkerMessage,
    type: K,
    transfer: Transferable[] = [],
  ): Promise<ReplyOf<K>> {
    const reply = await this.request(build, transfer);
    if (reply.type !== type) throw new Error(`worker replied '${reply.type}' where '${type}' was expected`);
    return reply as ReplyOf<K>;
  }

  private request(
    build: (requestId: number) => MainToWorkerMessage,
    transfer: Transferable[],
  ): Promise<WorkerToMainMessage> {
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    const message = build(requestId);
    return new Promise<WorkerToMainMessage>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage(message, transfer);
    });
  }

  private receive(message: WorkerToMainMessage): void {
    if (message.type === 'events') {
      this.handlers.onEvents(message);
      return;
    }

    // Every `ticked` reaches the handler, acknowledgement or push alike. A
    // command issued while paused answers with the tick and population it left
    // behind, and routing that only to the promise would leave the HUD showing
    // the state from before the meteor landed.
    if (message.type === 'ticked') this.handlers.onTicked(message);

    const requestId = message.requestId;
    const entry = requestId === null ? undefined : this.pending.get(requestId);
    if (entry !== undefined && requestId !== null) {
      this.pending.delete(requestId);
      if (message.type === 'error') entry.reject(new Error(message.message));
      else entry.resolve(message);
      return;
    }

    if (message.type === 'error') this.handlers.onError(message);
  }
}
