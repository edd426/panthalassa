/**
 * Marine-snow drift is the one piece of the ambience that is pure maths, so it
 * is the one piece that can be pinned. Everything the eye would notice is a
 * property of `driftPos`: that it is a function of (index, time) alone, that the
 * wrap seam is invisible, and that the motes actually fill the tile.
 */

import { describe, expect, it } from 'vitest';
import { driftHash01, driftPos, wrapInto, type DriftPoint, type DriftSpec } from './particulate';

const SPEC: DriftSpec = {
  count: 600,
  tileW: 2000,
  tileH: 1200,
  fallRate: 3.2,
  swayAmp: 9,
  swayRate: 0.22,
  seed: 0,
};

/** Per-mote rate spread inside `driftPos`; the bounds the seam test needs. */
const MAX_FALL = SPEC.fallRate * (0.55 + 0.9);
const MAX_SWAY_RATE = SPEC.swayRate * 1.5;

function at(spec: DriftSpec, index: number, tMs: number): DriftPoint {
  const out: DriftPoint = { x: 0, y: 0 };
  driftPos(spec, index, tMs, out);
  return out;
}

/** Shortest signed difference across a wrapping axis. */
function seamDelta(after: number, before: number, span: number): number {
  let d = after - before;
  if (d > span / 2) d -= span;
  if (d < -span / 2) d += span;
  return d;
}

describe('wrapInto', () => {
  it('returns a non-negative residue for negative input', () => {
    expect(wrapInto(-1, 10)).toBe(9);
    expect(wrapInto(-25, 10)).toBe(5);
    expect(wrapInto(25, 10)).toBe(5);
    expect(wrapInto(0, 10)).toBe(0);
  });
});

describe('driftHash01', () => {
  it('stays in [0, 1) and does not collide over the mote range', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 4000; i += 1) {
      const h = driftHash01(i);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
      seen.add(h);
    }
    expect(seen.size).toBe(4000);
  });
});

describe('driftPos', () => {
  it('is a deterministic function of (index, time)', () => {
    for (const [index, tMs] of [
      [0, 0],
      [7, 1234.5],
      [599, 987_654],
    ] as const) {
      const first = at(SPEC, index, tMs);
      const second = at(SPEC, index, tMs);
      expect(second).toEqual(first);
      // Nothing between the two calls; a hidden clock or RNG would show up here.
      const third = at(SPEC, index, tMs);
      expect(third).toEqual(first);
    }
  });

  it('writes into the caller buffer without allocating a result', () => {
    const out: DriftPoint = { x: -1, y: -1 };
    const returned = driftPos(SPEC, 3, 500, out) as unknown;
    expect(returned).toBeUndefined();
    expect(out.x).not.toBe(-1);
    expect(out.y).not.toBe(-1);
  });

  it('gives distinct motes distinct positions', () => {
    const keys = new Set<string>();
    for (let i = 0; i < SPEC.count; i += 1) {
      const p = at(SPEC, i, 0);
      keys.add(`${p.x.toFixed(4)}:${p.y.toFixed(4)}`);
    }
    expect(keys.size).toBe(SPEC.count);
  });

  it('keeps every mote inside the tile for a long run', () => {
    // Sway amplitude a tenth of the tile: the case where a mote in the leftmost
    // lane is swung past x = 0 and a bare `%` would hand back a negative
    // coordinate. Every index is checked — this is exactly the failure that hides
    // in the handful of motes with the smallest lane hash.
    const stress: DriftSpec = { ...SPEC, tileW: 160, tileH: 120, swayAmp: 16, seed: 41 };
    const point: DriftPoint = { x: 0, y: 0 };
    for (const spec of [SPEC, stress]) {
      for (let i = 0; i < spec.count; i += 1) {
        for (let tMs = 0; tMs <= 600_000; tMs += 977) {
          driftPos(spec, i, tMs, point);
          if (point.x < 0 || point.x >= spec.tileW || point.y < 0 || point.y >= spec.tileH) {
            expect.fail(`mote ${i} at ${tMs}ms left the tile at (${point.x}, ${point.y})`);
          }
        }
      }
    }
  });

  it('crosses the wrap seam without popping', () => {
    const stepMs = 16;
    const boundY = MAX_FALL * (stepMs / 1000) * 1.0001;
    const boundX = SPEC.swayAmp * MAX_SWAY_RATE * (stepMs / 1000) * 1.0001;
    let seamCrossings = 0;
    let worstDy = 0;
    let worstDx = 0;
    let backwards = 0;
    // Accumulate rather than asserting per step: 1.3M assertions is minutes of
    // matcher overhead for the same statement.
    const before: DriftPoint = { x: 0, y: 0 };
    const after: DriftPoint = { x: 0, y: 0 };

    for (let i = 0; i < 24; i += 1) {
      // Long enough that even the slowest mote wraps in y more than once.
      for (let tMs = 0; tMs < 900_000; tMs += stepMs) {
        driftPos(SPEC, i, tMs, before);
        driftPos(SPEC, i, tMs + stepMs, after);
        const dy = seamDelta(after.y, before.y, SPEC.tileH);
        const dx = Math.abs(seamDelta(after.x, before.x, SPEC.tileW));
        if (dy <= 0) backwards += 1;
        if (dy > worstDy) worstDy = dy;
        if (dx > worstDx) worstDx = dx;
        if (after.y < before.y) seamCrossings += 1;
      }
    }

    expect(backwards).toBe(0);
    expect(worstDy).toBeLessThanOrEqual(boundY);
    expect(worstDx).toBeLessThanOrEqual(boundX);
    // The seam is only proven invisible if the run actually went over it.
    expect(seamCrossings).toBeGreaterThan(24);
  });

  it('spreads motes across the whole tile', () => {
    const cols = 10;
    const rows = 6;
    const buckets = new Int32Array(cols * rows);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < SPEC.count; i += 1) {
      const p = at(SPEC, i, 12_345);
      const col = Math.min(cols - 1, Math.floor((p.x / SPEC.tileW) * cols));
      const row = Math.min(rows - 1, Math.floor((p.y / SPEC.tileH) * rows));
      buckets[row * cols + col] = (buckets[row * cols + col] ?? 0) + 1;
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }

    for (let b = 0; b < buckets.length; b += 1) {
      expect(buckets[b] ?? 0).toBeGreaterThan(0);
    }
    expect(minX).toBeLessThan(SPEC.tileW * 0.02);
    expect(maxX).toBeGreaterThan(SPEC.tileW * 0.98);
    expect(minY).toBeLessThan(SPEC.tileH * 0.02);
    expect(maxY).toBeGreaterThan(SPEC.tileH * 0.98);
  });

  it('separates the two fields by seed', () => {
    const near: DriftSpec = { ...SPEC, seed: 977 };
    let identical = 0;
    for (let i = 0; i < SPEC.count; i += 1) {
      const a = at(SPEC, i, 4000);
      const b = at(near, i, 4000);
      if (a.x === b.x && a.y === b.y) identical += 1;
    }
    expect(identical).toBe(0);
  });
});
