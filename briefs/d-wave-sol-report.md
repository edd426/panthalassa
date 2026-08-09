## 1. Implemented

- D0: disturbance/carrion config, state, events, formulas, toggle, scripted-shock command.
- D1: deterministic Poisson scheduler, exponentially decaying thermal jumps, global/regional plankton crashes, kelp swath clearing and regrowth.
- D2: death-biomass carrion deposits, half-life decay, concave type-II scavenging with no combat checks.
- D3: P15/P16, smoke and spec scenarios, cross-seed P16 aggregation, carrion and active-shock recorder columns.
- D4: shock event-feed descriptions and carrion biomass HUD readout.
- Snapshot format bumped to 3; active shocks and carrion round-trip and participate in hashing.
- Disturbance-off trajectory retains the golden pre-wave hash: `6922907c6421d7bf`.

Key implementations: [disturbances.ts](/private/tmp/claude-501/-Users-eddelord-Documents-Projects-quick-game/f06e36c0-7708-4421-9fa2-0770e8f9c63a/scratchpad/dwave/src/sim/ecology/disturbances.ts), [disturbance.ts](/private/tmp/claude-501/-Users-eddelord-Documents-Projects-quick-game/f06e36c0-7708-4421-9fa2-0770e8f9c63a/scratchpad/dwave/src/probes/probes/disturbance.ts).

## 2. Contract deltas

- `SimConfig`: added `disturbance` and `carrion` blocks.
- `MechanismToggles`: added `enableDisturbances`.
- `ResourceField`/`SimSnapshot`: added carrion grid.
- `SimState`/`SimSnapshot`: added active disturbance state.
- Added disc/rectangle disturbance geometry and per-shock state types.
- `SimEvent`: added `thermalShock`, `planktonCrash`, and `kelpStorm`.
- `formulas.ts`: added `dietEfficiencyCarrion` and `carrionIntake`.
- `SimCommand`: added `triggerDisturbance`.
- Snapshot format version: 2 → 3.

No `stats.ts` contract delta was retained; D-wave recorder data uses internal named columns.

## 3. Required work vs optional follow-ups

All required D0–D4 work is implemented.

Optional follow-ups:

- Trend-chart shock markers were not added because the chart code has no existing annotation primitive.
- The HUD currently refreshes carrion through a snapshot when a sample row arrives. A dedicated lightweight carrion query could reduce browser-worker transfer cost later.

## 4. Deviations

- P16 also sets `founderSdScale: 0.1` in addition to the specified diet baseline −1.4. At current founder variance, −1.4 alone produced 68 predators among 600 `q1` founders; the smaller scenario-only variance was required to make the stated “predator-free” precondition true.
- No existing config default or probe threshold was retuned.
- Existing test expectation edits were limited to registering P15/P16 and asserting P16’s 1/3 aggregation. The gate expectation remains exactly `['P1','P2','P3']`.

## 5. Not examined / not verified

- The multi-hour full suite and spec-length P15/P16 runs were not run.
- No browser automation or visual HUD inspection was available.
- Disease remains untouched.
- `npm run probe:quick` was not run in full; the added smoke scenario itself completed in 16.46 seconds including standalone probes.

## 6. Measurements and verification

Exact commands:

- `npm run typecheck` — exit 0.
- `npm run lint` — exit 0.
- `npm test` — exit 0; 260/260 tests passed.
- `npm run build` — exit 0.
- `npm run probe -- --scenario=disturbance-smoke --seed=q1` — exit 0; P15-smoke PASS, all three shock types fired, population 92, snapshot restored mid-shock.
- `npm run probe -- --scenario=re-evolvability --seed=q1 --generations=61` — exit 0; P16 row rendered WARN/N/A because the post-crash window was intentionally incomplete.
- `npm run probe -- --scenario=baseline --seed=q1 --generations=60 --probes=P7` — exit 0.

Measured P7 mix, unchanged bands:

- Starvation: 23%
- Predation: 58%
- Temperature: 11%
- Senescence: 8%
- P7 PASS

P12 during the final smoke run measured `9.34e5 organism-ticks/s`, narrowly above its `9.00e5` warning target.

## 7. Findings about the briefs

- “`qScav < 1` beats convex at mid-diet, loses at extremes” is mathematically imprecise for the diet-efficiency functions alone: the concave and convex powers are equal at diet 0 and 1, and the concave power wins everywhere strictly between. The high-end scavenging channel loses here because its intake asymptote is lower, not because of `qScav`.
- Diet baseline −1.4 does not guarantee predator-free founders under current variance, as noted above.
- P15’s ±40% per-seed rate criterion is noisy at default rates over 600 generations: expected counts are only approximately 4 thermal, 3 crash, and 2.4 kelp events per seed. A pooled cross-seed rate assertion would be statistically more stable.