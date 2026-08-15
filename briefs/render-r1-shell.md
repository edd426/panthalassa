# R1 — Pixi shell, camera, LOD, interpolation, colour map, integration

You are one of four parallel implementers on Panthalassa's Phase B render wave
(deep-water-cinematic PixiJS 8 renderer replacing the crude canvas dots). Read
`CLAUDE.md` first. The seam everything compiles against is
`src/render/contracts.ts` (orchestrator-owned, committed — **read-only for
you**, like all of `src/contracts/**`; if it is missing something you need,
STOP on that part and say so in your report rather than working around it).

## You own (create/edit ONLY these)

- `src/render/renderer.ts` — `createRenderer(canvas, config): Promise<WorldRenderer>`
- `src/render/layerRegistry.ts` — layer composition point (see below)
- `src/render/camera.ts` + `src/render/camera.test.ts` — PURE math
- `src/render/cameraController.ts` — DOM wiring
- `src/render/lod.ts` + `src/render/lod.test.ts` — PURE
- `src/render/interpolation.ts` + `src/render/interpolation.test.ts` — PURE
- `src/render/colourMap.ts` + `src/render/colourMap.test.ts` — PURE
- `src/render/fieldOverlay.ts` — the diagnostic `f`-key raster layer
- `src/render/selectionLayer.ts` — selection halo (pulsing sonar-ring, `waterAbove` slot)
- `src/render/fallback.ts` — adapter making `CrudeRenderer` satisfy `WorldRenderer`
- `src/app/main.ts` — the integration rewiring (surgical; described below)

