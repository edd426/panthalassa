/**
 * Camera input (R1). The DOM half of `camera.ts`: wheel, drag, double-click
 * and the `0` key turn into `CameraState` transitions, and nothing else in the
 * renderer touches an event listener.
 *
 * Only `0` is bound on the window. Every other key belongs to `main.ts`
 * (space, 1–9, f, c, t, r) and a second listener quietly stealing one of them
 * would be a bug nobody could find from the symptom.
 */

import { clampCamera, fitWorld, isFitted, pan, withViewport, zoomAt } from './camera';
import type { Vec2, WorldRect } from './camera';
import type { CameraState } from './contracts';

/** Wheel sensitivity. Exponential so a trackpad flick and a mouse notch feel alike. */
const ZOOM_PER_WHEEL_UNIT = 1.0015;

/** Movement below this is a click with a shaky hand, not a drag. */
const DRAG_THRESHOLD_PX = 4;

/** Exponential decay constant of the post-drag glide. */
const INERTIA_TAU_MS = 120;

/** Below this the glide is over; anything slower reads as drift. */
const INERTIA_STOP_PX_S = 12;

/** Fit-all animation length. */
const FIT_ANIMATION_MS = 420;

/** Overlays that own their own scrolling; a wheel over these is not a zoom. */
const SCROLLABLE_CHROME = '#panel, #charts';

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class CameraController {
  private readonly canvas: HTMLCanvasElement;
  private readonly world: WorldRect;
  private current: CameraState;

  private dragging = false;
  private pointerId = -1;
  private movedPx = 0;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private lastPointerMs = 0;
  private velocityX = 0;
  private velocityY = 0;
  private dragClickPending = false;

  private fitFrom: CameraState | null = null;
  private fitTo: CameraState | null = null;
  private fitStartedMs = 0;

  private lastUpdateMs = 0;

  /**
   * Wheel events actually delivered to this controller. Surfaced through the
   * debug hook because "zoom does nothing" has two very different causes —
   * the handler not firing, and the handler firing but the camera refusing —
   * and they are indistinguishable from the screen.
   */
  private wheelEvents = 0;
  private lastWheelDeltaY = 0;

  get wheelDiagnostics(): { events: number; lastDeltaY: number } {
    return { events: this.wheelEvents, lastDeltaY: this.lastWheelDeltaY };
  }

  constructor(canvas: HTMLCanvasElement, world: WorldRect, viewportW: number, viewportH: number) {
    this.canvas = canvas;
    this.world = world;
    this.current = fitWorld(viewportW, viewportH, world.widthWu, world.heightWu);

    // Wheel is bound on the window, not the canvas. The canvas is the bottom
    // layer of a page that grows chrome over time, and a zoom that silently
    // stops working because something was laid over the water is a bug with no
    // symptom to search for. Scrollable UI filters itself out in `onWheel`.
    window.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('dblclick', this.onDoubleClick);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
  }

  get state(): CameraState {
    return this.current;
  }

  /** True when the click now firing was the tail of a drag; consumed by the read. */
  isDragClick(): boolean {
    const wasDrag = this.dragClickPending;
    this.dragClickPending = false;
    return wasDrag;
  }

  resize(viewportW: number, viewportH: number): void {
    this.current = withViewport(this.current, viewportW, viewportH, this.world);
    this.fitFrom = null;
    this.fitTo = null;
  }

  /** Back to the whole sea, without animation — a new world starts fitted. */
  reset(): void {
    this.current = fitWorld(this.current.viewportW, this.current.viewportH, this.world.widthWu, this.world.heightWu);
    this.velocityX = 0;
    this.velocityY = 0;
    this.fitFrom = null;
    this.fitTo = null;
  }

  /** Advance the fit animation and the post-drag glide. Returns the camera to draw with. */
  update(nowMs: number): CameraState {
    const dtMs = this.lastUpdateMs === 0 ? 16 : Math.min(100, nowMs - this.lastUpdateMs);
    this.lastUpdateMs = nowMs;

    const from = this.fitFrom;
    const to = this.fitTo;
    if (from !== null && to !== null) {
      const t = Math.min(1, (nowMs - this.fitStartedMs) / FIT_ANIMATION_MS);
      const eased = easeInOutCubic(t);
      // Zoom is interpolated in log space: a linear ramp between two scales
      // spends most of the animation at the wide end and then lurches.
      const pxPerWu = from.pxPerWu * Math.pow(to.pxPerWu / from.pxPerWu, eased);
      this.current = clampCamera(
        {
          centerX: from.centerX + (to.centerX - from.centerX) * eased,
          centerY: from.centerY + (to.centerY - from.centerY) * eased,
          pxPerWu,
          viewportW: this.current.viewportW,
          viewportH: this.current.viewportH,
        },
        this.world,
      );
      if (t >= 1) {
        this.fitFrom = null;
        this.fitTo = null;
      }
      return this.current;
    }

    if (!this.dragging && (this.velocityX !== 0 || this.velocityY !== 0)) {
      const decay = Math.exp(-dtMs / INERTIA_TAU_MS);
      const dx = (this.velocityX * dtMs) / 1000;
      const dy = (this.velocityY * dtMs) / 1000;
      this.current = pan(this.current, dx, dy, this.world);
      this.velocityX *= decay;
      this.velocityY *= decay;
      if (Math.hypot(this.velocityX, this.velocityY) < INERTIA_STOP_PX_S) {
        this.velocityX = 0;
        this.velocityY = 0;
      }
    }
    return this.current;
  }

  destroy(): void {
    window.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
  }

  private localPoint(event: { clientX: number; clientY: number }, out: Vec2): Vec2 {
    const bounds = this.canvas.getBoundingClientRect();
    out.x = event.clientX - bounds.left;
    out.y = event.clientY - bounds.top;
    return out;
  }

  private readonly scratch: Vec2 = { x: 0, y: 0 };

  private readonly onWheel = (event: WheelEvent): void => {
    // The inspector panel and the trend strip scroll their own content; only a
    // wheel over the water is a zoom.
    const target = event.target;
    if (target instanceof Element && target !== this.canvas && target.closest(SCROLLABLE_CHROME) !== null) {
      return;
    }
    this.wheelEvents += 1;
    this.lastWheelDeltaY = event.deltaY;
    event.preventDefault();
    const point = this.localPoint(event, this.scratch);
    const factor = Math.pow(ZOOM_PER_WHEEL_UNIT, -event.deltaY);
    this.fitFrom = null;
    this.fitTo = null;
    this.current = zoomAt(this.current, point.x, point.y, factor, this.world);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.dragging = true;
    this.pointerId = event.pointerId;
    this.movedPx = 0;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.lastPointerMs = event.timeStamp;
    this.velocityX = 0;
    this.velocityY = 0;
    this.dragClickPending = false;
    this.fitFrom = null;
    this.fitTo = null;
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging || event.pointerId !== this.pointerId) return;
    const dx = event.clientX - this.lastPointerX;
    const dy = event.clientY - this.lastPointerY;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;

    this.movedPx += Math.hypot(dx, dy);
    if (this.movedPx < DRAG_THRESHOLD_PX) return;

    const gapMs = Math.max(1, event.timeStamp - this.lastPointerMs);
    this.lastPointerMs = event.timeStamp;
    this.velocityX = (dx / gapMs) * 1000;
    this.velocityY = (dy / gapMs) * 1000;
    this.current = pan(this.current, dx, dy, this.world);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.dragging || event.pointerId !== this.pointerId) return;
    this.dragging = false;
    this.pointerId = -1;
    // The click event fires after this one; the flag is what tells main.ts the
    // click was the end of a pan and must not select whatever is under it.
    this.dragClickPending = this.movedPx >= DRAG_THRESHOLD_PX;
    if (!this.dragClickPending) {
      this.velocityX = 0;
      this.velocityY = 0;
    }
    // A pointer that stopped moving before release should not glide.
    if (event.timeStamp - this.lastPointerMs > 80) {
      this.velocityX = 0;
      this.velocityY = 0;
    }
  };

  private readonly onDoubleClick = (): void => {
    this.fitAll();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== '0') return;
    this.fitAll();
  };

  private fitAll(): void {
    const target = fitWorld(
      this.current.viewportW,
      this.current.viewportH,
      this.world.widthWu,
      this.world.heightWu,
    );
    this.velocityX = 0;
    this.velocityY = 0;
    if (isFitted(this.current, this.world)) return;
    this.fitFrom = this.current;
    this.fitTo = target;
    // Wall clock, matching the `nowMs` the shell drives `update` with.
    this.fitStartedMs = performance.now();
  }
}
