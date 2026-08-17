# Status — pickup state

_Last updated 2026-08-09 morning: **the pause is lifted** — after a second
overnight watch (same world, 5,277 generations; DESIGN.md "Deep time"), the
user gave the go: "It's time to get to work on all those things you mentioned
would make the simulation even more interesting to watch." **Gate A-3 is
passed** — two multi-thousand-generation watches with screenshot reviews
answer that gate's question far past its 30-minute spec. Execution order:
dose batch → probe:full → Gate A-2 (Sol) → roadmap items 1+2. Phase B
(PixiJS) still awaits its own explicit go. Originally written 2026-08-08
evening at the user's wind-down order, after Phase A waves 1–2, Gate A-1 +
fix wave, the A6 watchability upgrades, and the A7 campaign through its
discriminator phase._

## Resume HERE

**WAVE 1 IS VERIFIED END-TO-END (2026-08-17): the spec-length probe:full
adjudicated GREEN-AT-GATES.** `runs/full-gwave-impl.log` (8.6 h): suite
WARN, **restated P3 passes on all three baseline seeds** — the G0-run s3
gate red is closed by the criterion the adjudication prescribed, and the
criterion bites both ways (s3 passes at 1.19% dropped births vs the 2%
tolerance; s1's 0.998 is real ceiling exceedance, and it matches the
orchestrator's independent derivation from the *G0 run's* series to the
digit — which is also the off-arm bit-identity proof across all five
packages). Only off-arm value shifts are instrument composition (P6/P14
denominators grew with the genome). First spec-length arm data: P17 2/3
(CV 0.93–1.11, ratchet 0.42 now far under achieved — re-ratchet in G6;
s3 warn = the thin-predator-guild watch, 20 predators, 18.8% kill-window
overlap), P18 1/3 (s1 genotypic r 0.435 clears the 0.163 analytic null —
selection did it; seed-contingent otherwise), P19 0 cycles but precursors
present (free-rider peak ~0.54, persistent toxic rings 2/3 seeds), P10
0/3 on neutralD at its provisional bar. Full record: DESIGN.md "G-wave
spec-length adjudication". All five packages (G0/G1/G2/G3 + G4/G5)
committed and probe-verified; contracts at v1.8.

**THE G6 CAMPAIGN IS MOSTLY ADJUDICATED (2026-08-17, one session).**
Done, each with a DESIGN.md record: (1) **yolk rule** committed e318dea —
feeding never destroys held reserves, ontogeny-gated, off-arm
bit-identical; the G2 birthEnergy-vs-ceiling waste is closed. (2) **9-seed
base-rate panels** run and folded into the probes (0df2f27): P18
across-seed floor → 0.2 (coupling base rate 2/9), P19 asserts the
universal precursor state (free-rider ≥0.50, ring persistence ≥0.75;
cycle base rate 0/9, now reported-not-asserted), P10 floor → 1/9
(completion 2/9, neutral false-positive 1/9). (3) **Size-window pair**:
cliff grid + 9-run spec batch — 0.45/−4.45 wins on guild persistence and
attack maintenance, but does NOT move standalone (shared config);
selected as the flip-package candidate. (4) **G-B toxin cost**: doses
0.004/0.008 trade ring persistence away without producing an ordered
Batesian cycle — no knob moves, 0.002 defends itself; cycles need a
future mechanism (predator learning), not a price. (5) **Bootstrap
route** answered from data: toxinMacro is a passenger (<2.5% frequency on
every rising-toxicity seed) — standing variation drives aposematism.
REMAINING: the **flip package** — a 3-seed × 300g flip-candidate batch
(both toggles on + 0.45/−4.45) is running detached for joint viability
and the **mandatory biomass band re-derivation**; then the coordinated
flip commit (toggles + pair + band + P17 CV re-ratchet ~0.9), the
confirming probe:full, the P12 bar decision (8.74e5 vs pre-G1 9.0e5),
and the wave-closing fresh-seed P1 panel (D5 lesson).
Glass reviews owed at next display availability: R5 morphology
divergence + G5 juveniles/signals (needs ?ontogeny=1&aposematism=1 URL
flags; default URL renders as R5).