Do NOT touch: `src/contracts/**`, `src/render/contracts.ts`,
`src/render/fieldSampling.ts`, `src/render/creatures/**` (R2's),
`src/render/ambience/**` (R3's), `src/app/hud.ts`, `src/app/charts.ts`,
`index.html` (R4's), `src/app/crudeRenderer.ts` (except: nothing — leave it),
`package.json` (pixi.js 8.19.0 is already installed), `src/sim/**`,
`src/probes/**`, `vitest.config.ts`. Do not `npm install` anything. Do not
commit — the orchestrator verifies and commits.

## Design (decided; implement, don't relitigate)

**Shell** (`renderer.ts`): `await Application.init({ canvas, preference:
['webgpu','webgl'], antialias: true, resolution: Math.min(devicePixelRatio, 2),
autoDensity: true, backgroundAlpha: 0 or the abyss colour })` on the existing
`#world` canvas. **Stop the Pixi ticker** — `main.ts`'s rAF stays the
conductor; `draw(frame)` ends with exactly one `app.render()`. Build the five
z-ordered container slots from the seam's `MountContext` (`backdrop`,
`waterBelow`, `creatures`, `waterAbove`, `foreground`); apply the camera
transform each frame to the three world-space slots (position/scale on a
shared parent is fine); screen-space slots are untouched by the camera. Mount
every layer from `layerRegistry.ts` with a `MountContext` whose
`generateTexture` wraps `app.renderer.generateTexture`. If `Application.init`
throws OR the URL has `?renderer=crude`, return `fallback.ts`'s adapter
around `CrudeRenderer` instead (its `pushEvents`/`reset`/`isDragClick` are
no-ops returning false).

**layerRegistry.ts**: exports `createLayers(): RenderLayer[]`. Ship it
returning `[fieldOverlayLayer, selectionLayer]` with a clearly marked
`// INTEGRATION POINT:` comment where the orchestrator will splice in R2's
creature layer and R3's ambience layer (they land in parallel with you; do
not import their files — they may not exist yet when you build).

**Per-frame pipeline in `draw(frame)`** (pooled, zero allocation in steady
state):
1. New slice (identity check vs previous `frame.slice`)? →
   `interpolator.ingest(slice, nowMs)`; `colourMap.resolve(...)` recomputes
   tints/alphas/legend once per slice (percentile spans here, never per rAF).
2. Camera controller applies pending input + inertia → `CameraState`.
3. `interpolator.sample(nowMs, camera)` fills the pooled `CreatureFrame`
   (fills poses/visuals/tints/alphas/visible; morphology via the seam's
   `resolveMorphology` — the slice now carries real values at stride 13,
   indices `SAMPLE_SLICE.segmentCount/finPairs/bodyAspect/armorPlating`).
4. `lod.select(prev, { pxPerWu, visibleCount, speedMultiplier, renderMsEma,
   medianSizeCm })` → `LodState`.
5. Build the pooled `FrameContext`; call `update()` on every layer in
   registry order; drain the event queue into `FrameContext.events` (cap 32).
6. `app.render()`; feed the measured ms into `renderMsEma` for the governor.

**camera.ts** (pure): `fitWorld(viewportW, viewportH, worldW, worldH)`
reproduces the crude letterbox exactly (uniform scale, centred);
`zoomAt(state, cursorX, cursorY, factor)` keeps the world point under the
cursor fixed; zoom clamped to [fit scale, 20 px/wu]; `pan`; viewport clamped
to world rect + 10% margin; `toWorld`/`toScreen` inverses.

**cameraController.ts**: wheel = exponential zoom (`1.0015 ** -deltaY`)
anchored at cursor; drag-pan with a 4 px threshold before it counts as a
drag; ~120 ms exponential inertia; dblclick and the `0` key = animate to
fit-all; `isDragClick(event)` true when the click ended a drag. Attach
listeners to the canvas; keys via window keydown but ONLY `0` (the app's
other keys live in main.ts — don't collide).

**lod.ts** (pure): tiers `near|mid|far|abyss` per the seam. Entry criteria on
`Lpx = medianSizeCm * CM_TO_WU * pxPerWu`: near `Lpx≥40 ∧ visible≤250 ∧
speed≤16`; mid `Lpx≥10 ∧ visible≤1500 ∧ speed≤64`; far `Lpx≥3`; else abyss.
±15% hysteresis bands + 500 ms stability before switching; frame-time
governor: `renderMsEma > 11` → demote one tier, hold ≥2 s; promote only after
`< 7 ms` sustained 3 s. `blend` ramps 0→1 over 220 ms on switch,
`previousTier` non-null during the fade.

**interpolation.ts** (pure): double-buffered slices with arrival timestamps;
render at `now − intervalEma` so poses are always interpolated, never
extrapolated (identical-tick slices while paused: ignore). Slot matching via
a persistent `Int32Array(MAX_SLOTS)`; a slot lerps only if present in both
slices AND continuity holds (`Δdist < 60 wu`, same speciesTag, `|Δsize| <
30%`), otherwise it's a slot-reuse → spawn fade-in (~250 ms). Slots that
vanish become death ghosts fading out 200 ms (cap 256 ghosts). Heading =
`atan2` of deltas with shortest-arc EMA (α≈0.25); below a speed floor hold
the last heading. Per-slot `jitter` = stable hash of slot index → [0,1).
`speed` in wu/s. Output fills the seam's `CreatureFrame`; `visible` = row
indices inside a 10%-padded viewport, sorted by sizeCm ascending.

**colourMap.ts** (pure): line-for-line port of
`crudeRenderer.drawOrganisms`'s colour logic — read that file. Identity: 48
hue buckets of `hsl(h 72% 58%)` (convert to 0xRRGGBB ints). Adaptedness:
`divergingAt((tOpt − sampleRaster(temperature, x, y)) / thermalReferenceC)`
(use `src/render/fieldSampling.ts`'s `sampleRaster`). Diet: `divergingAt((v −
0.5) * 2)`. speedCap/defense: `rampAt(SEQUENTIAL_AMBER, (v − p5) / (p95 −
p5))` with the percentile span over the living, recomputed once per slice.
Energy: ramp on energyFraction. Every mode: alpha = `clamp(0.3 +
energyFraction * 0.7, 0.3, 1)`. Trait mode without traitValues → identity
for that frame. Produce the same `ColourLegend` strings as
`crudeRenderer.buildLegend` (port it; the HUD prints these). Import
`src/app/palette.ts` (hex strings → ints once at module load); never fork
palette values. Species-ring hue helper (golden-angle 137.508°) exported for
R2's use at near/mid tiers.

**fieldOverlay.ts**: a `RenderLayer` that shows `FrameContext.overlayRaster`
via `normaliseField` → RGBA texture (`Texture.from` buffer resource,
**nearest** filtering — it is a diagnostic, keep it honest), stretched over
the world rect in `waterBelow`... actually place it in `waterAbove` *below*
selection so it reads over the ambience; hidden when overlay === 'off'.

**selectionLayer.ts**: pulsing ring at `FrameContext.selected` (world
coords), drawn in `waterAbove`; ring radius ~14 px / pxPerWu, 2 px stroke,
soft outward-fading pulse on wall clock (the R4 restyle's "sonar ping"
signature — a slow 2 s expanding echo ring is right).

**main.ts rewiring** (keep the diff surgical; everything else in that file
stays): async construction `const renderer: WorldRenderer = await
createRenderer(canvas, config)` (top-level await is fine); add
`renderer.pushEvents(message.events)` in both `onTicked` and `onEvents`
handlers; extend `pollField()` to also round-robin one of
plankton/kelp/temperature per 500 ms tick into cached ambience rasters and
pass them in the `draw()` frame object (`plankton`/`kelp` fields); click
handler starts with `if (renderer.isDragClick(event)) return;`; `startWorld`
calls `renderer.reset()`. The `renderer.draw`, `resize`, `toWorld`,
`pixelsPerWu`, `colourLegend` call sites keep working because
`WorldRenderer` preserves those signatures.

## Constraints

- TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
  + `verbatimModuleSyntax` (`import type` for types). ESLint zero warnings.
- Pure modules (`camera`, `lod`, `interpolation`, `colourMap`) import NO pixi
  and NO DOM — they must run under node vitest (env is node; no jsdom).
- Wall clock (`performance.now`) and `Math.random` are fine in `src/render`
  and `src/app` — but prefer deterministic per-slot jitter over randomness.
- No allocation inside `draw()` in steady state: pool CreatureFrame,
  FrameContext, scratch arrays.
- Comments: constraints and non-obvious why only, matching the codebase voice.

## Acceptance probe (the orchestrator re-runs this verbatim)

```
npm run typecheck && npm run lint && npx vitest run src/render/camera.test.ts src/render/lod.test.ts src/render/interpolation.test.ts src/render/colourMap.test.ts
```

plus `npm run build` green, plus all four test files exist with the
assertions from the wave plan: zoomAt fixes the cursor point / fitWorld ==
crude letterbox / toWorld∘toScreen identity / zoom+pan clamps; LOD
boundaries + hysteresis no-flap + governor demote-and-hold; interpolation
slot matching, midpoint lerp, slot-reuse spawn-fade (not cross-world lerp),
ghost expiry, shortest-arc across ±π; colourMap parity with crude semantics
including the p5–p95 outlier case, alpha floor, traitValues-absent fallback,
and legend text per mode. Run the full `npm test` once at the end to prove
you broke nothing (261 tests were green before you started).

Report back: what you built, probe output, any seam gaps you hit and how you
stopped (never worked around) them.
