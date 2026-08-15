import { describe, expect, it } from 'vitest';
import {
  EDGE_MARGIN_FRACTION,
  MAX_PX_PER_WU,
  clampCamera,
  fitScale,
  fitWorld,
  isFitted,
  pan,
  toScreen,
  toWorld,
  withViewport,
  worldTransform,
  zoomAt,
} from './camera';
import type { WorldRect } from './camera';
import type { CameraState } from './contracts';

const WORLD: WorldRect = { widthWu: 2000, heightWu: 1200 };
const VIEW_W = 1440;
const VIEW_H = 780;

/** The crude renderer's own letterbox arithmetic, reproduced here as the oracle. */
function crudeLetterbox(viewportW: number, viewportH: number, world: WorldRect) {
  const scale = Math.min(viewportW / world.widthWu, viewportH / world.heightWu);
  return {
    scale,
    offsetX: (viewportW - world.widthWu * scale) / 2,
    offsetY: (viewportH - world.heightWu * scale) / 2,
  };
}

function zoomedIn(): CameraState {
  return { centerX: 1000, centerY: 600, pxPerWu: 4, viewportW: VIEW_W, viewportH: VIEW_H };
}

describe('fitWorld', () => {
  it('reproduces the crude letterbox exactly', () => {
    const camera = fitWorld(VIEW_W, VIEW_H, WORLD.widthWu, WORLD.heightWu);
    const crude = crudeLetterbox(VIEW_W, VIEW_H, WORLD);

    expect(camera.pxPerWu).toBeCloseTo(crude.scale, 12);
    for (const [wx, wy] of [
      [0, 0],
      [WORLD.widthWu, WORLD.heightWu],
      [640, 210],
      [1999, 1],
    ] as const) {
      const screen = toScreen(camera, wx, wy);
      expect(screen.x).toBeCloseTo(crude.offsetX + wx * crude.scale, 9);
      expect(screen.y).toBeCloseTo(crude.offsetY + wy * crude.scale, 9);
    }
  });

  it('inverts the crude toWorld for a click anywhere on the canvas', () => {
    const camera = fitWorld(VIEW_W, VIEW_H, WORLD.widthWu, WORLD.heightWu);
    const crude = crudeLetterbox(VIEW_W, VIEW_H, WORLD);
    for (const [sx, sy] of [
      [0, 0],
      [VIEW_W, VIEW_H],
      [733, 401],
    ] as const) {
      const world = toWorld(camera, sx, sy);
      expect(world.x).toBeCloseTo((sx - crude.offsetX) / crude.scale, 9);
      expect(world.y).toBeCloseTo((sy - crude.offsetY) / crude.scale, 9);
    }
  });

  it('is reported as fitted', () => {
    expect(isFitted(fitWorld(VIEW_W, VIEW_H, WORLD.widthWu, WORLD.heightWu), WORLD)).toBe(true);
    expect(isFitted(zoomedIn(), WORLD)).toBe(false);
  });
});

