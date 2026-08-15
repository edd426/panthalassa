/**
 * The creature `RenderLayer` — four LOD tiers of the same animals.
 *
 * All four tier containers live permanently under `slots.creatures`; the LOD
 * state picks which is visible, and a tier change cross-fades by rendering into
 * both for the duration of the blend. Every tier draws the same population from
 * the same `bodies.ts` geometry, so an animal does not change identity as it
 * falls back — only how much of it survives the pixel budget:
 *
 * | tier  | mechanism |
 * |-------|-----------|
 * | near  | pooled `Graphics`, rebuilt every frame, over an additive glow sprite |
 * | mid   | pooled `Sprite`s flipping a 4-phase baked flipbook per archetype |
 * | far   | one `ParticleContainer` per archetype over a baked silhouette |
 * | abyss | one `ParticleContainer` over the radial glow |
 *
 * Two rules run through all of it. **Animation phase is wall-clock**, never sim
 * ticks, so bodies swim at believable rates while the sim runs at 256×; the
 * clock is accumulated locally so that pausing actually stops the animals.
 * **The selected animal is always a near-tier body**, promoted out of whatever
 * tier it would otherwise land in, because the inspected animal has to be the
 * drawn animal.
 */

import type { Container } from 'pixi.js';
import { Container as PixiContainer } from 'pixi.js';
import type {
  CreatureFrame,
  CreatureVisual,
  FrameContext,
  LodTier,
  MountContext,
  RenderLayer,
} from '../contracts';
import {
  CM_TO_WU,
  LOD_TIERS,
  MAX_SLOTS,
  POSE,
  POSE_STRIDE,
  VISUAL,
  VISUAL_STRIDE,
  archetypeFromIndex,
  readCreatureVisual,
} from '../contracts';
import type { CladeArchetype } from '../../contracts/genome';
import { CLADE_ARCHETYPES, CLADE_SCHEMA } from '../../contracts/genome';
import type { BodyGeometry, BodyParams } from './bodies';
import {
  ARCHETYPE_FREQUENCY_SCALE,
  buildBody,
  clampBodyAspect,
  createBodyGeometry,
  nearVertexCount,
} from './bodies';
import { GraphicsPool, ParticlePool, SpritePool } from './pool';
import type { BodyStyle, ShapeTextures } from './shapeTextures';
import {
  BAKED_ANCHOR_X,
  BAKED_ANCHOR_Y,
  FLIPBOOK_PHASES,
  bakeShapeTextures,
  fallbackShapeTextures,
  drawBody,
  speciesAccentColour,
} from './shapeTextures';
import { bellPulsePhase, swimFrequencyHz, wavePhase } from './spine';

/**
 * Near-tier drawing budget for one frame, in emitted points.
 *
 * **This is the knob to turn if the governor is demoting.** It is a cost budget
 * rather than a body count because body cost spans 18× across the morphology
 * space (see `nearVertexCount`): a minimal undulator emits 6 points, a maximal
 * crawler 369. A flat body cap sized for crawlers starves a fish-heavy world,
 * and one sized for fish blows the frame the moment crawlers take over — and
 * which of those a world becomes is decided by evolution, not by the camera. A
 * budget keeps the frame cost roughly flat and lets the *number* of full bodies
 * float, which is the variable that should give.
 *
 * Calibrated from a CPU-side measurement of ≈0.41 µs per emitted point plus
 * ≈6.5 µs fixed per body, against a ~7 ms target. 7 rather than the 11 ms
 * demote threshold because 7 is the governor's *promote* gate: a tier that
 * stays under it never enters the demote/re-promote machinery at all.
 *
 * ## What this budget does not cover
 *
 * It meters CPU-side path emission only. The other half of a frame is blended
 * fill, which no budget here touches, and at the near tier the additive glow
 * underlay dominates it — of 3.34 M blended pixels at 4 px/wu with 900 animals
 * visible, 3.05 M is glow, against 0.74 M for far and 0.13 M for abyss.
 *
 * **Those are CSS pixels.** The GPU resolves `resolution²` device samples for
 * each one, where `resolution` is `min(devicePixelRatio, MAX_RESOLUTION)` in
 * `renderer.ts` — so on a retina display the near figure is currently ~2.25×
 * what is written above, and it was 4× before that constant came down from 2.
 * Anyone comparing this table against another layer's must check which of the
 * two units that layer quoted; mixing them silently overstates one side by
 * severalfold. Note also that these assume the whole population visible at
 * every zoom, which viewport culling makes increasingly pessimistic as you zoom
 * in — the far and abyss rows are the trustworthy ones.
 *
 * So there are two knobs and they fix different symptoms:
 *
 * - frame time scaling with **population** → CPU-bound → this budget
 * - frame time scaling with **zoom** at fixed population → fill-bound →
 *   try `MAX_RESOLUTION` in `renderer.ts` first, which cuts every blended
 *   sample in the app at once and costs no design decision; only then
 *   {@link GLOW_SPAN} and {@link GLOW_ALPHA}, which cost look rather than
 *   animals
 *
 * The alarm that says this budget has a hole is `rememberedCost.near > 0` on
 * `__panthalassaRender` (R1's governor only records that after near actually
 * overran 11 ms in the wild), or a tier sitting below what the LOD criteria
 * call for. Prefer that signal to watching frame rate.
 */
