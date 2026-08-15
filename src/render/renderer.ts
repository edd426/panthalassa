/**
 * The Pixi shell (R1): the only file that owns an `Application`, the container
 * z-order, and the per-frame pipeline every layer hangs off.
 *
 * Two rules hold the render wave together and are worth stating where they are
 * enforced rather than where they are documented:
 *
 * 1. **`main.ts`'s rAF is the conductor.** Pixi's own ticker is stopped and
 *    `draw(frame)` ends in exactly one `app.render()`. Two clocks driving one
 *    scene graph is how a renderer ends up half a frame behind its own input.
 * 2. **Layers never see the slice.** They receive a `FrameContext` of already
 *    interpolated poses, already resolved tints and an already chosen LOD tier,
 *    so nothing downstream can re-derive the colour ramp or the camera and
 *    disagree with the HUD about what is on screen.
 *
 * If the GPU is not there, or the URL says `?renderer=crude`, this hands back
 * the Phase A canvas renderer wearing the same interface.
 */

import { Application, Container } from 'pixi.js';
import type { Texture } from 'pixi.js';
import type { SimEvent } from '../contracts/events';
import type { SimConfig } from '../contracts/types';
import { fitScale, toWorld as cameraToWorld, worldTransform } from './camera';
import type { WorldTransform } from './camera';
import { CameraController } from './cameraController';
import { createColourMap, resolveColours } from './colourMap';
import { createCrudeFallback, createNullRenderer } from './fallback';
import { bootRenderer, settleWithin } from './rendererBoot';
import type { BootAttempt } from './rendererBoot';
import { Interpolator } from './interpolation';
import { createLayers } from './layerRegistry';
import { createLod, select as selectLod } from './lod';
import type {
  AmbientEvent,
  CameraState,
  ColourMode,
  CreatureFrame,
  FieldOverlay,
  FieldRaster,
  Frame,
  LodState,
  MountContext,
  RenderLayer,
  WorldRenderer,
} from './contracts';

/** The abyss the sea is drawn on; matches the page background in `index.html`. */
const ABYSS_COLOUR = 0x03151d;

/** Events handed to the layers in one frame. A meteor can queue hundreds; flourishes cannot. */
const MAX_EVENTS_PER_FRAME = 32;

/** Backlog cap. Older events are dropped rather than shown late. */
const MAX_EVENT_QUEUE = 256;

/**
 * How long the world may go without a *distinct* slice before it is treated as
 * paused. See the seam note on `derivePaused` below.
 */
const PAUSE_GRACE_MS = 500;

const RENDER_MS_EMA_ALPHA = 0.1;

/** Reused point for the debug hook's world-centre probe; allocating per frame would defeat the point. */
const WORLD_CENTRE_PROBE = { x: 1000, y: 600 };

/**
 * Device-pixel ceiling for the framebuffer, and the single largest lever on
 * fill cost in the whole renderer: it is *squared*, so every blended pixel
 * every layer draws costs `MAX_RESOLUTION ** 2` device samples.
 *
 * That matters because the near tier is fill-bound rather than CPU-bound — the
 * creature layer's additive body glow is the large majority of blended fill.
 *
 * **Name the unit whenever you quote a fill figure here.** The layers measure
 * in CSS pixels; this constant is the only thing that converts those to device
 * samples, and a joint estimate that silently summed one layer's CSS pixels
 * with another's device samples cost the wave a review cycle. Convert by
 * multiplying through this constant — never copy a number across that boundary,
 * and never bake the product into a comment, because it goes stale the moment
 * this value is tuned (which has already happened once).
 *
 * Currently the orchestrator's look decision (2026-08-15) after browser review:
 * lowering it from 2 cut device samples 44% while still supersampling relative
 * to CSS pixels, which is what keeps edges smooth now that MSAA is off. Going
 * to 1 would cut a further 56% but leaves no supersampling at all and will
 * alias visibly. Spend the creature layer's GLOW_SPAN/GLOW_ALPHA only after
 * this lever is exhausted: this one costs no design decision, those cost look.
 */
const MAX_RESOLUTION = 1.5;

