/**
 * Slice interpolation (R1). Pure: no Pixi, no DOM.
 *
 * Sample slices arrive asynchronously from the worker and carry *slots*, not
 * ids — and a slot is reused the tick after its occupant dies. Lerping blindly
 * between two slices would therefore teleport a newborn across the ocean along
 * the path of whatever died in its slot. Everything here exists to keep that
 * from happening: a slot only lerps when the two rows plausibly describe the
 * same animal (it did not jump, it kept its species tag, it did not change size
 * by a third), and a slot that fails the test is a birth — the newcomer fades
 * in where it is, and the previous occupant is kept for a moment as a ghost so
 * a death is something the eye can catch.
 *
 * Rendering is deliberately one slice-interval behind the clock so poses are
 * always *between* two known states. Extrapolating ahead is what makes fish
 * overshoot and snap back the instant the network hiccups.
 *
 * The renderer holds no reference to the slice buffer past `ingest`: the main
 * thread hands old buffers back to the worker for reuse, so every retained
 * value is copied out here.
 */

import { SAMPLE_SLICE, SAMPLE_SLICE_STRIDE } from '../contracts/protocol';
import { MAX_SLOTS, POSE, POSE_STRIDE, VISUAL, VISUAL_STRIDE, resolveMorphology } from './contracts';
import type { CameraState, CreatureFrame, MorphologyValues, SliceView } from './contracts';

/** Birth ramp. Long enough to read as an arrival, short enough not to look like lag. */
export const SPAWN_FADE_MS = 250;

/** Death ghost lifetime. */
export const GHOST_FADE_MS = 200;

export const MAX_GHOSTS = 256;

/** Beyond this a slot's two rows are different animals, not one that moved. */
export const CONTINUITY_DIST_WU = 60;

/** Fractional size change that still counts as the same animal growing. */
export const CONTINUITY_SIZE_FRACTION = 0.3;

/** Heading smoothing per slice. Fish turn visibly but never twitch. */
export const HEADING_EMA_ALPHA = 0.25;

/** Below this observed speed the heading is held: a drifting animal has no facing. */
export const HEADING_SPEED_FLOOR_WU_S = 0.5;

/** Fraction of the viewport half-span added on each side of the cull rect. */
export const VIEWPORT_PAD_FRACTION = 0.1;

const INTERVAL_EMA_ALPHA = 0.2;
const MIN_INTERVAL_MS = 8;
const MAX_INTERVAL_MS = 500;

const TWO_PI = Math.PI * 2;

/** Signed shortest rotation from `from` to `to`, in (−π, π]. */
export function shortestArc(from: number, to: number): number {
  let delta = (to - from) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta < -Math.PI) delta += TWO_PI;
  return delta;
}

export function wrapAngle(angle: number): number {
  let wrapped = angle % TWO_PI;
  if (wrapped > Math.PI) wrapped -= TWO_PI;
  if (wrapped <= -Math.PI) wrapped += TWO_PI;
  return wrapped;
}

/**
 * Stable per-slot uniform in [0,1). A hash rather than a draw so the same slot
 * gets the same phase offset on every machine and across a reseed — animation
 * variety that is reproducible is worth more than variety that is random.
 */
