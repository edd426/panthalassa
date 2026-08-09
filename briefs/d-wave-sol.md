# D-wave implementation brief — disturbance regime + scavenging on-ramp (D0–D4)

You are Sol, acting as the **implementer** for this wave. You are in a dedicated
git worktree (branch `dwave`, checked out from `ac128fa`) with a real
`node_modules` installed — `npm run typecheck`, `npm run lint`, `npm test`, and
`npm run probe -- --scenario=… --seed=…` all work. Use them. **Do not attempt
git commits** — the worktree's git metadata lives outside your sandbox; the
orchestrator commits after diff review. Network is unavailable; everything you
need is installed.

Read first, in order: `CLAUDE.md` (invariants — they are enforced by lint and
probes, not suggestions), `briefs/roadmap-1-2-design.md` (the design you are
implementing), and the "Deep time" + tuning-log sections of `DESIGN.md` for
context on why these mechanisms exist. The design brief is authoritative for
mechanism intent; this brief pins the operational decisions it left open.

## Objective

Implement work packages **D0–D4** from `briefs/roadmap-1-2-design.md`:

- **D0** — contract additions (authorized below).
- **D1** — disturbance scheduler: thermal excursions (jump component decaying
  on the OU climate walk), plankton crashes (global or regional dead zone),
  kelp storms (cleared swath, regrowth).
- **D2** — carrion field (deposit fraction of death biomass, decay) +
  scavenging intake (type-II on carrion, concave `diet^q_scav`, no attack
  roll, no speed contest, no size window).
- **D3** — probes P15 (disturbance regime) + P16 (re-evolvability), their
  scenarios, recorder series (carrion biomass, shock annotations).
- **D4** — HUD: event-feed lines for shocks and a carrion readout.

Disease outbreaks are **out of scope** (explicitly deferred in the design
brief). Do not retune existing config defaults or existing probe thresholds
except where this brief says so.

## Contract authorization (D0)

`src/contracts/**` is normally frozen for implementers. For this wave you have
**explicit orchestrator authorization** to make exactly these contract deltas —
anything beyond them, stop and report instead of improvising:

1. `SimConfig`: a `disturbance` block — master `enableDisturbances` toggle
   (wired into the existing mechanism-toggle set so the marginal-contribution
   machinery can carry a disturbance row) plus per-type rate / magnitude /
   duration knobs for thermal, plankton-crash, and kelp-storm shocks; and a
   `carrion` block (deposit fraction, decay half-life, `qScav`, intake
   parameters). Follow the existing config style for naming and units; rates
   are per-generation (900 ticks) and the scheduler converts to per-tick.
2. `SimEvent` union: disturbance events (one per shock type, carrying tick,
   magnitude, duration, and region geometry when regional).
3. `SimState`: scheduler state (active shocks with decay clocks) and the
   carrion field. Both must round-trip `snapshot.ts` and be covered by
   `stateHash()` — P1 restore-continuation must stay green with shocks active.
4. `formulas.ts`: `dietEfficiencyCarrion` (concave, `q_scav < 1`, contrast the
   convex live-prey `diet^1.6`) and the carrion type-II intake formula. Pure
   functions of numbers + `SimConfig`, same as the rest of the file.
5. A **scripted-shock hook**: scenarios must be able to force a specific shock
   at a specific tick (P16 needs a plankton crash at a known generation, not
   Poisson luck). Model it on the existing sweep-injection machinery. This may
   touch the scenario/config contracts as needed — enumerate what you added.

Report the full list of contract deltas you actually made, as its own section.

## Pinned decisions (where the design brief left room)

- All shock randomness from a dedicated `SeededRng` fork (label includes
  `disturbance` and the tick where per-tick streams are needed). Adding the
  scheduler must not shift the trajectory of a run with disturbances disabled
  — there is a determinism test in this (see acceptance).
- Carrion uses the same grid machinery as plankton. Suggested starting
  defaults (D5 tunes later; pick sane numbers in these ranges): deposit
  fraction ~0.3 of death biomass, half-life ~1 generation, `qScav` ~0.7.
  Thermal: ~1 shock per 150 generations, ±2–5 °C, decay 10–30 generations.
  Crash: ~1 per 200 generations, productivity ×0.2–0.5, 5–20 generations,
  regional option with a disc geometry. Kelp storm: ~1 per 250 generations.
- **P15 and P16 are severity `warn`**, spec-length, full-suite only. The gates
  assertion in `probe-suite.test.ts` must stay `['P1','P2','P3']`.
- P16 aggregates cross-seed with the existing `ProbeAggregation` k-of-n
  machinery, criterion ≥1/3 replicates (guild `diet > 0.5` reappears and
  persists 50 generations). Its scenario starts predator-free — the tuning log
  documents how (`diet baseline −1.4` founder seeding) — runs quiet, then a
  scripted crash.
- The **quick suite** gets a short disturbance-smoke scenario (a scripted
  shock of each type fires; world survives; snapshot round-trips mid-shock) so
  `probe:quick` exercises the machinery without spec-length cost. Keep the
  added quick runtime under ~2 minutes.
- The **P1 determinism scenario** now runs with `enableDisturbances: true` so
  determinism and snapshot-restore are certified with scheduler state live.
- P7's mortality mix will shift when scavenging recycles biomass that
  starvation used to delete. **Do not retune P7's bands** — run it, and report
  the measured mix in your final report for the D5 campaign to adjudicate.
- HUD (D4): event-feed lines for shocks (type, magnitude, remaining duration)
  and a carrion-biomass readout. If the existing chart code supports cheap
  vertical annotations, add shock markers; otherwise list that as an optional
  follow-up, not required work. Acceptance for D4 is `npm run build` clean —
  no browser automation available to you.
- No clamps anywhere (costs, not caps; softplus for non-negatives). Read
  `state.config` fresh on every call. Slot-order iteration; queued mutations;
  no per-organism-per-tick allocations on hot paths.

## Acceptance (run these; report exact commands and exit codes)

1. `npm run typecheck` — clean.
2. `npm run lint` — clean (the determinism ban covers your new files).
3. `npm test` — green, including your new tests. Update existing test
   expectations only where the addition of P15/P16 legitimately changes them,
   and enumerate every such edit.
4. `npm run probe -- --scenario=<your disturbance-smoke> --seed=q1` — runs to
   completion, P15-smoke reports.
5. A short-form run of the P16 scenario (one seed, reduced generations is
   fine) — runs to completion and the report row renders.

Required new tests, at minimum: scheduler fires at configured rate (statistical
tolerance); thermal jump decays; regional crash affects inside-region
productivity and not outside; carrion deposit/decay conservation; scavenging
intake concavity (`q_scav < 1` beats convex at mid-diet, loses at extremes);
snapshot round-trip with active shocks; determinism unchanged with
disturbances **off** (same hash as before your change would be ideal — if the
hash shifts with disturbances off, that is a defect); P16 scenario
predator-free at start. For each: ask yourself whether it would fail if the
feature were reverted — a test that passes either way is not accepted.

## Reporting

Separate sections: (1) what you implemented, per package; (2) contract deltas;
(3) required work vs optional follow-ups; (4) every deviation from this brief
or the design brief; (5) not examined / could not verify; (6) measured P7 mix
and any probe rows from your runs worth the orchestrator's attention; (7)
anything in this brief or the design brief you believe is wrong. That last
section is taken seriously — the best findings of previous waves came from it.
