import { describe, expect, it } from 'vitest';
import { SAMPLE_SLICE, SAMPLE_SLICE_STRIDE } from '../contracts/protocol';
import { POSE, POSE_STRIDE, VISUAL, VISUAL_STRIDE } from './contracts';
import type { CameraState, CreatureFrame, SliceView } from './contracts';
import {
  CONTINUITY_DIST_WU,
  GHOST_FADE_MS,
  Interpolator,
  SPAWN_FADE_MS,
  shortestArc,
  slotJitter,
  wrapAngle,
} from './interpolation';

interface Row {
  slot: number;
  x: number;
  y: number;
  size?: number;
  species?: number;
  hue?: number;
  archetype?: number;
  energy?: number;
}

const CAMERA: CameraState = { centerX: 1000, centerY: 600, pxPerWu: 0.65, viewportW: 1440, viewportH: 780 };

function makeSlice(rows: readonly Row[]): SliceView {
  const buffer = new Float32Array(rows.length * SAMPLE_SLICE_STRIDE);
  rows.forEach((row, index) => {
    const base = index * SAMPLE_SLICE_STRIDE;
    buffer[base + SAMPLE_SLICE.slot] = row.slot;
    buffer[base + SAMPLE_SLICE.x] = row.x;
    buffer[base + SAMPLE_SLICE.y] = row.y;
    buffer[base + SAMPLE_SLICE.hue] = row.hue ?? 200;
    buffer[base + SAMPLE_SLICE.size] = row.size ?? 12;
    buffer[base + SAMPLE_SLICE.speciesTag] = row.species ?? 1;
    buffer[base + SAMPLE_SLICE.cladeId] = 1;
    buffer[base + SAMPLE_SLICE.archetype] = row.archetype ?? 0;
    buffer[base + SAMPLE_SLICE.energyFraction] = row.energy ?? 0.8;
    buffer[base + SAMPLE_SLICE.segmentCount] = 8;
    buffer[base + SAMPLE_SLICE.finPairs] = 2;
    buffer[base + SAMPLE_SLICE.bodyAspect] = 3.2;
    buffer[base + SAMPLE_SLICE.armorPlating] = 0.35;
  });
  return { count: rows.length, buffer };
}

function feed(interpolator: Interpolator, rows: readonly Row[], nowMs: number): boolean {
  const tints = new Uint32Array(rows.length).fill(0x336699);
  const alphas = new Float32Array(rows.length).fill(1);
  return interpolator.ingest(makeSlice(rows), nowMs, tints, alphas);
}

function poseOf(frame: CreatureFrame, row: number, channel: number): number {
  return frame.poses[row * POSE_STRIDE + channel] ?? 0;
}

/** The frame row a slot ended up on: live rows keep the order the slice listed them in. */
function rowOfSlot(sliceOrder: readonly number[], slot: number): number {
  return sliceOrder.indexOf(slot);
}

describe('angle helpers', () => {
  it('takes the short way across ±π', () => {
    expect(shortestArc(3.0, -3.0)).toBeCloseTo(2 * Math.PI - 6, 9);
    expect(shortestArc(-3.0, 3.0)).toBeCloseTo(6 - 2 * Math.PI, 9);
    expect(shortestArc(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2, 9);
    expect(Math.abs(shortestArc(0.1, 0.1 + Math.PI * 4))).toBeLessThan(1e-9);
  });

  it('wraps into (−π, π]', () => {
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 9);
    expect(wrapAngle(-Math.PI * 3)).toBeCloseTo(Math.PI, 9);
  });

  it('gives every slot a stable jitter in [0,1)', () => {
    for (let slot = 0; slot < 64; slot += 1) {
      const value = slotJitter(slot);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      expect(slotJitter(slot)).toBe(value);
    }
    expect(slotJitter(3)).not.toBe(slotJitter(4));
  });
});

