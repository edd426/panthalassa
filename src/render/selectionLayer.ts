/**
 * The selection halo (R1): a fixed ring on the inspected organism plus a slow
 * outward sonar echo, so a marked animal can be picked out of a crowded shoal
 * from across the room without the ring itself hiding the body.
 *
 * The halo marks *where the dump was taken*, not the animal — a slice carries
 * slots and a slot is reused the tick after its occupant dies, so a halo that
 * followed its subject would eventually ring a stranger while the panel
 * described the dead. Everything here is drawn in world units at
 * `px / camera.pxPerWu`, which keeps the ring the same size on screen at every
 * zoom even though it lives in a camera-transformed container.
 */

import { Graphics } from 'pixi.js';
import type { Container } from 'pixi.js';
import type { FrameContext, MountContext, RenderLayer } from './contracts';

/** Echo period. Slow enough to read as a ping rather than a strobe. */
const PING_PERIOD_MS = 2000;

const RING_RADIUS_PX = 14;
const RING_WIDTH_PX = 2;
const ECHO_TRAVEL_PX = 58;

const RING_COLOUR = 0xffffff;
const ECHO_COLOUR = 0x9fe8ff;

export class SelectionLayer implements RenderLayer {
  readonly name = 'selection';

  private graphics: Graphics | null = null;
  private parent: Container | null = null;
  /** Whether anything is currently drawn, so an idle frame can skip the clear. */
  private drawn = false;

  mount(ctx: MountContext): void {
    const graphics = new Graphics();
    graphics.visible = false;
    ctx.slots.waterAbove.addChild(graphics);
    this.graphics = graphics;
    this.parent = ctx.slots.waterAbove;
  }

  update(frame: FrameContext): void {
    const graphics = this.graphics;
    if (graphics === null) return;

    const selected = frame.selected;
    if (selected === null) {
      // Clear only on the transition. `Graphics.clear()` dirties the context and
      // costs a geometry rebuild every time it is called, and nothing is
      // selected for most of a run — this is a per-frame cost for an invisible
      // object.
      if (this.drawn) {
        graphics.clear();
        graphics.visible = false;
        this.drawn = false;
      }
      return;
    }

    graphics.clear();
    graphics.visible = true;
    this.drawn = true;

    const perPx = 1 / Math.max(1e-6, frame.camera.pxPerWu);
    graphics
      .circle(selected.x, selected.y, RING_RADIUS_PX * perPx)
      .stroke({ width: RING_WIDTH_PX * perPx, color: RING_COLOUR, alpha: 0.9 });

    // Phase runs on the wall clock, not the sim tick: the ping keeps pinging
    // while the world is paused, which is exactly when someone is reading the
    // inspector panel and looking for the animal it describes.
    const phase = (frame.nowMs % PING_PERIOD_MS) / PING_PERIOD_MS;
    const radius = (RING_RADIUS_PX + phase * ECHO_TRAVEL_PX) * perPx;
    graphics
      .circle(selected.x, selected.y, radius)
      .stroke({
        width: Math.max(0.5, RING_WIDTH_PX * (1 - phase)) * perPx,
        color: ECHO_COLOUR,
        alpha: 0.5 * (1 - phase),
      });
  }

  reset(): void {
    if (this.graphics === null) return;
    this.graphics.clear();
    this.graphics.visible = false;
    this.drawn = false;
  }

  destroy(): void {
    if (this.graphics === null) return;
    this.parent?.removeChild(this.graphics);
    this.graphics.destroy();
    this.graphics = null;
    this.parent = null;
  }
}

export function createSelectionLayer(): RenderLayer {
  return new SelectionLayer();
}
