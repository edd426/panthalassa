# Panthalassa — living design record

This file is the durable home for design decisions, tuning history, and the
directions we tried and abandoned. It is written to as work happens, not
afterwards. (Herdloom convention: the "superseded or rejected" section at the
bottom is as important as the rest — it is what stops a settled question from
being reopened three sessions later.)

## Context

Panthalassa is an aquatic population-genetics simulation you **watch and
inspect** rather than play: open the page and the world is already alive, with
no tutorial and no onramp. It is the fourth genetics project in this repo and
deliberately inverts the first three, which all put interaction first and let
the evolution flatten out behind it. Gladiator-genetics converged and then did
nothing; herdloom was measured and found to have founder-variance collapse, a
trait ceiling hit by generation 4, dead loci, and no natural selection at all
(old age was the only cause of death). The central engineering idea here is
that **"evolution stays interesting" is a measured property, not a hope**: a
headless probe suite asserts variance maintenance, ongoing adaptation, an
active mortality mix, divergence under a barrier, and visible sweeps over
multi-hundred-generation runs — and it does so before any graphics exist.

## Decisions locked with the user

| Decision | Choice |
|---|---|
| Frame | Simulation-first; watch/inspect; interaction later; zero onramp |
| Main view | Cinematic creature world (not petri-dish, not data-art-first) |
| World | Top-down continuous aquatic world: temperature/light gradients, plankton + kelp resources, reefs/landmasses as barriers |
| Bodies | Body-plan clades: procedural spine-chain swimmers; archetypes (undulator, radial drifter, armoured crawler) whose parameters evolve freely; rare macro-mutations found new clades; no authored sprites |
| Surprise budget | Speciation & radiation, coevolution/arms races, emergent bodies. Evolved neural behaviour is a far-roadmap item; v1 behaviours are parameterised policies with genetic parameters |
| Usage modes | Ambient aquarium (persistent, fast-forward, catch-up) + naturalist (genomes, pedigrees, lineages, sweeps) + meddling god (climate, barriers, meteor, introduce mutant) |
| Build order | Minimal probe first: headless sim core + aliveness probes + crude dots on canvas. Graphics only after probes pass **and** the user has watched the dots and found them interesting |
| Stack | TypeScript + Vite; dependency-free headless sim core (Node + Web Worker); PixiJS 8 renderer in Phase B; React panels + uPlot in Phase B/C; Vitest + fast-check; Dexie in Phase C |

## Herdloom lessons → design axioms

Each of these is probe-enforced, not merely intended.

1. **No bounded trait scales.** Traits are unbounded physical quantities (cm,
   °C, wu/tick); alleles are real numbers under a continuum-of-alleles model;
   limits come from cost tradeoffs, never clamps.
2. Founder alleles are drawn from the same distributions mutation feeds — there
   is no "null allele" concept to collapse founder variance.
