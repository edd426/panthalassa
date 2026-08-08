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
  basin), P7's starvation ceiling on 2 of 3 seeds, and P6/P4, which a
  5.8–6.6 SD defense sweep predicts. DESIGN.md "Structural finding for a
  human or Sol" states what A7 could and could not attribute, and names the
  cheapest next discriminator.
- **`probe:full` no longer fits its ~40-minute budget** — see the note in the
  tuning log. It was budgeted when worlds died at generation 5; now they
  survive, and 3 seeds × 4 scenarios × up to 600 generations is hours. This
  needs an orchestrator decision before the endgame gate can be run.
- P8 and P10 ran for the first time on a surviving world: **P10 passes**
  (injected allele crossed 0.5 in 56 generations), **P8 half-passes** — Fst
  0.063 → 0.723 across the ridge, but cross/within mate acceptance is 1.03,
  i.e. no reproductive isolation. `mating.prefSigmaBaseDeg` is 70°, wide
  enough that no achievable hue divergence would register; that is the
  untried knob for P8.

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