describe('slot matching and interpolation', () => {
  it('lerps a matched slot to the midpoint', () => {
    const interpolator = new Interpolator();
    feed(interpolator, [{ slot: 5, x: 100, y: 300 }], 0);
    feed(interpolator, [{ slot: 5, x: 140, y: 340 }], 100);

    // The render clock trails by one slice interval, so t = 0.5 lands at 150 ms.
    const frame = interpolator.sample(150, CAMERA);
    expect(poseOf(frame, 0, POSE.x)).toBeCloseTo(120, 4);
    expect(poseOf(frame, 0, POSE.y)).toBeCloseTo(320, 4);

    const start = interpolator.sample(100, CAMERA);
    expect(poseOf(start, 0, POSE.x)).toBeCloseTo(100, 4);
    const end = interpolator.sample(200, CAMERA);
    expect(poseOf(end, 0, POSE.x)).toBeCloseTo(140, 4);
  });

  it('never extrapolates past the newest slice', () => {
    const interpolator = new Interpolator();
    feed(interpolator, [{ slot: 5, x: 100, y: 300 }], 0);
    feed(interpolator, [{ slot: 5, x: 140, y: 300 }], 100);
    const late = interpolator.sample(5000, CAMERA);
    expect(poseOf(late, 0, POSE.x)).toBeCloseTo(140, 4);
  });

  it('matches by slot, not by row order', () => {
    const interpolator = new Interpolator();
    feed(
      interpolator,
      [
        { slot: 5, x: 100, y: 300 },
        { slot: 9, x: 500, y: 500 },
      ],
      0,
    );
    feed(
      interpolator,
      [
        { slot: 9, x: 520, y: 500 },
        { slot: 5, x: 120, y: 300 },
      ],
      100,
    );

    const frame = interpolator.sample(150, CAMERA);
    const slots = [9, 5];
    expect(poseOf(frame, rowOfSlot(slots, 9), POSE.x)).toBeCloseTo(510, 4);
    expect(poseOf(frame, rowOfSlot(slots, 5), POSE.x)).toBeCloseTo(110, 4);
  });

  it('reports observed speed in wu per second', () => {
    const interpolator = new Interpolator();
    feed(interpolator, [{ slot: 5, x: 100, y: 300 }], 0);
    feed(interpolator, [{ slot: 5, x: 110, y: 300 }], 100);
    const frame = interpolator.sample(150, CAMERA);
    expect(poseOf(frame, 0, POSE.speed)).toBeCloseTo(100, 3);
  });

  it('treats a repeated sim tick as the same world, whatever the buffer says', () => {
    const interpolator = new Interpolator();
    const tints = new Uint32Array(1).fill(0x336699);
    const alphas = new Float32Array(1).fill(1);
    const at = (x: number, tick: number): SliceView => ({ ...makeSlice([{ slot: 5, x, y: 300 }]), tick });

    expect(interpolator.ingest(at(100, 10), 0, tints, alphas)).toBe(true);
    expect(interpolator.ingest(at(140, 11), 100, tints, alphas)).toBe(true);
    // Same tick: the world has not advanced, so this is not new data even
    // though the positions differ — trusting the buffer here would restart the
    // interpolation window on every frame of a paused world.
    expect(interpolator.ingest(at(900, 11), 200, tints, alphas)).toBe(false);
    expect(poseOf(interpolator.sample(200, CAMERA), 0, POSE.x)).toBeCloseTo(140, 4);
    // A new tick is new data again.
    expect(interpolator.ingest(at(180, 12), 200, tints, alphas)).toBe(true);
  });

  it('ignores a repeated slice while the sim is paused', () => {
    const interpolator = new Interpolator();
    feed(interpolator, [{ slot: 5, x: 100, y: 300 }], 0);
    feed(interpolator, [{ slot: 5, x: 140, y: 300 }], 100);
    expect(feed(interpolator, [{ slot: 5, x: 140, y: 300 }], 200)).toBe(false);
    expect(feed(interpolator, [{ slot: 5, x: 140, y: 300 }], 300)).toBe(false);

    // The window is still the 0→100 one, so the pose holds at the last position
    // instead of restarting the lerp from a standstill every frame.
    expect(poseOf(interpolator.sample(400, CAMERA), 0, POSE.x)).toBeCloseTo(140, 4);
    expect(interpolator.sliceGeneration).toBe(2);
  });
});