interface MutableFrameContext {
  nowMs: number;
  dtMs: number;
  camera: CameraState;
  lod: LodState;
  creatures: CreatureFrame | null;
  colourMode: ColourMode;
  overlay: FieldOverlay;
  overlayRaster: FieldRaster | null;
  plankton: FieldRaster | null;
  kelp: FieldRaster | null;
  temperature: FieldRaster | null;
  events: AmbientEvent[];
  selected: { readonly x: number; readonly y: number } | null;
  paused: boolean;
  speedMultiplier: number;
}

function wantsCrudeRenderer(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('renderer') === 'crude';
  } catch {
    return false;
  }
}

/**
 * Whether a GPU context is obtainable at all, probed on a throwaway canvas.
 * Asking the real `#world` canvas first would poison it: an element that has
 * handed out a WebGL context can never return a 2D one, and the crude fallback
 * needs exactly that.
 *
 * The probe *must* release what it takes. A browser keeps only a small number
 * of live WebGL contexts (~16 per process) and drops the oldest when it runs
 * out; a probe context left for the GC to collect is a context the real
 * renderer may not get, which showed up as the same URL coming up on WebGL on
 * one load and on the crude fallback on the next. `WEBGL_lose_context` hands it
 * back immediately instead of whenever a collection happens to run.
 */
function gpuContextAvailable(): boolean {
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) return true;
  let probe: HTMLCanvasElement | null = null;
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  try {
    probe = document.createElement('canvas');
    gl = probe.getContext('webgl2') ?? probe.getContext('webgl');
    return gl !== null;
  } catch {
    return false;
  } finally {
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    if (probe !== null) {
      probe.width = 0;
      probe.height = 0;
    }
  }
}

/**
 * How long any one graphics backend gets to initialise before its turn is over.
 *
 * Generous: a healthy init is tens of milliseconds, so this only fires on a
 * stack that is genuinely stuck. Erring long costs a slow machine a few seconds
 * of black water once; erring short would demote a working WebGPU device to
 * WebGL for no reason.
 */
export const INIT_TIMEOUT_MS = 4000;

/**
 * Backends to try, in order. WebGPU first because it is the better renderer
 * where it works; WebGL alone second because "WebGPU hangs" is precisely the
 * case the combined preference cannot recover from on its own — Pixi has
 * already committed to WebGPU by the time it stalls.
 */
const WEBGL_ONLY: BootAttempt = { preference: ['webgl'], label: 'webgl-only' };

const INIT_ATTEMPTS: readonly BootAttempt[] = [
  { preference: ['webgpu', 'webgl'], label: 'webgpu-then-webgl' },
  WEBGL_ONLY,
];

/**
 * How long WebGPU gets to admit it exists before it is left out of the running.
 * Short, because this is a pre-flight on a healthy machine's fast path.
 */
const ADAPTER_PROBE_MS = 1500;

/**
 * Decide the backend order *before* the real canvas is committed to anything.
 *
 * A canvas can only ever produce one kind of context. If Pixi asks it for
 * WebGPU and then stalls, that canvas can no longer give WebGL — or the 2D
 * context the crude fallback needs — and every remaining option is gone. So the
 * one question that decides the whole boot, "does this machine's WebGPU
 * actually answer", is asked here where the answer costs nothing: a bare
 * adapter request, raced against a deadline, touching no canvas at all.
 *
 * `'gpu' in navigator` is not that question. It is true on the machine this bug
 * was found on, where contexts nevertheless fail.
 */
async function preferredAttempts(): Promise<readonly BootAttempt[]> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (gpu === undefined) return [WEBGL_ONLY];

  let adapter: unknown = null;
  let probe: Promise<unknown>;
  try {
    probe = gpu.requestAdapter().then((found: unknown) => {
      adapter = found;
    });
  } catch {
    return [WEBGL_ONLY];
  }

  const outcome = await settleWithin(probe, ADAPTER_PROBE_MS);
  if (outcome === 'ok' && adapter !== null && adapter !== undefined) return INIT_ATTEMPTS;
  console.warn(
    `[panthalassa] WebGPU adapter ${outcome === 'timeout' ? 'did not answer' : 'unavailable'}; using WebGL`,
  );
  return [WEBGL_ONLY];
}

export type RendererKind =
  | 'pixi'
  | 'pixi-webgl'
  | 'crude-requested'
  | 'crude-no-gpu'
  | 'crude-init-failed'
  | 'none';

