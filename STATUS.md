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

**WP-A7 (tuning) is IN PROGRESS and is the next thing to resume.** The
campaign brief lives at the session scratchpad but its essentials are in
DESIGN.md: untuned baseline collapses to extinction by generation ~6
(diet expresses 0.5 for every founder → the population hunts itself;
median death age 420 vs maturity 600). A7 owns DEFAULT_SIM_CONFIG
values, probe thresholds/severities, and the DESIGN.md tuning log — one
knob change = one measured row = one commit. Check `git log` for how far
it got; the tuning log is the authoritative campaign state.

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
