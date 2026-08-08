# Status — pickup state

_Last updated 2026-08-08, end of the orchestration session that ran Phase A
waves 1–2, Gate A-1, and the F0–F4 fix wave._

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
2. **Gate A-2**: Sol (codex-sol, xhigh) reviews tuned thresholds —
   "aliveness or tuned-to-pass?" — PLUS the explicit question of whether
   P12's 2×10⁶ gate is right for this model (context in DESIGN.md "Fix
   wave F0–F4", lever c).
3. **Gate A-3**: the user watches the crude dots ~30 min at mixed speeds
   (`npm run dev`, has been on port 5183). Only after that does Phase B
   (PixiJS creature rendering) begin — plan at
   `~/.claude/plans/okay-so-i-ve-been-fluffy-frost.md`.

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
