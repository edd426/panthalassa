# R3 — Water ambience + event flourishes

You are one of four parallel implementers on Panthalassa's Phase B render
wave. Read `CLAUDE.md` first. Art direction: **deep-water cinematic** — dark
abyssal teals, drifting marine snow, god-ray light shafts toward the warm
latitude, resource fields as soft luminous haze. The ambience is the stage;
it must never upstage the creatures (R2's package, built in parallel).

The seam you compile against is `src/render/contracts.ts`
(orchestrator-owned, committed — **read-only**, as is all of
`src/contracts/**`; hit a gap → STOP on that part and report, never work
around). Key pieces for you: `RenderLayer`, `MountContext` (your slots:
`backdrop` screen-space, `waterBelow` world-space, `foreground` screen-space,
plus `waterAbove` for flourish shockwaves/beacons; `config` for
`thermal`/world geometry; `generateTexture`), `FrameContext` (camera, rasters
`plankton`/`kelp`/`temperature`, `events: AmbientEvent[]`, nowMs, paused,
speedMultiplier), `FieldRaster`. Shared raster math:
`src/render/fieldSampling.ts` (`normaliseField`, `rasterSpan`, `rasterMean`,
`sampleRaster`) — use it, don't duplicate it.

## You own (create ONLY these)

- `src/render/ambience/ambienceLayer.ts` — the `RenderLayer`; composes the rest; export `createAmbienceLayer(): RenderLayer`
- `src/render/ambience/godRays.ts`
- `src/render/ambience/particulate.ts` + `particulate.test.ts` — drift math is PURE
- `src/render/ambience/fieldHaze.ts`
- `src/render/ambience/flourishes.ts`

Import ONLY: `../contracts`, `../fieldSampling`, `src/contracts/**`
(read-only), `src/app/palette.ts`, `pixi.js` (8.19.0, installed). Do NOT
import R1/R2 files (parallel, may not exist), touch main.ts / index.html /
package.json, `npm install`, or commit — the orchestrator verifies, wires
your layer into R1's registry, and commits.

## The pieces

**Backdrop** (screen-space `backdrop` slot): full-screen vertical gradient
sprite, near-black abyssal teal `#06222e → #020b11` (Pixi 8 `FillGradient`,
rebuild on resize). Over the world rect (world-space, `waterBelow` bottom): a
subtle wash keyed to `config.thermal` — the warm y-edge marginally brighter
and greener, preserving the at-a-glance latitude read the crude renderer had
(read its `draw()` gradient for the tone reference: `#0d3a4a → #071f2c`,
warm = y 0 side... check `thermal` config for which edge is warm rather than
assuming). Faint 2 px rim stroke around the world; the void outside the world
rect stays darker than the sea, so panning past the edge reads as the edge.

**God rays** (`waterBelow`): ~8 pre-baked soft-beam gradient textures (tall
quads, additive blend, alpha 0.04–0.10) rooted at the warm y-edge, tilted
10–25°, gentle wall-clock sway (rotation ±2°, alpha breathing, 20–40 s
desynchronised periods). Parallax 0.85: offset your container by
`(1 − 0.85) · cameraOffset` each frame. Intensity fades toward the cold edge.

**Marine snow** (`particulate.ts`): background ~600 large dim motes
(world-space, parallax 0.92, behind creatures) + foreground ~400 small
brighter motes (screen-space `foreground`, parallax 1.15). Positions are a
**pure function** `driftPos(i, nowMs)` — slow fall + sinusoidal drift over a
wrapping tile larger than the viewport, offset by camera — zero per-particle
state, zero allocation. Two `ParticleContainer`s (Pixi 8: `Particle` objects,
`addParticle`, declare dynamic properties; position dynamic, color static).

**Field haze** (`fieldHaze.ts`, `waterBelow`): the 80×48 rasters →
`normaliseField` RGBA → `Texture.from({ resource, width: cols, height: rows })`
with **linear** filtering, stretched over the world rect, additive blend —
plankton in resource green (86,214,132, alpha ≤0.25 — ambience is subtler
than the diagnostic overlay), kelp deeper green. Rasters refresh ~2 s; keep
two stacked sprites and cross-fade 1 s so updates never pop. **Kelp fronds**:
each kelp raster update, take the ~40 richest cells as anchors; 3–5
quadratic-curve blades per anchor in one pooled Graphics, swaying on wall
clock; anchors keyed by cell index persist across updates (fronds must not
teleport). Fronds are the one place ambience gets structural detail — they
sell "reef", and kelp is where prey hide from predators.

**Flourishes** (`flourishes.ts`): a capped active-effects list (≤32) fed from
`FrameContext.events` each frame, each effect decaying on **wall-clock TTL**
(sim durations only clamp: 4–20 s). Match on `event.event.kind`
(`src/contracts/events.ts` is the union — handle these, ignore the rest):
- `meteor` (x, y, radiusWu): 150 ms additive white flash; ring stroke
  expanding to radiusWu×1.5 over 1.2 s, alpha→0 (in `waterAbove`); ~80-mote
  impulse burst; god rays dim 30% for 2 s.
- `planktonCrash` (productivityMultiplier, region?): ease the plankton haze
  target alpha down ×multiplier over 1 s, recover over 8 s; regional crash →
  apply per-cell inside the haze build (expose a multiplier hook from
  flourishes to fieldHaze).
- `kelpStorm` (region): frond sway amplitude ×3 decaying over 8 s + a few
  shed-debris motes drifting through the region.
- `thermalShock` (magnitudeC): 3 s shimmer — world wash tint pulses warm or
  cool by sign, god rays flicker. No full-screen filters in v1.
- `cladeFounding` (x, y): 6 s beacon — expanding concentric sonar-ping rings
  + soft glow at the founder (`waterAbove`). This is the rarest, most
  precious event in the sim; make it feel like one.
- `climateEvent` (meanOffsetC): no flash — drift the world wash tint toward
  warm/cool over 10 s. The climate walk becomes ambient light.

`reset()` clears every active effect, haze state and frond anchors (reseed).
`paused` freezes drift phase advancement (hold, don't snap).

## Constraints

TS strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` +
`verbatimModuleSyntax`; ESLint zero warnings; comments = constraints and
non-obvious why. Wall clock legal; prefer index-derived phase over
`Math.random` so screenshots reproduce. Zero allocation per frame in steady
state. Everything must stay legible UNDER the creatures: additive alphas low,
motes small, rays faint.

## Acceptance probe (the orchestrator re-runs this verbatim)

```
npm run typecheck && npm run lint && npx vitest run src/render/ambience/particulate.test.ts
```

plus `npm run build` green. `particulate.test.ts` asserts: `driftPos`
deterministic in (i, t); wrap-seam continuity (position at tile edge and
just past it differ by ~one step, no popping); mote spread covers the tile.
Run the full `npm test` once at the end to prove you broke nothing.

Report back: what you built, probe output, any seam gaps (STOPPED, not
worked around).