3. Neutral marker loci exist on purpose and are probed for staying alive.
4. Four independent mortality channels, each required to carry weight.
5. Environment shifts expression; it never multiplies deviation-from-mean
   (herdloom's variance-shrinking bug).
6. Generation time is first-class (~900 ticks ≈ 30 s watched at 1×); probes are
   denominated in generations.
7. Variance maintenance is mechanistic and individually toggleable, so tuning
   can measure each mechanism's marginal contribution.

## Contract decisions (WP-A0)

The contracts in `src/contracts/**` are frozen after A0. The decisions inside
them that are not obvious from the plan:

- **Latent vs expressed traits.** Every trait has an unbounded latent value and
  an expressed value produced by a link function. Both are stored per organism
  (`traits`, `traitsLatent`), written once at birth. Selection statistics read
  the latent scale so that a link can never masquerade as lost additive
  variance.
- **Softplus everywhere a trait is physically non-negative**, not only on
  `size`. The plan said "softplus floor on size only"; the same argument
  applies to `speedCap`, `tWidth`, `armorPlating` and the rest, and the
  alternative that four parallel implementers would otherwise invent —
  `Math.max(0, x)` — is exactly herdloom's pinning failure relocated to the
  bottom of the range. Softplus is strictly increasing everywhere, so the
  latent value keeps responding to selection at the floor. There is no upper
  link on any trait.
- **`diet` is a logistic link on an unbounded latent scale**, so the share is
  bounded (a share must be) while selection on the underlying axis is not.
- **Antagonistic pleiotropy is authored**: 17 of the 48 quantitative loci carry
  opposed signs on two traits that are each better when higher. `ANTAGONISTIC_LOCI`
  is derived from W so it cannot drift out of sync with the table.
- **The magic trait is built in, not hoped for**: q36 loads `diet`, `size` and
  `displayHue` together, and q38 loads `displayHue` with `prefTarget`. Diet
  specialisation therefore drags the mating signal, and the signal is
  genetically correlated with the preference for it.
- **Two tight linkage blocks** (q07/q08 at 41/42.5 cM, q29/q30 at 30/31.5 cM)
  give the sweep probe something to hitchhike.
- **100 cM chromosomes** so that map length and the Poisson(1.0) crossover rate
  are the same statement.
- **Slot vs id.** `OrganismId` is never reused; slots are reused immediately.
  Anything outliving an organism holds an id.
- **Snapshots preserve slot layout verbatim**, dead slots and free list
  included. Compacting would renumber slots, change iteration order, and fail
  P1's restore-continuity assertion for a reason unrelated to any real bug.
- **No loci on the sex pair in Phase A.** Sex linkage breaks the diploid
  variance formulas in `src/stats` (hemizygous males); deferred rather than
  half-done.
- **One file may read a clock**: `src/probes/timing.ts`, for P12. ESLint bans
  clock and entropy access everywhere else in sim/stats/probes/contracts.
- **The engine talks to modules only through `apis.ts` interfaces**, injected
  via `createSim({ modules })`. This is what makes A1–A4 concurrent: A3 writes
  the engine against the interfaces and tests it with stubs, and A5 wires the
  real implementations. `RandomSource` is declared structurally in contracts
  rather than importing `SeededRng`, so contracts depend on nothing.
- **`armor`, not `defense`, pays the metabolic bill.** `metabolicCostPerTick`
  takes `armorPlating` (mm, non-negative). `defense` is an unbounded logit that
  can go negative, and `(1 + ca · defense)` would then produce a *negative*
  energy cost. Armour is the thing you pay for; defense is the outcome armour
  and several other loci buy.
- **The frequency-dependence term is centred on `1 / hueBinCount`.** Uncentred,
  turning the mechanism off would also reduce mean predation pressure, and A7
  could not attribute a change in maintained variance to frequency dependence
  rather than to milder predation. Every toggle should be shape-preserving in
  its mean for the same reason.
- **The specialist–generalist tax is a power law**, `(refWidth/tWidth)^κ` with
  κ = 0.35 (`thermal.generalistTaxExponent`), replacing the earlier linear
  `generalistTaxPerDegree`. κ = 0 switches the tradeoff off cleanly, which the
  linear form could not do without also shifting the baseline.

## Review gates

### Gate A-1 — Sol (GPT-5.6, xhigh) review of genetics + popgen, 2026-08-08

**Verdict: FAIL** at `bd2cf57`. Full report:
`sol-a1-final.md` (session scratchpad; findings adjudicated below are the
durable record). Orchestrator spot-verified 7/7 sampled findings at the cited
lines before accepting. The gate did exactly what it was built for: the
inheritance machinery is clean, but the herdloom failure mode reappeared at
the expression and measurement layers.

Accepted defects and rulings (fix wave F0–F3, before any A7 tuning):

1. **GxE multiplies the genotypic value** (`phenotype.ts`) — `G × (1 + s·z)`
   scales genetic deviation by environment and the scaled value is stored as
   `genotypicValues`, contaminating every V_A the recorder reports. This is
   the axiom-5 violation that killed herdloom. Ruling: environment shifts
   expression **additively** (`… + s·z` on GxE-masked traits); store raw `G`.
   True reaction-norm slope loci are roadmap, not v1.
2. **Founder h² target excludes discrete-locus variance** (`genome.ts`) —
   display/preference traits start with h² far above target. Ruling: fold
   discrete effect variance into the founder-variance analytic.
3. **Speed cost charges `speedFraction`, not speed** (`formulas.ts`,
   `metabolism.ts`) — raising `speedCap` buys free absolute speed; the
   advertised receding ceiling does not exist. Ruling: charge
   `(speed/referenceSpeed)²` with a config reference speed.
4. **`laplace()` can return −∞** when the RNG hands back exactly 0
   (`rng.ts`) — one draw in 2³² poisons a genome forever. Ruling: guard.
5. **Temporal Ne**: short-window fallback, `10 × census` right-censoring and
   `Ne = 0.5` substitutions (`recorder.ts`, `popgen.ts`). Ruling: null until
   a full window exists; null for non-identifiable estimates; nullable
   `neTemporal` in the contract.
6. **Demographic Ne multiplies sex-ratio and offspring-variance corrections**
   (`popgen.ts`) — double-counts between-sex inequality. Ruling: sex-specific
   Crow & Denniston (1988) combination.
7. **Breeder window counts juveniles that died before maturity**
   (`ancestry.ts`). Ruling: eligibility requires surviving to maturity.
8. **Midparent h² only sees offspring that survive to a census row**
   (`recorder.ts`) — trait-dependent juvenile mortality biases the slope.
   Ruling: ingest offspring phenotypes at birth via `onBirth`.
9. **Rect barriers have no two-sides Fst partition** (`popgen.ts`). Ruling:
   ridges define sides; rect ⇒ `fstBarrier = null`, documented.
10. **Zero reported where assortment is undefined** (`shared.ts`). Ruling:
    nullable assortment indices; "no matings" ≠ "measured random mating".
11. **Species cross-mating expectation ignores sex margins** (`species.ts`).
    Ruling: directed expectation `f_f(1−f_m) + (1−f_f)f_m`.
12. **`wariness` benefit saturates at the scan radius with no cost**
    (`behavior.ts`) — selection shadow, neutral drift above the horizon.
    Ruling: sensing horizon is legitimate physics; add an explicit vigilance
    metabolic cost so the trait pays for what it asks of the organism.
13. **Fst deme filter coupled to `speciation.minSpeciesSize`** — estimator
    estimand changes with an unrelated knob. Ruling: own small constant.

Adjudicated down: diet's logistic link saturating (in Float32 at latent
≈17.3) is inherent to a deliberate proportion-scale trait, not a hidden
clamp — the guild sample already reports the expressed scale; docs corrected.
Temporal-Ne-under-overlapping-generations is a known estimator limitation:
documented as a drift index, P14 keeps broad thresholds. Macro-mutation
"genome reset" semantics, 4-marker estimate width, detector
allopatry-vs-incompatibility conflation: recorded as risks for A7 and the
roadmap, not v1 defects.

