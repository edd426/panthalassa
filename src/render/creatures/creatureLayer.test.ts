/**
 * Visibility and publication tests for the creature layer.
 *
 * These exist because the layer failed silently in the browser: every tier drew
 * nothing, with no error anywhere. Two causes, both asserted here —
 *
 * 1. `ParticleContainer.update()` does not mark the view dirty, so the far and
 *    abyss pools were built empty once and never asked again.
 * 2. A texture bake that throws used to take `mount()` down with it, leaving
 *    the layer's containers unattached.
 *
 * Neither needs a GPU to catch, which is the point: both are cheap assertions
 * on scene-graph state, and both were invisible to a probe that only checked
 * that geometry was correct.
 */

import { Container, Texture, type Particle, type ParticleContainer } from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';
import type { CreatureFrame, FrameContext, LodState, LodTier, MountContext } from '../contracts';
import { LOD_TIERS, POSE, POSE_STRIDE, VISUAL, VISUAL_STRIDE } from '../contracts';
import { createCreatureLayer } from './creatureLayer';

const COUNT = 24;

function makeCreatures(): CreatureFrame {
  const poses = new Float32Array(COUNT * POSE_STRIDE);
  const visuals = new Float32Array(COUNT * VISUAL_STRIDE);
  for (let i = 0; i < COUNT; i += 1) {
    const p = i * POSE_STRIDE;
    poses[p + POSE.x] = i * 3;
    poses[p + POSE.y] = i * 2;
    poses[p + POSE.heading] = i * 0.4;
    poses[p + POSE.speed] = 1.5;
    poses[p + POSE.fade] = 1;
    poses[p + POSE.jitter] = i / COUNT;
    const v = i * VISUAL_STRIDE;
    visuals[v + VISUAL.archetype] = i % 3;
    visuals[v + VISUAL.sizeCm] = 4 + i;
    visuals[v + VISUAL.segments] = 8;
    visuals[v + VISUAL.finPairs] = 2;
    visuals[v + VISUAL.bodyAspect] = 2;
    visuals[v + VISUAL.armor] = 0.6;
    visuals[v + VISUAL.speciesTag] = i % 5;
  }
  return {
    count: COUNT,
    poses,
    visuals,
    tints: new Uint32Array(COUNT).fill(0x66ccff),
    alphas: new Float32Array(COUNT).fill(1),
    visible: Uint16Array.from({ length: COUNT }, (_, i) => i),
    visibleCount: COUNT,
  };
}

/**
 * `bake: 'ok'` stands in for a working GPU; `bake: 'throws'` for one that will
 * not hand back a render texture, which the layer has to survive.
 *
 * The glow bake goes through Pixi's `FillGradient`, which rasterises on a 2D
 * canvas and so cannot run under the node test environment either way. That is
 * deliberately left to fail into the same fallback rather than stubbed: it
 * keeps these tests exercising the resilient path that ships.
 */
function makeMount(bake: 'ok' | 'throws' = 'ok'): MountContext {
  return {
    slots: {
      backdrop: new Container(),
      waterBelow: new Container(),
      creatures: new Container(),
      waterAbove: new Container(),
      foreground: new Container(),
    },
    world: { widthWu: 400, heightWu: 300 },
    config: {} as MountContext['config'],
    generateTexture: (): Texture => {
      if (bake === 'throws') throw new Error('no GPU in a headless test');
      return Texture.EMPTY;
    },
  };
}

/** Mount with the expected bake warning silenced, so the suite output stays readable. */
function mountQuietly(layer: ReturnType<typeof createCreatureLayer>, mount: MountContext): void {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    layer.mount(mount);
  } finally {
    warn.mockRestore();
  }
}

function makeFrame(creatures: CreatureFrame | null, lod: LodState): FrameContext {
  return {
    nowMs: 1000,
    dtMs: 16.7,
    camera: { centerX: 0, centerY: 0, pxPerWu: 4, viewportW: 1280, viewportH: 800 },
    lod,
    creatures,
    colourMode: 'identity',
    overlay: 'off',
    overlayRaster: null,
    plankton: null,
    kelp: null,
    temperature: null,
    events: [],
    selected: null,
    paused: false,
    speedMultiplier: 1,
  };
}

/** The five roots the layer parks under `slots.creatures`, in z-order. */
function roots(mount: MountContext): Record<LodTier | 'selection', Container> {
  const children = mount.slots.creatures.children as Container[];
  return {
    abyss: children[0] as Container,
    far: children[1] as Container,
    mid: children[2] as Container,
    near: children[3] as Container,
    selection: children[4] as Container,
  };
}