let activeKind: RendererKind = 'pixi';

/**
 * Which renderer the last `createRenderer` actually produced, and why. Exposed
 * as a module query rather than on `WorldRenderer` because the seam is frozen;
 * `main.ts` reads it to put the degradation in the event feed, where someone
 * watching the ocean will see it without opening a console.
 */
export function rendererKind(): RendererKind {
  return activeKind;
}

export async function createRenderer(canvas: HTMLCanvasElement, config: SimConfig): Promise<WorldRenderer> {
  // Asked for explicitly: the Phase A picture, on purpose, without a warning.
  if (wantsCrudeRenderer()) {
    console.info('[panthalassa] ?renderer=crude — using the Phase A canvas renderer');
    activeKind = 'crude-requested';
    return createCrudeFallback(canvas, config);
  }
  // Every other route to the fallback is a degradation and has to say so. This
  // path used to return silently, so a load that quietly lost the GPU was
  // indistinguishable from one that never had it.
  if (!gpuContextAvailable()) {
    console.warn(
      '[panthalassa] no WebGPU or WebGL context available; falling back to the crude canvas renderer',
    );
    activeKind = 'crude-no-gpu';
    return createCrudeFallback(canvas, config);
  }
  try {
    activeKind = 'pixi';
    return await createPixiRenderer(canvas, config);
  } catch (error) {
    console.warn('[panthalassa] pixi renderer unavailable; falling back to the crude canvas', error);
    activeKind = 'crude-init-failed';
  }

  // Last resort. The crude renderer needs a 2D context, and a canvas that has
  // already handed one out to WebGL cannot give one — so this can fail too, and
  // if it throws it takes `main.ts`'s top-level await with it and the page never
  // boots at all. A world with no renderer is bad; a blank page with an empty
  // HUD and nothing in the console is the bug we are here to remove.
  try {
    return createCrudeFallback(canvas, config);
  } catch (error) {
    console.error('[panthalassa] no renderer could be created; the HUD will run over empty water', error);
    activeKind = 'none';
    return createNullRenderer(config);
  }
}

/**
 * Boot the Pixi application, refusing to wait forever for any one backend.
 *
 * A WebGPU adapter request that never answers is not a rejected promise — it is
 * a promise that never settles — and `main.ts` awaits this at the top level, so
 * a stall here is a permanently blank page with nothing in the console. That is
 * exactly what the production bundle did while the dev server was fine, because
 * which backend gets chosen is not something the build is required to keep
 * stable. Every attempt therefore gets a deadline and the next backend gets a
 * turn; only when all of them are exhausted does this give up.
 */
async function createPixiRenderer(canvas: HTMLCanvasElement, config: SimConfig): Promise<WorldRenderer> {
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);

  const booted = await bootRenderer<Application>(
    await preferredAttempts(),
    {
      begin(preference) {
        // `new Application()` is synchronous, so the handle exists even when
        // `init` never comes back — which is what makes teardown possible.
        const app = new Application();
        return { handle: app, ready: app.init(initOptions(canvas, width, height, preference)) };
      },
      abandon(app) {
        // Release whatever the stalled attempt did manage to take, but leave
        // the canvas in the document: the next attempt draws into it.
        app.destroy(false, { children: true });
      },
    },
    INIT_TIMEOUT_MS,
    (attempt, outcome) => {
      console.warn(
        `[panthalassa] renderer init ${outcome} for preference [${attempt.preference.join(', ')}] after ${INIT_TIMEOUT_MS} ms`,
      );
    },
  );

  if (booted === null) throw new Error('every renderer backend timed out or failed to initialise');
  // Keyed off which attempt won, not off how many were tried: the pre-flight
  // can put WebGL first, so "running on WebGL" and "retried" are not the same.
  if (booted.label === WEBGL_ONLY.label) activeKind = 'pixi-webgl';

  const app = booted.handle;
  // The conductor is main.ts's rAF loop; Pixi must not also be driving frames.
  app.ticker.stop();

  return new PixiWorldRenderer(app, canvas, config);
}