export function slotJitter(slot: number): number {
  let h = (slot + 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

interface Snapshot {
  count: number;
  atMs: number;
  slots: Int32Array;
  px: Float32Array;
  py: Float32Array;
  speed: Float32Array;
  visuals: Float32Array;
  tints: Uint32Array;
  alphas: Float32Array;
  /** Row order by ascending sizeCm; sorted once per slice, not once per frame. */
  order: Uint16Array;
  /** Matching row in the previous snapshot, or −1 when this row is a birth. */
  fromRow: Int32Array;
}

function createSnapshot(): Snapshot {
  return {
    count: 0,
    atMs: 0,
    slots: new Int32Array(MAX_SLOTS),
    px: new Float32Array(MAX_SLOTS),
    py: new Float32Array(MAX_SLOTS),
    speed: new Float32Array(MAX_SLOTS),
    visuals: new Float32Array(MAX_SLOTS * VISUAL_STRIDE),
    tints: new Uint32Array(MAX_SLOTS),
    alphas: new Float32Array(MAX_SLOTS),
    order: new Uint16Array(MAX_SLOTS),
    fromRow: new Int32Array(MAX_SLOTS),
  };
}

/** `CreatureFrame` before the seam's readonly lid goes on; pooled, never reallocated. */
interface MutableCreatureFrame {
  count: number;
  poses: Float32Array;
  visuals: Float32Array;
  tints: Uint32Array;
  alphas: Float32Array;
  visible: Uint16Array;
  visibleCount: number;
}

function sizeOfRow(visuals: Float32Array, row: number): number {
  return visuals[row * VISUAL_STRIDE + VISUAL.sizeCm] ?? 0;
}

/**
 * In-place sort of `order[0..count)` by ascending body length. Iterative with
 * an explicit stack and an insertion-sort tail: this runs once per slice on up
 * to 4096 rows and must not allocate.
 */
function sortRowsBySize(order: Uint16Array, count: number, visuals: Float32Array, stack: Int32Array): void {
  if (count < 2) return;
  let top = 0;
  stack[top] = 0;
  stack[top + 1] = count - 1;
  top += 2;

  while (top > 0) {
    top -= 2;
    const low = stack[top] ?? 0;
    const high = stack[top + 1] ?? 0;

    if (high - low < 12) {
      for (let i = low + 1; i <= high; i += 1) {
        const row = order[i] ?? 0;
        const key = sizeOfRow(visuals, row);
        let j = i - 1;
        while (j >= low && sizeOfRow(visuals, order[j] ?? 0) > key) {
          order[j + 1] = order[j] ?? 0;
          j -= 1;
        }
        order[j + 1] = row;
      }
      continue;
    }

    const pivot = sizeOfRow(visuals, order[(low + high) >> 1] ?? 0);
    let i = low;
    let j = high;
    while (i <= j) {
      while (sizeOfRow(visuals, order[i] ?? 0) < pivot) i += 1;
      while (sizeOfRow(visuals, order[j] ?? 0) > pivot) j -= 1;
      if (i <= j) {
        const swap = order[i] ?? 0;
        order[i] = order[j] ?? 0;
        order[j] = swap;
        i += 1;
        j -= 1;
      }
    }
    // Larger partition pushed first so the shallower one is processed next and
    // the stack stays logarithmic.
    const leftSize = j - low;
    const rightSize = high - i;
    if (leftSize >= rightSize) {
      if (low < j) {
        stack[top] = low;
        stack[top + 1] = j;
        top += 2;
      }
      if (i < high) {
        stack[top] = i;
        stack[top + 1] = high;
        top += 2;
      }
    } else {
      if (i < high) {
        stack[top] = i;
        stack[top + 1] = high;
        top += 2;
      }
      if (low < j) {
        stack[top] = low;
        stack[top + 1] = j;
        top += 2;
      }
    }
  }
}

export class Interpolator {
  private curr = createSnapshot();
  private prev = createSnapshot();
  private rowOfSlotCurr = new Int32Array(MAX_SLOTS).fill(-1);
  private rowOfSlotPrev = new Int32Array(MAX_SLOTS).fill(-1);

  private readonly spawnAtMs = new Float64Array(MAX_SLOTS);
  private readonly heading = new Float32Array(MAX_SLOTS);
  private readonly headingValid = new Uint8Array(MAX_SLOTS);

  private ghostCount = 0;
  private readonly ghostPose = new Float32Array(MAX_GHOSTS * POSE_STRIDE);
  private readonly ghostVisual = new Float32Array(MAX_GHOSTS * VISUAL_STRIDE);
  private readonly ghostTint = new Uint32Array(MAX_GHOSTS);
  private readonly ghostAlpha = new Float32Array(MAX_GHOSTS);
  private readonly ghostDiedAtMs = new Float64Array(MAX_GHOSTS);

  private readonly frame: MutableCreatureFrame = {
    count: 0,
    poses: new Float32Array((MAX_SLOTS + MAX_GHOSTS) * POSE_STRIDE),
    visuals: new Float32Array((MAX_SLOTS + MAX_GHOSTS) * VISUAL_STRIDE),
    tints: new Uint32Array(MAX_SLOTS + MAX_GHOSTS),
    alphas: new Float32Array(MAX_SLOTS + MAX_GHOSTS),
    visible: new Uint16Array(MAX_SLOTS + MAX_GHOSTS),
    visibleCount: 0,
  };

  private readonly ghostVisible = new Uint16Array(MAX_GHOSTS);
  private readonly sortStack = new Int32Array(128);
  private readonly morphReal: MorphologyValues = { segments: 0, finPairs: 0, bodyAspect: 1, armor: 0 };
  private readonly morphOut: MorphologyValues = { segments: 0, finPairs: 0, bodyAspect: 1, armor: 0 };

  private sliceCount = 0;
  private intervalEmaMs = 0;
  private medianSize = 0;
  /** Sim tick of the held slice, when the slice carried one. */
  private currTick: number | undefined = undefined;

  /** Slices seen so far; below 2 there is nothing to interpolate between. */
  get sliceGeneration(): number {
    return this.sliceCount;
  }

  /** Smoothed gap between slices, ms. The render clock lags the wall clock by this. */
  get intervalMs(): number {
    return this.intervalEmaMs;
  }

  get lastSliceAtMs(): number {
    return this.curr.atMs;
  }

  /** Median body length of the living, cm — the LOD's "is there anything to see" input. */
  get medianSizeCm(): number {
    return this.medianSize;
  }

  reset(): void {
    this.curr.count = 0;
    this.prev.count = 0;
    this.curr.atMs = 0;
    this.prev.atMs = 0;
    this.rowOfSlotCurr.fill(-1);
    this.rowOfSlotPrev.fill(-1);
    this.headingValid.fill(0);
    this.ghostCount = 0;
    this.sliceCount = 0;
    this.intervalEmaMs = 0;
    this.medianSize = 0;
    this.currTick = undefined;
    this.frame.count = 0;
    this.frame.visibleCount = 0;
  }

  /**
   * Take a slice, with its already-resolved per-row tints and alphas (the
   * colour map runs once per slice, never per frame). Returns false for a
   * repeat of the slice already held — while the sim is paused the worker keeps
   * answering with an identical world, and treating that as new data would
   * restart the interpolation window every frame and freeze every animal
   * mid-stroke.
   */
  ingest(slice: SliceView, nowMs: number, tints: Uint32Array, alphas: Float32Array): boolean {
    const data = slice.buffer;
    const count = Math.max(0, Math.min(MAX_SLOTS, slice.count, Math.floor(data.length / SAMPLE_SLICE_STRIDE)));
    // The tick is authoritative when the slice carries one: the same tick is
    // the same world, whatever the buffer contents happen to compare as.
    const tick = slice.tick;
    if (tick !== undefined && this.sliceCount > 0 && tick === this.currTick) return false;
    if (tick === undefined && this.isRepeat(data, count)) return false;

    const prev = this.curr;
    const next = this.prev;
    this.prev = prev;
    this.curr = next;

    const rowOfSlotPrev = this.rowOfSlotCurr;
    const rowOfSlotNext = this.rowOfSlotPrev;
    this.rowOfSlotPrev = rowOfSlotPrev;
    this.rowOfSlotCurr = rowOfSlotNext;
    rowOfSlotNext.fill(-1);

    next.count = count;
    next.atMs = nowMs;
    this.currTick = tick;

    const hadPrev = this.sliceCount > 0;
    const dtSeconds = hadPrev ? Math.max(1e-3, (nowMs - prev.atMs) / 1000) : 0;

    for (let i = 0; i < count; i += 1) {
      const base = i * SAMPLE_SLICE_STRIDE;
      const rawSlot = Math.round(data[base + SAMPLE_SLICE.slot] ?? 0);
      const slot = rawSlot >= 0 && rawSlot < MAX_SLOTS ? rawSlot : 0;
      const x = data[base + SAMPLE_SLICE.x] ?? 0;
      const y = data[base + SAMPLE_SLICE.y] ?? 0;
      const size = data[base + SAMPLE_SLICE.size] ?? 0;
      const species = data[base + SAMPLE_SLICE.speciesTag] ?? 0;
      const archetype = data[base + SAMPLE_SLICE.archetype] ?? 0;

      next.slots[i] = slot;
      next.px[i] = x;
      next.py[i] = y;
      next.order[i] = i;
      next.tints[i] = tints[i] ?? 0xffffff;
      next.alphas[i] = alphas[i] ?? 1;

      this.morphReal.segments = data[base + SAMPLE_SLICE.segmentCount] ?? 0;
      this.morphReal.finPairs = data[base + SAMPLE_SLICE.finPairs] ?? 0;
      this.morphReal.bodyAspect = data[base + SAMPLE_SLICE.bodyAspect] ?? 1;
      this.morphReal.armor = data[base + SAMPLE_SLICE.armorPlating] ?? 0;
      resolveMorphology(archetype, slotJitter(slot), this.morphReal, this.morphOut);

      const v = i * VISUAL_STRIDE;
      next.visuals[v + VISUAL.archetype] = archetype;
      next.visuals[v + VISUAL.sizeCm] = size;
      next.visuals[v + VISUAL.hueDeg] = data[base + SAMPLE_SLICE.hue] ?? 0;
      next.visuals[v + VISUAL.segments] = this.morphOut.segments;
      next.visuals[v + VISUAL.finPairs] = this.morphOut.finPairs;
      next.visuals[v + VISUAL.bodyAspect] = this.morphOut.bodyAspect;
      next.visuals[v + VISUAL.armor] = this.morphOut.armor;
      next.visuals[v + VISUAL.speciesTag] = species;
      next.visuals[v + VISUAL.diet] = data[base + SAMPLE_SLICE.diet] ?? 0;
      next.visuals[v + VISUAL.defense] = data[base + SAMPLE_SLICE.defense] ?? 0;

      rowOfSlotNext[slot] = i;

      const candidate = hadPrev ? (rowOfSlotPrev[slot] ?? -1) : -1;
      let from = -1;
      if (candidate >= 0 && candidate < prev.count) {
        const dx = x - (prev.px[candidate] ?? 0);
        const dy = y - (prev.py[candidate] ?? 0);
        const prevBase = candidate * VISUAL_STRIDE;
        const prevSize = prev.visuals[prevBase + VISUAL.sizeCm] ?? 0;
        const prevSpecies = prev.visuals[prevBase + VISUAL.speciesTag] ?? 0;
        const sizeOk = Math.abs(size - prevSize) <= CONTINUITY_SIZE_FRACTION * Math.max(1e-6, prevSize);
        if (Math.hypot(dx, dy) < CONTINUITY_DIST_WU && prevSpecies === species && sizeOk) from = candidate;
      }
      next.fromRow[i] = from;

      let speed = 0;
      if (from >= 0) {
        const dx = x - (prev.px[from] ?? 0);
        const dy = y - (prev.py[from] ?? 0);
        speed = Math.hypot(dx, dy) / dtSeconds;
        if (speed > HEADING_SPEED_FLOOR_WU_S) {
          const target = Math.atan2(dy, dx);
          if (this.headingValid[slot] === 0) {
            this.heading[slot] = target;
            this.headingValid[slot] = 1;
          } else {
            const held = this.heading[slot] ?? 0;
            this.heading[slot] = wrapAngle(held + HEADING_EMA_ALPHA * shortestArc(held, target));
          }
        }
      } else {
        this.spawnAtMs[slot] = nowMs;
        this.headingValid[slot] = 0;
        this.heading[slot] = 0;
      }
      next.speed[i] = speed;
    }

    this.expireGhosts(nowMs);
    for (let j = 0; j < prev.count; j += 1) {
      const slot = prev.slots[j] ?? 0;
      const currRow = rowOfSlotNext[slot] ?? -1;
      // A slot present in both but discontinuous is a reuse: the previous
      // occupant died even though the slot never went empty.
      if (currRow >= 0 && next.fromRow[currRow] === j) continue;
      this.addGhost(prev, j, nowMs);
    }

    if (hadPrev) {
      const gap = nowMs - prev.atMs;
      if (gap > 0) {
        this.intervalEmaMs =
          this.intervalEmaMs <= 0 ? gap : this.intervalEmaMs * (1 - INTERVAL_EMA_ALPHA) + gap * INTERVAL_EMA_ALPHA;
        this.intervalEmaMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, this.intervalEmaMs));
      }
    }

    sortRowsBySize(next.order, count, next.visuals, this.sortStack);
    this.medianSize = count === 0 ? 0 : sizeOfRow(next.visuals, next.order[count >> 1] ?? 0);
    this.sliceCount += 1;
    return true;
  }

  /**
   * Recolour the held slice in place. The colour mode can change without the
   * world moving — pressing `c` on a paused ocean — and the tints live in the
   * snapshot, so without this the view would keep the old ramp until something
   * finally moved.
   */
  restain(tints: Uint32Array, alphas: Float32Array): void {
    const curr = this.curr;
    for (let i = 0; i < curr.count; i += 1) {
      curr.tints[i] = tints[i] ?? 0xffffff;
      curr.alphas[i] = alphas[i] ?? 1;
    }
  }

  /**
   * Pose every creature at `nowMs − intervalEma`, cull to the padded viewport
   * and return the pooled frame. Fills poses, visuals, tints, alphas and the
   * size-sorted visible list.
   */
  sample(nowMs: number, camera: CameraState): CreatureFrame {
    const curr = this.curr;
    const prev = this.prev;
    const frame = this.frame;

    const span = curr.atMs - prev.atMs;
    const t = this.sliceCount >= 2 && span > 0 ? clamp01((nowMs - this.intervalEmaMs - prev.atMs) / span) : 1;

    for (let i = 0; i < curr.count; i += 1) {
      const slot = curr.slots[i] ?? 0;
      const from = curr.fromRow[i] ?? -1;
      const cx = curr.px[i] ?? 0;
      const cy = curr.py[i] ?? 0;
      const p = i * POSE_STRIDE;
      if (from >= 0) {
        const ax = prev.px[from] ?? cx;
        const ay = prev.py[from] ?? cy;
        frame.poses[p + POSE.x] = ax + (cx - ax) * t;
        frame.poses[p + POSE.y] = ay + (cy - ay) * t;
      } else {
        frame.poses[p + POSE.x] = cx;
        frame.poses[p + POSE.y] = cy;
      }
      frame.poses[p + POSE.heading] = this.heading[slot] ?? 0;
      frame.poses[p + POSE.speed] = curr.speed[i] ?? 0;
      frame.poses[p + POSE.fade] = clamp01((nowMs - (this.spawnAtMs[slot] ?? 0)) / SPAWN_FADE_MS);
      frame.poses[p + POSE.jitter] = slotJitter(slot);

      const source = i * VISUAL_STRIDE;
      for (let k = 0; k < VISUAL_STRIDE; k += 1) frame.visuals[source + k] = curr.visuals[source + k] ?? 0;
      frame.tints[i] = curr.tints[i] ?? 0xffffff;
      frame.alphas[i] = curr.alphas[i] ?? 1;
    }

    let rows = curr.count;
    for (let g = 0; g < this.ghostCount; g += 1) {
      const fade = 1 - (nowMs - (this.ghostDiedAtMs[g] ?? 0)) / GHOST_FADE_MS;
      if (fade <= 0) continue;
      const source = g * POSE_STRIDE;
      const target = rows * POSE_STRIDE;
      for (let k = 0; k < POSE_STRIDE; k += 1) frame.poses[target + k] = this.ghostPose[source + k] ?? 0;
      frame.poses[target + POSE.fade] = fade > 1 ? 1 : fade;
      const visualSource = g * VISUAL_STRIDE;
      const visualTarget = rows * VISUAL_STRIDE;
      for (let k = 0; k < VISUAL_STRIDE; k += 1) frame.visuals[visualTarget + k] = this.ghostVisual[visualSource + k] ?? 0;
      frame.tints[rows] = this.ghostTint[g] ?? 0xffffff;
      frame.alphas[rows] = this.ghostAlpha[g] ?? 1;
      rows += 1;
    }
    frame.count = rows;

    this.cull(frame, curr, rows, camera);
    return frame;
  }

  private cull(frame: MutableCreatureFrame, curr: Snapshot, rows: number, camera: CameraState): void {
    const halfW = (camera.viewportW / (2 * camera.pxPerWu)) * (1 + VIEWPORT_PAD_FRACTION);
    const halfH = (camera.viewportH / (2 * camera.pxPerWu)) * (1 + VIEWPORT_PAD_FRACTION);
    const minX = camera.centerX - halfW;
    const maxX = camera.centerX + halfW;
    const minY = camera.centerY - halfH;
    const maxY = camera.centerY + halfH;

    // `order` is already ascending by size, so walking it yields a sorted list
    // for free — no per-frame sort.
    let live = 0;
    for (let k = 0; k < curr.count; k += 1) {
      const row = curr.order[k] ?? 0;
      const p = row * POSE_STRIDE;
      const x = frame.poses[p + POSE.x] ?? 0;
      const y = frame.poses[p + POSE.y] ?? 0;
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      frame.visible[live] = row;
      live += 1;
    }

    let ghosts = 0;
    for (let row = curr.count; row < rows; row += 1) {
      const p = row * POSE_STRIDE;
      const x = frame.poses[p + POSE.x] ?? 0;
      const y = frame.poses[p + POSE.y] ?? 0;
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      const key = sizeOfRow(frame.visuals, row);
      let j = ghosts - 1;
      while (j >= 0 && sizeOfRow(frame.visuals, this.ghostVisible[j] ?? 0) > key) {
        this.ghostVisible[j + 1] = this.ghostVisible[j] ?? 0;
        j -= 1;
      }
      this.ghostVisible[j + 1] = row;
      ghosts += 1;
    }

    // Backwards merge of the two sorted runs, in place: the live run already
    // occupies the head of `visible`.
    let a = live - 1;
    let b = ghosts - 1;
    let write = live + ghosts - 1;
    while (b >= 0) {
      const ghostRow = this.ghostVisible[b] ?? 0;
      const liveRow = a >= 0 ? (frame.visible[a] ?? 0) : 0;
      if (a >= 0 && sizeOfRow(frame.visuals, liveRow) > sizeOfRow(frame.visuals, ghostRow)) {
        frame.visible[write] = liveRow;
        a -= 1;
      } else {
        frame.visible[write] = ghostRow;
        b -= 1;
      }
      write -= 1;
    }
    frame.visibleCount = live + ghosts;
  }

  private isRepeat(data: Float32Array, count: number): boolean {
    const curr = this.curr;
    if (this.sliceCount === 0 || curr.count !== count) return false;
    for (let i = 0; i < count; i += 1) {
      const base = i * SAMPLE_SLICE_STRIDE;
      if (Math.round(data[base + SAMPLE_SLICE.slot] ?? 0) !== curr.slots[i]) return false;
      if ((data[base + SAMPLE_SLICE.x] ?? 0) !== curr.px[i]) return false;
      if ((data[base + SAMPLE_SLICE.y] ?? 0) !== curr.py[i]) return false;
    }
    return true;
  }

  private expireGhosts(nowMs: number): void {
    let kept = 0;
    for (let g = 0; g < this.ghostCount; g += 1) {
      if (nowMs - (this.ghostDiedAtMs[g] ?? 0) >= GHOST_FADE_MS) continue;
      if (kept !== g) this.copyGhost(g, kept);
      kept += 1;
    }
    this.ghostCount = kept;
  }

  private copyGhost(from: number, to: number): void {
    const fromPose = from * POSE_STRIDE;
    const toPose = to * POSE_STRIDE;
    for (let k = 0; k < POSE_STRIDE; k += 1) this.ghostPose[toPose + k] = this.ghostPose[fromPose + k] ?? 0;
    const fromVisual = from * VISUAL_STRIDE;
    const toVisual = to * VISUAL_STRIDE;
    for (let k = 0; k < VISUAL_STRIDE; k += 1) this.ghostVisual[toVisual + k] = this.ghostVisual[fromVisual + k] ?? 0;
    this.ghostTint[to] = this.ghostTint[from] ?? 0xffffff;
    this.ghostAlpha[to] = this.ghostAlpha[from] ?? 1;
    this.ghostDiedAtMs[to] = this.ghostDiedAtMs[from] ?? 0;
  }

  private addGhost(snapshot: Snapshot, row: number, nowMs: number): void {
    // Capped rather than grown: a mass extinction should cost a fixed budget of
    // fading bodies, not a frame spike on the worst frame of the run.
    if (this.ghostCount >= MAX_GHOSTS) return;
    const g = this.ghostCount;
    const slot = snapshot.slots[row] ?? 0;
    const p = g * POSE_STRIDE;
    this.ghostPose[p + POSE.x] = snapshot.px[row] ?? 0;
    this.ghostPose[p + POSE.y] = snapshot.py[row] ?? 0;
    this.ghostPose[p + POSE.heading] = this.heading[slot] ?? 0;
    this.ghostPose[p + POSE.speed] = snapshot.speed[row] ?? 0;
    this.ghostPose[p + POSE.fade] = 1;
    this.ghostPose[p + POSE.jitter] = slotJitter(slot);
    const source = row * VISUAL_STRIDE;
    const target = g * VISUAL_STRIDE;
    for (let k = 0; k < VISUAL_STRIDE; k += 1) this.ghostVisual[target + k] = snapshot.visuals[source + k] ?? 0;
    this.ghostTint[g] = snapshot.tints[row] ?? 0xffffff;
    this.ghostAlpha[g] = snapshot.alphas[row] ?? 1;
    this.ghostDiedAtMs[g] = nowMs;
    this.ghostCount = g + 1;
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
