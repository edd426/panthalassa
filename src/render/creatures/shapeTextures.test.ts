/**
 * The bake budget.
 *
 * The mid tier went from one flipbook per archetype to twelve, which is the
 * difference between 12 baked frames and 144. That is a good trade and it is
 * also the kind of number that grows by one innocent bucket at a time until
 * startup stalls on a texture upload, so the count is asserted rather than
 * remembered — including against the *arithmetic*, so adding a bucket without
 * updating the documented figure fails here rather than in the field.
 *
 * The glow is baked through `FillGradient`, which rasterises on a 2D canvas and
 * cannot run under the node environment; `creatureLayer` catches that and falls
 * back, and these tests count the calls made before it.
 */

import { Container, Texture } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import type { MountContext } from '../contracts';
import { CLADE_ARCHETYPES } from '../../contracts/genome';
import { ASPECT_BUCKETS, FLIPBOOK_VARIANTS, HEAD_BUCKETS, PATTERN_BUCKETS } from './divergence';
import {
  BAKED_TEXTURE_COUNT,
  FLIPBOOK_PHASES,
  FLIPBOOK_TEXTURE_COUNT,
  SILHOUETTE_TEXTURE_COUNT,
  bakeShapeTextures,
  fallbackShapeTextures,
} from './shapeTextures';

/** Counts `generateTexture` calls; the glow bake throws before it reaches one. */
function countBakes(): number {
  let calls = 0;
  const ctx: MountContext = {
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
      calls += 1;
      return Texture.EMPTY;
    },
  };
  try {
    bakeShapeTextures(ctx);
  } catch {
    // The glow's canvas rasterisation, not a geometry failure — see the header.
  }
  return calls;
}

describe('texture budget', () => {
  it('bakes exactly the documented number of textures', () => {
    expect(FLIPBOOK_VARIANTS).toBe(12);
    expect(FLIPBOOK_TEXTURE_COUNT).toBe(
      CLADE_ARCHETYPES.length * ASPECT_BUCKETS * HEAD_BUCKETS * PATTERN_BUCKETS * FLIPBOOK_PHASES,
    );
    expect(FLIPBOOK_TEXTURE_COUNT).toBe(144);
    expect(SILHOUETTE_TEXTURE_COUNT).toBe(9);
    expect(BAKED_TEXTURE_COUNT).toBe(154);
    // Everything but the glow, which cannot rasterise headless.
    expect(countBakes()).toBe(BAKED_TEXTURE_COUNT - 1);
  });

  it('stays under the startup ceiling', () => {
    // ~103 KB per flipbook frame at FLIPBOOK_RESOLUTION, so 160 frames is the
    // point where the bake stops being a startup cost and starts being a stall.
    expect(BAKED_TEXTURE_COUNT).toBeLessThanOrEqual(160);
  });

  it('gives the fallback the same shape as a real bake, so the layer indexes it identically', () => {
    // The fallback ships whenever the GPU refuses a render texture. A shape
    // mismatch there would turn a degraded ocean into an empty one.
    const textures = fallbackShapeTextures();
    for (const archetype of CLADE_ARCHETYPES) {
      const variants = textures.flipbooks[archetype];
      expect(variants.length).toBe(FLIPBOOK_VARIANTS);
      for (const phases of variants) expect(phases.length).toBe(FLIPBOOK_PHASES);
      expect(textures.silhouettes[archetype].length).toBe(ASPECT_BUCKETS);
    }
    textures.destroy();
  });
});
