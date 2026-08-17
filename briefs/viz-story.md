# V1 — story-telling readouts: overlays, colour modes, deep-history panels

## Why

The user asked for "more interesting overlays, graphs, and colors — some that
would make sense and help tell the story of what's happening." The sim records
far more story than the screen currently shows: death causes, macro-allele
frequencies, life-history structure, the climate chase, the whole aposematism
axis. This package widens the three readout surfaces — organism colour modes,
field overlays, deep-history panels — using only data that already flows.

## Owned files

`src/render/contracts.ts` (extend `ColourMode`/`COLOUR_MODES`/
`FieldOverlay`/`FIELD_OVERLAYS` and legend types), `src/render/colourMap.ts`,
`src/render/colourMap.test.ts`, `src/render/fieldOverlay.ts`,
`src/render/fieldSampling.ts` (the one field→RGBA palette; a carrion branch
belongs there, not in a parallel palette), `src/app/trends.ts` +
`trends.test.ts` (the live `t`-key deep-history surface — the brief
originally said `charts.ts`, which is a dead panel that `#charts` never
unhides; corrected by the implementer's report), `src/app/hud.ts` (legend
strings only), `src/app/main.ts` (field polling only). Nothing in `src/sim/**`, `src/stats/**`, or
`src/contracts/**` — the one protocol change this needed (`'carrion'` in
`FieldSliceField`, worker handler) is already landed by the orchestrator.

## Deliverables

### 1. Carrion overlay
`FIELD_OVERLAYS` gains `'carrion'`. Pick a palette distinct from plankton
green and kelp deep-green — carrion reads as pale/bone against the abyss.
Wire `src/app/main.ts`'s round-robin background field polling
(`AMBIENCE_FIELDS` stays ambience-only unless carrion belongs there — decide
and say why) and the overlay legend. Story: where the dead are settling, and
who scavenges.

### 2. New colour modes
Study `colourMap.ts`'s existing semantics first (identity hue buckets,
adaptedness diverging vs sampled temperature, amber p5–p95 ramps recomputed
per slice, energy alpha, fallback-to-identity) and follow them exactly.
The slice carries any `TraitKey` via `sampleSlice(traitKey)` — the plumbing
from mode → traitKey is `traitKeyForMode`. Add:

- **`toxicity`** — the aposematism story: watch chemical defence spread
  (only alive with `?aposematism=1`; off-arm the trait sits ≈0 and the ramp
  degenerates — make sure the existing degenerate-ramp fallback handles it
  gracefully, and the legend says so rather than lying with a flat ramp).
- **`boldness`** (traitKey `forageBoldness`) — pairs with the kelp overlay
  and kelp storms: the timid live in the forests, the bold in open water.

Each mode gets a station-log legend naming the quantity and its endpoints
(existing pattern in hud legend strings). If, while in there, you find another
trait whose spatial pattern tells a story these two don't (argue it in one
sentence in your report), you may add a third — no more.

### 3. Deep-history panels (`t`)
First inventory `src/contracts/stats.ts` (`SampleRow`) and the existing
panels in `trends.ts` — add only stories not yet told. (Implementer audit:
four of the five candidates below already exist in trends.ts; only
macro-allele frequencies is missing. Add it plus at most 1–2 genuinely new
stories.) Original candidate list, for the record:

- **Deaths by cause over time** (composition: starvation / predation /
  thermal / age / catastrophe / toxin) — what is killing the world right now.
- **Macro-allele frequencies** (`discreteAlleleFreq`) — the clade story: a
  body-plan allele rising is the founding event's aftermath, visible.
- **Juvenile fraction + mean length** (`lifeHistory`) — the ontogeny story.
- **Mean thermal optimum vs. actual water °C** — the climate chase: does the
  population track a ramp you apply from the bench?
- **Mean toxicity + free-rider fraction** — the aposematism story (armed
  worlds).

Follow the existing chart framework and visual language exactly (zoom ranges,
reset, colours off the palette tokens). If a `dataviz` skill is listed in your
environment, load it before chart work; if none is listed, proceed.

## Constraints

- Presentation only. Never touch sim RNG; never import from `src/sim/**`
  except existing type-only imports already present in these files.
- The help overlay's readout lines join `COLOUR_MODES`/`FIELD_OVERLAYS`
  directly, so they update themselves — do not edit `helpOverlay.ts`.
- Do not rename DOM ids, existing mode names, or key bindings.
- Comments: constraints and non-obvious why only.

## Acceptance probe

```
npm run build > /tmp/v1-build.log 2>&1; echo "build=$?"
npm run lint  > /tmp/v1-lint.log  2>&1; echo "lint=$?"
npm test      > /tmp/v1-test.log  2>&1; echo "test=$?"
grep -c "carrion" src/render/contracts.ts   # ≥ 1
grep -c "toxicity" src/render/colourMap.ts  # ≥ 1
```

All exit codes 0, greps non-zero, and `colourMap.test.ts` covers the new
modes (ramp endpoints, fallback on degenerate data). Report actual exit
codes, the panels you chose with one-line rationales, and any candidate you
rejected for missing data. Do NOT commit — the orchestrator reviews and
commits.
