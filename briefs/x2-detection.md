# X2 — Detection: deep-history trends + divergence instruments + alerts

Overnight wave, user-directed: "there's no point in having surprises if I'm
not able to detect them somehow, whether that's a rich set of charts or some
other form of analysis or alerts." Read `CLAUDE.md`, then
`src/contracts/stats.ts` (`SampleRow` — your entire data source),
`src/app/charts.ts` (the sparkline panels you are superseding),
`src/app/palette.ts` (frozen; use its exports), and index.html's `:root`
design tokens + the `#charts`/`#trends` elements (both exist; `#trends` is
an empty div reserved for you — do NOT edit index.html itself).

**Invoke the `dataviz` skill (Skill tool) before designing the charts.**

## You own

- `src/app/trends.ts` (new) — uPlot deep-history charts (uplot@1.6.32 is
  installed; `import 'uplot/dist/uPlot.min.css'` works under Vite, and you
  may inject a small `<style>` for the panel chrome).
- `src/app/alerts.ts` (new) — PURE detection functions over `SampleRow`
  streams.
- `src/app/alerts.test.ts`, `src/app/trends.test.ts` — node-env tests for
  every pure part (series building, downsampling, detectors).
- You do NOT edit `main.ts` (another agent owns it tonight) and do NOT edit
  `charts.ts`/`hud.ts`. Instead your report ends with an exact, minimal
  integration diff for main.ts (imports, init, the row-ingest call, the `t`
  key behaviour swap, reset) that the orchestrator applies verbatim. Design
  your API so that diff is ≤ 20 lines: e.g. `createTrends(container:
  HTMLElement)` returning `{ ingest(row: SampleRow): void; setOpen(open:
  boolean): void; resize(): void; reset(): void; alerts:
  ReadableStream-like or callback }` — your call, but ONE object, tiny
  surface.

## Charts (`#trends`, replacing the `t`-key canvas sparklines)

Requirements the old canvas panels fail: multi-thousand-generation series
(the user runs 5,000+ generation overnights) with pan/zoom (uPlot cursor +
range selection), readable axes/legends, and panels for the experiment the
user most wants to run — walls:

1. Population, with per-species breakdown when species > 1.
2. The four focal traits (size, tOpt, diet, defense): mean ±1σ band.
3. Attack vs defense + predator fraction (the arms-race panel).
4. **Divergence panel — the wall experiment readout**: `popgen.fstDemes` and
   `popgen.fstBarrier` over time, plus `populationByDeme` as a compact
   stacked area — Fst climbing after a wall goes up IS the experiment
   working, and the user must see it without a probe run.
5. Deaths by cause per generation (stacked rate) + resources
   (plankton/kelp/carrion totals, `resources.*` + carrion if present).
6. Heterozygosity + neTemporal (the variance economy).

Downsample intelligently for render (min/max-preserving bucketing, never
naive striding — spikes are the signal), keep raw arrays for zoom. Dark
theme matching the R/V register: panel base from the tokens, series colours
from palette.ts exports (SERIES_1/SERIES_2 + derive extra hues distinctly),
small-caps panel titles.

## Alerts (`alerts.ts` — pure, tested; this is the "or some other form of
analysis" half)

Detectors over the incoming `SampleRow` sequence, each returning typed alert
objects `{ tick, severity: 'notice'|'alert', line: string }` with feed-ready
lines in the house voice:

- Trait excursion: any focal trait mean moves > 2 pooled-σ within a 20-gen
  window ("size is running · +2.3σ in 18 gen").
- Guild collapse / rebirth: predatorFraction crossing below 0.05 or above
  0.15 with hysteresis ("the hunters are gone · predator share 3%").
- Fst surge: fstBarrier or fstDemes rising > 0.1 above its trailing 50-gen
  median ("populations diverging across the wall · Fst 0.31").
- Population regime: crash (>40% drop over 5 gens) and cap-riding (>85% of
  slot capacity sustained 20 gens).
- Diversity drain: heterozygosity falling > 0.15 over 100 gens.
Thresholds as named constants with a one-line why each; every detector
edge-triggered with hysteresis so a hovering value cannot spam. Tests feed
synthetic rows and assert exact trigger/no-trigger cases both sides of each
threshold.

## Acceptance probe (orchestrator re-runs verbatim)

```
npm run typecheck && npx eslint src/app/trends.ts src/app/alerts.ts src/app/trends.test.ts src/app/alerts.test.ts --max-warnings=0 && npx vitest run src/app/alerts.test.ts src/app/trends.test.ts && npm run build
```

plus full `npm test` green at the end. Report: what you built, probe output,
and the exact main.ts integration diff. TS strict
(noUncheckedIndexedAccess/exactOptionalPropertyTypes/verbatimModuleSyntax);
comments = constraints/why; no commits; no Chrome.
