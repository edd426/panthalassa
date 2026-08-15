/**
 * Event flourishes (R3).
 *
 * The sim narrates itself through `SimEvent`s; this module is where a handful of
 * those become something the watcher sees in the water rather than reads in a
 * feed. Everything is a capped list of pooled effects decaying on a wall-clock
 * TTL — sim durations only pull the TTL around inside the 4-20 s window — so a
 * burst of events can never grow the scene graph or outlive its welcome.
 *
 * Two kinds of output. Some effects draw themselves (`waterAbove`: meteor flash
 * and shockwave, clade beacon, impulse motes). Others only *modulate* what the
 * rest of the ambience already draws: a meteor dims the god rays, a plankton
 * crash eases the haze down and back, a kelp storm triples frond sway inside its
 * swath, the climate walk drifts the colour of the whole sea. The second kind is
 * the more important one — it is how a slow statistical process becomes weather.
 */

import { Container, Particle, ParticleContainer, Sprite } from 'pixi.js';
import type { Texture } from 'pixi.js';
import type { AmbientEvent } from '../contracts';
import type { DisturbanceRegion } from '../../contracts/types';
import { anchorHash, bakeAlphaTexture } from './fieldHaze';
import type { HazeHooks } from './fieldHaze';

const MAX_EFFECTS = 32;

/** Pool ceilings. Anything past these is dropped, never allocated around. */
const GLOW_POOL = 12;
const RING_POOL = 32;
const BURST_POOL = 240;

const GLOW_TEXTURE_PX = 96;
const RING_TEXTURE_PX = 128;
/** Where the ring sits in the baked texture, as a fraction of the half-width. */
const RING_RADIUS_FRACTION = 0.74;
const MOTE_TEXTURE_PX = 16;

const METEOR_TTL_MS = 2000;
const METEOR_FLASH_MS = 150;
const METEOR_RING_MS = 1200;
const METEOR_BURST_MS = 1600;
const METEOR_BURST_MOTES = 80;
/** A meteor punches a hole in the light column for a beat. */
const METEOR_RAY_DIM = 0.3;

const THERMAL_SHOCK_MS = 3000;

const CLADE_TTL_MS = 6000;
const CLADE_PING_COUNT = 6;
const CLADE_PING_SPACING_MS = 900;
const CLADE_PING_LIFE_MS = 2000;
const CLADE_PING_RADIUS_WU = 130;

const KELP_DEBRIS_MOTES = 24;
/** Sway multiplier at the peak of a storm, over the resting 1. */
const KELP_SWAY_PEAK = 3;

const CRASH_FALL_MS = 1000;
const CRASH_RECOVER_MS = 8000;

/** Time constant for the climate wash, so a step lands in roughly ten seconds. */
const CLIMATE_TAU_MS = 3300;
/** °C of climate offset that saturates the wash tint. */
const CLIMATE_SATURATION_C = 5;

/**
 * The renderer is never told the sim's tick rate, so a duration in ticks is read
 * at a nominal display rate and then clamped. The clamp is what actually
 * governs; the nominal only preserves the ordering of short and long shocks.
 */
const NOMINAL_MS_PER_TICK = 50;
const DURATION_MIN_MS = 4000;
const DURATION_MAX_MS = 20_000;

type EffectKind = 'meteor' | 'planktonCrash' | 'kelpStorm' | 'thermalShock' | 'cladeFounding';

interface Effect {
  active: boolean;
  kind: EffectKind;
  startMs: number;
  ttlMs: number;
  x: number;
  y: number;
  radiusWu: number;
  /** `productivityMultiplier` for a crash, `magnitudeC` for a shock. */
  magnitude: number;
  region: DisturbanceRegion | null;
  /** First owned slot in the burst container, or -1 for effects with no motes. */
  burstStart: number;
  burstCount: number;
  seed: number;
}

/** What the rest of the ambience reads back each frame. */
export interface AmbienceModulation {
  /** Multiplier on god-ray alpha; 1 at rest. */
  godRayIntensity: number;
  /** Multiplier on the global plankton haze alpha; 1 at rest. */
  planktonAlpha: number;
  /** Signed wash warmth, -1 (cool) .. +1 (warm); 0 at rest. */
  washWarmth: number;
}

export interface Flourishes {
  mount(parent: Container): void;
  /** Fold newly arrived events into the active list; drops past {@link MAX_EFFECTS}. */
  ingest(events: readonly AmbientEvent[]): void;
  update(nowMs: number, dtMs: number): void;
  readonly modulation: AmbienceModulation;
  readonly hooks: HazeHooks;
  reset(): void;
  destroy(): void;
}