**TASK #18 IS DECIDED AND PHASE B IS GO (2026-08-15).** The user chose the
recommended lever: `carrion.maxIntake` 0.7 → 0.5 is committed as the default
(DESIGN.md "The maxIntake lever lands"). Cliff screen green (45 gens ×
s1–s3, no FAIL); the spec-length `probe:full` is running detached
(`runs/full-maxintake05.log`, pid 9533, launched ~18:45) — **its adjudication
is the next sim work**: P3 back in band? P7 predation share? and the open
question, whether halved scavenging depresses P16's ~1/8 base rate. The
carrion on-ramp unit test was re-scoped to the new crossover structure
(famine bridge, not destination) — see the DESIGN.md entry.

**THE PHASE B RENDER WAVE LANDED THE SAME EVENING** — built by four parallel
Opus agents (briefs in `briefs/render-*.md`), verified on glass through
two orchestrator fix rounds, closed with 399 tests + probe:quick green.
Full record: DESIGN.md "Phase B — the render wave" (including the browser-
only bug list and the residual polish queue). The user watched the wave
land and gave the overnight direction: (1) an **experiment bench**, (2) **detection to match**, (3) a **G-wave
design doc**.

**ALL THREE LANDED THE SAME NIGHT (~22:20), plus two build fixes.** The
experiment bench (`g` key; X1): two-click walls with a migration
(permeability) slider and DROP, climate target, disturbance presets, meteor,
introduceMutant clade founding. Detection (`t` key; X2): uPlot deep-history
charts with zoom, the "DIVERGENCE — THE WALL EXPERIMENT" Fst panel, and
edge-triggered alert detectors feeding the station log. G-wave proposal:
`briefs/g-wave-design.md` — **awaiting the user's morning review**; its
headline is that `size` written-once-at-birth (no juveniles) is upstream of
the predator-persistence front. Verified end-to-end on glass: wall raised →
detectors announced "the demes are pulling apart · Fst 0.18" → 0.25 → 0.33
with the Fst chart climbing → wall dropped at gen 100 (gif:
`~/Downloads/panthalassa_wall_experiment.gif`). Build fixes: R1's
un-hangable renderer boot (timeout + webgl retry + loud fallback), and the
production-only TLA deadlock — pixi.js now lives in its own Rollup chunk
(`vite.config.ts`); the prod bundle never booted Pixi before this. 491
tests. The renderer soak is opportunistic only — Chrome throttles occluded
windows, so tick counts, not wall-clock, measure what it actually exercised.

