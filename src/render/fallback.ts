/**
 * The crude renderer as a `WorldRenderer` (R1).
 *
 * A machine with no working WebGPU or WebGL context still gets the ocean —
 * dots on a 2D canvas, which is what the whole of Phase A was watched on. The
 * same adapter is what `?renderer=crude` selects, so the pre-Phase-B picture
 * stays reachable for comparing a tuning change against the view it was tuned
 * on.
 *
 * The four Phase B entry points that have no crude equivalent are inert rather
 * than approximated: no camera means no drag, no ghosts means nothing to reset,
 * and narrative events have nowhere to go.
 */

import { CrudeRenderer } from '../app/crudeRenderer';
import type { SimConfig } from '../contracts/types';
import { fitWorld, toWorld as cameraToWorld } from './camera';
import type { ColourLegend, Frame, WorldRenderer } from './contracts';

/**
 * A renderer that draws nothing, for when no drawing surface can be had at all.
 *
 * This exists so that "no graphics" degrades to a running instrument rather
 * than a blank page. Everything outside the renderer — the HUD, the trend
 * charts, the event feed, the worker, `window.panthalassa` — is independent of
 * whether anything is being painted, and all of it keeps working here. The
 * legend says why the water is empty, because a black rectangle with no
 * explanation is indistinguishable from a hung page.
 *
 * `toWorld` still answers correctly: it is the fit-camera mapping, so a click
 * selects the organism it would have selected, and the inspector panel works
 * even though there is nothing on screen to aim at.
 */
export function createNullRenderer(config: SimConfig): WorldRenderer {
  const world = config.world;
  const legend: ColourLegend = {
    mode: 'identity',
    description: 'renderer unavailable — the sim is running but nothing is being drawn',
    stops: [],
  };
  const camera = (): ReturnType<typeof fitWorld> =>
    fitWorld(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight), world.widthWu, world.heightWu);

  return {
    draw(): void {},
    resize(): void {},
    toWorld(clientX: number, clientY: number): { x: number; y: number } {
      return cameraToWorld(camera(), clientX, clientY);
    },
    get pixelsPerWu(): number {
      return camera().pxPerWu;
    },
    get colourLegend(): ColourLegend {
      return legend;
    },
    pushEvents(): void {},
    reset(): void {},
    isDragClick(): boolean {
      return false;
    },
    destroy(): void {},
  };
}

export function createCrudeFallback(canvas: HTMLCanvasElement, config: SimConfig): WorldRenderer {
  const crude = new CrudeRenderer(canvas, config);
  return {
    draw(frame: Frame): void {
      crude.draw(frame);
    },
    resize(): void {
      crude.resize();
    },
    toWorld(clientX: number, clientY: number): { x: number; y: number } {
      return crude.toWorld(clientX, clientY);
    },
    get pixelsPerWu(): number {
      return crude.pixelsPerWu;
    },
    get colourLegend(): ColourLegend {
      return crude.colourLegend;
    },
    pushEvents(): void {
      // No flourishes on the crude path.
    },
    reset(): void {
      // Nothing survives a frame here, so a new world needs no clearing.
    },
    isDragClick(): boolean {
      return false;
    },
    destroy(): void {
      // The 2D context is owned by the canvas; nothing to release.
    },
  };
}
