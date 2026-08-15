# R4 — UI restyle: R/V Panthalassa station chrome

You are one of four parallel implementers on Panthalassa's Phase B render
wave. Read `CLAUDE.md` first. While R1–R3 build a cinematic PixiJS ocean
(deep-water: abyssal teals, bioluminescent creatures, god rays), you restyle
the HUD chrome so it belongs to that world. **Presentation only — zero
behavioural change.**

## Identity (decided)

An oceanographic research vessel's instrument station. The page is the
viewport of **R/V PANTHALASSA**; the status block is its station log; the
inspector panel is a specimen label; the charts are the survey trace. Ground
every choice in that register (sonar readouts, expedition logbook, catalogue
numbers) — not a generic dark dashboard.

Design tokens (CSS custom properties in index.html; use these, extend
sparingly):
`--abyss: #041824` (panel base) · `--ink: #d8f2ff` · `--ink-dim: #7fa8b8` ·
`--phosphor: #6ff2c4` (live readouts) · `--amber: #f0b747` (matches the data
palette's SEQUENTIAL_AMBER) · `--alert: #ff8264` (extinction).
Type: the existing monospace stays for data; add letter-spaced small-caps
~10px labels for section headers. **Signature element: the sonar ping ring**
— a slow expanding echo ring used for the extinction banner pulse and any
focus/selection accents you style (R1 draws the in-world selection halo with
the same motif).

## You own (edit ONLY these)

- `index.html` — the inline `<style>` block and, if needed, minimal wrapper
  markup around the EXISTING elements. The element ids `world`, `status`,
  `panel`, `charts`, `banner` and the `<script>` tag are load-bearing —
  main.ts queries them; do not rename, remove or change their tag types.
- `src/app/hud.ts` — how it FORMATS text (labels, casing, rules/dividers,
  ordering, the station-log voice). Its API is frozen: `Hud` constructor
  signature, `render(model: HudModel)`, `showSelection(dump)`,
  `describeEvent` export, the `HudModel`/`ExtinctionNotice` shapes. The key
  legend must keep naming every real binding (space pause · 1-9 speed · f
  field · c colour · t trends · click inspect — plus Phase B's new wheel
  zoom / drag pan / dblclick or 0 fit, which R1 is adding; word them in).
  It may build styled DOM (spans/classes) instead of raw textContent if you
  want richer typography — but keep `render()` cheap: it runs every frame,
  so build DOM structure once and update text nodes, never innerHTML per
  frame.
- `src/app/charts.ts` — visual constants only (colours, line weights, grid,
  legends, panel titles, margins). The `TrendSeries` columns,
  `appendTrendRow`/`createTrendSeries`/`resetTrendSeries`, class API and the
  `STRIP_HEIGHT_FRACTION` ↔ `#charts` height sync (34vh — if you change one,
  change both) are frozen. **Before touching chart colours, invoke the
  `dataviz` skill** (Skill tool) and follow its accessibility/palette
  method; `src/app/palette.ts` is the validated palette — read its header,
  use its exports, never fork values. Series colours #3987e5/#d95926 keep
  their validated contrast against the panel base.

Do NOT touch: `src/app/main.ts` (R1 is rewiring it in parallel — collisions
here are the wave's one merge hazard), `src/app/palette.ts`,
`src/app/crudeRenderer.ts`, `src/render/**`, `src/contracts/**`,
`package.json`. No `npm install`. No commits — the orchestrator verifies and
commits.

## What good looks like

- `#status` (top-left): station-log block — a small-caps header line
  (`R/V PANTHALASSA · SEED <seed>`), aligned data rows with dim labels and
  phosphor values, a thin rule before the event feed; feed lines prefixed
  with a small ping glyph. Keep it `pointer-events: none` and compact — it
  overlays the ocean.
- `#panel` (top-right, the inspector): specimen label — catalogue number
  (the organism id) as the header, rule lines between sections, trait rows
  with percentile context readable at a glance. It scrolls; keep it so.
- `#charts`: survey trace — same data, quieter grid, titled panels in
  small-caps, ±1σ bands subtler than the mean lines.
- `#banner` (extinction): the ship's somber all-stations notice — `--alert`
  accent, sonar ping pulse (CSS animation), the death tally as a clean
  table, restart hint. It must remain `pointer-events: none` and hidden by
  default.
- Background page colour must coordinate with R3's abyss gradient
  (`#06222e → #020b11`) — the chrome floats on the ocean, slightly
  translucent panels (`rgba` of `--abyss`) with a 1px hairline border in
  `--ink-dim` at low alpha are in-register.
- Motion: CSS only, subtle, and never continuous on large surfaces (the GPU
  belongs to the ocean). The ping animation runs on discrete events
  (banner appearing), not perpetually.

## Constraints

TS strict + `exactOptionalPropertyTypes` + `verbatimModuleSyntax`; ESLint
zero warnings; comments = constraints and non-obvious why. `hud.render`
runs per frame — no per-frame DOM structure churn, no layout thrash.

## Acceptance probe (the orchestrator re-runs this verbatim)

```
npm run typecheck && npm run lint && npm test \
  && grep -q 'id="world"' index.html && grep -q 'id="status"' index.html \
  && grep -q 'id="panel"' index.html && grep -q 'id="charts"' index.html \
  && grep -q 'id="banner"' index.html \
  && grep -q 'pause' src/app/hud.ts && grep -q 'inspect' src/app/hud.ts
```

plus `npm run build` green. All 261 pre-existing tests must stay green — you
change no behaviour.

Report back: what you built, probe output, one-paragraph description of the
visual language you landed (the orchestrator screenshots it afterwards).
