# G5 — Render: juveniles on screen, signals in colour

The wave's presentation package. Read `CLAUDE.md`, DESIGN.md "Phase B — the
render wave" and the R5 record, then `briefs/g-wave-design.md` §4 (G-A/G-B
"Renderer" paragraphs). Contracts v1.8 landed the feed: `SAMPLE_SLICE`
stride 17 with `lifeStage: 15` (1 = mature, 0 = juvenile) and
`conspicuousness: 16`; channel 4 (`size`) has carried **realised length**
since G2, so juveniles already arrive small — your job is to make them read
as *young*, not merely small, and to make the signal axis visible.

## You own

`src/render/**`, `src/app/**`, `index.html`. Nothing else.
`src/contracts/**` FROZEN — missing contract = STOP and report. Do not
touch `src/sim/**`, `src/probes/**`, `src/stats/**`.

A probes/stats package (G4) runs concurrently in `src/probes/**` and
`src/stats/**` — expect its uncommitted edits in the tree; never touch its
files. If `npm test` shows failures there, ignore them and say so in your
report; your acceptance gates are the render/app suites plus build.

No commits — the orchestrator re-runs your probe, reviews, and commits.

## The work

1. **Plumb the two channels** through the seam: `VISUAL` stride grows by 2
   (`lifeStage`, `conspicuousness`) in `src/render/contracts.ts`,
   `readCreatureVisual` fills them, `src/render/interpolation.ts` copies
   them (lifeStage snaps — never lerp a 0/1 flag; conspicuousness lerps).
2. **Juveniles read as young** (near/mid tiers; far tiers get it free from
   length): for `lifeStage === 0`, reduced fin development and a slightly
   larger relative eye in the near-tier bodies, and a subtle translucency
   lift (~0.85× alpha). Follow the archetype's existing body construction
   in `src/render/creatures/bodies.ts` — the treatment must survive the R5
   caricature amplification without fighting it. Keep it restrained: the
   size difference is already the main signal.
3. **Conspicuousness drives saturation and contrast**: at draw time, map
   the (unbounded, renderRange-clamped like every morphology channel)
   conspicuousness onto tint saturation — negative = duller/greyer toward
   the water (cryptic), positive = more saturated with a slight
   luminance lift (loud). Wire it wherever tints are resolved
   (`src/render/colourMap.ts`) so every colour mode inherits it, but make
   identity mode the reference look and confirm the other modes stay
   legible. The mapping must be monotone and centred so conspicuousness 0
   is exactly today's look — the off-arm world must render pixel-identical.
4. **Toxicity in the inspector only** — it is deliberately NOT on the
   slice (the watcher must infer who is toxic the way the predators do).
   The inspector/specimen panel (`src/app/hud.ts`) gains toxicity and
   conspicuousness rows for the selected organism if the organism query
   already carries the trait vector; if it does not, STOP and report the
   gap rather than widening the protocol. A juvenile/mature line in the
   specimen label is welcome (data is on the slice).
5. **Trends**: if the deep-trends panel ('t') can cheaply gain a
   life-history or toxicity chart from series the recorder already emits,
   do it; if the series names are not yet stable (G4 is landing them
   concurrently), leave charts alone and say so — do not guess at series
   names.

## Rules

- Presentation may use wall-clock and `Math.random` for jitter, but never
  feeds the sim and never consumes sim RNG.
- No allocation in per-frame paths; pooled everything; respect the
  frame-time governor and the LOD fill-cost ordering (the R5 tests pin it).
- Off-arm pixel identity: with ontogeny+aposematism off, every organism has
  `lifeStage 1` and conspicuousness ≈0 at founding — your mappings must
  make that render exactly as today (centred mapping, no-op at 0/1).

## Acceptance probe (orchestrator re-runs verbatim)

```
npm run typecheck && npx eslint src/render src/app --max-warnings=0 && npx vitest run src/render && npm run build
```

Report: what you built per file, the conspicuousness→saturation mapping
with its centring argument, the juvenile treatment choices, whether the
inspector had the data (gap report if not), what you did or skipped in
trends and why, probe output tail, and any contract gaps. A glass review
happens later on the orchestrator's side — you do not need a browser. No
commits.