describe('slot reuse and ghosts', () => {
  it('fades a reused slot in where it is instead of lerping across the world', () => {
    const interpolator = new Interpolator();
    feed(interpolator, [{ slot: 5, x: 100, y: 300 }], 0);
    feed(interpolator, [{ slot: 5, x: 100 + CONTINUITY_DIST_WU + 1, y: 300 }], 100);

    const frame = interpolator.sample(150, CAMERA);
    expect(poseOf(frame, 0, POSE.x)).toBeCloseTo(161, 4);
    expect(poseOf(frame, 0, POSE.fade)).toBeCloseTo(50 / SPAWN_FADE_MS, 4);
    expect(poseOf(interpolator.sample(100, CAMERA), 0, POSE.fade)).toBe(0);
    expect(poseOf(interpolator.sample(100 + SPAWN_FADE_MS, CAMERA), 0, POSE.fade)).toBe(1);
  });

  it('breaks continuity on a species change and on a large size jump', () => {
    const species = new Interpolator();
    feed(species, [{ slot: 5, x: 100, y: 300, species: 1 }], 0);
    feed(species, [{ slot: 5, x: 110, y: 300, species: 2 }], 100);
    expect(poseOf(species.sample(150, CAMERA), 0, POSE.x)).toBeCloseTo(110, 4);

    const size = new Interpolator();
    feed(size, [{ slot: 5, x: 100, y: 300, size: 10 }], 0);
    feed(size, [{ slot: 5, x: 110, y: 300, size: 14 }], 100);
    expect(poseOf(size.sample(150, CAMERA), 0, POSE.x)).toBeCloseTo(110, 4);

    // Growth inside the tolerance is still the same animal.
    const growing = new Interpolator();
    feed(growing, [{ slot: 5, x: 100, y: 300, size: 10 }], 0);
    feed(growing, [{ slot: 5, x: 110, y: 300, size: 12 }], 100);
    expect(poseOf(growing.sample(150, CAMERA), 0, POSE.x)).toBeCloseTo(105, 4);
  });

  it('leaves a fading ghost where a slot vanished, and expires it', () => {
    const interpolator = new Interpolator();
    feed(
      interpolator,
      [
        { slot: 5, x: 100, y: 300 },
        { slot: 9, x: 500, y: 500 },
      ],
      0,
    );
    feed(interpolator, [{ slot: 9, x: 510, y: 500 }], 100);

    const frame = interpolator.sample(150, CAMERA);
    expect(frame.count).toBe(2);
    expect(poseOf(frame, 1, POSE.x)).toBeCloseTo(100, 4);
    expect(poseOf(frame, 1, POSE.fade)).toBeCloseTo(1 - 50 / GHOST_FADE_MS, 4);

    expect(interpolator.sample(100 + GHOST_FADE_MS, CAMERA).count).toBe(1);
  });

  it('ghosts the previous occupant of a reused slot', () => {
    const interpolator = new Interpolator();
    feed(interpolator, [{ slot: 5, x: 100, y: 300 }], 0);
    feed(interpolator, [{ slot: 5, x: 1500, y: 900 }], 100);
    const frame = interpolator.sample(120, CAMERA);
    expect(frame.count).toBe(2);
    expect(poseOf(frame, 1, POSE.x)).toBeCloseTo(100, 4);
  });

  it('drops every ghost and every slot on reset', () => {
    const interpolator = new Interpolator();
    feed(interpolator, [{ slot: 5, x: 100, y: 300 }], 0);
    feed(interpolator, [{ slot: 9, x: 500, y: 500 }], 100);
    interpolator.reset();
    const frame = interpolator.sample(150, CAMERA);
    expect(frame.count).toBe(0);
    expect(frame.visibleCount).toBe(0);
    expect(interpolator.sliceGeneration).toBe(0);
  });
});