const NEAR_VERTEX_BUDGET = 17_000;

/** Per-body overhead in the same currency: ≈6.5 µs of setup at ≈0.41 µs/point. */
const BODY_FIXED_COST = 16;

/** Hard ceiling on pooled `Graphics` however cheap the bodies get. */
const NEAR_BODY_CAP = 250;
/**
 * Glow underlay diameter, in body lengths. Deliberately *not* clamped in screen
 * pixels the way the abyss dot is: this is a halo on a body the viewer can
 * see, so it has to scale with the body, and pinning it to pixels would make it
 * shrink relative to the animal as you zoom in. It is the layer's largest fill
 * cost — see the budget note above before reaching for it.
 */
const GLOW_SPAN = 1.9;
const GLOW_ALPHA = 0.32;
/** Abyssal glow dot diameter, in body lengths. See {@link ABYSS_MAX_PX}. */
const ABYSS_SPAN = 1.8;
/** How close a visible animal must be to the inspector's pick to count as it. */
const SELECT_RADIUS_WU = 10;
/** Drifters drift: their heading is smoothed far harder than a swimmer's. */
const DRIFTER_HEADING_TAU_MS = 900;
/** Screen-space floors, so a far or abyssal animal never shrinks below a mark. */
const FAR_MIN_PX = 3;
const ABYSS_MIN_PX = 2.5;

/**
 * Screen-space ceiling on an abyssal glow dot, and the constant that keeps the
 * cheapest tier actually cheapest.
 *
 * Abyss draws `ABYSS_SPAN` body lengths of *additive* quad for every visible
 * animal with no per-body budget in front of it, so without a ceiling it bills
 * ~11× the far tier — the fallback tier costing more than what it falls back
 * from, which defeats the point of having it and leaves a load-demoted governor
 * nothing to recover to.
 *
 * **Both bounds have to be checked against the far tier, at both ends of the
 * zoom range.** A first attempt at 2.4 span / 12 px fixed the zoomed-in case
 * and left the inversion intact at fit-all (0.72 px/wu, the default view and
 * the lowest the camera clamp allows), where the ceiling stops binding for
 * small animals and `ABYSS_MIN_PX` starts binding instead: abyss measured 1.81×
 * far there. These values keep the ratio at 0.66 or below across the whole
 * reachable range of 0.72–20 px/wu, verified in `creatureLayer.test.ts`.
 *
 * A dot is what the tier is meant to be anyway: at this range the eye reads a
 * field of motes rather than comparing body sizes, so clamping the big end
 * costs no information. The mark lives in 2.5–7 px.
 */
export const ABYSS_MAX_PX = 7;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const DRIFTER_INDEX = CLADE_ARCHETYPES.indexOf('radialDrifter');

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

class CreatureLayer implements RenderLayer {
  readonly name = 'creatures';

  private textures: ShapeTextures | null = null;

  private readonly tierRoots = {} as Record<LodTier, Container>;
  private readonly tierHolds = { near: false, mid: false, far: false, abyss: false };