function initOptions(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  preference: readonly string[],
): Parameters<Application['init']>[0] {
  return {
    canvas,
    width,
    height,
    preference: preference as ('webgpu' | 'webgl')[],
    // No MSAA. `MAX_RESOLUTION` already supersamples, which antialiases every
    // edge in this scene, and multisampling on top of that pays the fill cost
    // twice over — it showed up as `renderMsEma` in the double digits before
    // anything had been drawn at all. If MAX_RESOLUTION ever drops to 1 there
    // is no supersampling left and this has to be reconsidered.
    antialias: false,
    resolution: Math.min(window.devicePixelRatio, MAX_RESOLUTION),
    autoDensity: true,
    background: ABYSS_COLOUR,
    backgroundAlpha: 1,
    autoStart: false,
  };
}

class PixiWorldRenderer implements WorldRenderer {
  private readonly app: Application;
  private readonly canvas: HTMLCanvasElement;
  private readonly config: SimConfig;

  private readonly worldRoot = new Container();
  private readonly backdrop = new Container();
  private readonly waterBelow = new Container();
  private readonly creatureSlot = new Container();
  private readonly waterAbove = new Container();
  private readonly foreground = new Container();

  private readonly controller: CameraController;
  private readonly interpolator = new Interpolator();
  private readonly colourMap = createColourMap();
  private readonly lod = createLod(performance.now());
  private readonly layers: RenderLayer[] = [];

  private readonly queue: AmbientEvent[] = [];
  private readonly drained: AmbientEvent[] = [];

  private readonly context: MutableFrameContext;

  private lastSlice: Frame['slice'] = null;
  private lastColourMode: ColourMode | null = null;
  private lastTemperature: FieldRaster | null = null;
  private lastFrameMs = 0;
  private renderMsEma = 0;
  private readonly transformScratch: WorldTransform = { x: 0, y: 0, scale: 1 };

  constructor(app: Application, canvas: HTMLCanvasElement, config: SimConfig) {
    this.app = app;
    this.canvas = canvas;
    this.config = config;

    this.worldRoot.addChild(this.waterBelow, this.creatureSlot, this.waterAbove);
    app.stage.addChild(this.backdrop, this.worldRoot, this.foreground);

    this.controller = new CameraController(
      canvas,
      { widthWu: config.world.widthWu, heightWu: config.world.heightWu },
      Math.max(1, window.innerWidth),
      Math.max(1, window.innerHeight),
    );

    this.context = {
      nowMs: 0,
      dtMs: 0,
      camera: this.controller.state,
      lod: this.lod,
      creatures: null,
      colourMode: 'identity',
      overlay: 'off',
      overlayRaster: null,
      plankton: null,
      kelp: null,
      temperature: null,
      events: this.drained,
      selected: null,
      paused: false,
      speedMultiplier: 1,
    };

    const mount: MountContext = {
      slots: {
        backdrop: this.backdrop,
        waterBelow: this.waterBelow,
        creatures: this.creatureSlot,
        waterAbove: this.waterAbove,
        foreground: this.foreground,
      },
      world: { widthWu: config.world.widthWu, heightWu: config.world.heightWu },
      config,
      generateTexture: (source: Container, options?: { resolution?: number }): Texture =>
        app.renderer.generateTexture(
          options?.resolution === undefined
            ? { target: source }
            : { target: source, resolution: options.resolution },
        ),
    };

    // Each layer is mounted in isolation. Letting one throw out of here would
    // reject `createPixiRenderer` and drop the whole app to the crude canvas
    // because a single flourish failed to bake — losing the ocean to save a
    // god ray. A layer that cannot mount is dropped from the frame loop and
    // says so; the rest of the world still draws.
    for (const layer of createLayers()) {
      try {
        layer.mount(mount);
        this.layers.push(layer);
      } catch (error) {
        console.error(`[panthalassa] render layer "${layer.name}" failed to mount and was dropped`, error);
      }
    }
    this.applyCamera(this.syncViewport());
  }

  get pixelsPerWu(): number {
    return this.controller.state.pxPerWu;
  }

  get colourLegend() {
    return this.colourMap.legend;
  }