## Tuning log

WP-A7 owns this section. Every config change gets a row: what moved, why, and
the probe numbers before and after. A knob that moved without a measured
justification is a knob that will be moved back.

| Date | Knob | From → To | Probe evidence before | Probe evidence after | Rationale |
|---|---|---|---|---|---|
| _(empty — A7 has not run)_ | | | | | |

### Mechanism marginal contributions

Toggle-off runs measuring what each variance mechanism actually buys. Filled in
by A7; a mechanism that shows no marginal contribution is a mechanism to delete,
not to keep for comfort.

| Mechanism | Toggle | V_A(size) ratio with | without | Verdict |
|---|---|---|---|---|
| Spatial GxE | `enableSpatialGxE` | | | |
| Frequency-dependent predation | `enableFrequencyDependentPredation` | | | |
| Climate red-noise walk | `enableClimateWalk` | | | |
| Mutation input | `enableMutation` | | | |
| Seasonality | `enableSeasonality` | | | |
| Assortative mating | `enableAssortativeMating` | | | |

## Superseded or rejected directions

Directions we tried, considered seriously, or inherited and then abandoned —
kept so they are not silently retried.

| Direction | Why it was rejected | When |
|---|---|---|
| Bounded 0–10 trait scales (herdloom) | Every trait pinned at the clamp by generation 4; evolution had nowhere to go | Inherited, rejected at design time |
| Zero-effect "null" founder alleles (herdloom) | Collapsed founder variance; generation 0 had almost nothing to select on | Inherited, rejected at design time |
| Old age as the only mortality channel (herdloom) | Produced no natural selection whatsoever | Inherited, rejected at design time |
| `Math.max(0, x)` floors on non-negative traits | Recreates the pinning failure at the bottom of the range; softplus instead | WP-A0 |
