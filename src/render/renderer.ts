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
import { toWorld as cameraToWorld, worldTransform } from './camera';
import type { WorldTransform } from './camera';
import { CameraController } from './cameraController';
import { createColourMap, resolveColours } from './colourMap';
import { createCrudeFallback } from './fallback';
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
 * fill cost in the whole renderer — it is squared, so it multiplies every
 * blended pixel every layer draws by 4x at 2, not 2x.
 *
 * That matters because the near tier is fill-bound rather than CPU-bound: R2
 * measures the additive body glow at ~3.0M of 3.4M blended CSS pixels, and this
 * constant is what turns that into ~13.4M device samples. Dropping to 1.5 cuts
 * all of it by 44% ((1.5/2)^2) while still supersampling relative to CSS
 * pixels, which is what keeps edges smooth now that MSAA is off. Going to 1 is
 * a further 75% cut but leaves no supersampling at all and will alias visibly.
 *
 * Set to 1.5 by the orchestrator's look decision (2026-08-15) after browser
 * review: the fill cut is the cheapest headroom in the app and edges stay
 * smooth. Spend GLOW_SPAN/GLOW_ALPHA only after this lever is exhausted.
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

export type RendererKind = 'pixi' | 'crude-requested' | 'crude-no-gpu' | 'crude-init-failed';

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
    const renderer = await createPixiRenderer(canvas, config);
    activeKind = 'pixi';
    return renderer;
  } catch (error) {
    console.warn('[panthalassa] pixi renderer unavailable; falling back to the crude canvas', error);
    activeKind = 'crude-init-failed';
    return createCrudeFallback(canvas, config);
  }
}

async function createPixiRenderer(canvas: HTMLCanvasElement, config: SimConfig): Promise<WorldRenderer> {
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);

  const app = new Application();
  await app.init({
    canvas,
    width,
    height,
    preference: ['webgpu', 'webgl'],
    // No MSAA. At resolution 2 the downsample already antialiases every edge in
    // this scene, and multisampling a 2x buffer pays the fill cost twice — on
    // a 1440x722 window that is 4.2M samples resolved every frame, which shows
    // up as `renderMsEma` in the double digits before anything is drawn at all.
    antialias: false,
    resolution: Math.min(window.devicePixelRatio, MAX_RESOLUTION),
    autoDensity: true,
    background: ABYSS_COLOUR,
    backgroundAlpha: 1,
    autoStart: false,
  });
  // The conductor is main.ts's rAF loop; Pixi must not also be driving frames.
  app.ticker.stop();

  return new PixiWorldRenderer(app, canvas, config);
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
      worldRoot: { x: this.worldRoot.position.x, y: this.worldRoot.position.y, scale: this.worldRoot.scale.x },
      worldProbe: { x: probe.x, y: probe.y },
      slotChildren: {
        backdrop: this.backdrop.children.length,
        waterBelow: this.waterBelow.children.length,
        creatures: this.creatureSlot.children.length,
        waterAbove: this.waterAbove.children.length,
        foreground: this.foreground.children.length,
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