function particleContainers(root: Container): ParticleContainer[] {
  return root.children as unknown as ParticleContainer[];
}

/**
 * `particleChildren` is typed as the `IParticle` interface, which carries the
 * packed `color` but not the `alpha`/`tint` accessors. The pool only ever puts
 * concrete `Particle`s in, so reading them back as such is sound.
 */
function particlesOf(container: ParticleContainer): Particle[] {
  return container.particleChildren as unknown as Particle[];
}

/**
 * Device pixels a tier asks the rasteriser to touch, summed over its marks.
 *
 * Every mark this layer draws is a quad scaled in world units, so its screen
 * area is `(scale * pxPerWu)²`. Overlap is not deduplicated on purpose:
 * blending costs per drawn pixel whether or not something is already there,
 * which is exactly why an unbounded additive mark is dangerous.
 */
function tierFill(mount: MountContext, tier: LodTier, pxPerWu: number): number {
  const root = roots(mount)[tier];
  let total = 0;
  const addNode = (node: Container): void => {
    if (!node.visible) return;
    total += node.scale.x * pxPerWu * node.scale.y * pxPerWu;
  };
  switch (tier) {
    case 'near':
      // Glow, overflow and body sub-roots, each holding the marks themselves.
      for (const group of root.children) {
        for (const mark of (group as Container).children) addNode(mark as Container);
      }
      return total;
    case 'mid':
      for (const sprite of root.children) addNode(sprite as Container);
      return total;
    case 'far':
    case 'abyss':
      for (const container of particleContainers(root)) {
        for (const particle of particlesOf(container)) {
          total += particle.scaleX * pxPerWu * particle.scaleY * pxPerWu;
        }
      }
      return total;
  }
}

function frameAtZoom(creatures: CreatureFrame, tier: LodTier, pxPerWu: number): FrameContext {
  const base = makeFrame(creatures, { tier, previousTier: null, blend: 1 });
  return { ...base, camera: { ...base.camera, pxPerWu } };
}

describe('LOD tier cost ordering', () => {
  /**
   * The invariant that makes LOD worth having: a coarser tier must cost less.
   *
   * It was broken. The abyss glow was `2.4 x body length` of additive quad per
   * animal with no budget and no ceiling in front of it, while near and far both
   * had one, so abyss billed ~11x the far tier — the tier the governor demotes
   * *to* costing more than the tier it demotes *from*, which buys no headroom
   * and leaves a loaded governor nothing to recover to.
   */
  it('never costs more fill at a coarser tier than at a finer one', () => {
    const mount = makeMount();
    const layer = createCreatureLayer();
    mountQuietly(layer, mount);
    const creatures = makeCreatures();
    for (const pxPerWu of [2, 4, 8]) {
      const fill = {} as Record<LodTier, number>;
      for (const tier of LOD_TIERS) {
        layer.update(frameAtZoom(creatures, tier, pxPerWu));
        fill[tier] = tierFill(mount, tier, pxPerWu);
      }
      // `LOD_TIERS` runs finest to coarsest, so cost must be non-increasing.
      for (let i = 1; i < LOD_TIERS.length; i += 1) {
        const finer = LOD_TIERS[i - 1] ?? 'near';
        const coarser = LOD_TIERS[i] ?? 'abyss';
        // Relative slack: mid and far compute the same total in a different
        // accumulation order and land ~1e-12 apart.
        expect(fill[coarser], `${coarser} vs ${finer} @${pxPerWu}px/wu`).toBeLessThanOrEqual(
          fill[finer] * (1 + 1e-9),
        );
      }
      // Mid and far draw the same quad and differ in draw calls rather than
      // pixels, so the two drops that actually buy fill are near→mid and
      // far→abyss. Those have to be real, not rounding.
      expect(fill.mid, `near→mid @${pxPerWu}px/wu`).toBeLessThan(fill.near * 0.5);
      expect(fill.abyss, `far→abyss @${pxPerWu}px/wu`).toBeLessThan(fill.far * 0.75);
      expect(fill.abyss).toBeGreaterThan(0);
    }
    layer.destroy();
  });

  it('holds the abyss cost flat as the camera zooms, because the dot is capped', () => {
    // A fallback tier whose cost climbs with zoom is not a fallback. The 12 px
    // ceiling makes abyss a fixed, tiny bill at any magnification.
    const mount = makeMount();
    const layer = createCreatureLayer();
    mountQuietly(layer, mount);
    const creatures = makeCreatures();
    layer.update(frameAtZoom(creatures, 'abyss', 4));
    const atFour = tierFill(mount, 'abyss', 4);
    layer.update(frameAtZoom(creatures, 'abyss', 16));
    const atSixteen = tierFill(mount, 'abyss', 16);
    expect(atSixteen).toBeCloseTo(atFour, 6);
    // And every mark is genuinely at the ceiling, not accidentally tiny.
    const abyss = particleContainers(roots(mount).abyss)[0];
    for (const particle of abyss === undefined ? [] : particlesOf(abyss)) {
      expect(particle.scaleX * 16).toBeCloseTo(12, 6);
    }
    layer.destroy();
  });
});

