# R5 — Morphological divergence (the "too samey" fix)

User direction, verbatim: *"I'd like to see a little bit more divergent
morphology between all the different creatures. At the moment they're a bit
too samey, even when zoomed in."*

Read `CLAUDE.md` first. Then read your own package end to end —
`src/render/creatures/` (bodies.ts, spine.ts, shapeTextures.ts,
creatureLayer.ts, pool.ts and the three test files) — plus the seam
`src/render/contracts.ts` (CreatureVisual, VISUAL stride, resolveMorphology,
LOD tier machinery) and `src/contracts/genome.ts` `CLADE_SCHEMA` (typicals +
renderRanges). The art direction is deep-water cinematic: soft bioluminescent
forms in abyssal teal water; divergence must read as *different animals*, not
as cartoon decals.

## Why they look samey (measured, not guessed)

1. **Realised trait CV is 6–10%** in every run (DESIGN.md tuning log). The
   morphology channels (segmentCount, finPairs, bodyAspect) hover near the
   archetype typical — the population never spans the renderRanges, so drawing
   the raw values produces near-clones.
2. **One archetype dominates.** `cladeMacroA/B` stay fixed at allele 0 for
   whole runs, so ~everyone is an undulator.
3. **The traits that DO diverge were invisible.** Diet ratchets +1.4 logits
   over a run; defense moved +3.3σ in 20 generations during the wall
   experiment. Neither had any effect on body form.
4. **Mid tier collapses variety**: one 4-phase flipbook per archetype, so at
   mid zoom only tint varies.

## New channels (already landed, contracts v1.6 — commit 78f9139)

`CreatureVisual.diet` and `CreatureVisual.defense` now carry the raw expressed
values per organism (VISUAL stride 10). Diet is identity-linked (negative =
grazer/filterer, positive = hunter; population means reach ±1.5). Defense is
softplus-linked, non-negative, typically 0.3–3. Both unbounded — squash
smoothly (e.g. tanh(x/scale)), never hard-clamp with visible pops.

## You own

`src/render/creatures/**` only. Do NOT touch: `src/render/contracts.ts` (the
seam is orchestrator-owned — report needed changes), `interpolation.ts`,
`colourMap.ts`, ambience, `src/app/**`, `src/contracts/**`, `index.html`. No
commits — the orchestrator reviews on glass, re-runs your probe, and commits.

## The work

1. **Caricature amplification (pure function, tested).** For the three
   schema morphology channels, amplify deviation-from-typical before the
   renderRange clamp: `draw = typical + gain · (value − typical)`, gain ≈ 2.5–3,
   with soft saturation approaching the renderRange edges (no hard corner, no
   sign flip — a genuinely longer-bodied fish must always draw longer).
   Deterministic per organism, no cross-frame or population state. Put it in a
   pure module so tests pin monotonicity, sign preservation, and range respect.
2. **Diet → head and jaw form (the headline).** Continuous morph from blunt
   rounded filter-feeder head (negative diet) through neutral fusiform to a
   tapered predatory jaw wedge with a visible gape/teeth notch and slightly
   larger eye (positive diet). Near tier: real geometry change in bodies.ts.
   Mid tier: bake the head form into the flipbook variants (below). This is
   the axis where the sim's actual story lives — hunters must *look* like
   hunters.
3. **Defense → spination/ridging.** Defense + armorPlating drive dorsal
   spines / plate ridging on undulators too (today armor only matters on
   crawlers). Low defense = smooth back; high = a visible serrated dorsal
   line. Near tier geometry; a subtler silhouette cue at mid if cheap.
4. **Species patterning.** A deterministic pattern family per organism —
   none / stripes / spots / countershading — chosen from speciesTag and
   jitter (stable per slot, no RNG), rendered at near tier as darkened
   fill regions, hinted at mid via flipbook variants. Two members of
   different species side by side should read as different animals.
5. **Mid-tier flipbook variety.** Replace one-flipbook-per-archetype with a
   small bucketed variant set (e.g. 3 bodyAspect buckets × 2 head forms ×
   2 pattern families per archetype — keep the total texture count bounded
   and documented). Bucket selection deterministic from the amplified
   channels. Texture memory and bake time must stay startup-bounded; note
   the count in your report.
6. **Far/abyss tiers unchanged in cost.** If a near-free silhouette-variant
   pick (by aspect bucket) fits the existing ParticleContainer texture path,
   take it; otherwise leave far/abyss alone. The fill-cost ordering across
   the camera-reachable zoom range [fit, 20 px/wu] must keep holding — the
   existing tests sweep it; extend them if you touch tier costs.

## Constraints

- All new logic Pixi-free and node-testable; Pixi confined to the existing
  layer/texture files. No allocation in the per-frame draw path (pool
  everything, follow the existing idiom).
- Wall-clock time may come only from the FrameContext (`nowMs`) — never
  `Date.now`/`performance.now` in your files (presentation exemption exists,
  but the package convention is nowMs so tests can drive time).
- The selected organism's near-tier promotion, death ghosts, spawn fades,
  and the LOD governor must keep working (creatureLayer tests cover these —
  keep them green, extend where behaviour legitimately changed).
- TS strict (noUncheckedIndexedAccess, exactOptionalPropertyTypes,
  verbatimModuleSyntax). Comments = constraints/why only.

## Acceptance probe (orchestrator re-runs verbatim)

```
npm run typecheck && npx eslint src/render/creatures --max-warnings=0 && npx vitest run src/render/creatures && npm run build
```

plus full `npm test` green at the end. Tests must cover: amplification
(monotone, sign-preserving, saturating, identity at typical), head-form morph
continuity (no discontinuity at diet 0), pattern-family determinism (same
slot+species → same pattern), bucket selection edges, and texture-count bound.
Report: what changed visually per tier, texture counts, any seam changes you
need, and the probe output.