  private nearGlow: SpritePool | null = null;
  private nearBodies: GraphicsPool | null = null;
  /** Graceful degradation for anything the near budget could not afford. */
  private nearOverflow: SpritePool | null = null;
  private midSprites: SpritePool | null = null;
  private readonly farPools = {} as Record<CladeArchetype, ParticlePool>;
  private abyssPool: ParticlePool | null = null;

  private selectionRoot: Container | null = null;
  private selectionGlow: SpritePool | null = null;
  private selectionBody: GraphicsPool | null = null;

  private readonly geometry: BodyGeometry = createBodyGeometry();
  private readonly visual: CreatureVisual = {
    archetype: 'undulator',
    sizeCm: 0,
    hueDeg: 0,
    segmentCount: 0,
    finPairs: 0,
    bodyAspect: 1,
    armorPlating: 0,
    tint: 0xffffff,
    alpha: 1,
    jitter: 0,
    heading: 0,
    speed: 0,
    fade: 1,
  };
  private readonly bodyParams: Mutable<BodyParams> = {
    archetype: 'undulator',
    segmentCount: 8,
    finPairs: 2,
    bodyAspect: 3.2,
    armorPlating: 0.35,
    phase: 0,
    pulsePhase: 0,
    amplitudeScale: 1,
  };
  private readonly style: Mutable<BodyStyle> = { tint: 0xffffff, alpha: 1, rimTint: -1 };

  /** Heading per slot, resolved once per frame so a cross-fade cannot double-integrate. */
  private readonly headingCache = new Float32Array(MAX_SLOTS);
  private readonly headingSeen = new Uint8Array(MAX_SLOTS);

  /**
   * Wall-clock animation time. Accumulated rather than read straight off
   * `nowMs` so that `paused` freezes the bodies — otherwise an animal thrashes
   * while the watcher is trying to read it.
   */
  private animationMs = 0;
  /**
   * This frame's animation delta — `dtMs`, or 0 while paused. Every easing in
   * the layer runs off this rather than off `dtMs`, so "paused" means every
   * moving part stops, not just the body wave. A drifter still slewing its
   * heading on a frozen world would contradict the HUD.
   */
  private animationDtMs = 0;
  private pxPerWu = 1;

  mount(ctx: MountContext): void {
    // Baking is the one step here that can fail (it is the only one that talks
    // to the GPU), and `layerRegistry` mounts layers in a bare loop — a throw
    // out of here would take the whole render wave's mount with it and leave
    // this layer's containers unattached, which looks exactly like a dead sim.
    // Degrade to flat quads instead and say so.
    try {
      this.textures = bakeShapeTextures(ctx);
    } catch (error) {
      console.warn('[panthalassa] creature texture bake failed; drawing untextured bodies', error);
      this.textures = fallbackShapeTextures();
    }

    for (const tier of LOD_TIERS) {
      const root = new PixiContainer();
      root.visible = false;
      this.tierRoots[tier] = root;
    }

    const nearGlowRoot = new PixiContainer();
    const nearOverflowRoot = new PixiContainer();
    const nearBodyRoot = new PixiContainer();
    this.tierRoots.near.addChild(nearGlowRoot, nearOverflowRoot, nearBodyRoot);
    this.nearGlow = new SpritePool(nearGlowRoot, 'add');
    this.nearOverflow = new SpritePool(nearOverflowRoot);
    this.nearBodies = new GraphicsPool(nearBodyRoot);

    this.midSprites = new SpritePool(this.tierRoots.mid);

    for (const archetype of CLADE_ARCHETYPES) {
      const pool = new ParticlePool(this.textures.silhouettes[archetype], BAKED_ANCHOR_X, BAKED_ANCHOR_Y);
      this.farPools[archetype] = pool;
      this.tierRoots.far.addChild(pool.container);
    }

    this.abyssPool = new ParticlePool(this.textures.glow, 0.5, 0.5, false);
    this.abyssPool.container.blendMode = 'add';
    this.tierRoots.abyss.addChild(this.abyssPool.container);

    const selectionRoot = new PixiContainer();
    const selectionGlowRoot = new PixiContainer();
    const selectionBodyRoot = new PixiContainer();
    selectionRoot.addChild(selectionGlowRoot, selectionBodyRoot);
    this.selectionRoot = selectionRoot;
    this.selectionGlow = new SpritePool(selectionGlowRoot, 'add');
    this.selectionBody = new GraphicsPool(selectionBodyRoot);

    // Back to front: the faintest tiers first, the promoted selection on top.
    ctx.slots.creatures.addChild(
      this.tierRoots.abyss,
      this.tierRoots.far,
      this.tierRoots.mid,
      this.tierRoots.near,
      selectionRoot,
    );
  }