describe('worldTransform', () => {
  /**
   * The scene-graph half of the camera. A world container carrying this
   * position/scale must put its children exactly where `toScreen` says, at
   * every zoom and pan — this is the invariant that a screenshot cannot check,
   * because a world drawn in the wrong place and a world not drawn at all look
   * the same.
   */
  it('reproduces toScreen for any camera and any world point', () => {
    const cameras: CameraState[] = [
      fitWorld(VIEW_W, VIEW_H, WORLD.widthWu, WORLD.heightWu),
      fitWorld(800, 1400, WORLD.widthWu, WORLD.heightWu),
      zoomedIn(),
      { centerX: 120, centerY: 1100, pxPerWu: 12.5, viewportW: 2560, viewportH: 1329 },
    ];
    for (const camera of cameras) {
      const transform = worldTransform(camera);
      expect(transform.scale).toBe(camera.pxPerWu);
      for (const [wx, wy] of [
        [0, 0],
        [WORLD.widthWu, WORLD.heightWu],
        [1000, 600],
        [-350, 2400],
      ] as const) {
        const expected = toScreen(camera, wx, wy);
        expect(transform.x + wx * transform.scale).toBeCloseTo(expected.x, 9);
        expect(transform.y + wy * transform.scale).toBeCloseTo(expected.y, 9);
      }
    }
  });

  it('puts the world centre at the viewport centre when fitted', () => {
    const camera = fitWorld(VIEW_W, VIEW_H, WORLD.widthWu, WORLD.heightWu);
    const transform = worldTransform(camera);
    expect(transform.x + (WORLD.widthWu / 2) * transform.scale).toBeCloseTo(VIEW_W / 2, 9);
    expect(transform.y + (WORLD.heightWu / 2) * transform.scale).toBeCloseTo(VIEW_H / 2, 9);
  });

  it('keeps the whole world on screen when fitted, so nothing can drift off', () => {
    const camera = fitWorld(VIEW_W, VIEW_H, WORLD.widthWu, WORLD.heightWu);
    const t = worldTransform(camera);
    expect(t.x).toBeGreaterThanOrEqual(-1e-6);
    expect(t.y).toBeGreaterThanOrEqual(-1e-6);
    expect(t.x + WORLD.widthWu * t.scale).toBeLessThanOrEqual(VIEW_W + 1e-6);
    expect(t.y + WORLD.heightWu * t.scale).toBeLessThanOrEqual(VIEW_H + 1e-6);
  });

  it('fills an out-parameter without allocating', () => {
    const out = { x: 0, y: 0, scale: 0 };
    expect(worldTransform(zoomedIn(), out)).toBe(out);
    expect(out.scale).toBe(4);
  });

  /**
   * A viewport disagreement between the camera and the projection is what put
   * the world off-screen in the integrated build. Half a viewport of drift is
   * enough to push a fitted world's centre outside the frame entirely.
   */
  it('shows how far a stale viewport moves the world', () => {
    const real = fitWorld(1440, 722, WORLD.widthWu, WORLD.heightWu);
    const stale: CameraState = { ...real, viewportW: 1440, viewportH: 1200 };
    const drift = worldTransform(stale).y - worldTransform(real).y;
    expect(drift).toBeCloseTo((1200 - 722) / 2, 9);
  });
});

describe('toWorld / toScreen', () => {
  it('are inverses at any zoom', () => {
    for (const pxPerWu of [0.3, 1, 4, 19.5]) {
      const camera: CameraState = { centerX: 812, centerY: 355, pxPerWu, viewportW: VIEW_W, viewportH: VIEW_H };
      for (const [sx, sy] of [
        [0, 0],
        [VIEW_W, VIEW_H],
        [123.5, 456.25],
      ] as const) {
        const world = toWorld(camera, sx, sy);
        const screen = toScreen(camera, world.x, world.y);
        expect(screen.x).toBeCloseTo(sx, 9);
        expect(screen.y).toBeCloseTo(sy, 9);
      }
    }
  });

  it('fills an out-parameter without allocating a fresh object', () => {
    const camera = zoomedIn();
    const out = { x: 0, y: 0 };
    expect(toWorld(camera, 10, 20, out)).toBe(out);
    expect(out.x).toBeCloseTo(camera.centerX + (10 - VIEW_W / 2) / camera.pxPerWu, 9);
  });
});

describe('zoomAt', () => {
  it('keeps the world point under the cursor fixed', () => {
    const before = zoomedIn();
    for (const cursor of [
      [200, 120],
      [VIEW_W / 2, VIEW_H / 2],
      [1300, 700],
    ] as const) {
      const anchor = toWorld(before, cursor[0], cursor[1]);
      const after = zoomAt(before, cursor[0], cursor[1], 1.4, WORLD);
      expect(after.pxPerWu).toBeCloseTo(before.pxPerWu * 1.4, 9);
      const screen = toScreen(after, anchor.x, anchor.y);
      expect(screen.x).toBeCloseTo(cursor[0], 6);
      expect(screen.y).toBeCloseTo(cursor[1], 6);
    }
  });

  it('clamps zoom-out at the fit scale and zoom-in at the ceiling', () => {
    const fit = fitScale(VIEW_W, VIEW_H, WORLD.widthWu, WORLD.heightWu);
    let camera = zoomedIn();
    for (let i = 0; i < 40; i += 1) camera = zoomAt(camera, 700, 400, 0.8, WORLD);
    expect(camera.pxPerWu).toBeCloseTo(fit, 9);

    camera = zoomedIn();
    for (let i = 0; i < 40; i += 1) camera = zoomAt(camera, 700, 400, 1.3, WORLD);
    expect(camera.pxPerWu).toBeCloseTo(MAX_PX_PER_WU, 9);
  });

  it('returns the same object when the zoom is already clamped', () => {
    const fitted = fitWorld(VIEW_W, VIEW_H, WORLD.widthWu, WORLD.heightWu);
    expect(zoomAt(fitted, 10, 10, 0.5, WORLD)).toBe(fitted);
  });

  it('lands back on the fit view after a zoom in and out round trip', () => {
    const fitted = fitWorld(VIEW_W, VIEW_H, WORLD.widthWu, WORLD.heightWu);
    const zoomed = zoomAt(fitted, 400, 300, 3, WORLD);
    const back = zoomAt(zoomed, 400, 300, 1 / 3, WORLD);
    expect(back.pxPerWu).toBeCloseTo(fitted.pxPerWu, 9);
  });
});

