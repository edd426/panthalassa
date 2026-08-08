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

### Fix wave F0–F4 — closed 2026-08-08 (`f083f2c`…`7d9f19d`)

Every accepted defect above is fixed and committed; each fix's tests were
proven revert-sensitive by their authors (reinstate the defect → named tests
fail). Verified findings worth keeping visible:

- Realised founder h² for discrete-effect traits now lands 0.47–0.54 on the
  0.5 target (displayHue had been 0.92). Reported V_A is genetic again.
- Demographic Ne on the skewed-sex test window: 5.98 (double-counted) →
  16.52 (per-sex Crow & Denniston). The per-sex variance uses the N−1
  divisor deliberately: the population-variance form cancels the breeder
  count exactly, which would have made the breeder-eligibility fix
  unobservable. Ne is NaN for near-empty windows (either sex absent, <3
  births) rather than negative.
- The sex-margin cross-mating expectation is provably second-order where
  cross-mating is rare (correction = 2·d², d bounded by the cross rate), so
  **P11 movement must not be credited to or expected from it**; it matters
  at high cross rates, where the pooled form dissolves real pairs.
- `onBirth` carries the newborn's latent view (required as of the wave
  close), so the midparent regression is no longer conditioned on juvenile
  survival. P13 stays n/a until the ecology survives burn-in.
- **P12 stands red at 1.05×10⁶ organism-ticks/s against the 2×10⁶ gate**
  after a measured 1.37× campaign (thermal-tax memo +17.5% the largest
  single win; full ledger in the F4 commit). The profile is flat at
  ~950 ns/organism-tick vs the 488 ns budget: the remaining 2× is model
  decisions, not optimisation —
  (a) field-grid resolution: `fieldCellSizeWu` 25 ⇒ 3840 cells for ~512
  organisms; the per-tick field pass plus per-organism field reads are the
  biggest lever, and it is an A7-ownable config default;
  (b) one shared neighbour query instead of three (behaviour r=90,
  predation r=45, mating r=120) — changes candidate sets, i.e. a model
  change nobody should make casually;
  (c) whether 2×10⁶ is the right gate for this model at all.
  **Gate A-2 must adjudicate (c) explicitly**: the number was authored
  before the model existed. At 1.05×10⁶, 256× fast-forward is genuine up to
  ~140 organisms and degrades to ~35–70× at 500–1000 — the worker already
  degrades gracefully (A6 measured a locked 60 fps at 256×).
- Declined for correctness, permanently: tick-caching `temperatureAt` (it
  is the analytic authority; a probe legitimately moves climate without
  advancing the tick) and lazy carrying capacity (the every-tick K recompute
  is load-bearing for restore fidelity — see the P1 incident above).
- Tooling: vitest runs sequentially (`fileParallelism: false`) because the
  CPU-bound suite starved the reporter RPC and made exit codes
  non-deterministic — a run could fail with every test green. Diagnosed by
  A5/A6.

## Tuning log

WP-A7 owns this section. Every config change gets a row: what moved, why, and
the probe numbers before and after. A knob that moved without a measured
justification is a knob that will be moved back.

**Baseline before any tuning** (2026-08-08, `77a770c`, three seeds, verified
live and headless): the default config collapses to extinction by generation
5–6 — 600 founders → ~50 by gen 1 → 0 by gen 5. Predation carries ~66–71% of
deaths. P3 viability fails wildly at defaults; the crude-renderer phase
surfaced this before any graphics spend, which is exactly what it was for.
Note the Gate A-1 fix wave (additive GxE, absolute-speed metabolic cost)
changes the dynamics, so re-measure the baseline after F0–F3 land before
turning any ecology knobs.

**Baseline after F0–F4** (2026-08-08, `6c0989b`, three seeds, 60 generations):
unchanged in kind — extinction at generation 4.0 / 5.1 / 4.9. 600 founders →
273 alive by tick 200 → 0 by generation 5. Predation 67% of deaths,
starvation 16%, temperature 14%, senescence 3%. 195 births in the whole run.
The Gate A-1 fix wave did not move the collapse, so the tuning campaign starts
from the same diagnosis the crude-renderer phase surfaced.

### The diagnosis A7 measured (and what it overturned)

The brief's starting hypothesis was that the world is *predation*-limited. It
is not, and the isolation experiments say so plainly (baseline, seed s1,
60 generations):

| Intervention | Outcome |
|---|---|
| predation off (`baseLogit` −12) | **survives**, population 173–709, 89% of deaths starvation |
| temperature hazard off (`hazardCoef` 0) | extinct at generation 4.0, predation still 72% |
| more food (`kBase` 40 + `grazingMaxIntake` 1.2) | **survives**, population 936–1964, both guilds ~50/50 |

Predation is the proximate cause of death and the wrong place to intervene.
Turning it down alone (`baseLogit` −4.0, −4.5) does not rescue the world at
all; deaths simply move to starvation (22–24%) and it still empties by
generation 8. Turning it down far enough to survive (−5.0, −6.0) buys a
filterer monoculture: predators fall to 2% and 0% of the population, which is
P9's failure by another route. Total mortality is near-conserved because the
population sits on the edge of its energy budget, so **capping one channel
just re-routes deaths through another**.