describe('heading', () => {
  it('smooths across the ±π seam without swinging through zero', () => {
    const interpolator = new Interpolator();
    feed(interpolator, [{ slot: 5, x: 1000, y: 600 }], 0);
    feed(interpolator, [{ slot: 5, x: 990, y: 600.1 }], 100);
    const first = poseOf(interpolator.sample(200, CAMERA), 0, POSE.heading);
    expect(Math.abs(first)).toBeGreaterThan(3.1);

    feed(interpolator, [{ slot: 5, x: 980, y: 599.9 }], 200);
    const second = poseOf(interpolator.sample(300, CAMERA), 0, POSE.heading);
    expect(Math.abs(second)).toBeGreaterThan(3.1);
    expect(Math.abs(shortestArc(first, second))).toBeLessThan(0.05);
  });

  it('holds the last heading while the animal is barely moving', () => {
    const interpolator = new Interpolator();
    feed(interpolator, [{ slot: 5, x: 1000, y: 600 }], 0);
    feed(interpolator, [{ slot: 5, x: 1040, y: 600 }], 100);
    const moving = poseOf(interpolator.sample(200, CAMERA), 0, POSE.heading);
    expect(moving).toBeCloseTo(0, 6);

    feed(interpolator, [{ slot: 5, x: 1040, y: 600.001 }], 200);
    expect(poseOf(interpolator.sample(300, CAMERA), 0, POSE.heading)).toBeCloseTo(moving, 6);
  });
});

describe('visibility', () => {
  it('culls to the padded viewport and sorts what is left by size', () => {
    const interpolator = new Interpolator();
    feed(
      interpolator,
      [
        { slot: 1, x: 1000, y: 600, size: 30 },
        { slot: 2, x: 1100, y: 600, size: 8 },
        { slot: 3, x: 900, y: 600, size: 19 },
        { slot: 4, x: 9000, y: 600, size: 25 },
      ],
      0,
    );
    const frame = interpolator.sample(0, CAMERA);
    expect(frame.visibleCount).toBe(3);
    const sizes = Array.from({ length: frame.visibleCount }, (_unused, index) => {
      const row = frame.visible[index] ?? 0;
      return frame.visuals[row * VISUAL_STRIDE + VISUAL.sizeCm] ?? 0;
    });
    expect(sizes).toEqual([8, 19, 30]);
  });

  it('merges ghosts into the size order rather than appending them', () => {
    const interpolator = new Interpolator();
    feed(
      interpolator,
      [
        { slot: 1, x: 1000, y: 600, size: 30 },
        { slot: 2, x: 1010, y: 600, size: 5 },
      ],
      0,
    );
    feed(interpolator, [{ slot: 1, x: 1005, y: 600, size: 30 }], 100);
    const frame = interpolator.sample(120, CAMERA);
    const sizes = Array.from({ length: frame.visibleCount }, (_unused, index) => {
      const row = frame.visible[index] ?? 0;
      return frame.visuals[row * VISUAL_STRIDE + VISUAL.sizeCm] ?? 0;
    });
    expect(sizes).toEqual([5, 30]);
  });

  it('tracks the median body length for the LOD governor', () => {
    const interpolator = new Interpolator();
    feed(
      interpolator,
      [
        { slot: 1, x: 1000, y: 600, size: 4 },
        { slot: 2, x: 1010, y: 600, size: 40 },
        { slot: 3, x: 1020, y: 600, size: 12 },
      ],
      0,
    );
    expect(interpolator.medianSizeCm).toBe(12);
  });
});