describe('pan and clamping', () => {
  it('never lets the viewport leave the world rect plus its margin', () => {
    const marginX = WORLD.widthWu * EDGE_MARGIN_FRACTION;
    let camera = zoomedIn();
    for (let i = 0; i < 50; i += 1) camera = pan(camera, -400, -400, WORLD);
    const halfW = camera.viewportW / (2 * camera.pxPerWu);
    const halfH = camera.viewportH / (2 * camera.pxPerWu);
    expect(camera.centerX + halfW).toBeLessThanOrEqual(WORLD.widthWu + marginX + 1e-6);
    expect(camera.centerY + halfH).toBeLessThanOrEqual(
      WORLD.heightWu + WORLD.heightWu * EDGE_MARGIN_FRACTION + 1e-6,
    );

    camera = zoomedIn();
    for (let i = 0; i < 50; i += 1) camera = pan(camera, 400, 400, WORLD);
    expect(camera.centerX - halfW).toBeGreaterThanOrEqual(-marginX - 1e-6);
    expect(camera.centerY - halfH).toBeGreaterThanOrEqual(-WORLD.heightWu * EDGE_MARGIN_FRACTION - 1e-6);
  });

  it('stops both axes at the padded world edge, however hard it is dragged', () => {
    const fitted = fitWorld(VIEW_W, VIEW_H, WORLD.widthWu, WORLD.heightWu);
    const panned = pan(fitted, 5000, 5000, WORLD);
    const halfW = panned.viewportW / (2 * panned.pxPerWu);
    const halfH = panned.viewportH / (2 * panned.pxPerWu);
    // At fit scale the tight axis (y here) has exactly the margin to give, and
    // the letterboxed one has whatever the letterbox left over.
    expect(panned.centerX - halfW).toBeCloseTo(-WORLD.widthWu * EDGE_MARGIN_FRACTION, 6);
    expect(panned.centerY - halfH).toBeCloseTo(-WORLD.heightWu * EDGE_MARGIN_FRACTION, 6);
  });

  it('centres an axis it cannot slide at all', () => {
    // A viewport far wider than the world plus both margins: nothing to pan to.
    const wide: CameraState = { centerX: 0, centerY: 600, pxPerWu: 0.2, viewportW: 4000, viewportH: 240 };
    expect(clampCamera(wide, WORLD).centerX).toBeCloseTo(WORLD.widthWu / 2, 9);
  });

  it('moves the world with the pointer', () => {
    const before = zoomedIn();
    const after = pan(before, 40, 0, WORLD);
    expect(after.centerX).toBeCloseTo(before.centerX - 40 / before.pxPerWu, 9);
  });

  it('pulls an out-of-range camera back on clamp', () => {
    const rogue: CameraState = { centerX: 9e4, centerY: -9e4, pxPerWu: 500, viewportW: VIEW_W, viewportH: VIEW_H };
    const clamped = clampCamera(rogue, WORLD);
    expect(clamped.pxPerWu).toBe(MAX_PX_PER_WU);
    expect(clamped.centerX).toBeLessThanOrEqual(WORLD.widthWu * (1 + EDGE_MARGIN_FRACTION));
    expect(clamped.centerY).toBeGreaterThanOrEqual(-WORLD.heightWu * EDGE_MARGIN_FRACTION);
  });

  it('drops the zoom to the new floor when the window grows', () => {
    const small = fitWorld(400, 300, WORLD.widthWu, WORLD.heightWu);
    const grown = withViewport(small, 3000, 2000, WORLD);
    expect(grown.pxPerWu).toBeCloseTo(fitScale(3000, 2000, WORLD.widthWu, WORLD.heightWu), 9);
  });
});