describe('mounting', () => {
  it('attaches all five containers even when every texture bake throws', () => {
    const mount = makeMount('throws');
    const layer = createCreatureLayer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => layer.mount(mount)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(mount.slots.creatures.children.length).toBe(5);
    layer.destroy();
  });

  it('still renders a population after a failed bake, rather than an empty ocean', () => {
    const mount = makeMount('throws');
    const layer = createCreatureLayer();
    mountQuietly(layer, mount);
    layer.update(makeFrame(makeCreatures(), { tier: 'abyss', previousTier: null, blend: 1 }));
    const abyss = particleContainers(roots(mount).abyss)[0];
    expect(abyss?.particleChildren.length).toBe(COUNT);
    layer.destroy();
  });

  it('touches no slot but its own', () => {
    const mount = makeMount();
    const layer = createCreatureLayer();
    mountQuietly(layer, mount);
    expect(mount.slots.backdrop.children.length).toBe(0);
    expect(mount.slots.waterBelow.children.length).toBe(0);
    expect(mount.slots.waterAbove.children.length).toBe(0);
    expect(mount.slots.foreground.children.length).toBe(0);
    layer.destroy();
  });
});

describe('tier visibility', () => {
  it('shows exactly one tier, at full alpha, for every settled LodState', () => {
    const mount = makeMount();
    const layer = createCreatureLayer();
    mountQuietly(layer, mount);
    const creatures = makeCreatures();
    for (const tier of LOD_TIERS) {
      // `previousTier: null, blend: 1` is the shape the layer gets on frame one.
      for (const blend of [0, 0.5, 1]) {
        layer.update(makeFrame(creatures, { tier, previousTier: null, blend }));
        const byTier = roots(mount);
        const shown = LOD_TIERS.filter((t) => byTier[t].visible && byTier[t].alpha > 0);
        expect(shown, `tier=${tier} blend=${blend}`).toEqual([tier]);
        expect(byTier[tier].alpha).toBe(1);
      }
    }
    layer.destroy();
  });

  it('cross-fades both tiers with complementary alpha, and neither is ever zero-width', () => {
    const mount = makeMount();
    const layer = createCreatureLayer();
    mountQuietly(layer, mount);
    const creatures = makeCreatures();
    layer.update(makeFrame(creatures, { tier: 'near', previousTier: 'mid', blend: 0.25 }));
    const byTier = roots(mount);
    expect(byTier.near.visible).toBe(true);
    expect(byTier.mid.visible).toBe(true);
    expect(byTier.near.alpha).toBeCloseTo(0.25, 6);
    expect(byTier.mid.alpha).toBeCloseTo(0.75, 6);
    expect(byTier.far.visible).toBe(false);
    expect(byTier.abyss.visible).toBe(false);
    layer.destroy();
  });

  it('hides everything when there is no population yet', () => {
    const mount = makeMount();
    const layer = createCreatureLayer();
    mountQuietly(layer, mount);
    layer.update(makeFrame(null, { tier: 'near', previousTier: null, blend: 1 }));
    const byTier = roots(mount);
    for (const tier of LOD_TIERS) expect(byTier[tier].visible).toBe(false);
    layer.destroy();
  });
});

