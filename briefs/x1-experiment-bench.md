# X1 — The experiment bench (god tools UI)

Overnight wave, user-directed: "the ability for me to interact with the world
more and possibly conduct some experiments. Like walling off two populations
to let them evolve independently under different conditions, but allowing
migration to happen between them. or suddenly being able to remove the wall
then seeing what happens." Read `CLAUDE.md` first, then
`src/contracts/protocol.ts` (the `SimCommand` union is your whole backend —
it already does everything: `raiseBarrier` with **permeability** IS the leaky
wall, `lowerBarrier` IS the sudden removal), `src/contracts/types.ts`
(`BarrierShape`, `DisturbanceRegion`), `src/contracts/genome.ts` (clade macro
loci — an `introduceMutant` on them founds a body-plan clade), and
`src/app/main.ts` (the conductor you wire into).

## You own

- `src/app/godTools.ts` (new) — the bench: DOM built into the existing empty
  `<section id="bench" hidden>` (do NOT touch index.html; inject a `<style>`
  element from this module, using the R/V design tokens already defined in
  index.html's `:root` — read them, reuse them, match the station-log
  register: small-caps labels, hairline rules, phosphor values).
- `src/app/godTools.test.ts` — node-env tests for the pure parts (shape
  construction from two world points, command payload building, barrier
  bookkeeping reducer).
- `src/app/main.ts` — wiring only (described below).

Do NOT touch: index.html, hud.ts, charts.ts, palette.ts, src/render/**,
src/contracts/**, package.json. Another agent (X2) works in charts/trends
files concurrently — stay out. No commits.

## The bench (keyboard `g` toggles; also pause-aware — commands work paused)

1. **Wall tools** — the star of the show:
   - "RAISE WALL" arms a draw mode: the next two clicks on the ocean define
     the wall through those world points (use the `BarrierShape` kinds that
     exist in types.ts — read them and pick the natural fit; P8's probe
     scenario in `src/probes/scenarios.ts` shows a working `raiseBarrier`
     payload to copy the shape idiom from).
   - Permeability slider 0.00–1.00 (default 0) applied at raise time —
     label it MIGRATION so the concept reads ("0 = sealed · 1 = open water").
   - Active-walls list (id, permeability, age in ticks) each with a DROP
     button → `lowerBarrier`. Track the list locally from commands you issue
     plus `barrierChange` events (main.ts can hand you those — see wiring).
   - While draw mode is armed, clicks must NOT fall through to the
     inspect-select handler (see wiring), and the cursor/status must show the
     armed state ("WALL: click two points · esc cancels").
2. **Climate** — a target-offset slider (−6…+6 °C) + APPLY →
   `setClimateTarget`; show the current offset from the latest series data if
   available, else the applied target.
3. **Disturbances** — three buttons (THERMAL SHOCK, PLANKTON CRASH, KELP
   STORM) each with small magnitude/duration presets; crash/storm optionally
   regional: armed-click places a disc region (`DisturbanceRegion`), or a
   GLOBAL toggle for the crash. → `triggerDisturbance`.
4. **Meteor** — arm+click → `meteor` at the clicked world point, radius
   slider 50–400 wu.
5. **Found a clade** — arm+click → `introduceMutant` at that point on a clade
   macro locus with the allele that yields radialDrifter (and a second button
   for armoredCrawler): read `CLADE_MACRO_TABLE`/`cladeArchetypeFor` in
   genome.ts to pick locus+allele values that actually produce each
   archetype. Count from the table, don't guess. This is how the user meets
   the other two body plans without waiting ~1e5 births.

Every issued command appends a line to the event feed (wiring gives you a
`note` callback) in the house voice: `wall W1 raised · permeability 0.25`,
`wall W1 dropped after 3,120 ticks`.

## main.ts wiring (surgical)

- Instantiate the bench after the renderer exists; pass it: a
  `(command: SimCommand) => Promise<unknown>` that gates on `live` like every
  other send, `renderer.toWorld`, a `note(line)` callback into the feed, and
  a way to register a click-interceptor so armed modes swallow canvas clicks
  before the select handler runs (a simple `bench.handleCanvasClick(x, y):
  boolean` consulted at the TOP of the existing click listener — true =
  consumed).
- `g` key in the existing keydown handler toggles the bench; `Escape`
  cancels an armed mode (route to bench). Extend the HUD key-legend string in
  main.ts ONLY if the legend lives there — it lives in hud.ts which you must
  not touch; instead the bench's own header carries its key hints.
- On reseed (`startWorld`) call `bench.reset()`.

## Acceptance probe (orchestrator re-runs verbatim)

```
npm run typecheck && npx eslint src/app/godTools.ts src/app/godTools.test.ts src/app/main.ts --max-warnings=0 && npx vitest run src/app/godTools.test.ts && npm run build
```

plus `npm test` full-suite green at the end. Tests must cover: barrier shape
built from two world points matches the types.ts contract; permeability
clamps to [0,1]; the clade-founding button's locus/allele pair provably maps
to the intended archetype via `cladeArchetypeFor`; the armed-mode reducer
(arm → click → click → command payload → disarm; esc cancels). Report what
you built + probe output. TS strict; comments = constraints/why only; no
commits; no Chrome (the orchestrator does glass verification).
