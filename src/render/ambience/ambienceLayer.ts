/**
 * The ambience layer (R3) — the stage the creatures swim on.
 *
 * Composition, back to front: an abyssal screen-space gradient behind
 * everything; over the world rect a wash keyed to the thermal gradient, so the
 * latitude still reads at a glance the way it did in the crude renderer; the
 * resource fields as luminous haze with kelp fronds; drifting marine snow; god
 * rays leaning out of the warm edge; a faint rim on the world boundary; and, in
 * `waterAbove`, whatever the event flourishes are currently drawing.
 *
 * Two rules govern the whole package. First, it must stay *under* the animals:
 * additive alphas are low, motes are small, rays are faint, and nothing here
 * moves fast enough to pull the eye off a fish. Second, all animation phase
 * comes from a single layer clock that this file advances by `dtMs` and freezes
 * while the sim is paused — pausing holds the water still rather than snapping
 * it, and two layers can never drift out of phase with each other.
 */

import { Graphics, Sprite, FillGradient } from 'pixi.js';
import type { Texture } from 'pixi.js';
import type { FrameContext, MountContext, RenderLayer } from '../contracts';
import { bakeVerticalTexture, createFieldHaze } from './fieldHaze';
import type { FieldHaze } from './fieldHaze';
import { createGodRays } from './godRays';
import type { GodRays } from './godRays';
import { createParticulate } from './particulate';
import type { Particulate } from './particulate';
import { createFlourishes } from './flourishes';
import type { Flourishes } from './flourishes';

/** Screen-space abyss: near-black teal above, effectively void below. */
const ABYSS_TOP = '#06222e';
const ABYSS_BOTTOM = '#020b11';

/**
 * The world wash, baked warm-edge-first. Tones track the crude renderer's
 * `#0d3a4a -> #071f2c` so the latitude read survives the port; the bake is a
 * little brighter than that because {@link WASH_TINT_NEUTRAL} scales it back
 * down, which is what leaves headroom for a warm shift to actually brighten.
 */
const WASH_WARM_EDGE: readonly [number, number, number] = [17, 70, 82];
const WASH_COLD_EDGE: readonly [number, number, number] = [8, 34, 48];
const WASH_TEXTURE_H = 256;
const WASH_TINT_NEUTRAL: readonly [number, number, number] = [223, 230, 234];
const WASH_TINT_WARM: readonly [number, number, number] = [255, 240, 221];
const WASH_TINT_COOL: readonly [number, number, number] = [208, 226, 255];

const RIM_COLOUR = 0x96d2e6;
const RIM_ALPHA = 0.35;
const RIM_PX = 2;

