/**
 * The diagnostic field underlay (R1) — what the `f` key cycles through.
 *
 * Deliberately unbeautiful: one nearest-filtered texel per field cell, stretched
 * over the world rect. It is an instrument, not scenery, and a smoothed overlay
 * would draw a gradient the sim does not have. The ambience layers are where
 * the sea is allowed to look good.
 *
 * It sits in `waterAbove` rather than `waterBelow` so it reads *over* the haze
 * and the kelp; an overlay you have to squint through has failed at its one job.
 */

import { BufferImageSource, Sprite, Texture } from 'pixi.js';
import type { Container } from 'pixi.js';
import type { FieldRaster, FrameContext, MountContext, RenderLayer } from './contracts';
import { normaliseField } from './fieldSampling';

export class FieldOverlayLayer implements RenderLayer {
  readonly name = 'fieldOverlay';

  private sprite: Sprite | null = null;
  private parent: Container | null = null;
  private source: BufferImageSource | null = null;
  private texture: Texture | null = null;
  private rgba: Uint8Array = new Uint8Array(0);
  private cols = 0;
  private rows = 0;
  private shown: FieldRaster | null = null;

  mount(ctx: MountContext): void {
    const sprite = new Sprite(Texture.EMPTY);
    sprite.visible = false;
    ctx.slots.waterAbove.addChild(sprite);
    this.sprite = sprite;
    this.parent = ctx.slots.waterAbove;
  }

  update(frame: FrameContext): void {
    const sprite = this.sprite;
    if (sprite === null) return;

    const raster = frame.overlay === 'off' ? null : frame.overlayRaster;
    // A raster of the wrong field is a reply that outlived the keypress that
    // asked for it; painting it would show plankton under a temperature label.
    if (raster === null || raster.field !== frame.overlay || raster.cols === 0 || raster.rows === 0) {
      sprite.visible = false;
      return;
    }

    if (raster !== this.shown) {
      this.upload(raster);
      this.shown = raster;
    }

    sprite.visible = true;
    sprite.position.set(0, 0);
    sprite.width = raster.cols * raster.cellSizeWu;
    sprite.height = raster.rows * raster.cellSizeWu;
  }

  reset(): void {
    this.shown = null;
    if (this.sprite !== null) this.sprite.visible = false;
  }

  destroy(): void {
    if (this.sprite !== null) {
      this.parent?.removeChild(this.sprite);
      this.sprite.destroy();
      this.sprite = null;
    }
    this.texture?.destroy(true);
    this.texture = null;
    this.source = null;
    this.parent = null;
  }

  private upload(raster: FieldRaster): void {
    const normalised = normaliseField(raster, this.rgba);
    this.rgba = normalised.rgba;
    premultiply(this.rgba);

    if (this.source === null || this.cols !== raster.cols || this.rows !== raster.rows) {
      this.texture?.destroy(true);
      // `format` is explicit because a Uint8Array resource defaults to bgra and
      // would silently swap the red and blue channels of every overlay.
      const source = new BufferImageSource({
        resource: this.rgba,
        width: raster.cols,
        height: raster.rows,
        format: 'rgba8unorm',
        alphaMode: 'premultiplied-alpha',
        scaleMode: 'nearest',
      });
      this.source = source;
      this.texture = new Texture({ source });
      this.cols = raster.cols;
      this.rows = raster.rows;
      if (this.sprite !== null) this.sprite.texture = this.texture;
      return;
    }

    this.source.resource = this.rgba;
    this.source.update();
  }
}

/**
 * Premultiply an RGBA buffer in place.
 *
 * `normaliseField` produces straight alpha (the crude renderer's semantics),
 * but Pixi's normal blend expects premultiplied source — and the
 * `premultiply-alpha-on-upload` mode is a no-op for raw buffer sources, where
 * there is no browser decode step to do it. Without this, a 0.32-alpha plankton
 * cell composites like an opaque one and the overlay paints the ocean solid
 * green.
 */
function premultiply(rgba: Uint8Array): void {
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = (rgba[i + 3] ?? 0) / 255;
    rgba[i] = (rgba[i] ?? 0) * alpha;
    rgba[i + 1] = (rgba[i + 1] ?? 0) * alpha;
    rgba[i + 2] = (rgba[i + 2] ?? 0) * alpha;
  }
}

export function createFieldOverlayLayer(): RenderLayer {
  return new FieldOverlayLayer();
}
