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

**A7 IS CLOSED (2026-08-09).** The dose batch found no window (DESIGN.md
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
