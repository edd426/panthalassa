/**
 * Camera math (R1). Pure: no Pixi, no DOM, so every zoom/pan invariant is
 * testable under node.
 *
 * Screen space is CSS pixels with the origin at the canvas top-left; world
 * space is world units with the origin at the sea's top-left corner. The fit
 * camera reproduces the crude renderer's letterbox exactly — uniform scale,
 * centred — because `toWorld` has to keep selecting the organism the dots
 * renderer would have selected under the same click.
 */

import type { CameraState } from './contracts';

/**
 * Zoom ceiling, CSS px per world unit. A 12 cm fish is ~8 wu long, so 20 px/wu
 * puts a single animal across 160 px — past that the spine chain has no more
 * detail to give and the ocean stops reading as an ocean.
 */
export const MAX_PX_PER_WU = 20;

/** How far past the world rect the viewport may wander, as a fraction of the world span. */
export const EDGE_MARGIN_FRACTION = 0.1;

export interface WorldRect {
  readonly widthWu: number;
  readonly heightWu: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** The crude renderer's letterbox scale: uniform, whole world visible. */
export function fitScale(viewportW: number, viewportH: number, worldW: number, worldH: number): number {
  const w = Math.max(1, viewportW);
  const h = Math.max(1, viewportH);
  return Math.min(w / Math.max(1e-6, worldW), h / Math.max(1e-6, worldH));
}

export function fitWorld(viewportW: number, viewportH: number, worldW: number, worldH: number): CameraState {
  return {
    centerX: worldW / 2,
    centerY: worldH / 2,
    pxPerWu: fitScale(viewportW, viewportH, worldW, worldH),
    viewportW: Math.max(1, viewportW),
    viewportH: Math.max(1, viewportH),
  };
}

/**
 * Legal zoom window at this viewport. The floor is the fit scale: zooming out
 * past "the whole sea" would letterbox twice and shrink the world into a
 * postage stamp. `Math.max` guards the degenerate case of a world so small
 * that fitting it already exceeds the ceiling.
 */
export function zoomRange(state: CameraState, world: WorldRect): { low: number; high: number } {
  const low = fitScale(state.viewportW, state.viewportH, world.widthWu, world.heightWu);
  return { low, high: Math.max(low, MAX_PX_PER_WU) };
}

function clampCenter(center: number, halfSpanWu: number, worldSpanWu: number): number {
  const margin = worldSpanWu * EDGE_MARGIN_FRACTION;
  const low = halfSpanWu - margin;
  const high = worldSpanWu + margin - halfSpanWu;
  // Viewport wider than the world plus both margins: nothing to slide, centre it.
  if (low >= high) return worldSpanWu / 2;
  return clamp(center, low, high);
}

/** Pull the viewport back inside the world rect + margin, and the zoom inside its range. */
export function clampCamera(state: CameraState, world: WorldRect): CameraState {
  const range = zoomRange(state, world);
  const pxPerWu = clamp(state.pxPerWu, range.low, range.high);
  const centerX = clampCenter(state.centerX, state.viewportW / (2 * pxPerWu), world.widthWu);
  const centerY = clampCenter(state.centerY, state.viewportH / (2 * pxPerWu), world.heightWu);
  if (pxPerWu === state.pxPerWu && centerX === state.centerX && centerY === state.centerY) return state;
  return { centerX, centerY, pxPerWu, viewportW: state.viewportW, viewportH: state.viewportH };
}

export function toWorld(state: CameraState, screenX: number, screenY: number, out?: Vec2): Vec2 {
  const x = state.centerX + (screenX - state.viewportW / 2) / state.pxPerWu;
  const y = state.centerY + (screenY - state.viewportH / 2) / state.pxPerWu;
  if (out === undefined) return { x, y };
  out.x = x;
  out.y = y;
  return out;
}

export function toScreen(state: CameraState, worldX: number, worldY: number, out?: Vec2): Vec2 {
  const x = state.viewportW / 2 + (worldX - state.centerX) * state.pxPerWu;
  const y = state.viewportH / 2 + (worldY - state.centerY) * state.pxPerWu;
  if (out === undefined) return { x, y };
  out.x = x;
  out.y = y;
  return out;
}

/**
 * Zoom by `factor` about a screen point, keeping the world point under the
 * cursor pinned. Clamping the result can break the pin at the world edge; that
 * is the correct trade — the alternative is the sea sliding out of frame.
 */
export function zoomAt(
  state: CameraState,
  cursorX: number,
  cursorY: number,
  factor: number,
  world: WorldRect,
): CameraState {
  const range = zoomRange(state, world);
  const pxPerWu = clamp(state.pxPerWu * factor, range.low, range.high);
  if (pxPerWu === state.pxPerWu) return state;

  const offsetX = cursorX - state.viewportW / 2;
  const offsetY = cursorY - state.viewportH / 2;
  const worldX = state.centerX + offsetX / state.pxPerWu;
  const worldY = state.centerY + offsetY / state.pxPerWu;
  return clampCamera(
    {
      centerX: worldX - offsetX / pxPerWu,
      centerY: worldY - offsetY / pxPerWu,
      pxPerWu,
      viewportW: state.viewportW,
      viewportH: state.viewportH,
    },
    world,
  );
}

/** Drag the world by a screen-pixel delta (the world follows the pointer). */
export function pan(state: CameraState, deltaXPx: number, deltaYPx: number, world: WorldRect): CameraState {
  if (deltaXPx === 0 && deltaYPx === 0) return state;
  return clampCamera(
    {
      centerX: state.centerX - deltaXPx / state.pxPerWu,
      centerY: state.centerY - deltaYPx / state.pxPerWu,
      pxPerWu: state.pxPerWu,
      viewportW: state.viewportW,
      viewportH: state.viewportH,
    },
    world,
  );
}

/**
 * Re-fit after a resize. The zoom is carried across in px/wu — the sea keeps
 * the size it had on screen — but a window that grew past the fit scale pulls
 * it back down to the new floor.
 */
export function withViewport(
  state: CameraState,
  viewportW: number,
  viewportH: number,
  world: WorldRect,
): CameraState {
  return clampCamera(
    {
      centerX: state.centerX,
      centerY: state.centerY,
      pxPerWu: state.pxPerWu,
      viewportW: Math.max(1, viewportW),
      viewportH: Math.max(1, viewportH),
    },
    world,
  );
}

export interface WorldTransform {
  x: number;
  y: number;
  scale: number;
}

/**
 * The position/scale to put on the world-space container parent so that its
 * children, drawn in world units, land exactly where {@link toScreen} says.
 *
 * This lives here rather than inline in the shell because it is the one place
 * the camera crosses from arithmetic into the scene graph, and it is the piece
 * that cannot be checked by looking at the screen — a world container that is
 * subtly mistransformed and one that is not drawing at all look identical.
 * `camera.test.ts` pins it against `toScreen` so the two can never drift.
 */
export function worldTransform(camera: CameraState, out?: WorldTransform): WorldTransform {
  const x = camera.viewportW / 2 - camera.centerX * camera.pxPerWu;
  const y = camera.viewportH / 2 - camera.centerY * camera.pxPerWu;
  if (out === undefined) return { x, y, scale: camera.pxPerWu };
  out.x = x;
  out.y = y;
  out.scale = camera.pxPerWu;
  return out;
}

/** True when the camera is already showing the whole world, centred. */
export function isFitted(state: CameraState, world: WorldRect): boolean {
  const fit = fitScale(state.viewportW, state.viewportH, world.widthWu, world.heightWu);
  return (
    Math.abs(state.pxPerWu - fit) < 1e-6 &&
    Math.abs(state.centerX - world.widthWu / 2) < 1e-6 &&
    Math.abs(state.centerY - world.heightWu / 2) < 1e-6
  );
}
