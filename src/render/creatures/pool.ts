/**
 * Display-object pools for the creature layer.
 *
 * Every pool follows the same frame protocol — `begin()`, one `next()` per
 * drawn creature, `end()` — so a frame allocates nothing once the population
 * has been seen once. `end()` parks the unused tail rather than destroying it,
 * because a population that oscillates around a size would otherwise churn
 * GPU-backed objects every frame.
 */

import type { Container, Texture } from 'pixi.js';
import { Graphics, Particle, ParticleContainer, Sprite } from 'pixi.js';

export class GraphicsPool {
  private readonly items: Graphics[] = [];
  private used = 0;

  constructor(private readonly parent: Container) {}

  begin(): void {
    this.used = 0;
  }

  next(): Graphics {
    const existing = this.items[this.used];
    if (existing !== undefined) {
      existing.visible = true;
      this.used += 1;
      return existing;
    }
    const created = new Graphics();
    this.items.push(created);
    this.parent.addChild(created);
    this.used += 1;
    return created;
  }

  end(): void {
    for (let i = this.used; i < this.items.length; i += 1) {
      const item = this.items[i];
      if (item === undefined) continue;
      if (!item.visible) break; // The parked tail is contiguous; nothing past here is live.
      item.visible = false;
      item.clear();
    }
  }

  /** Reseed: park and empty every object, keeping the allocation. */
  reset(): void {
    this.used = 0;
    this.end();
  }

  destroy(): void {
    for (const item of this.items) item.destroy();
    this.items.length = 0;
    this.used = 0;
  }
}

export class SpritePool {
  private readonly items: Sprite[] = [];
  private used = 0;

  constructor(
    private readonly parent: Container,
    private readonly blendMode: 'normal' | 'add' = 'normal',
  ) {}

  begin(): void {
    this.used = 0;
  }

  next(texture: Texture): Sprite {
    const existing = this.items[this.used];
    if (existing !== undefined) {
      existing.visible = true;
      existing.texture = texture;
      this.used += 1;
      return existing;
    }
    const created = new Sprite(texture);
    created.blendMode = this.blendMode;
    this.items.push(created);
    this.parent.addChild(created);
    this.used += 1;
    return created;
  }

  end(): void {
    for (let i = this.used; i < this.items.length; i += 1) {
      const item = this.items[i];
      if (item === undefined) continue;
      if (!item.visible) break;
      item.visible = false;
    }
  }

  reset(): void {
    this.used = 0;
    this.end();
  }

  destroy(): void {
    for (const item of this.items) item.destroy();
    this.items.length = 0;
    this.used = 0;
  }
}

/**
 * A `ParticleContainer` and its particle pool.
 *
 * One pool per texture: Pixi 8 batches a container's particles into a single
 * draw call off one texture source, so the three far-tier silhouettes get three
 * containers rather than one container of mixed particles.
 *
 * `color` is dynamic because tint and alpha change on every slice — the colour
 * mode is a live control and the energy-condition alpha tracks condition.
 * `vertex` is dynamic because a pooled particle is reassigned to a different
 * animal each frame, and Pixi carries particle scale in the vertex data.
 */
export class ParticlePool {
  readonly container: ParticleContainer;
  private readonly items: Particle[] = [];
  private used = 0;
  /** How many were on screen last frame, so emptying can be detected. */
  private published = 0;

  constructor(
    private readonly texture: Texture,
    private readonly anchorX = 0.5,
    private readonly anchorY = 0.5,
    rotates = true,
  ) {
    this.container = new ParticleContainer({
      dynamicProperties: { vertex: true, position: true, rotation: rotates, uvs: false, color: true },
    });
  }

  begin(): void {
    this.used = 0;
  }

  next(): Particle {
    const existing = this.items[this.used];
    if (existing !== undefined) {
      this.used += 1;
      return existing;
    }
    const created = new Particle({
      texture: this.texture,
      anchorX: this.anchorX,
      anchorY: this.anchorY,
    });
    this.items.push(created);
    this.used += 1;
    return created;
  }

  /**
   * Publish exactly the particles taken this frame.
   *
   * `ParticleContainer.update()` is the call Pixi's own docs point you to after
   * mutating `particleChildren`, and it is **not sufficient**: it sets the
   * container's private `_childrenDirty` flag but never reaches
   * `onViewUpdate()`, which is what marks the view dirty on the parent render
   * group. A pool that starts empty therefore gets built as empty and is never
   * asked again — the tier renders nothing, permanently, with no error. Only
   * `addParticle`/`removeParticles` call `onViewUpdate` (it is `protected`, so
   * there is no direct route to it).
   *
   * Handing `addParticle` the final particle publishes the whole batch with one
   * view update, and its rest argument is the only allocation — one small array
   * per pool per frame rather than one per particle.
   */
  end(): void {
    const children = this.container.particleChildren;
    const last = this.used > 0 ? this.items[this.used - 1] : undefined;
    children.length = 0;
    for (let i = 0; i < this.used - 1; i += 1) {
      const item = this.items[i];
      if (item !== undefined) children.push(item);
    }
    if (last !== undefined) {
      this.container.addParticle(last);
    } else if (this.published > 0) {
      // Emptying still has to dirty the view, or the last batch stays on screen.
      this.container.removeParticles();
    }
    this.published = this.used;
  }

  reset(): void {
    this.used = 0;
    this.end();
  }

  destroy(): void {
    this.items.length = 0;
    this.used = 0;
    this.container.destroy();
  }
}
