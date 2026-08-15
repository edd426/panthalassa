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
import { toWorld as cameraToWorld } from './camera';
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
 */
function gpuContextAvailable(): boolean {
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) return true;
  try {
    const probe = document.createElement('canvas');
    return probe.getContext('webgl2') !== null || probe.getContext('webgl') !== null;
  } catch {
    return false;
  }
}

export async function createRenderer(canvas: HTMLCanvasElement, config: SimConfig): Promise<WorldRenderer> {
  if (wantsCrudeRenderer() || !gpuContextAvailable()) return createCrudeFallback(canvas, config);
  try {
    return await createPixiRenderer(canvas, config);
  } catch (error) {
    console.warn('[panthalassa] pixi renderer unavailable; falling back to the crude canvas', error);
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
    antialias: true,
    resolution: Math.min(window.devicePixelRatio, 2),
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
  private readonly layers: RenderLayer[];

  private readonly queue: AmbientEvent[] = [];
  private readonly drained: AmbientEvent[] = [];

  private readonly context: MutableFrameContext;

  private lastSlice: Frame['slice'] = null;
  private lastColourMode: ColourMode | null = null;
  private lastTemperature: FieldRaster | null = null;
  private lastFrameMs = 0;
  private renderMsEma = 0;

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

    this.layers = createLayers();
    for (const layer of this.layers) layer.mount(mount);
    this.applyCamera(this.controller.state);
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

    const camera = this.controller.update(nowMs);
    const creatures = this.interpolator.sliceGeneration > 0 ? this.interpolator.sample(nowMs, camera) : null;

    const lod = selectLod(this.lod, {
      nowMs,
      pxPerWu: camera.pxPerWu,
      visibleCount: creatures?.visibleCount ?? 0,
      // SEAM GAP: `Frame` carries no watch speed, so the speed criterion cannot
      // fire. Reported to the orchestrator rather than worked around; the frame
      // -time governor still covers the case this would have caught early.
      speedMultiplier: 1,
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
    context.paused = this.derivePaused(nowMs);
    context.speedMultiplier = 1;
    this.drainEvents();

    this.applyCamera(camera);
    for (const layer of this.layers) layer.update(context);

    const startedMs = performance.now();
    this.app.render();
    const cost = performance.now() - startedMs;
    this.renderMsEma =
      this.renderMsEma === 0 ? cost : this.renderMsEma * (1 - RENDER_MS_EMA_ALPHA) + cost * RENDER_MS_EMA_ALPHA;
  }

  resize(): void {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    this.app.renderer.resize(width, height);
    this.controller.resize(width, height);
    this.applyCamera(this.controller.state);
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
   * SEAM GAP: `Frame` carries neither `paused` nor the watch speed, and
   * `FrameContext` requires `paused`. Derived here from the one signal the
   * renderer does have — a world that has stopped producing distinct slices —
   * rather than by forking the contract. Reported to the orchestrator; a
   * `paused` field on `Frame` replaces this with one line.
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

  private applyCamera(camera: CameraState): void {
    // Only the world slots move; backdrop and foreground are screen-space and
    // are deliberately left at identity.
    this.worldRoot.scale.set(camera.pxPerWu);
    this.worldRoot.position.set(
      camera.viewportW / 2 - camera.centerX * camera.pxPerWu,
      camera.viewportH / 2 - camera.centerY * camera.pxPerWu,
    );
  }
}
