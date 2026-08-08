# Status — pickup state

_Last updated 2026-08-09 (roadmap + Gate A-2 agenda item added after the
user's 2,000-generation watch; project remains paused). Originally written
2026-08-08 evening, at the user's wind-down order. This is the
handoff for a fresh session: the session that wrote it ran Phase A waves 1–2,
Gate A-1 + fix wave, the A6 watchability upgrades, and the A7 tuning campaign
through its discriminator phase. The user's instruction at close: **do not
start the next phase** (no Gate A-2, no Phase B) until they say so._

## Resume HERE

**Next action: the one-batch mutation dose search** (knob phase reopened for
exactly this, then closed). Bracket `quantMutationRate` ≈ 2.0/2.2/2.4e-3,
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

1. **A7**: tune until `LONG_SIM=1 npm run probe:full` exits 0 on 3 seeds
   (P11 and P12 warn acceptable), thresholds ratcheted, mechanism
   marginal-contribution table filled (DESIGN.md).
2. **Gate A-2**: Sol (codex-sol skill, xhigh, read-only, brief on stdin)
   reviews the tuned suite. The agenda, all with DESIGN.md context:
   - Threshold ratchet legitimacy — "aliveness or tuned-to-pass?" — with the
     falsified P6↔P9 tradeoff presented as a worked example of the campaign
     catching itself (fixed-mutation-rate correlation over-read as model
     property; superseded sections marked in place).
   - The defense-pricing genome finding: defense carries 1.5× attack's input
     mass and 8 of 9 defense loci charge nothing, contradicting the design
     record's own "armour is the thing you pay for" note. Sol rules whether a
     genome-table change is warranted (A7 was barred from editing it).
   - P8's second criterion is unfalsifiable: SampleRow lacks per-deme trait
     moments, so per-side hue means cannot be compared. Sol rules on both the
     criterion's reformulation and the minimal instrument; implementation
     lands after the review.
   - P12's 2×10⁶ threshold predates the model (measured ~1.0×10⁶ clean;
     remaining 2× is model decisions — DESIGN.md "Fix wave F0–F4" lever c).
   - Whether the suite may demand P6 and P9 green simultaneously (evidence
     now says yes, via mutation input — confirm the dose-batch result).
   - Whether speed's cost is fully paid. In the user's 2,000-generation watch
     (DESIGN.md "Deep time"), `speedCap` ran away ~8× in a predator-free world
     where its only benefit is foraging. Cost charges *realized* speed, so the
     cap itself is free until used — same shape as the defense-pricing
     question. Sol rules whether this is honest selection or a cheap-trait
     leak.
3. **Gate A-3**: the user watches ~30 min at mixed speeds (`npm run dev`,
   port 5183). They already did an informal watch and found it "more
   interesting than this morning"; their two requests (trait colour modes,
   trend charts) are BUILT and committed, plus extinction banner/reseed.
   Only after their formal verdict does Phase B (PixiJS creature rendering)
   begin — plan at `~/.claude/plans/okay-so-i-ve-been-fluffy-frost.md`.
   **Phase B is explicitly NOT to be started without the user's go.**

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