export function createFlourishes(): Flourishes {
  const glowTexture = bakeGlowTexture();
  const ringTexture = bakeRingTexture();
  const moteTexture = bakeMoteTexture();

  const container = new Container();
  const glows: Sprite[] = [];
  const rings: Sprite[] = [];
  for (let i = 0; i < GLOW_POOL; i += 1) glows.push(makeSprite(glowTexture));
  for (let i = 0; i < RING_POOL; i += 1) rings.push(makeSprite(ringTexture));

  const bursts = new ParticleContainer({
    dynamicProperties: { position: true, rotation: false, vertex: false, uvs: false, color: true },
  });
  const burstParticles: Particle[] = [];
  for (let i = 0; i < BURST_POOL; i += 1) {
    const particle = new Particle({ texture: moteTexture, tint: 0xdff0f5, alpha: 0, anchorX: 0.5, anchorY: 0.5 });
    particle.scaleX = 5 / MOTE_TEXTURE_PX;
    particle.scaleY = 5 / MOTE_TEXTURE_PX;
    bursts.addParticle(particle);
    burstParticles.push(particle);
  }
  for (const sprite of glows) container.addChild(sprite);
  for (const sprite of rings) container.addChild(sprite);
  container.addChild(bursts);

  const effects: Effect[] = [];
  for (let i = 0; i < MAX_EFFECTS; i += 1) effects.push(blankEffect());

  const modulation: AmbienceModulation = { godRayIntensity: 1, planktonAlpha: 1, washWarmth: 0 };
  /** The climate walk is persistent state, not a decaying effect: it holds. */
  let climateWarmth = 0;
  let climateTarget = 0;
  let nextBurstSlot = 0;
  let glowsUsed = 0;
  let ringsUsed = 0;
  /** True while any burst mote is visible; gates the particle buffer upload. */
  let burstLive = false;
  let frameMs = 0;
  let eventSeed = 1;

  function mount(parent: Container): void {
    parent.addChild(container);
  }

  function ingest(events: readonly AmbientEvent[]): void {
    for (const ambient of events) {
      const event = ambient.event;
      switch (event.kind) {
        case 'meteor':
          spawn('meteor', ambient.receivedAtMs, METEOR_TTL_MS, (effect) => {
            effect.x = event.x;
            effect.y = event.y;
            effect.radiusWu = event.radiusWu;
            claimBurst(effect, METEOR_BURST_MOTES);
          });
          break;
        case 'planktonCrash':
          spawn('planktonCrash', ambient.receivedAtMs, clampDurationMs(event.durationTicks), (effect) => {
            effect.magnitude = event.productivityMultiplier;
            effect.region = event.region;
          });
          break;
        case 'kelpStorm':
          spawn('kelpStorm', ambient.receivedAtMs, clampDurationMs(event.durationTicks), (effect) => {
            effect.region = event.region;
            claimBurst(effect, KELP_DEBRIS_MOTES);
          });
          break;
        case 'thermalShock':
          spawn('thermalShock', ambient.receivedAtMs, THERMAL_SHOCK_MS, (effect) => {
            effect.magnitude = event.magnitudeC;
          });
          break;
        case 'cladeFounding':
          spawn('cladeFounding', ambient.receivedAtMs, CLADE_TTL_MS, (effect) => {
            effect.x = event.x;
            effect.y = event.y;
          });
          break;
        case 'climateEvent':
          // No flash. The climate walk is the one event that should read as a
          // change in the light rather than as something that happened.
          climateTarget = clamp(event.meanOffsetC / CLIMATE_SATURATION_C, -1, 1);
          break;
        default:
          break;
      }
    }
  }

  function spawn(kind: EffectKind, startMs: number, ttlMs: number, fill: (effect: Effect) => void): void {
    let effect: Effect | undefined;
    for (const candidate of effects) {
      if (!candidate.active) {
        effect = candidate;
        break;
      }
    }
    if (effect === undefined) return; // At the cap: drop, never grow the pool.
    effect.active = true;
    effect.kind = kind;
    effect.startMs = startMs;
    effect.ttlMs = ttlMs;
    effect.x = 0;
    effect.y = 0;
    effect.radiusWu = 0;
    effect.magnitude = 0;
    effect.region = null;
    effect.burstStart = -1;
    effect.burstCount = 0;
    effect.seed = eventSeed;
    eventSeed = (eventSeed + 7919) % 0x7fffffff;
    fill(effect);
  }

  function claimBurst(effect: Effect, count: number): void {
    if (count > BURST_POOL) return;
    if (nextBurstSlot + count > BURST_POOL) nextBurstSlot = 0;
    effect.burstStart = nextBurstSlot;
    effect.burstCount = count;
    nextBurstSlot += count;
  }

  function update(nowMs: number, dtMs: number): void {
    frameMs = nowMs;
    // Only clear what was actually drawn last frame. In the steady state — which
    // is nearly all of the time, since these are rare events — this whole
    // function touches nothing and uploads nothing.
    for (let i = 0; i < glowsUsed; i += 1) {
      const sprite = glows[i];
      if (sprite !== undefined) sprite.visible = false;
    }
    for (let i = 0; i < ringsUsed; i += 1) {
      const sprite = rings[i];
      if (sprite !== undefined) sprite.visible = false;
    }
    const hadBurst = burstLive;
    if (hadBurst) for (const particle of burstParticles) particle.alpha = 0;
    burstLive = false;
    glowsUsed = 0;
    ringsUsed = 0;

    modulation.godRayIntensity = 1;
    modulation.planktonAlpha = 1;
    let shockWarmth = 0;

    for (const effect of effects) {
      if (!effect.active) continue;
      const age = nowMs - effect.startMs;
      if (age >= effect.ttlMs) {
        effect.active = false;
        effect.region = null;
        continue;
      }
      switch (effect.kind) {
        case 'meteor':
          drawMeteor(effect, age);
          modulation.godRayIntensity *= 1 - METEOR_RAY_DIM * (1 - age / effect.ttlMs);
          break;
        case 'cladeFounding':
          drawCladeBeacon(effect, age);
          break;
        case 'planktonCrash':
          if (effect.region === null) modulation.planktonAlpha *= crashLevel(effect, age);
          break;
        case 'kelpStorm':
          drawKelpDebris(effect, age);
          break;
        case 'thermalShock': {
          const decay = 1 - age / effect.ttlMs;
          const sign = effect.magnitude >= 0 ? 1 : -1;
          shockWarmth += sign * 0.5 * decay * Math.sin(age * 0.012);
          modulation.godRayIntensity *= 1 + 0.22 * decay * Math.sin(age * 0.019);
          break;
        }
      }
    }

    // Exponential approach rather than a linear ramp: a second climate event
    // mid-drift retargets smoothly instead of restarting the animation.
    climateWarmth += (climateTarget - climateWarmth) * (1 - Math.exp(-dtMs / CLIMATE_TAU_MS));
    modulation.washWarmth = clamp(climateWarmth + shockWarmth, -1, 1);
    modulation.godRayIntensity = Math.max(0, modulation.godRayIntensity);
    // One upload on the frame motes appear, one on the frame they go out.
    if (hadBurst || burstLive) bursts.update();
  }

  function drawMeteor(effect: Effect, age: number): void {
    if (age < METEOR_FLASH_MS) {
      const glow = claimGlow();
      if (glow !== null) {
        glow.position.set(effect.x, effect.y);
        glow.width = effect.radiusWu * 3.2;
        glow.height = effect.radiusWu * 3.2;
        glow.tint = 0xffffff;
        glow.alpha = 0.6 * (1 - age / METEOR_FLASH_MS);
      }
    }
    if (age < METEOR_RING_MS) {
      const t = age / METEOR_RING_MS;
      const ring = claimRing();
      if (ring !== null) {
        ring.position.set(effect.x, effect.y);
        setRingRadius(ring, effect.radiusWu * 1.5 * easeOut(t));
        ring.tint = 0xcfe8f2;
        ring.alpha = 0.5 * (1 - t);
      }
    }
    if (age < METEOR_BURST_MS && effect.burstStart >= 0) {
      const t = age / METEOR_BURST_MS;
      for (let k = 0; k < effect.burstCount; k += 1) {
        const particle = burstParticles[effect.burstStart + k];
        if (particle === undefined) continue;
        const angle = anchorHash(effect.seed + k) * Math.PI * 2;
        const reach = effect.radiusWu * (0.6 + anchorHash(effect.seed + k + 1) * 1.4);
        // Decelerating throw: debris loses to the water quickly.
        const r = reach * (1 - Math.exp(-3 * t));
        particle.x = effect.x + Math.cos(angle) * r;
        particle.y = effect.y + Math.sin(angle) * r;
        particle.alpha = 0.6 * Math.pow(1 - t, 1.5);
      }
      burstLive = true;
    }
  }

  function drawCladeBeacon(effect: Effect, age: number): void {
    const life = 1 - age / effect.ttlMs;
    const glow = claimGlow();
    if (glow !== null) {
      glow.position.set(effect.x, effect.y);
      const size = CLADE_PING_RADIUS_WU * 0.7;
      glow.width = size;
      glow.height = size;
      glow.tint = 0xbff0e0;
      glow.alpha = 0.34 * life * (0.65 + 0.35 * Math.sin(age * 0.006));
    }
    // Sonar pings: a founding is the rarest event the sim produces, so it gets
    // the one flourish that repeats rather than fading once.
    for (let k = 0; k < CLADE_PING_COUNT; k += 1) {
      const local = age - k * CLADE_PING_SPACING_MS;
      if (local < 0 || local >= CLADE_PING_LIFE_MS) continue;
      const t = local / CLADE_PING_LIFE_MS;
      const ring = claimRing();
      if (ring === null) return;
      ring.position.set(effect.x, effect.y);
      setRingRadius(ring, CLADE_PING_RADIUS_WU * easeOut(t));
      ring.tint = 0x9fe8cf;
      ring.alpha = 0.42 * (1 - t) * life;
    }
  }

  function drawKelpDebris(effect: Effect, age: number): void {
    const region = effect.region;
    if (region === null || effect.burstStart < 0) return;
    const t = age / effect.ttlMs;
    const seconds = age / 1000;
    for (let k = 0; k < effect.burstCount; k += 1) {
      const particle = burstParticles[effect.burstStart + k];
      if (particle === undefined) continue;
      const u = anchorHash(effect.seed + k * 3);
      const v = anchorHash(effect.seed + k * 3 + 1);
      const speed = 14 + anchorHash(effect.seed + k * 3 + 2) * 22;
      const spanX = region.kind === 'rect' ? region.widthWu : region.radiusWu * 2;
      const spanY = region.kind === 'rect' ? region.heightWu : region.radiusWu * 2;
      const originX = region.kind === 'rect' ? region.xWu : region.xWu - region.radiusWu;
      const originY = region.kind === 'rect' ? region.yWu : region.yWu - region.radiusWu;
      // Debris runs along the swath's long axis, which is the way the storm went.
      const alongX = spanX >= spanY;
      const travel = ((alongX ? u * spanX : v * spanY) + speed * seconds) % (alongX ? spanX : spanY);
      particle.x = originX + (alongX ? travel : u * spanX);
      particle.y = originY + (alongX ? v * spanY : travel);
      particle.alpha = 0.4 * (1 - t);
    }
    burstLive = true;
  }

  function crashLevel(effect: Effect, age: number): number {
    const target = clamp(effect.magnitude, 0, 1);
    const recover = Math.min(CRASH_RECOVER_MS, Math.max(0, effect.ttlMs - CRASH_FALL_MS));
    const recoverStart = effect.ttlMs - recover;
    if (age < CRASH_FALL_MS) return 1 + (target - 1) * (age / CRASH_FALL_MS);
    if (age < recoverStart) return target;
    return target + (1 - target) * easeOut((age - recoverStart) / Math.max(1, recover));
  }

  function claimGlow(): Sprite | null {
    const sprite = glows[glowsUsed];
    if (sprite === undefined) return null;
    glowsUsed += 1;
    sprite.visible = true;
    return sprite;
  }

  function claimRing(): Sprite | null {
    const sprite = rings[ringsUsed];
    if (sprite === undefined) return null;
    ringsUsed += 1;
    sprite.visible = true;
    return sprite;
  }

  const hooks: HazeHooks = {
    get planktonAlpha(): number {
      return modulation.planktonAlpha;
    },
    planktonCellMultiplier(xWu: number, yWu: number): number {
      let value = 1;
      for (const effect of effects) {
        if (!effect.active || effect.kind !== 'planktonCrash' || effect.region === null) continue;
        const weight = regionWeight(effect.region, xWu, yWu);
        if (weight <= 0) continue;
        value *= 1 + (crashLevel(effect, frameMs - effect.startMs) - 1) * weight;
      }
      return value;
    },
    frondSwayAt(xWu: number, yWu: number): number {
      let value = 1;
      for (const effect of effects) {
        if (!effect.active || effect.kind !== 'kelpStorm' || effect.region === null) continue;
        const weight = regionWeight(effect.region, xWu, yWu);
        if (weight <= 0) continue;
        const decay = 1 - (frameMs - effect.startMs) / effect.ttlMs;
        value += (KELP_SWAY_PEAK - 1) * weight * Math.max(0, decay);
      }
      return value;
    },
  };

  function reset(): void {
    for (const effect of effects) {
      effect.active = false;
      effect.region = null;
      effect.burstStart = -1;
      effect.burstCount = 0;
    }
    climateWarmth = 0;
    climateTarget = 0;
    nextBurstSlot = 0;
    eventSeed = 1;
    burstLive = false;
    glowsUsed = 0;
    ringsUsed = 0;
    modulation.godRayIntensity = 1;
    modulation.planktonAlpha = 1;
    modulation.washWarmth = 0;
    for (const sprite of glows) sprite.visible = false;
    for (const sprite of rings) sprite.visible = false;
    for (const particle of burstParticles) particle.alpha = 0;
    bursts.update();
  }

  function destroy(): void {
    container.destroy({ children: true });
    glowTexture.destroy(true);
    ringTexture.destroy(true);
    moteTexture.destroy(true);
  }

  return { mount, ingest, update, modulation, hooks, reset, destroy };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function blankEffect(): Effect {
  return {
    active: false,
    kind: 'meteor',
    startMs: 0,
    ttlMs: 0,
    x: 0,
    y: 0,
    radiusWu: 0,
    magnitude: 0,
    region: null,
    burstStart: -1,
    burstCount: 0,
    seed: 0,
  };
}

function makeSprite(texture: Texture): Sprite {
  const sprite = new Sprite(texture);
  sprite.anchor.set(0.5, 0.5);
  sprite.blendMode = 'add';
  sprite.visible = false;
  return sprite;
}

function setRingRadius(sprite: Sprite, radiusWu: number): void {
  const size = (radiusWu * 2) / RING_RADIUS_FRACTION;
  sprite.width = size;
  sprite.height = size;
}

export function clampDurationMs(durationTicks: number): number {
  return clamp(durationTicks * NOMINAL_MS_PER_TICK, DURATION_MIN_MS, DURATION_MAX_MS);
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function easeOut(t: number): number {
  const clamped = clamp(t, 0, 1);
  return 1 - (1 - clamped) * (1 - clamped);
}

/** 1 well inside the region, easing to 0 across its outer quarter. */
function regionWeight(region: DisturbanceRegion, x: number, y: number): number {
  if (region.kind === 'disc') {
    const dx = x - region.xWu;
    const dy = y - region.yWu;
    const d = Math.sqrt(dx * dx + dy * dy) / Math.max(1e-6, region.radiusWu);
    if (d >= 1) return 0;
    return d <= 0.75 ? 1 : (1 - d) / 0.25;
  }
  return axisWeight(x, region.xWu, region.widthWu) * axisWeight(y, region.yWu, region.heightWu);
}

function axisWeight(value: number, origin: number, span: number): number {
  if (span <= 0) return 0;
  const t = (value - origin) / span;
  if (t <= 0 || t >= 1) return 0;
  const edge = 0.125;
  if (t < edge) return t / edge;
  if (t > 1 - edge) return (1 - t) / edge;
  return 1;
}

function bakeGlowTexture(): Texture {
  return bakeAlphaTexture(GLOW_TEXTURE_PX, GLOW_TEXTURE_PX, (u, v) => {
    const dx = u - 0.5;
    const dy = v - 0.5;
    const r = Math.sqrt(dx * dx + dy * dy) / 0.5;
    return r >= 1 ? 0 : Math.exp(-(r * r) * 4.5) * (1 - r * r);
  });
}

function bakeRingTexture(): Texture {
  return bakeAlphaTexture(RING_TEXTURE_PX, RING_TEXTURE_PX, (u, v) => {
    const dx = u - 0.5;
    const dy = v - 0.5;
    const r = Math.sqrt(dx * dx + dy * dy) / 0.5;
    if (r >= 1) return 0;
    const d = (r - RING_RADIUS_FRACTION) / 0.075;
    return Math.exp(-d * d);
  });
}

function bakeMoteTexture(): Texture {
  return bakeAlphaTexture(MOTE_TEXTURE_PX, MOTE_TEXTURE_PX, (u, v) => {
    const dx = u - 0.5;
    const dy = v - 0.5;
    const r = Math.sqrt(dx * dx + dy * dy) / 0.5;
    return r >= 1 ? 0 : Math.exp(-(r * r) * 5.5) * (1 - r * r);
  });
}