  update(frame: FrameContext): void {
    const textures = this.textures;
    if (textures === null) return;

    this.animationDtMs = frame.paused ? 0 : Math.max(0, frame.dtMs);
    this.animationMs += this.animationDtMs;
    this.pxPerWu = Math.max(1e-6, frame.camera.pxPerWu);

    const creatures = frame.creatures;
    if (creatures === null || creatures.visibleCount === 0) {
      for (const tier of LOD_TIERS) this.releaseTier(tier);
      this.releaseSelection();
      return;
    }

    const incoming = frame.lod.tier;
    const previous = frame.lod.previousTier;
    const blend = clamp01(frame.lod.blend);
    const fading = previous !== null && previous !== incoming && blend < 1;

    for (const tier of LOD_TIERS) {
      const root = this.tierRoots[tier];
      if (tier === incoming) {
        root.visible = true;
        root.alpha = fading ? blend : 1;
      } else if (fading && tier === previous) {
        root.visible = true;
        root.alpha = 1 - blend;
      } else {
        root.visible = false;
      }
    }

    this.resolveHeadings(creatures);
    const selected = this.findSelected(frame, creatures);

    this.renderTier(incoming, frame, creatures, textures);
    if (fading && previous !== null) this.renderTier(previous, frame, creatures, textures);
    for (const tier of LOD_TIERS) {
      if (tier === incoming) continue;
      if (fading && tier === previous) continue;
      this.releaseTier(tier);
    }

    const nearShown = incoming === 'near' || (fading && previous === 'near');
    if (selected >= 0 && !nearShown) {
      this.renderSelection(selected, frame, creatures, textures);
    } else {
      this.releaseSelection();
    }
  }

  reset(): void {
    this.headingSeen.fill(0);
    this.animationMs = 0;
    for (const tier of LOD_TIERS) {
      // Force the release: a reseed must empty every pool, including tiers that
      // were already parked and would otherwise be skipped as clean.
      this.tierHolds[tier] = true;
      this.releaseTier(tier);
    }
    this.releaseSelection();
  }

  destroy(): void {
    this.nearGlow?.destroy();
    this.nearOverflow?.destroy();
    this.nearBodies?.destroy();
    this.midSprites?.destroy();
    this.selectionGlow?.destroy();
    this.selectionBody?.destroy();
    for (const archetype of CLADE_ARCHETYPES) this.farPools[archetype]?.destroy();
    this.abyssPool?.destroy();
    this.textures?.destroy();
    for (const tier of LOD_TIERS) this.tierRoots[tier]?.destroy();
    this.selectionRoot?.destroy();
    this.textures = null;
  }

  // -------------------------------------------------------------------------
  // Per-frame preparation
  // -------------------------------------------------------------------------

  /**
   * Smooth every visible heading once, into a per-slot cache. Slot indices are
   * stable across slices (the pool reuses them), which is what makes the
   * exponential smoothing meaningful; `reset()` drops the cache with the world.
   */
  private resolveHeadings(creatures: CreatureFrame): void {
    const k = 1 - Math.exp(-this.animationDtMs / DRIFTER_HEADING_TAU_MS);
    for (let i = 0; i < creatures.visibleCount; i += 1) {
      const row = creatures.visible[i] ?? 0;
      if (row >= MAX_SLOTS) continue;
      const heading = creatures.poses[row * POSE_STRIDE + POSE.heading] ?? 0;
      const isDrifter = Math.round(creatures.visuals[row * VISUAL_STRIDE + VISUAL.archetype] ?? 0) === DRIFTER_INDEX;
      if (!isDrifter || this.headingSeen[row] !== 1) {
        this.headingCache[row] = heading;
        this.headingSeen[row] = 1;
        continue;
      }
      const previous = this.headingCache[row] ?? heading;
      let delta = heading - previous;
      delta -= 2 * Math.PI * Math.round(delta / (2 * Math.PI));
      this.headingCache[row] = previous + delta * k;
    }
  }

