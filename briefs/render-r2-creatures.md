# R2 — Procedural creature rendering (spine-chain bodies, LOD tiers)

You are one of four parallel implementers on Panthalassa's Phase B render
wave. Read `CLAUDE.md` first. The world is an aquatic evolution sim; bodies
are **procedural** — no authored sprites, ever. Art direction: deep-water
cinematic — creatures read as softly bioluminescent forms in their evolved
display hues against a dark abyssal ocean.

The seam you compile against is `src/render/contracts.ts` (orchestrator-owned,
committed — **read-only**, as is all of `src/contracts/**`; hit a gap → STOP
on that part and report it, never work around it). Key seam pieces for you:
`RenderLayer`, `MountContext` (your container slot is `slots.creatures`;
`generateTexture` is provided), `FrameContext`, `CreatureFrame` +
`readCreatureVisual` + `CreatureVisual`, `LodState`, `CM_TO_WU`,
`resolveMorphology` (already renderRange-clamps against
`src/contracts/genome.ts` `CLADE_SCHEMA` — read that schema's
`interpretation` strings; they are your drawing spec). The colour mode is
already resolved upstream: you receive per-creature `tint` (0xRRGGBB) and
`alpha` and must not reimplement colour logic.

## You own (create ONLY these)

- `src/render/creatures/creatureLayer.ts` — the `RenderLayer`
- `src/render/creatures/spine.ts` + `spine.test.ts` — PURE kinematics
- `src/render/creatures/bodies.ts` + `bodies.test.ts` — PURE outline builders
- `src/render/creatures/shapeTextures.ts` — mount-time texture baking
- `src/render/creatures/pool.ts` — Graphics/Sprite/Particle pools

Import ONLY: `../contracts` (the seam), `../fieldSampling` (if needed),
`src/contracts/**` (read-only), `src/app/palette.ts`, `pixi.js` (8.19.0,
already installed). Do NOT import R1's or R3's files (they're being built in
parallel and may not exist), do NOT touch main.ts / index.html / package.json,
do NOT `npm install`, do NOT commit — the orchestrator verifies and commits.
R1 will splice your layer into its registry at integration; just export
`createCreatureLayer(): RenderLayer` from `creatureLayer.ts`.

## The four LOD tiers (the seam's `LodState.tier` tells you which; honor `blend`/`previousTier` with a 220 ms alpha cross-fade of the incoming tier's container)

| tier | renders | mechanism |
|---|---|---|
| near | full animated procedural body + additive glow underlay | pooled `Graphics`, `.clear()` + rebuilt each frame from `bodies.ts` points; glow = shared radial-gradient texture Sprite, additive blend, tinted |
| mid | recognisable tinted silhouette with visible undulation | pooled `Sprite`s over pre-baked **4-phase flipbook textures** per archetype (bake at mount via `MountContext.generateTexture` from the same `bodies.ts` geometry at 4 phase values); per frame set position/rotation/scale/tint/alpha and `texture = phases[(now·f + jitter·4) & 3]` |
| far | oriented soft silhouette, tint + alpha | `ParticleContainer` (dynamic position/rotation/color), one baked 64 px silhouette per archetype |
| abyss | soft glow dot | `ParticleContainer` (dynamic position/color), one radial glow texture |

All four tier containers live permanently under `slots.creatures`; unused
tiers `visible = false`. Iterate only `frame.creatures.visible` rows (already
viewport-culled, sorted by size ascending so big animals draw on top). The
**selected** organism (`FrameContext.selected`, match by nearest visible row
within ~10 wu) is always promoted to a near-tier Graphics body even at
far/abyss, so the inspected animal is the drawn animal. Multiply every
creature's alpha by its `fade` (birth/death fades from the interpolator).
Pixi 8 notes: `Graphics` is shape-then-`.fill()/.stroke()`; `ParticleContainer`
uses `Particle` objects in `particleChildren` with `addParticle`; declare
`color` a dynamic particle property (tints change every slice).

## Bodies (pure geometry — the heart of this package)

Build in a unit local frame (body length 1, head at origin, +x forward),
scale by `sizeCm * CM_TO_WU`, rotate to `heading`. `spine.ts` and `bodies.ts`
take plain numbers/objects and return point arrays — **no pixi imports** so
they test headless. Animation phase derives from `nowMs` (wall clock) plus
per-creature `jitter`, NEVER sim ticks — at 256× the water hums but bodies
still swim at believable rates; observed `speed` modulates vigour.

- **undulator** (the ancestral fish/eel): spine = `segmentCount` points along
  a travelling sine — lateral offset `A(s)·sin(2π(s/λ) − φ)`, amplitude
  envelope growing tail-ward 0.02→0.12 of length, λ≈0.8, `φ = 2π(now/1000 ·
  f + jitter)`, `f = clamp(0.9 + speed·k, 0.6, 3)` Hz. Body = spine offset by
  a fusiform half-width profile (`width = length / bodyAspect`, widest ~30%
  back) closed into a polygon; `finPairs` triangular fin pairs at even spine
  stations fluttering with per-fin phase lag; small bright eye dot near the
  head. High bodyAspect must read eel-like, low read stubby.
- **radialDrifter** (medusa): bell = superellipse of aspect `bodyAspect`,
  translucent fill (alpha ×0.45) + bright rim stroke — the jellyfish read;
  slow pulse (scale ±8%, period ~2.2 s + jitter) with a quicker contraction
  snap and slow relax; `segmentCount` = radial symmetry order → short arm
  strokes around the rim; `finPairs` = trailing tentacle pairs lagging the
  pulse phase, trailing anti-heading; heading heavily smoothed (drifters
  drift).
- **armoredCrawler** (benthic arthropod): stiff spine (amplitude ×0.3,
  higher f); `segmentCount` somites as overlapping rounded plates whose
  widths follow a carapace profile of aspect `bodyAspect`; `armorPlating` →
  plate stroke weight + desaturated mineral lightening of the fill;
  `finPairs` limb pairs as short paddle strokes with **metachronal phase
  offsets** (the travelling leg wave); dorsal midline highlight.

Species identity at near/mid: a thin ring or rim accent in the species hue
(golden-angle `137.508° * speciesTag`, matching the crude renderer) only when
colour mode is identity — R1's colourMap owns body tint; you own only this
rim accent. Keep it subtle.

## Performance rules

Zero allocation per frame in steady state: preallocate point arrays at max
segment count, pool Graphics/Sprites/Particles (`pool.ts`), reuse a single
scratch `CreatureVisual`. Near tier is capped by the LOD contract at ≤250
visible bodies; budget ~30–60 vertices per body.

## Constraints

TS strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` +
`verbatimModuleSyntax`; ESLint zero warnings; comments = constraints and
non-obvious why only. Wall clock is legal here; `Math.random` is legal but
prefer jitter-derived determinism so screenshots are reproducible.

## Acceptance probe (the orchestrator re-runs this verbatim)

```
npm run typecheck && npm run lint && npx vitest run src/render/creatures/spine.test.ts src/render/creatures/bodies.test.ts
```

plus `npm run build` green. Tests must assert: segment spacing preserved
under undulation; phase periodicity (φ and φ+2π identical); amplitude
envelope monotone tail-ward; head at origin, chain extends anti-heading;
outlines respect `CLADE_SCHEMA` renderRange clamps for all three archetypes;
point counts are the documented function of (segments, finPairs); bodyAspect
changes width, not length; all three archetypes produce non-self-crossing
closed outlines at typical parameters. Run the full `npm test` once at the
end to prove you broke nothing.

Report back: what you built, probe output, any seam gaps (STOPPED, not worked
around).