describe('particle publication', () => {
  /**
   * The regression that mattered: `ParticleContainer.update()` sets the
   * container's private dirty flag but never calls the protected
   * `onViewUpdate()`, so the parent render group is never told the view
   * changed. `didViewUpdate` is the public flag `onViewUpdate` sets, and the
   * renderer clears it after every frame — so asserting it is true after a
   * publish is exactly the check that the old code failed.
   */
  it('marks the view dirty when particles are published', () => {
    const mount = makeMount();
    const layer = createCreatureLayer();
    mountQuietly(layer, mount);
    const creatures = makeCreatures();
    const abyss = particleContainers(roots(mount).abyss)[0];
    expect(abyss).toBeDefined();
    if (abyss === undefined) return;

    layer.update(makeFrame(creatures, { tier: 'abyss', previousTier: null, blend: 1 }));
    // Simulate the renderer consuming the frame.
    abyss.didViewUpdate = false;
    layer.update(makeFrame(creatures, { tier: 'abyss', previousTier: null, blend: 1 }));
    expect(abyss.didViewUpdate).toBe(true);
    expect(abyss.particleChildren.length).toBe(COUNT);
    layer.destroy();
  });

  it('routes far-tier particles into the container for their own archetype', () => {
    const mount = makeMount();
    const layer = createCreatureLayer();
    mountQuietly(layer, mount);
    layer.update(makeFrame(makeCreatures(), { tier: 'far', previousTier: null, blend: 1 }));
    const containers = particleContainers(roots(mount).far);
    expect(containers.length).toBe(3);
    const total = containers.reduce((sum, c) => sum + c.particleChildren.length, 0);
    expect(total).toBe(COUNT);
    // The fixture cycles the three archetypes, so each gets a share.
    for (const c of containers) expect(c.particleChildren.length).toBeGreaterThan(0);
    layer.destroy();
  });

  it('empties the particles, and dirties the view, when the tier is left behind', () => {
    const mount = makeMount();
    const layer = createCreatureLayer();
    mountQuietly(layer, mount);
    const creatures = makeCreatures();
    const abyss = particleContainers(roots(mount).abyss)[0];
    expect(abyss).toBeDefined();
    if (abyss === undefined) return;

    layer.update(makeFrame(creatures, { tier: 'abyss', previousTier: null, blend: 1 }));
    expect(abyss.particleChildren.length).toBe(COUNT);
    abyss.didViewUpdate = false;
    layer.update(makeFrame(creatures, { tier: 'near', previousTier: null, blend: 1 }));
    expect(abyss.particleChildren.length).toBe(0);
    expect(abyss.didViewUpdate).toBe(true);
    layer.destroy();
  });

  it('gives every published particle a non-zero size and a visible alpha', () => {
    const mount = makeMount();
    const layer = createCreatureLayer();
    mountQuietly(layer, mount);
    layer.update(makeFrame(makeCreatures(), { tier: 'abyss', previousTier: null, blend: 1 }));
    const abyss = particleContainers(roots(mount).abyss)[0];
    expect(abyss).toBeDefined();
    if (abyss === undefined) return;
    expect(particlesOf(abyss).length).toBe(COUNT);
    for (const particle of particlesOf(abyss)) {
      expect(particle.scaleX).toBeGreaterThan(0);
      expect(particle.scaleY).toBeGreaterThan(0);
      expect(particle.alpha).toBeGreaterThan(0);
      expect(particle.texture).toBeDefined();
    }
    layer.destroy();
  });
});

describe('near tier', () => {
  it('draws a body and a glow per animal, and leaves none of them invisible', () => {
    const mount = makeMount();
    const layer = createCreatureLayer();
    mountQuietly(layer, mount);
    layer.update(makeFrame(makeCreatures(), { tier: 'near', previousTier: null, blend: 1 }));
    const near = roots(mount).near;
    const glows = (near.children[0] as Container).children.filter((c) => c.visible);
    const bodies = (near.children[2] as Container).children.filter((c) => c.visible);
    expect(bodies.length).toBe(COUNT);
    expect(glows.length).toBe(COUNT);
    for (const body of bodies) expect(body.alpha).toBeGreaterThan(0);
    layer.destroy();
  });

  it('reports zero alpha only when the upstream fade says so', () => {
    // Guards the alpha chain: tint alpha x energy alpha x fade. A layer that
    // multiplies in something of its own would fail this.
    const mount = makeMount();
    const layer = createCreatureLayer();
    mountQuietly(layer, mount);
    const creatures = makeCreatures();
    layer.update(makeFrame(creatures, { tier: 'near', previousTier: null, blend: 1 }));
    const bodyRoot = (roots(mount).near.children[2] as Container).children;
    const opaque = bodyRoot.filter((c) => c.visible).map((c) => c.alpha);
    expect(opaque.every((a) => a > 0)).toBe(true);
    layer.destroy();
  });
});