  /** Row index of the inspected animal, or −1. */
  private findSelected(frame: FrameContext, creatures: CreatureFrame): number {
    const target = frame.selected;
    if (target === null) return -1;
    let best = -1;
    let bestDistance = SELECT_RADIUS_WU * SELECT_RADIUS_WU;
    for (let i = 0; i < creatures.visibleCount; i += 1) {
      const row = creatures.visible[i] ?? 0;
      const p = row * POSE_STRIDE;
      const dx = (creatures.poses[p + POSE.x] ?? 0) - target.x;
      const dy = (creatures.poses[p + POSE.y] ?? 0) - target.y;
      const distance = dx * dx + dy * dy;
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = row;
      }
    }
    return best;
  }

  private load(creatures: CreatureFrame, row: number): void {
    readCreatureVisual(creatures, row, this.visual);
    this.style.tint = this.visual.tint;
    this.style.alpha = clamp01(this.visual.alpha * this.visual.fade);
    // Only the tiers that actually stroke a rim pay for resolving one.
    this.style.rimTint = -1;
  }

  /**
   * The species rim accent, for the tiers fine enough to show it.
   * `CreatureVisual` carries no `speciesTag`, so this reads the stride through
   * the seam's own `VISUAL` offsets rather than through a parallel decoder.
   */
  private loadRim(creatures: CreatureFrame, row: number, colourIsIdentity: boolean): void {
    this.style.rimTint = colourIsIdentity
      ? speciesAccentColour(creatures.visuals[row * VISUAL_STRIDE + VISUAL.speciesTag] ?? 0)
      : -1;
  }

  private bodyLengthWu(): number {
    return Math.max(1e-3, this.visual.sizeCm * CM_TO_WU);
  }

  private beatHz(): number {
    return swimFrequencyHz(this.visual.speed) * ARCHETYPE_FREQUENCY_SCALE[this.visual.archetype];
  }

  private buildCurrentBody(): void {
    const visual = this.visual;
    this.bodyParams.archetype = visual.archetype;
    this.bodyParams.segmentCount = visual.segmentCount;
    this.bodyParams.finPairs = visual.finPairs;
    this.bodyParams.bodyAspect = visual.bodyAspect;
    this.bodyParams.armorPlating = visual.armorPlating;
    this.bodyParams.phase = wavePhase(this.animationMs, this.beatHz(), visual.jitter);
    this.bodyParams.pulsePhase = bellPulsePhase(this.animationMs, visual.jitter);
    this.bodyParams.amplitudeScale = 1;
    buildBody(this.bodyParams, this.geometry);
  }

  /**
   * How much to squash a baked sprite across its length. The flipbooks are baked
   * at each archetype's typical `bodyAspect`, so an eel and a stubby fish share
   * a texture; scaling the cross-body axis puts the difference back without a
   * texture per morphology.
   */
  private aspectSquash(): number {
    const archetype = this.visual.archetype;
    const typical = CLADE_SCHEMA[archetype].bodyAspect.typical;
    return typical / clampBodyAspect(archetype, this.visual.bodyAspect);
  }

  // -------------------------------------------------------------------------
  // Tiers
  // -------------------------------------------------------------------------

  private renderTier(tier: LodTier, frame: FrameContext, creatures: CreatureFrame, textures: ShapeTextures): void {
    this.tierHolds[tier] = true;
    switch (tier) {
      case 'near':
        this.renderNear(frame, creatures, textures);
        return;
      case 'mid':
        this.renderMid(creatures, textures);
        return;
      case 'far':
        this.renderFar(creatures);
        return;
      case 'abyss':
        this.renderAbyss(creatures);
        return;
    }
  }

  private releaseTier(tier: LodTier): void {
    const root = this.tierRoots[tier];
    if (root !== undefined) root.visible = false;
    if (!this.tierHolds[tier]) return;
    this.tierHolds[tier] = false;
    switch (tier) {
      case 'near':
        this.nearGlow?.reset();
        this.nearOverflow?.reset();
        this.nearBodies?.reset();
        return;
      case 'mid':
        this.midSprites?.reset();
        return;
      case 'far':
        for (const archetype of CLADE_ARCHETYPES) this.farPools[archetype]?.reset();
        return;
      case 'abyss':
        this.abyssPool?.reset();
        return;
    }
  }

  private releaseSelection(): void {
    if (this.selectionRoot !== null) this.selectionRoot.visible = false;
    this.selectionGlow?.reset();
    this.selectionBody?.reset();
  }

  private renderNear(frame: FrameContext, creatures: CreatureFrame, textures: ShapeTextures): void {
    const glowPool = this.nearGlow;
    const bodyPool = this.nearBodies;
    const overflowPool = this.nearOverflow;
    if (glowPool === null || bodyPool === null || overflowPool === null) return;
    glowPool.begin();
    bodyPool.begin();
    overflowPool.begin();
    const identity = frame.colourMode === 'identity';
    const start = this.nearBudgetStart(creatures);
    for (let i = 0; i < start; i += 1) {
      this.drawFlipbook(creatures.visible[i] ?? 0, creatures, textures, overflowPool);
    }
    for (let i = start; i < creatures.visibleCount; i += 1) {
      this.drawNearBody(creatures.visible[i] ?? 0, creatures, textures, identity, glowPool, bodyPool);
    }
    glowPool.end();
    bodyPool.end();
    overflowPool.end();
  }

  /**
   * First index of `visible` that gets a real body; everything before it falls
   * to the overflow sprites.
   *
   * `visible` is sorted by size ascending, so spending the budget from the tail
   * backwards gives it to the biggest animals — the ones whose bodies are worth
   * the points. What does *not* fit degrades to a mid-tier sprite rather than
   * vanishing: an animal that silently stops being drawn is the worst failure
   * this app has, and it would look exactly like a sim bug.
   */
  private nearBudgetStart(creatures: CreatureFrame): number {
    let budget = NEAR_VERTEX_BUDGET;
    let taken = 0;
    let i = creatures.visibleCount - 1;
    for (; i >= 0 && taken < NEAR_BODY_CAP; i -= 1) {
      const v = (creatures.visible[i] ?? 0) * VISUAL_STRIDE;
      const cost =
        BODY_FIXED_COST +
        nearVertexCount(
          archetypeFromIndex(creatures.visuals[v + VISUAL.archetype] ?? 0),
          creatures.visuals[v + VISUAL.segments] ?? 0,
          creatures.visuals[v + VISUAL.finPairs] ?? 0,
        );
      // Always draw at least one body, even if a single animal is dearer than
      // the whole budget — an empty near tier is never the right answer.
      if (cost > budget && taken > 0) break;
      budget -= cost;
      taken += 1;
    }
    return i + 1;
  }

  private drawNearBody(
    row: number,
    creatures: CreatureFrame,
    textures: ShapeTextures,
    identity: boolean,
    glowPool: SpritePool,
    bodyPool: GraphicsPool,
  ): void {
    this.load(creatures, row);
    this.loadRim(creatures, row, identity);
    const p = row * POSE_STRIDE;
    const x = creatures.poses[p + POSE.x] ?? 0;
    const y = creatures.poses[p + POSE.y] ?? 0;
    const heading = this.headingCache[row] ?? this.visual.heading;
    const lengthWu = this.bodyLengthWu();

    const glow = glowPool.next(textures.glow);
    glow.anchor.set(0.5);
    glow.position.set(x + Math.cos(heading) * -0.5 * lengthWu, y + Math.sin(heading) * -0.5 * lengthWu);
    glow.scale.set(lengthWu * GLOW_SPAN);
    glow.tint = this.visual.tint;
    glow.alpha = this.style.alpha * GLOW_ALPHA;

    this.buildCurrentBody();
    const g = bodyPool.next();
    g.clear();
    drawBody(g, this.geometry, this.style);
    g.position.set(x, y);
    g.rotation = heading;
    g.scale.set(lengthWu);
  }

  private renderMid(creatures: CreatureFrame, textures: ShapeTextures): void {
    const pool = this.midSprites;
    if (pool === null) return;
    pool.begin();
    for (let i = 0; i < creatures.visibleCount; i += 1) {
      this.drawFlipbook(creatures.visible[i] ?? 0, creatures, textures, pool);
    }
    pool.end();
  }

  /** One animal as a tinted, phase-flipped sprite: the mid tier, and near's overflow. */
  private drawFlipbook(
    row: number,
    creatures: CreatureFrame,
    textures: ShapeTextures,
    pool: SpritePool,
  ): void {
    this.load(creatures, row);
    const phases = textures.flipbooks[this.visual.archetype];
    // Flip through the bake at the animal's own beat, offset by its jitter, so
    // a school reads as many animals rather than one animal drawn many times.
    const step = Math.floor(
      (this.animationMs / 1000) * this.beatHz() * FLIPBOOK_PHASES + this.visual.jitter * FLIPBOOK_PHASES,
    );
    const texture = phases[((step % FLIPBOOK_PHASES) + FLIPBOOK_PHASES) % FLIPBOOK_PHASES];
    if (texture === undefined) return;
    const sprite = pool.next(texture);
    const p = row * POSE_STRIDE;
    const lengthWu = this.bodyLengthWu();
    sprite.anchor.set(BAKED_ANCHOR_X, BAKED_ANCHOR_Y);
    sprite.position.set(creatures.poses[p + POSE.x] ?? 0, creatures.poses[p + POSE.y] ?? 0);
    sprite.rotation = this.headingCache[row] ?? this.visual.heading;
    sprite.scale.set(lengthWu, lengthWu * this.aspectSquash());
    sprite.tint = this.visual.tint;
    sprite.alpha = this.style.alpha;
  }

  private renderFar(creatures: CreatureFrame): void {
    for (const archetype of CLADE_ARCHETYPES) this.farPools[archetype]?.begin();
    const floorWu = FAR_MIN_PX / this.pxPerWu;
    for (let i = 0; i < creatures.visibleCount; i += 1) {
      const row = creatures.visible[i] ?? 0;
      this.load(creatures, row);
      const pool = this.farPools[this.visual.archetype];
      if (pool === undefined) continue;
      const particle = pool.next();
      const p = row * POSE_STRIDE;
      const lengthWu = Math.max(this.bodyLengthWu(), floorWu);
      particle.x = creatures.poses[p + POSE.x] ?? 0;
      particle.y = creatures.poses[p + POSE.y] ?? 0;
      particle.rotation = this.headingCache[row] ?? this.visual.heading;
      particle.scaleX = lengthWu;
      particle.scaleY = lengthWu * this.aspectSquash();
      particle.tint = this.visual.tint;
      particle.alpha = this.style.alpha * 0.9;
    }
    for (const archetype of CLADE_ARCHETYPES) this.farPools[archetype]?.end();
  }

  private renderAbyss(creatures: CreatureFrame): void {
    const pool = this.abyssPool;
    if (pool === null) return;
    pool.begin();
    const floorWu = ABYSS_MIN_PX / this.pxPerWu;
    const ceilingWu = ABYSS_MAX_PX / this.pxPerWu;
    for (let i = 0; i < creatures.visibleCount; i += 1) {
      const row = creatures.visible[i] ?? 0;
      this.load(creatures, row);
      const particle = pool.next();
      const p = row * POSE_STRIDE;
      const span = Math.min(Math.max(this.bodyLengthWu() * ABYSS_SPAN, floorWu), ceilingWu);
      particle.x = creatures.poses[p + POSE.x] ?? 0;
      particle.y = creatures.poses[p + POSE.y] ?? 0;
      particle.scaleX = span;
      particle.scaleY = span;
      particle.tint = this.visual.tint;
      particle.alpha = this.style.alpha * 0.75;
    }
    pool.end();
  }

  private renderSelection(
    row: number,
    frame: FrameContext,
    creatures: CreatureFrame,
    textures: ShapeTextures,
  ): void {
    const glowPool = this.selectionGlow;
    const bodyPool = this.selectionBody;
    const root = this.selectionRoot;
    if (glowPool === null || bodyPool === null || root === null) return;
    root.visible = true;
    root.alpha = 1;
    glowPool.begin();
    bodyPool.begin();
    this.drawNearBody(row, creatures, textures, frame.colourMode === 'identity', glowPool, bodyPool);
    glowPool.end();
    bodyPool.end();
  }
}

export function createCreatureLayer(): RenderLayer {
  return new CreatureLayer();
}