**WAVE 1 IS GO (2026-08-16 morning).** The user approved the G-wave's
Wave 1 ("Go ahead with your Wave 1 experiments you need in order to build up
to the richer genome") — per the design doc's §9 recommendations: G0 first
with its own probe:full, then G-A ontogeny + G-B aposematism, cannibalism
allowed with a cost knob, P3 restated in biomass. **G0 IS IMPLEMENTED**
(per-chromosome/per-birth forked RNG streams; parent consumption pinned by
`src/sim/genetics/g0-streams.test.ts`; golden hash deliberately re-baselined
d60c12703108a788 → 2937150f89939ef6; 498 tests) — record in DESIGN.md
"G0 — the genome made growable". Its probe:full verification run must be
adjudicated (regime unchanged in kind?) before G1 contracts work starts.
**G1 IS LANDED THE SAME MORNING** — the full v1.7 contract surface (5
traits, A5/A6, strategy macros, config blocks, formulas, SampleRow shapes,
toxinInvention event, snapshot v4, enableCarrion split) with the
**dark-chromosome rule** resolving the design doc's self-contradiction:
A5/A6 accumulate variation from tick 0 but express nothing until their
toggle is on, which is what keeps the off-arm byte-identical to G0
(verified against G0 source via worktree diff — exit 0) and makes the G0
spec run adjudicate G1's defaults too. 540 tests; quick green (P12
discounted, busy machine). Record: DESIGN.md "G1 — the v1.7 contracts
land". Next after the spec adjudication: G2 (ontogeny biology, Opus) then
G3 (aposematism), G4 (probes/stats incl. P3-as-biomass), G5 (render).
The same message asked for **more divergent creature morphology** ("too
samey, even when zoomed in") — contracts v1.6 landed (slice stride 15 +
visual stride 10 carrying expressed diet/defense, commit 78f9139) and render
package **R5** (briefs/render-r5-divergence.md: caricature amplification,
diet→jaw form, defense→spination, species patterning, bucketed flipbooks)
ran as an Opus agent on src/render/creatures/** — **LANDED AND COMMITTED**
(caricature amplification, diet→jaw, defense→spination, species patterns,
12 flipbook variants/archetype, aspect-banded far silhouettes; 88 render
tests; probe re-run by orchestrator). **Glass review still owed**: the
machine's display was occluded (visibilityState hidden, no rAF) — review
the near/mid tiers on screen at the next opportunity, against the user's
ask that creatures stop looking samey.

**THE SPEC RUN IS ADJUDICATED (2026-08-16 ~03:15): the lever stands.**
Suite WARN, zero FAILs — P3 green on all seeds, P7 in-band on all seeds,
P16 0/3 (inconclusive vs the ~1/8 base rate; the campaign still needs a
panel). New watch-item: P4 variance decay on s1/s2 in the cooled world.
Full record: DESIGN.md "The maxIntake lever at spec length — adjudicated".
Next sim work: the predation-pays campaign (P7 share up, P16 base rate as
the metric, P4 decay as a coupled watch-item) — and the user's morning
review of `briefs/g-wave-design.md`, whose Wave 1 likely subsumes parts of
that campaign.

The paragraph below is the pre-decision state, kept for context:

**D5 SPEC MEASUREMENT IS ADJUDICATED (2026-08-10 early morning).** The first
spec-length `probe:full` under the regime finished (481 min,
`runs/full-dwave.log`): **gates all PASS**, suite WARN, and the full
verdict-by-verdict adjudication against the pre-D-wave reference run is in
DESIGN.md "D5 measurement — spec-length adjudication". The short version:
P4 flipped from variance-decay to variance-growth (the regime pumps
variance); P15's scheduler is in-rate pooled and the per-seed rate criterion
is retired in favour of a pooled cross-seed row (implemented + tested this
commit); P7's predation collapse at spec length **predates the D-wave**
(pre-wave 6–10%, now 1–10%); P10 regressed 0/3 because crashes reverse
size-favouring sweeps (redesign decision queued, not retuned); P16 read 0/3
with partial signals in every seed — **a 6-seed panel (s4–s9) is running
detached** (`runs/p16-panel.log`) to size the base rate before any threshold
moves.

**The panel landed and D5 is CLOSED (2026-08-10, ~01:30).** Two results:
(1) **P16's moment is real but rare** — 9 seeds: one outright pass (s9,
diet Δ+0.349, attack ×2.27, guild persisted), seven misses with partial
signals, one crash-extinction (s8 died at gen 66.4). Base rate ~1/8;
ruling: no threshold ratchet — the warn is the honest state, and the base
rate is the target metric for the next campaign. (2) **The panel's fresh
seeds caught a live P1 gate bug** — mid-tick spatial-grid build made
restored runs diverge from uninterrupted ones (pre-existing since Phase A).
Fixed in `56dceab` (build moved to the tick boundary), P1 now PASS on
s1–s9+q1, golden hash re-baselined `d60c12703108a788`, 261/261 tests,
cliff + quick green (`runs/quick-post-p1fix.log`). Full record: DESIGN.md
"D5 measurement — spec-length adjudication".

**P3 IS RED AT SPEC LENGTH ON MAIN (2026-08-10 afternoon) — cause
understood, lever choice is the user's.** The P1 fix took two rounds
(`56dceab` boundary-only → `ad2ef3b` two builds per tick; P1 PASS
s1–s9+q1, P12 9.04e5, `runs/quick-post-p1fix2.log`), and BOTH rounds'
spec runs failed P3 on s2/s3 the same way: population riding the
4096-slot cap with births dropped (`runs/full-postfix.log`,
`runs/full-postfix2.log`; s2 breaches 3500 from gen 142). The
stale-candidates theory died with round two — the real cause is
additive: **carrion is a new energy channel on a world A7 tuned without
it** (pre-wave max pop 3127 → post-wave 3495, already at the band's
edge) and the corrected behavior roster (no phantom-corpse fleeing)
added the last nudge. The correct engine's carrying capacity simply
exceeds the P3 band, so the cap binds — violating
density-dependence-via-resources. This converges with the D5 headline:
the cooling lever and the predation-pays lever are likely the SAME
knob (nerf scavenging calories). **Lever screens are DONE**
(`runs/lever-*.log`, 200 gens on the two failing seeds; control
reproduced the hot world: s2 maxPop 4089 with 5,025 births dropped):

| lever | s2 maxPop | s3 maxPop | verdict |
|---|---|---|---|
| `carrion.decayHalfLifeGenerations` 1→0.5 | 3379, 0 drops | **4087, 2,472 drops** | fails s3 |
| `carrion.maxIntake` 0.7→0.5 | 2902, 0 drops | 2144, 0 drops | restores the band, both seeds |

Recommendation: `maxIntake` 0.7→0.5 — the only screened lever that
cools both seeds, and it is the direct nerf of
scavenging-as-terminal-strategy. Open question it does NOT answer:
whether a halved scavenging rate depresses P16's already-rare
re-ignition (base rate ~1/8) — that is the campaign's spec-length
measurement. The lever DECISION stays with the user (task #18) — no
config change is committed without it. Once chosen: cliff → spec
`probe:full` → update the D5 rows in DESIGN.md.

**The headline D5 finding: scavenging pays too well as a terminal strategy.**
Mean diet ratchets to +1.4/+1.6 and predator-fraction to ~0.95 while
predation deaths fall to 4–7% — carrion+plankton sustain high-diet organisms
without hunting, so the on-ramp functions as a destination and the arms race
stays cold. **The predation-pays tuning campaign is the next work**: make
hunting pay relative to scavenging (`carrion.maxIntake`/`qScav` down, prey
payoff up, or faster carrion decay), measured against spec-length P7
predation share and P16's base rate — take the lever choice to the user
with the D5 report first. Also still open from the wave agenda: a separate
carrion toggle for marginal-contribution runs. Phase B (PixiJS) still
awaits its own explicit go.

The paragraph below is the pre-measurement state, kept for context:

**THE D-WAVE IS MERGED (2026-08-09 evening, `b491a45`).** Roadmap items 1+2 —
disturbance regime (thermal shocks, plankton crashes, kelp storms) and the
carrion/scavenging on-ramp — are implemented (Sol as implementer,
`briefs/d-wave-sol.md`; its report at `briefs/d-wave-sol-report.md`),
orchestrator-verified (diff review, independent 260-test run, disturbances-off
golden hash reproduced against pre-wave source, merge-tree `probe:quick` green
— `runs/quick-post-dwave.log`), and committed. P15/P16 exist at warn; the
record is DESIGN.md "Roadmap 1+2 — the D-wave". D5 agenda
carried from the wave: pooled cross-seed P15 rates, a separate carrion toggle
for marginal-contribution runs, capacity-loop region-check cost (P12
headroom).

Earlier the same day, kept for context: **A7 IS CLOSED (2026-08-09).** The dose batch found no window (DESIGN.md
"The dose batch" — the slot cap, not mutation input, is the binding
constraint; 1.6e-3 stands) and the campaign-closing `probe:full` recorded
**zero FAILs** (`runs/full-close-1.6e-3.log`). Gate A-2 launched to Sol the
same day (brief: `briefs/gate-a2-sol.md`). Next after Sol's rulings: the
adjudication + any instrument fixes, then roadmap items 1+2
(`briefs/roadmap-1-2-design.md`, work packages D0–D5).

The paragraph below is the superseded pre-batch state, kept for context:
the one-batch mutation dose search (knob phase reopened for exactly this,
then closed). Bracket `quantMutationRate` ≈ 2.0/2.2/2.4e-3,
3 seeds. **Cliff-screen first**: 45 generations × 3 seeds per dose (~2 min)
before any spec-length run — every knob this campaign was bound by the
founding transient, and the screen rejects doomed doses for the price of a
coffee (3.2e-3 killed s3 at generation 12). Then spec length on survivors. Accept a dose iff: founding cliff survivable on all
seeds, P4 under its 8.0 ceiling, P14 above its 0.10 floor, AND the two-sided
arms race + P6 retention seen at 3.2e-3 persist. If no window exists, 1.6e-3
stands and the residual goes to Gate A-2 as measured. Then `LONG_SIM=1 npm run
probe:full` ONCE on the accepted config (hours accepted — see below) as the
campaign-closing record, then Gate A-2. Full context in "Where the second A7
session left it" below and DESIGN.md's tuning log.

## Where things stand

Phase A is complete except the tuning campaign. All packages A0–A6 are
committed and orchestrator-verified; Gate A-1 (Sol review) ran, failed,
was adjudicated, and every accepted defect is fixed (see DESIGN.md
"Review gates" — the durable record of the review, the rulings, and the
fix wave). 237 tests green, deterministic exit codes. Probe gates: P1
and P2 green; P12 at warn severity, 1.05×10⁶ org-ticks/s against the
original 2×10⁶ (adjudication of that number is a Gate A-2 agenda item).

**WP-A7 (tuning) is IN PROGRESS and is the next thing to resume.** A7 owns
DEFAULT_SIM_CONFIG values, probe thresholds/severities, and the DESIGN.md
tuning log — one knob change = one measured row = one commit. **The tuning
log is the authoritative campaign state**; `git log` gives the sequence.

Where the second A7 session left it:

- The world now survives 300 generations on three seeds and carries a
  predator guild on two of them (82–92% of samples, from 0–1% before).
  The lever was a mis-sized config default, not the genome: the predation
  size-ratio window peaked at 0.55 while realised size CV is 6–10%, so it
  paid 0.3 of its 2.0 logits. Fixed at 0.88 with `baseLogit` −4.45 giving
  the mean kill probability back — a shape change at constant intensity.
- **P1 was red and is fixed** (`d9d1839`): F4's memos returned a double on
  a miss and a float32 on a hit, so the first tick after a restore diverged.
  Every seed diverged; P1 caught it on one.
- Ratcheted: **P3, P5, P13 are gates now**; P14's ceiling tightened. P4, P6,
  P7, P9 stay warn because they are still red — they are the open front.
- **Still open**: P9 on s2 (that seed still falls into the filterer-monoculture
  basin), P7's starvation ceiling on 2 of 3 seeds, and P6/P4.
- **The single highest-value remaining experiment**, from the orchestrator's
  two discriminators (DESIGN.md "The two discriminators"): `quantMutationRate`
  around **2.0–2.4e-3** on three seeds. Mutation input, not the defense sweep,
  is what P6/P4 are short of — it dominates sweep consumption ~3.4× — and at
  3.2e-3 s1 reaches P6 0.958 **with** a 99% guild and the campaign's only
  two-sided arms race (attack 2.95 SD vs defense 2.93 SD). 3.2e-3 is too much:
  s3 dies at generation 12 of mutation load and s1 breaches P4's ceiling
  (8.27/8.0) and P14's floor (0.081/0.10). The window between is untested.
- The **founding transient is the campaign's recurring binding constraint** —
  it bound the size window, the attempt radius, and the mutation rate alike.
  Any future knob should be cliff-screened at 45 generations on 3 seeds first;
  that costs ~2 minutes and rejects most candidates.
- **`probe:full` costs ~2.5–3 hours and that is now the accepted price**
  (orchestrator ruling). It was budgeted at ~40 minutes when worlds died at
  generation 5; 3 seeds × 4 scenarios × up to 600 generations on surviving
  worlds is hours, and generations are not to be trimmed to fit the stale
  estimate. It runs in the background at gates and nightly. A7 measured and
  **rejected** `fieldCellSizeWu` as a way to buy the time back (6% for a 2.6×
  cell cut, and 50/60 wu starve the world) — the remaining wall-clock option is
  running the four independent scenarios as parallel processes, an A5 change.
- P8 and P10 ran for the first time on a surviving world: **P10 passes**
  (injected allele crossed 0.5 in 56 generations), **P8 half-passes** — Fst
  0.063 → 0.723 across the ridge, but cross/within mate acceptance is 1.03,
  i.e. no reproductive isolation. Narrowing `mating.prefSigmaBaseDeg` from 70°
  to 45° and 32° does not move it (1.01, 1.04), and neither does turning
  frequency-dependent predation off (1.02, with Fst reaching 0.931) — so
  `displayHue` genuinely does not diverge across the barrier, and A7's
  balancing-selection explanation is falsified. **P8's second criterion is
  currently unfalsifiable, not merely unmet**: `SampleRow` carries
  `populationByDeme` but no per-deme trait moments, so per-side hue means
  cannot be compared. That instrument gap is the blocker, not a knob.
- **Read DESIGN.md "The two discriminators" before the next tuning attempt.**
  A7 first read the configs as showing that P6/P4 and P7/P9 pull in opposite
  directions and told the orchestrator to treat "P6 and P9 green together" as
  unproven. The mutation discriminator falsified that: both go green at once on
  s1 at 3.2e-3. The correlation holds only at a fixed mutation rate.

## Remaining Phase A sequence

1. **A7: CLOSED 2026-08-09.** Dose batch found no window (1.6e-3 stands);
   campaign-closing `probe:full` recorded zero FAILs.
2. **Gate A-2: RAN 2026-08-09 — verdict FAIL, adjudicated and accepted.**
   Record: DESIGN.md "Gate A-2"; full report `briefs/gate-a2-verdict.md`.
   Same-day actions: P5 and P13 demoted to warn (gates now P1, P2, P3).
   **Fix wave G1 LANDED same day (`6d50f5f`)** — all nine fixes (Sol as
   implementer, orchestrator-verified: 252 tests, revert-sensitivity
   spot-check, probe:quick; record in DESIGN.md "Fix wave G1"). Still
   open from the rulings: a preregistered larger seed panel before any
   future gate promotion, and P5/P13 metric redesigns if they are ever
   to gate again. Two agenda claims were themselves wrong
   and are corrected in the record: defense loci DO pay (q33 bills
   wariness ×2.5), and speed feeds far more than foraging — no genome
   change, no speed maintenance cost without instrumentation first.
3. **Gate A-3: PASSED 2026-08-09.** In place of the formal 30-minute watch,
   the user ran the same world overnight twice (2,000 then 5,277 generations,
   seed=colour-test), reviewed both via screenshots, called the dots
   "fascinating to watch", and gave the go to build the roadmap. The gate's
   question — is watching rewarding before graphics spend begins — is
   answered at 100× the spec'd dose. Phase B (PixiJS creature rendering,
   plan at `~/.claude/plans/okay-so-i-ve-been-fluffy-frost.md`) **still
   requires its own explicit go** — the user's instruction green-lit the
   roadmap's model work, not the render spend.

## Roadmap — brainstorm endorsed by the user (2026-08-09)

After a 2,000-generation watch (DESIGN.md "Deep time"), the user endorsed
these ideas **and this ordering**. Nothing here starts before the A7 resume,
Gate A-2, and Gate A-3 — it is the queue for model work after those. Each item
that lands needs probe coverage in the project's usual way (a disturbance
probe, a kelp-channel probe, …); none is exempt from the suite.

1. **Predator persistence** — not new work: it IS the open front (P9) and the
   resume-point dose batch targets it. Recorded here because the deep-time run
   showed everything downstream hangs on it: the arms race, variance
   maintenance via frequency-dependent predation, defense meaning anything,
   and kelp mattering at all.
   - **Flip side, endorsed 2026-08-09: predator *re-evolvability*.** Predators
     are a diet morph of the same species, not a lineage — re-evolution from
     foragers is structurally possible but did not happen in 1,800
     predator-free generations (DESIGN.md "Deep time" for the three barriers:
     the q=1.6 disruptive-selection valley, attack variance eroded, no
     rare-invader advantage without predation). The candidate fix is a
     **valley-filling on-ramp**: carrion/scavenging biomass best exploited at
     intermediate diet (or juvenile cannibalism via the existing size window),
     so every step from filterer toward hunter pays. Interacts with item 2:
     a plankton crash is exactly the selective window where re-evolution
     should fire — guild rebirth after collapse is the payoff to watch for.
2. **A disturbance regime** *(new)* — rare spontaneous shocks: marine
   heatwaves, plankton crashes, storms that mow kelp down, disease outbreaks,
   century-scale climate excursions. Today nothing fires spontaneously (the
   meteor is a god command; `catas 0` after 2,000 generations) and the climate
   walk wobbled ±0.02 °C. This is the direct answer to "trends get predictable
   in deep time": punctuated equilibrium — stasis, shock, visible
   re-adaptation — and shocks regenerate the variance quiet eras consume.
3. **Kelp as an ecological actor** *(new)* — combinable options: a second food
   channel (grazers vs. plankton-filterers, making the genome's diet
   disruptive selection spatially visible); kelp dynamics (storms clear it,
   regrowth fronts); flee-behavior that actually seeks cover (today no policy
   reads kelp at all). Falls out nearly free once predators persist.
4. **Density regulation that isn't cap-and-starve** *(new)* — the deep-time
   population rode the 4,096 slot cap in a fill-and-starve sawtooth with
   starvation at 82% of deaths. Softer resource-driven regulation so the
   population curve tells an ecological story instead of bouncing off a
   ceiling. May largely fix itself if predation carries real weight again.
5. **Visible geography and speciation** — partly existing work (P8's per-deme
   instrument is on the Gate A-2 agenda); the new part is spontaneous
   geography (a ridge rising, sea level shifting) so allopatric divergence
   happens as theater, not only as a probe scenario.

The user's stated priority: 1 and 2 together are the game.

## Conventions that made this work (keep them)

- Orchestrator re-runs every package's acceptance probe before
  committing; agent self-reports and idle notifications are never
  evidence. Fix agents must prove tests revert-sensitive.
- Contracts frozen; gaps go to the orchestrator, who edits contracts,
  commits, and re-briefs. Scoped `git add` only — concurrent agents
  keep in-flight work in the same tree (an early `add -A` swept another
  agent's edits into a commit unattributed).
- Implementers are Opus agents with self-contained brief files naming
  artifact + machine-checkable probe; Sol (codex exec, read-only
  sandbox, brief on stdin) for cross-lineage review gates.
- **Run `probe:full` detached from the agent's shell.** It takes ~3 hours, and
  an agent's own polling loop timing out sends SIGTERM to its process group,
  which kills the suite with it — A7 lost two runs to this before noticing the
  `exit=143`. `scripts/`-style launch is not enough; the run needs its own
  session (`os.setsid()` after a fork, since macOS has no `setsid(1)`). Verify
  with `ps -eo pid,pgid` that the run's pgid differs from the shell's.
- Long runs are also **timing-sensitive**: P12 is a stopwatch probe inside
  `probe:full`, and a busy machine moves it ~35% (1.0×10⁶ idle against
  6.8×10⁵ with three concurrent sims). Measure P12 on a quiet machine, or
  discount the number and say so.