  draw(frame: Frame): void {
    const nowMs = performance.now();
    const dtMs = this.lastFrameMs === 0 ? 16.7 : nowMs - this.lastFrameMs;
    this.lastFrameMs = nowMs;

    this.absorb(frame, nowMs);

    this.syncViewport();
    const camera = this.controller.update(nowMs);
    const creatures = this.interpolator.sliceGeneration > 0 ? this.interpolator.sample(nowMs, camera) : null;

    // A paused world is watch speed 0; the LOD reads the speed the sim is
    // actually being run at, which is what decides how much detail can survive.
    const paused = frame.paused ?? this.derivePaused(nowMs);
    const watchSpeed = paused ? 0 : (frame.speedMultiplier ?? 1);

    const lod = selectLod(this.lod, {
      nowMs,
      pxPerWu: camera.pxPerWu,
      visibleCount: creatures?.visibleCount ?? 0,
      speedMultiplier: watchSpeed,
      renderMsEma: this.renderMsEma,
      medianSizeCm: this.interpolator.medianSizeCm,
    });

    const context = this.context;
    context.nowMs = nowMs;
    context.dtMs = dtMs;
    context.camera = camera;
    context.lod = lod;
    context.creatures = creatures;
    context.colourMode = frame.colourMode;
    context.overlay = frame.overlay;
    context.overlayRaster = frame.field;
    context.plankton = frame.plankton ?? null;
    context.kelp = frame.kelp ?? null;
    context.temperature = frame.temperature;
    context.selected = frame.selected;
    context.paused = paused;
    context.speedMultiplier = watchSpeed;
    this.drainEvents();

    this.applyCamera(camera);
    for (const layer of this.layers) layer.update(context);

    const startedMs = performance.now();
    this.app.render();
    const cost = performance.now() - startedMs;
    this.renderMsEma =
      this.renderMsEma === 0 ? cost : this.renderMsEma * (1 - RENDER_MS_EMA_ALPHA) + cost * RENDER_MS_EMA_ALPHA;

    // Review-loop instrument, orchestrator-owned: what the pipeline actually
    // produced this frame, readable from devtools. Cheap enough to keep.
    //
    // Extended (R1) with the scene-graph side. The pure-math figures agreeing
    // with themselves tells you nothing about whether the world is on screen —
    // that question is answered by where the world container actually puts a
    // world point, and by whether the slots have any children to put there.
    // `worldProbe` is the screen position of the world centre: with a fitted
    // camera it must land near the middle of `screen`.
    const probe = this.worldRoot.toGlobal(WORLD_CENTRE_PROBE, undefined, false);
    const screen = this.app.renderer.screen;
    (window as unknown as Record<string, unknown>)['__panthalassaRender'] = {
      count: creatures?.count ?? -1,
      visibleCount: creatures?.visibleCount ?? -1,
      tier: lod.tier,
      renderMsEma: this.renderMsEma,
      pxPerWu: camera.pxPerWu,
      sliceGeneration: this.interpolator.sliceGeneration,
      speedMultiplier: watchSpeed,
      paused,
      rendererKind: activeKind,
      screen: { w: screen.width, h: screen.height },
      cameraViewport: { w: camera.viewportW, h: camera.viewportH },
      // Zoom triage: `wheel.events` separates "the handler never fired" from
      // "the handler fired and the camera declined". `fitPxPerWu` is what the
      // camera would sit at with no zoom applied — pxPerWu equal to it means
      // the camera is at fit, which is a very different story from clamped.
      wheel: this.controller.wheelDiagnostics,
      fitPxPerWu: fitScale(camera.viewportW, camera.viewportH, this.config.world.widthWu, this.config.world.heightWu),
      worldRoot: { x: this.worldRoot.position.x, y: this.worldRoot.position.y, scale: this.worldRoot.scale.x },
      worldProbe: { x: probe.x, y: probe.y },
      slotChildren: {
        backdrop: this.backdrop.children.length,
        waterBelow: this.waterBelow.children.length,
        creatures: this.creatureSlot.children.length,
        waterAbove: this.waterAbove.children.length,
        foreground: this.foreground.children.length,
      },
      // Live container references, for review-loop ablation from devtools
      // (toggle `.visible` per child to attribute a wrong pixel to its layer).
      containers: {
        backdrop: this.backdrop,
        waterBelow: this.waterBelow,
        creatures: this.creatureSlot,
        waterAbove: this.waterAbove,
        foreground: this.foreground,
      },
    };
  }

