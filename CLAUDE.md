# Panthalassa — working instructions

An aquatic evolution simulation you watch. Headless, deterministic sim core;
graphics arrive only after the probe suite passes. Read `DESIGN.md` for the
design record and the tuning log.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (app shell lands with WP-A6) |
| `npm run build` | Typecheck, then production build |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm run lint` | ESLint 9 flat config, zero warnings tolerated. Includes the determinism ban |
| `npm test` | Vitest, single run |
| `npm run test:watch` | Vitest, watch mode |
| `npm run probe` | Probe runner CLI. `npm run probe -- --scenario=barrier --seed=s1` |
| `npm run probe:quick` | ~4 min suite; run on every change |
| `npm run probe:full` | 3 seeds × 300–600 generations, `LONG_SIM=1`; gates and nightly |

The probe scripts go through `scripts/probe.mjs`, which prints
`probe runner not yet implemented (WP-A5)` and exits 1 until
`src/probes/runner.ts` exists. Landing that file turns the scripts on; nobody
needs to edit `package.json`.

## CONTRACTS-FROZEN RULE

**`src/contracts/**` is read-only for implementer agents after WP-A0.**

If your work package needs a contract change — a missing field, a wrong type, a
layout that does not fit — **STOP and report the needed change to the
orchestrator**. Do not edit contracts. Do not work around a contract by
declaring a parallel type in your own directory either; that produces two
sources of truth and the drift only surfaces at integration.

The contracts are `types.ts`, `traits.ts`, `genome.ts`, `events.ts`,
`stats.ts`, `protocol.ts`, `formulas.ts`, `apis.ts` and the `index.ts` barrel.
Import them from `src/contracts` (the barrel) or from the specific module.

### The module seam

`apis.ts` declares the interfaces each work package implements
(`GeneticsApi` = A1, `EcologyApi` + `SpatialIndex` = A2, `MatingApi` = A3,
`StatsApi` = A4). This is what lets the packages build concurrently in one tree.

**The engine depends only on these interfaces — never on a sibling module
path.** If `src/sim/engine.ts` imports `../genetics/meiosis` or
`./ecology/predation`, the parallel build is over and A3 is blocked on A1 and
A2 landing. A3 tests against its own stubs; A5 injects the real
implementations through `createSim({ modules })`.

Anything called once per organism per tick takes an out-parameter or a sink
rather than returning a fresh object — P12 wants 2×10⁶ organism-ticks/s.

### Shared model math

`formulas.ts` holds the tradeoff formulas more than one package consumes
(metabolic cost, thermal performance, diet efficiency, the predation kernel,
type-II grazing, the hazards). They are pure functions of numbers and take
`SimConfig`, so every constant lives in one place for A7 to tune. Genetics and
ecology both call these instead of importing each other.

## Invariants

These are not style preferences. Each one is enforced by a probe, a lint rule,
or both.

### Determinism

The sim is a pure function of `(config, seed)`. The same pair produces a
bit-identical world at every tick, on every machine.

- **No `Math.random`, `Date.now`, `performance.now`, or `crypto` randomness** in
  `src/sim/**`, `src/stats/**`, `src/probes/**`, `src/contracts/**`. ESLint
  fails the build. All randomness comes from `SeededRng`; all time comes from
  `SimState.tick`.
  - The single exception is `src/probes/timing.ts`, which P12 needs in order to
    measure performance. A clock reading may be reported and must never flow
    back into the sim.
  - Presentation code (`src/app`, `src/render`, `src/ui`) may use wall-clock
    time and `Math.random` for animation jitter, because it never feeds the sim.
- **Presentation never consumes sim RNG.** The renderer reads sample slices and
  snapshot queries through the worker protocol; it never touches `SimState`.
- **Slot-order iteration.** Always walk pool slots `0..capacity-1` ascending and
  skip the dead. Never iterate a `Set`, a `Map`, or a list whose order depends
  on death history. Neighbour lists from the spatial grid must be sorted before
  use.
- **Queued mutations.** Births and deaths go into queues and are applied at
  stage boundaries, never in the middle of an iteration.
- `SeededRng.fork(label)` gives a stage its own sub-stream without consuming
  parent entropy, so adding a consumer cannot shift the trajectory. Put the tick
  in the label when you want a fresh stream per tick.

### Model

- **No bounded trait scales.** Traits are unbounded physical quantities. Limits
  come from cost tradeoffs, never from a clamp. If you find yourself writing
  `Math.min(cap, trait)`, you are recreating the bug that killed the previous
  project — use a cost instead.
- Non-negative traits get a **softplus** link, never `Math.max(0, x)`.
- **Environment shifts expression; it never multiplies deviation-from-mean.**
- **Phenotype is computed once at birth** and cached in the SoA pools. The tick
  loop never reads a genome.
- **Genomes are immutable** once constructed.
- `OrganismId` is never reused; slot indices are. Anything that outlives an
  organism holds an id.

### Definition of done

**Probes are the definition of done.** A work package is complete when its named
probe or test command passes, not when the code looks right. The orchestrator
re-runs every package's probe independently and does not trust self-reports.

Probe thresholds get ratcheted during tuning to sit just below achieved
behaviour: **a probe that has never failed is not testing anything.**

## File ownership (Phase A)

Disjoint by design; do not write outside your package.

| Package | Owns |
|---|---|
| A0 | root configs, `src/contracts/**`, `src/sim/rng.ts`, `scripts/`, `DESIGN.md`, `CLAUDE.md` |
| A1 | `src/sim/genetics/**` |
| A2 | `src/sim/ecology/**`, `src/sim/spatial.ts` |
| A3 | `src/sim/engine.ts`, `organisms.ts`, `mating.ts`, `snapshot.ts` |
| A4 | `src/stats/**` |
| A5 | `src/probes/**` |
| A6 | `src/app/**`, `index.html` |
| A7 | config defaults (by exception) and the DESIGN.md tuning log |

## Conventions

- TypeScript strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
  Index access returns `T | undefined`; handle it rather than asserting.
- `verbatimModuleSyntax` is on: use `import type` for type-only imports.
- Long-running tests are gated behind `LONG_SIM=1`.
- Comments explain constraints and non-obvious *why*, never what the next line
  does.
