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
import type { ColourLegend, Frame, WorldRenderer } from './contracts';

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