  resize(): void {
    this.app.renderer.resize(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight));
    // Re-read from the renderer rather than from the window: Pixi may adjust
    // what it was asked for, and the projection is what the camera must match.
    this.applyCamera(this.syncViewport());
  }

  toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const bounds = this.canvas.getBoundingClientRect();
    return cameraToWorld(this.controller.state, clientX - bounds.left, clientY - bounds.top);
  }

  pushEvents(events: readonly SimEvent[]): void {
    const receivedAtMs = performance.now();
    for (const event of events) this.queue.push({ event, receivedAtMs });
    // Newest wins: a flourish that surfaces two seconds after its event is
    // worse than one that never surfaces at all.
    if (this.queue.length > MAX_EVENT_QUEUE) this.queue.splice(0, this.queue.length - MAX_EVENT_QUEUE);
  }

  reset(): void {
    this.interpolator.reset();
    this.controller.reset();
    this.queue.length = 0;
    this.drained.length = 0;
    this.lastSlice = null;
    this.lastColourMode = null;
    this.lastTemperature = null;
    for (const layer of this.layers) layer.reset();
  }

  isDragClick(): boolean {
    return this.controller.isDragClick();
  }

  destroy(): void {
    for (const layer of this.layers) layer.destroy();
    this.controller.destroy();
    this.app.destroy(false, { children: true });
  }

  /** Fold a new slice into the interpolator, re-staining if only the mode changed. */
  private absorb(frame: Frame, nowMs: number): void {
    const slice = frame.slice;
    if (slice === null) return;
    const restained =
      frame.colourMode !== this.lastColourMode || frame.temperature !== this.lastTemperature;
    if (slice === this.lastSlice && !restained) return;

    resolveColours(this.colourMap, slice, frame.colourMode, frame.temperature, this.config);
    this.lastSlice = slice;
    this.lastColourMode = frame.colourMode;
    this.lastTemperature = frame.temperature;

    if (!this.interpolator.ingest(slice, nowMs, this.colourMap.tints, this.colourMap.alphas)) {
      // The slice was a repeat (paused world), but the palette may still have
      // changed under it — recolour in place without disturbing the poses.
      this.interpolator.restain(this.colourMap.tints, this.colourMap.alphas);
    }
  }

  /**
   * Fallback for a `Frame` that carries no `paused` flag. The seam now has one
   * and `main.ts` sets it, so this only covers a caller that predates the
   * field: a world that has stopped producing distinct slices has stopped.
   */
  private derivePaused(nowMs: number): boolean {
    if (this.interpolator.sliceGeneration === 0) return false;
    return nowMs - this.interpolator.lastSliceAtMs > PAUSE_GRACE_MS;
  }

  private drainEvents(): void {
    this.drained.length = 0;
    const take = Math.min(MAX_EVENTS_PER_FRAME, this.queue.length);
    for (let i = 0; i < take; i += 1) {
      const event = this.queue[i];
      if (event !== undefined) this.drained.push(event);
    }
    this.queue.splice(0, take);
  }

  /**
   * Make the camera's viewport agree with the projection Pixi is actually
   * rendering through.
   *
   * `renderer.screen` is the only authority on that rectangle. Reading
   * `window.innerWidth` a second time to build the camera was a second source
   * of truth separated from the first by an `await`, so a window that settled
   * during `Application.init` — a scrollbar resolving, a devtools pane, a
   * restoring window — left the camera centring the world for one viewport
   * while the projection used another. The world then drew off to one side, or
   * off-screen entirely, while every pure-math check still agreed with itself.
   * Checked per frame rather than only on resize, so any future drift heals on
   * the next frame instead of persisting for the run.
   */
  private syncViewport(): CameraState {
    const screen = this.app.renderer.screen;
    const width = Math.max(1, screen.width);
    const height = Math.max(1, screen.height);
    const camera = this.controller.state;
    if (camera.viewportW !== width || camera.viewportH !== height) {
      this.controller.resize(width, height);
    }
    return this.controller.state;
  }

  private applyCamera(camera: CameraState): void {
    // Only the world slots move; backdrop and foreground are screen-space and
    // are deliberately left at identity.
    const transform = worldTransform(camera, this.transformScratch);
    this.worldRoot.scale.set(transform.scale);
    this.worldRoot.position.set(transform.x, transform.y);
  }
}