Three mechanisms explain the collapse, and only the third is load-bearing:

1. **Founders are obligate generalists.** `diet` has latent baseline 0, so
   every founder expresses ≈0.5 through the logistic link, and `dietConvexity`
   1.6 makes a 0.5 forager 2.6× worse at filtering than a specialist
   (0.5^1.6 = 0.33 against 0.9^1.6 = 0.85). The founding population is the
   worst possible composition: bad at both jobs.
2. **Hunger drives predation.** `tryPredation` is gated on
   `energy < matingSeekEnergyFraction × maxEnergy`, so a hungry world is a
   world where every organism hunts on every tick it can. Food shortage
   therefore *converts itself into predation pressure* — which is why the
   predation share stays at 67–74% under every intervention that does not fix
   the energy budget, and why raising `birthEnergy` to 16 changes nothing
   (a founder burns back below the threshold in ~14 ticks).
3. **The world is food-poor, and the binding quantity is standing stock, not
   bite rate.** This is the one that moves.

**Why the bite rate is not the lever.** Grazing is Holling type-II on the
*cell's* plankton, and grazing pressure pulls each cell to wherever
consumption balances regrowth. Raising `grazingMaxIntake` alone (0.8, 1.0,
1.2) strips cells faster, `R/(Rhalf+R)` collapses, and the world dies
*sooner* — extinct at generation 4.0, 5.6, 8.7 respectively. Raising the
carrying capacity raises the equilibrium standing stock instead, and the
type-II term with it. The two knobs are not substitutes and not independent:
`kBase` 40 alone survives on seed s1 but goes **extinct on s2 and s3**
(generation 11.8 and 6.0), and `grazingMaxIntake` 1.2 alone is extinct on
every seed. Only together are they robust.

**The response surface near the old default is non-monotone**, which is the
reason no single-knob answer survives review: at default intake, `kBase` 18
and 22 go extinct, 25 survives, and **30 goes extinct again**. That is an
Allee-type founding cliff — 600 founders crash roughly tenfold before the
first birth is possible at `maturityTicks` 600 — and whether a run clears it
is not a smooth function of any knob. Tuning had to land somewhere the world
is comfortably away from that cliff, not one step past it.

**Two attractors, and only one is watchable.** Every survivable configuration
falls into one of two regimes. A *poor* world sits next to the extinction
cliff, runs 60–84% starvation, and always loses its predator guild
(0–5% of the population) — the arms race runs away in favour of `defense`
because defense is selected in everybody while attack is selected only in the
few remaining predators. A *rich* world carries enough filterer biomass to
feed a predator guild on top of it, and both guilds hold at roughly 50/50.
The trophic pyramid needs a base; the aliveness probes are asking for the
rich regime.

| Date | Knob | From → To | Probe evidence before | Probe evidence after | Rationale |
|---|---|---|---|---|---|
| 2026-08-08 | `probes/performance.ts` P12 severity | `gate` → `warn` | P12 red at 1.05e6 against a 2e6 gate; suite exits 1 | P12 yellow, same number; suite exit reflects tunable probes | Pre-adjudicated. The 2e6 target predates the model; the remaining 2× is model decisions, not optimisation. Gate A-2 owns the threshold. See "Fix wave F0–F4". |
| 2026-08-08 | `resources.planktonCarryingCapacityBase` + `resources.grazingMaxIntake` | 12 → 40, 0.55 → 1.2 | 3 seeds: **extinct at generation 4.0 / 5.1 / 4.9**; P3–P14 all n/a | 3 seeds × 45 generations: P3 100% in band (population 936–1831 / 1164–1698 / 995–1682, 0% at slot cap); P7 starvation 28/32/51%, predation 61/56/40%, temperature 8/8/5%, senescence 4/3/4%; P4 ratios 0.21–1.96; P6 98/100%; P13 h² 0.40/0.49; P14 Ne/N 0.22–0.27; **both guilds 0.51/0.49** | Moved together because neither works alone: `kBase` 40 alone is extinct on 2 of 3 seeds, `grazingMaxIntake` 1.2 alone is extinct on all 3. Standing stock sets achievable intake; bite rate without stock just strips the field. Buys the rich regime and with it the predator guild. Senescence still short of P7's 5% floor. |

| 2026-08-08 | `senescence.gompertzA` | 2.2e-5 → 9e-5 | senescence 4/3/4% of deaths across seeds — under P7's 5% floor; P7 WARN | 3 seeds × 45 generations: senescence 9/10/9%, P7 **PASS** on all seeds (starvation 31/49/28%, predation 53/34/56%, temperature 8/8/7%); P3 still 1.00 on all seeds | Old age was decorative. ~4× on the Gompertz baseline hazard puts senescence just above the floor without denting viability; the age slope (`gompertzB`) untouched so it still kills the old, not the unlucky. (Orchestrator row — A7's agent died at the session limit; same discipline, one knob, three seeds.) |

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