export function createAmbienceLayer(): RenderLayer {
  let backdrop: Graphics | null = null;
  let wash: Sprite | null = null;
  let washTexture: Texture | null = null;
  let rim: Graphics | null = null;
  let haze: FieldHaze | null = null;
  let godRays: GodRays | null = null;
  let particulate: Particulate | null = null;
  let flourishes: Flourishes | null = null;

  let worldW = 0;
  let worldH = 0;
  let worldMidX = 0;
  let worldMidY = 0;
  /** Layer clock: wall-clock milliseconds, frozen while paused. */
  let animMs = 0;
  /** Cached so the backdrop gradient and rim are rebuilt only when they must be. */
  let backdropW = -1;
  let backdropH = -1;
  let rimPxPerWu = -1;

  function mount(ctx: MountContext): void {
    worldW = ctx.world.widthWu;
    worldH = ctx.world.heightWu;
    worldMidX = worldW / 2;
    worldMidY = worldH / 2;

    // Which y-edge is warm is a property of the config, not an assumption: the
    // gradient runs northC at y = 0 to southC at y = height, and either may be
    // the warmer end. Read once at mount — this is world geometry, not a knob
    // A7 swaps mid-run, and `FrameContext` carries no config to re-read.
    const thermal = ctx.config.thermal;
    const warmY = thermal.northC >= thermal.southC ? 0 : worldH;
    const warmAtTop = warmY === 0;

    backdrop = new Graphics();
    ctx.slots.backdrop.addChild(backdrop);

    washTexture = bakeVerticalTexture(WASH_TEXTURE_H, (v, out) => {
      const t = warmAtTop ? v : 1 - v;
      for (let c = 0; c < 3; c += 1) {
        out[c] = (WASH_WARM_EDGE[c] ?? 0) + ((WASH_COLD_EDGE[c] ?? 0) - (WASH_WARM_EDGE[c] ?? 0)) * t;
      }
    });
    wash = new Sprite(washTexture);
    wash.position.set(0, 0);
    wash.width = worldW;
    wash.height = worldH;
    ctx.slots.waterBelow.addChild(wash);

    haze = createFieldHaze({ worldWidthWu: worldW, worldHeightWu: worldH, warmY });
    haze.mount(ctx.slots.waterBelow);

    particulate = createParticulate({ worldWidthWu: worldW, worldHeightWu: worldH });
    godRays = createGodRays({ worldWidthWu: worldW, worldHeightWu: worldH, warmY });
    godRays.mount(ctx.slots.waterBelow);

    rim = new Graphics();
    ctx.slots.waterBelow.addChild(rim);

    // Background motes go into the world slot after the rays so they read as
    // being in front of the light; the near field is screen-space.
    particulate.mount(ctx.slots.waterBelow, ctx.slots.foreground);

    flourishes = createFlourishes();
    flourishes.mount(ctx.slots.waterAbove);
  }

  function update(frame: FrameContext): void {
    if (!frame.paused) animMs += frame.dtMs;

    if (flourishes !== null) {
      flourishes.ingest(frame.events);
      flourishes.update(frame.nowMs, frame.dtMs);
    }
    const modulation = flourishes?.modulation ?? null;

    if (backdrop !== null && (frame.camera.viewportW !== backdropW || frame.camera.viewportH !== backdropH)) {
      backdropW = frame.camera.viewportW;
      backdropH = frame.camera.viewportH;
      const gradient = new FillGradient({
        type: 'linear',
        start: { x: 0, y: 0 },
        end: { x: 0, y: 1 },
        colorStops: [
          { offset: 0, color: ABYSS_TOP },
          { offset: 1, color: ABYSS_BOTTOM },
        ],
        textureSpace: 'local',
      });
      backdrop.clear();
      backdrop.rect(0, 0, backdropW, backdropH).fill(gradient);
    }

    if (wash !== null) {
      const warmth = modulation?.washWarmth ?? 0;
      const pole = warmth >= 0 ? WASH_TINT_WARM : WASH_TINT_COOL;
      const mix = Math.abs(warmth);
      let tint = 0;
      for (let c = 0; c < 3; c += 1) {
        const base = WASH_TINT_NEUTRAL[c] ?? 255;
        const channel = Math.round(base + ((pole[c] ?? base) - base) * mix);
        tint = (tint << 8) | Math.max(0, Math.min(255, channel));
      }
      wash.tint = tint;
    }

    if (haze !== null && flourishes !== null) {
      haze.update(frame.plankton, frame.kelp, animMs, frame.dtMs, flourishes.hooks);
    }
    godRays?.update(animMs, frame.camera, worldMidX, worldMidY, modulation?.godRayIntensity ?? 1);
    particulate?.update(animMs, frame.camera, worldMidX, worldMidY);

    // The rim is drawn in world space, so its width has to be un-zoomed to stay
    // a 2 px line. Rebuild only when the zoom actually moved.
    if (rim !== null && Math.abs(frame.camera.pxPerWu - rimPxPerWu) > rimPxPerWu * 0.01) {
      rimPxPerWu = frame.camera.pxPerWu;
      rim.clear();
      rim
        .rect(0, 0, worldW, worldH)
        .stroke({ color: RIM_COLOUR, alpha: RIM_ALPHA, width: RIM_PX / Math.max(1e-6, rimPxPerWu) });
    }
  }

  function reset(): void {
    animMs = 0;
    backdropW = -1;
    backdropH = -1;
    rimPxPerWu = -1;
    haze?.reset();
    godRays?.reset();
    particulate?.reset();
    flourishes?.reset();
  }

  function destroy(): void {
    backdrop?.destroy();
    wash?.destroy();
    washTexture?.destroy(true);
    rim?.destroy();
    haze?.destroy();
    godRays?.destroy();
    particulate?.destroy();
    flourishes?.destroy();
    backdrop = null;
    wash = null;
    washTexture = null;
    rim = null;
    haze = null;
    godRays = null;
    particulate = null;
    flourishes = null;
  }

  return { name: 'ambience', mount, update, reset, destroy };
}
