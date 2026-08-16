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

### Gate A-2 — Sol (GPT-5.6, xhigh) review of the tuned suite, 2026-08-09

**Verdict: FAIL** — "I do not accept the current suite as a defensible
certificate that 'evolution stays interesting.'" Full report, verbatim:
`briefs/gate-a2-verdict.md` (brief: `briefs/gate-a2-sol.md`). The
orchestrator spot-checked the four acceptance-critical claims in code and
confirmed all four; the verdict is accepted. The six rulings, adjudicated:

1. **Ratchets.** P3's subject is legitimate but its dropped-births blind
   spot is acceptance-critical (printed, never asserted — 2.4e-3/s1 passed
   with 363 drops). **P5 and P13 demoted to warn same day** (this commit):
   P5's max-over-overlapping-windows metric rewards noise (Sol's endpoint
   check drops the closing run from 4/4/4 to 2/2/0); P13's ceiling is
   post-hoc and its documented V_A/V_P cross-check was display-only. P14
   stays warn; its census denominator should be the window mean.
2. **Defense pricing: no genome-table change.** And the design record's own
   claim was wrong: the "1.5×" is L1 weight mass (variance mass is ~1.43×),
   and defense loci do pay — q33 bills wariness at 2.5, others trade speed,
   attack, boldness or thermal breadth. Balance work, if any, goes through
   locus ablations, not input-mass fiat.
3. **Speed pricing: not a leak; keep realized-speed pricing.** The
   deep-time "only benefit is foraging" claim was false — speedCap feeds
   every movement policy, mate-seeking and the predation kernel. Add
   instrumentation (realized speed, mode fractions, cap–fitness covariance)
   before considering any maintenance cost.
4. **P8: the criterion is falsified, not unfalsifiable** (≈1.0 is not
   <0.5 — the brief's own framing was wrong). Split into P8a (Fst) / P8b
   (acceptance ratio) with per-side circular statistics recorded through
   `ScenarioNotes` — no SampleRow contract change needed — and replace the
   first-64-slots acceptance sample with a deterministic ID-hash sample.
5. **P12: reject 2×10⁶, re-derive from watchability.** One simulated
   generation per wall-clock second at 1,000 organisms = 0.9×10⁶
   organism-ticks/s; measured 1.008×10⁶ passes with ~12% margin. Gate only
   on a documented reference environment.
6. **P6∧P9 simultaneity: confirmed per run** — and 1.8e-3 (all seeds P9
   green with 100% guild presence) is stronger evidence than 3.2e-3/s1.
   But three certification seeds cannot estimate robustness under chaotic
   basin membership: gate promotion needs k-of-n aggregation (the runner
   has none) over a preregistered larger seed panel. "The slot cap is THE
   binding constraint" was too broad — it is one blocker among several.

Defects list for the fix wave (G1), from the report: P3 dropped-births
assertion; P8 split + instrument + sampling; P12 re-derivation; P14
denominator; P10's injected-allele estimator can false-pass (needs a tagged
allele or paired no-injection control); k-of-n aggregation; artifact
provenance (commit, config hash, host — reports currently overwrite a
generic filename); P1's "at the end" detail reads a stale liveCount; P2
certifies a token blacklist, not entropy hygiene. The A5 toggle-scenario
empty-report gap re-confirmed.

### Fix wave G1 — closed same day (`6d50f5f`)

All nine fixes, implemented by **Sol as implementer** (workspace-write
worktree, brief on stdin) and verified by the orchestrator: diff review,
252 tests run independently (Sol's sandbox cannot run vitest), and a
revert-sensitivity spot-check (reverting the P3 fix fails its new test).
Notable implementation choices: P10's control arm is a **zero-offset sham
injection** with a mirrored discrete companion, so the intervention's
population and id side-effects are preserved and the locus-mean difference
is attributable to the edit alone (cost: one extra sweep-length run per
seed); P8's per-side circular statistics ride `ScenarioNotes` — no
contract change was needed anywhere; report artifacts now carry
commit/config/host provenance under identity filenames with stable
"latest" copies. Ops footnote for worktree setups, recorded because it bit twice in one
merge: `.gitignore`'s `node_modules/` (trailing slash) does not match a
node_modules *symlink*, so the worktree's symlink rode a `git add -A`
into the wave's commit — and merging that commit **deleted the real
node_modules**, because checkout treats ignored paths as expendable and
replaced the directory with a now-self-referential link. Recovered with
`npm ci`; the ignore pattern now covers both forms; and worktree dep
symlinks should point *elsewhere* than the path they shadow. The suite after G1: gates P1, P2, P3; everything else
warn with honest criteria.

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

| 2026-08-08 | `genetics.quantMutationRate` | 1e-3 → 1.6e-3 | P4 ratio 0.17–0.22 across seeds at 150 gens (variance eroding); P6 75–92% | **Spec length (300 gens, 3 seeds): P4 4.46 / 4.88 / 0.43 — all in band**; P13 h² 0.52/0.72/0.59; P3 ≥0.999. Dose-response mapped: 3e-3 gave ratios 6.3–8.9 (runaway, s3 breached the 8× cap); 1.6e-3 at 150 gens reads high (3.8–10.7) because the denominator window sits in the post-founding trough — judge this knob at spec length only. | The plan's #1 leverage knob. Mutation input now balances selection+drift consumption at the probe's own windows. (Orchestrator row.) |

### The Red-Queen front, re-diagnosed on three seeds

The previous entry called the open problem a **one-sided attack–defense arms
race**, from s3 alone (defense +6.96 SD against attack +0.06 SD). Reading all
three seeds at 300 generations says that was one seed's expression of a
simpler and more universal disease, and the arms-race framing sent the first
round of knob candidates at the wrong target.

**What actually happens on every seed: the predator guild goes extinct and the
world ends as a starving filterer monoculture.** Late-window (generations
250–300) readings, three seeds, at `33d6cc1` + the engine fix below:

| Seed | predators late | starvation | predation | diet move | defense (abs) | P7 | P9 |
|---|---|---|---|---|---|---|---|
| s1 | 0% | 76% | 6% | −1.49 SD | +3.41 | WARN | WARN |
| s2 | 0% | 83% | 0% | −2.50 SD | +2.41 | WARN | WARN |
| s3 | 1% | 80% | 3% | −1.55 SD | +3.33 | WARN | WARN |

P9's *movement* test passes on all three (0.65–1.80 SD); what fails is guild
persistence. P7 fails by the starvation ceiling, not by the senescence floor.
The direction attack moves is seed-dependent (+2.51, −2.50, −1.79 SD) — which
is the signature of a trait under no selection at all, not of an arms race.

**Why predation stops paying — a measured mis-sizing, not a mystery.** The
kill kernel's size term is `sizeWindowGain · exp(−((ratio − 0.55)/0.3)²)`,
worth up to +2 logits when the victim is 0.55× the predator's length. But
`size` has a realised CV of **6–10%** in every run, so the ratio between two
encountering organisms is 1.00 ± 0.12 and the window's peak sits ~3.5 SD
outside the distribution that exists. Integrating the kernel over the realised
ratio density, a predator collects **0.26–0.35 of the 2.0 logits on offer**,
and fewer than 1% of encounters even reach ratio < 0.7. The default was
authored for a population with a 2× spread of body sizes; the genome does not
produce one, and cannot — `size` is written once at birth, so there are no
small juveniles to eat either. Together with defense reaching +2.4…+3.4 by
generation 50 (defense is cheap: 8 of its 9 loci carry no `armorPlating`
load, so it is close to un-paid-for), the total kill logit sits near −6 and
predation is arithmetically impossible. The predators then starve, `diet`
selects down toward filtering, and starvation takes 76–83% of deaths.

Expected size-window bonus against `sizeRatioOptimum`, at the realised CV of
8%: 0.55 → 0.31 logits (the default), 0.70 → 0.81, 0.80 → 1.25, 0.88 → 1.56,
1.00 → 1.77. The curve is still rising at 0.88, so a predator there is
rewarded for being modestly larger than its neighbour — the disparity
gradient stays alive, which a peak at 1.00 would flatten.

**Measurement provenance.** Every number from here down was taken against the
memo-precision fix landed at `d9d1839`, which A7 diagnosed but does not own.
F4's thermal-tax memo in `stageMovement` and `metabolicCostFor` returned a
full-precision double on a memo miss and a float32 on a hit, so the first tick
after a snapshot restore ran on different numbers than the run the snapshot
came from — a 1-ULP `vx`/`vy` divergence at tick 601 on **every** seed, which
P1 caught only on the one seed where it failed to re-converge before the next
hash checkpoint. Tuning numbers measured before that fix (the three rows above)
describe the same regime but not the same trajectory.

### Red-Queen screens: what was tried and what it did

Every row is a 300-generation baseline run unless noted. The founding-cliff rows
are 45-generation runs, which is enough because every extinction in this table
happens before generation 12.

| Knob move | s1 | s2 | s3 | Verdict |
|---|---|---|---|---|
| `attackDefenseCoef` 1 → 0.35 | **extinct at gen 9.1** | — | — | Rejected. Defense is the founders' only protection from each other; cutting it to a third re-runs the untuned predation crash. A "keep the kernel sensitive" knob is not free. |
| `energyPerPreySize` 0.9 → 2.2 | P7 **PASS** (starv 70%, pred 10%), P9 WARN (attack **0.00 SD**), P6 0.583 | — | — | Rejected as the primary. Fixes the mortality mix, but attack stops moving entirely and 7 loci fix — a bigger payoff per kill does not make attack pay if the kill never lands. |
| `sizeRatioOptimum` 0.55 → 0.70 | — | survives, P9 0.045 (predators **0%**) | P7 **PASS**, P9 **PASS** 2.74 (guilds 92%, predators 74%) | Rejected: bimodal. Same knob, same value, and s3 lands in the rich basin while s2 lands in the poor one. |
| `sizeRatioOptimum` 0.55 → 0.78 | — | extinct | extinct | Founding cliff. |
| `sizeRatioOptimum` 0.55 → 0.88 | P9 **PASS** 0.626 (guilds 100%, predators 72%), P7 72% starv, P6 0.708 | **extinct at 9.6** | **extinct at 6.7** | Right mechanism, overshoots the cliff. This is the run that proved the guild collapse is fixable at all. |
| + `maturityTicks` 600 → 450 | survives 45g | **extinct at 11.8** | survives 45g | Rejected. Breeding earlier clears the cliff on two seeds only. |
| + `diet` baseline 0 → −1.4 | survives; P9 predators **0%** | survives; P9 predators **0%** | (in flight) | Rejected. Founders that start as filterers clear the cliff and then never invent carnivory — the guild the knob was meant to protect never forms. |
| + `baseLogit` −3.2 → −4.45 | P7 **PASS**, P9 **PASS** (guilds 92%, predators 84%) | P9 guilds 19% | P9 guilds 86%, pred 10% of deaths | **Accepted**, below. |

| Date | Knob | From → To | Probe evidence before | Probe evidence after | Rationale |
|---|---|---|---|---|---|
| 2026-08-08 | `predation.sizeRatioOptimum` + `predation.baseLogit` | 0.55 → 0.88, −3.2 → −4.45 | 3 seeds × 300 gens: predator guild present in **0% / 0% / 1%** of samples, starvation 76/83/80%, predation 6/0/3%; P7 and P9 WARN on all three | 3 seeds × 300 gens: guild present **92% / 19% / 86%** (predators 84/4/82% of the population), predation 6/7/10% of deaths, starvation 67/75/72%; P7 **PASS** on s1 (0.055) and P9 **PASS** on s1 (0.750); P3 1.00 on all three; P13 0.71/0.41/0.61; P14 0.108/0.206/0.141 | Moved together because the pair is one mechanism and neither half works alone: 0.88 alone is extinct on 2 of 3 seeds, and a lower `baseLogit` alone only deepens the monoculture. The window fix adds ~1.25 logits of mean kill probability at the realised size CV, and the `baseLogit` offset hands them back — so predation keeps its **intensity** and changes its **shape**, from "uniformly impossible" to "decided by how much bigger you are than your neighbour". Size is a trait the model actually charges for (metabolic cost ∝ size^0.75), unlike defense, so this puts the arms race on a costed axis. Not yet a 3-seed P9 pass: s2 still falls into the poor basin, and P6 drops to 0.63–0.77 because a 5.8–6.6 SD defense sweep drags linked loci. |

### `probe:full` costs hours now, and that is the accepted price

The brief's endgame is `LONG_SIM=1 npm run probe:full`, exit 0, "under ~40
min". That number was set when every run ended at generation 5. It cannot be
met now, and the reason is the campaign succeeding rather than anything going
wrong.

**Orchestrator ruling, 2026-08-08: accepted at ~2.5–3 hours.** A suite that
runs 300–600 generations on surviving worlds is the honest price of the
product's central claim, and generations are not to be trimmed to fit a stale
estimate. It runs in the background as the campaign-closing record, at future
gates, and nightly. The options below are recorded as the wall-clock levers
that remain, not as a request to shrink the suite.

Measured: `probe:quick` (175 generations on one seed, plus P1 and P12) takes
**5m 24s** at the accepted config. A single 300-generation baseline run takes
**~13 minutes** of core time. `probe:full` is 3 seeds × (baseline 300 + barrier
300 + sweep 200 + speciation 600) = **4200 generations**, run sequentially —
roughly **3 hours**, and the tuned world is *more* expensive per generation
than the numbers above because population now reaches ~3100 instead of dying.

This needs an orchestrator decision before the endgame gate means anything.
The options, cheapest first:

1. ~~`world.fieldCellSizeWu` 25 → 45~~ — **measured and rejected, see the row
   below.** The field pass is not where the time goes.
2. **Cut `speciation` from 600 generations to 300** — it is 43% of the suite's
   cost and feeds only P11, which is pre-adjudicated to stay `warn`.
3. **Run the four scenarios as parallel processes.** They are independent; the
   runner is sequential. On 8 cores this is ~3× wall-clock for free, and it is
   an A5 change of maybe twenty lines. **With (1) dead, this is the only option
   that buys wall-clock without changing what the suite measures.**
4. **Accept `probe:full` as a nightly job** and gate CI on `probe:quick`.

A7 did not choose among 2–4 because 2 changes a spec length, 3 is not A7's
file, and 4 is a policy call.

**`world.fieldCellSizeWu` 25 → 40/50/60: measured, rejected, and it falsifies
the F4 hypothesis.** The F4 ledger named field-grid resolution the biggest
remaining P12 lever — 3840 cells serving ~512 organisms — and Gate A-2 lever
(a) rests on it. Measured serially on a quiet machine, one P12 run each:

| `fieldCellSizeWu` | cells | org-ticks/s | mean population in the perf harness |
|---|---|---|---|
| 25 (default) | 3840 | 1.01×10⁶ | 512 |
| 40 | 1500 | 1.07×10⁶ | 511 |
| 50 | 960 | 1.07×10⁶ | **471** |
| 60 | 660 | 1.07×10⁶ | **313** |

Cutting the cell count 2.6× buys **6%**, and everything past 40 wu buys nothing
further while visibly damaging the ecology: the perf harness turns predation,
senescence and thermal hazard off, so the population falling to 471 and 313 is
*starvation* — a coarser field changes the grazing dynamics enough to starve a
world that the fine grid feeds. The knob is therefore not a free performance
lever in either direction, and 6% is not worth an ecology risk.

The useful conclusion for Gate A-2: **P12's remaining 2× is not recoverable
from field resolution**, so lever (a) is closed. At most ~10% of the tick is
the field pass; the rest is per-organism work, which points at F4's lever (b)
— three separate neighbour queries per organism per tick (behaviour r=90,
predation r=45, mating r=120) — and that is a model change, not a knob.

### The two discriminators — and the correction they force

Run at the orchestrator's direction after the knob phase closed. Both were
designed to attribute a red probe rather than to move a knob, and **both
overturned an A7 claim**, one of them a headline claim that was already on its
way into the Gate A-2 brief. Recorded before the superseded version so nobody
reads the old conclusion first.

#### (a) Is P4/P6 sweep consumption or mutation shortfall? — Mutation, by ~3.4×

Two readings. First, the 18 runs measured this campaign already contain a
matched-intensity comparison, using predator fraction as the proxy for
selection intensity:

| Arm | Loci alive (P6) |
|---|---|
| Mutation on, weak selection (<10% predators) | 0.708–0.938, **mean 0.843** (n=9) |
| Mutation on, fierce selection (≥50% predators) | 0.583–0.958, **mean 0.727** (n=8) |
| Mutation off, weak selection | **0.438** (n=1) |

Holding mutation fixed, selection intensity costs ~0.12 of loci alive — real,
but well inside the seed spread, since the fierce arm's range (0.583–0.958)
covers the weak arm's. Holding selection weak, removing mutation costs **0.41**,
which lands outside the mutation-on range entirely. **Mutation input dominates
sweep consumption by about 3.4×.**

Second, the direct dose: `quantMutationRate` 1.6e-3 → 3.2e-3 at the accepted
config, three seeds.

| Reading | 1.6e-3 (accepted) | 3.2e-3 |
|---|---|---|
| P6 loci alive | 0.625 / 0.771 / 0.771 | **0.958 / 0.979** / — |
| P9 guild present | 92% / 19% / 86% | **99%** / 0% / — |
| P4 V_A ratio | 0.179 / 0.272 / 0.214 | 8.27 / 2.80 / — |
| P3 viability | 1.00 / 1.00 / 1.00 | 0.991 / 1.00 / **extinct at gen 12** |

#### The correction: P6 and P9 *can* be green together, and A7 has now shown it

The section below concluded from the 3-seed configs that a live predator guild
and retained locus variance move in opposite directions, and recommended Gate
A-2 treat "P6 and P9 green simultaneously" as unproven-until-shown. **On s1 at
3.2e-3 they are both green at once**: P6 0.958 with the guild present in 99% of
samples and predators at 73% of the population. More than that, it is the only
run in the whole campaign with a **two-sided** arms race — attack 2.95 SD
against defense 2.93 SD, where every other config had defense running 5–7 SD
against an attack that barely moved.

So the trade-off is real as a correlation across the configs A7 happened to
sample, and false as a law. The correct statement is narrower: **at a fixed
mutation rate**, buying guild persistence costs locus variance; raising the
mutation rate buys both back at once. What actually binds is elsewhere —
**mutation load at the founding cliff** (s3 extinct at generation 12), plus
P4's ceiling (8.27 against a max of 8.0) and P14's floor (0.081 against 0.10)
on s1. The founding transient has now been the binding constraint for the size
window, the attempt radius, and the mutation rate alike.

A7 stopped here rather than searching the dose, per the directive that the knob
phase is closed. The obvious next experiment, for whoever picks it up, is an
intermediate rate around **2.0–2.4e-3** on three seeds: the evidence says P6
and P9 both come green somewhere below the dose that kills s3, and the
question is only whether P4's ceiling and P14's floor leave a window open.

#### (b) Is frequency-dependent predation what stops hue diverging? — No

A7 hypothesised that frequency-dependent predation acts as balancing selection
holding both sides of the ridge at the same hue distribution, which would
explain P8's cross/within mate acceptance sitting at 1.03. Tested directly, the
barrier scenario with `enableFrequencyDependentPredation` off:

| Barrier run | Fst across the ridge | cross/within acceptance |
|---|---|---|
| Default | 0.063 → 0.723 | 1.03 |
| `prefSigmaBaseDeg` 45 | 0.161 → 0.760 | 1.01 |
| `prefSigmaBaseDeg` 32 | 0.144 → 0.798 | 1.04 |
| **frequency dependence off** | 0.292 → **0.931** | **1.02** |

**Hypothesis falsified.** Acceptance does not move even with the mechanism off,
and neutral Fst reaches 0.93 while mate choice stays blind. Two explanations
survive, and A7 could not separate them with the instruments available:
`displayHue`'s within-side spread (sd ≈ 34°) may simply exceed any between-side
divergence a polygenic trait accumulates in 250 generations, so the pairwise
distance distribution is the same across and within; or the authored magic-trait
pleiotropy is pinning it — q36 loads `diet`, `size` and `displayHue` together,
and both sides of the ridge experience the *same* ecology, so parallel
selection on diet and size would drag hue to the same place on both sides
rather than letting it drift apart.

Distinguishing them needs a per-side trait mean, which `SampleRow` does not
carry (it has `populationByDeme` but no per-deme trait moments). **That is the
concrete instrumentation gap blocking P8's second criterion**, and it is a
stats/contract question rather than a tuning one.

### The dose batch (2026-08-09) — run, and the window is not where it was thought to be

The intermediate-rate experiment the discriminator called for, run at the
campaign resume. Cliff screens (45 gens × 3 seeds): **all three doses
survive the founding cliff** — the constraint that killed 3.2e-3 does not
reach down to 2.4e-3. Spec length (300 gens × 3 seeds, baseline):

| Reading | 2.0e-3 | 2.2e-3 | 2.4e-3 |
|---|---|---|---|
| P3 viability | 1.00 / 1.00 / **FAIL 0.942** (s3 rides cap, 18k births dropped) | **FAIL 0.910** (s1 rides cap, 32k dropped) / 1.00 / 1.00 | 0.993 / 1.00 / 1.00 |
| P4 V_A ratio | 7.17 / 5.14 / 5.30 — all in band | 0.136 / 3.84 / **11.7** | **0.183** / 4.75 / **0.142** |
| P6 loci alive | **0.833 / 0.875 / 0.938** | 0.875 / 0.917 / 0.938 | 0.833 / 0.938 / 0.917 |
| P9 attack SD | **1.63 / 1.72 / 1.58 — moves on every seed** | 0.65 / 0.54 / 0.58 | 2.08 / 0.85 / 0.77 |
| P9 guild present | 11% / 39% / 77% | 100% / 0% / 67% | 99% / 2% / 0% |
| P13 h² | 0.46 / 0.46 / 0.58 | 0.69 / 0.62 / 0.41 | **FAIL 0.82** / 0.73 / 0.44 |
| P14 Ne ratio | 0.194 / 0.199 / 0.107 | **0.086** / 0.193 / 0.214 | 0.114 / 0.210 / 0.167 |

Every dose is rejected, each by a different probe — which is the finding.
The dose that buys what the discriminator promised (2.0e-3: P6 retention up
~0.15 across all seeds versus 1.6e-3, attack moving 1.5–1.7 SD on every
seed, P4/P13/P14 all green) fails **P3 by cap-riding**: better-adapted
worlds outgrow the 4,096-slot container and the suite correctly refuses the
cap-and-starve regime. At 2.2e-3 the same failure moves to s1; by 2.4e-3
the guild dies on two seeds instead.

**The binding constraint has moved.** The campaign's recurring constraint
was the founding transient; for the mutation dose it is now the slot cap.
Roadmap item 4 (density regulation that isn't cap-and-starve) is therefore
not cosmetic — it is what pins `quantMutationRate` at its current value,
and the dose worth revisiting after it lands is ~2.0e-3.

Guild persistence, meanwhile, does not improve monotonically with dose at
spec length on any seed — s2 keeps its guild only at 2.0e-3 (15%), s1 only
at ≥2.2e-3, s3 only at ≤2.0e-3. Whatever separates the guild-keeping basin
from the monoculture basin, it is seed-specific and not purchasable with
mutation input alone. That closes the discriminator's question honestly:
mutation input buys locus retention and a two-sided race, but **P6 ∧ P9
simultaneity on all three seeds is not reachable inside the current density
regime**, and Gate A-2 gets that as measured.

Follow-up, same day — **1.8e-3, and the adjudication**. The midpoint fails
hardest: P3 red on two seeds (cap-riding reaches down to 1.8e-3), P4
breached on all three (0.089 and 0.161 under the floor; s2 at **21.9** over
the ceiling on a size-variance explosion), P13 red on s2 (h² 0.94). And yet
it posts the batch's best guild persistence — 100% presence with predators
at 78–81% on *every* seed. Which basin a seed falls into is not a smooth
function of dose anywhere in the bracket: guild fate is seed-specific
basin-hopping, and no dose in 1.8–2.4e-3 buys the suite green.

**Adjudicated: the window does not exist. `quantMutationRate` 1.6e-3
stands as the accepted config.** The residual — P4 low, P6 short of its
across-replicates ideal, the one-sided race on two seeds, s2's monoculture
basin — goes to Gate A-2 as measured, along with this batch's two
structural findings: the slot cap is what pins the dose (roadmap item 4),
and guild persistence is not purchasable with mutation input (roadmap
items 1+2 are the mechanism-shaped answer).

### Campaign close (2026-08-09)

`LONG_SIM=1 probe:full` on the accepted config (1.6e-3), machine idle:
**suite WARN, zero FAILs** — every gate green on every seed (P1, P2, P3,
P5, P13), P10 and P14 pass 3/3, and the warns are exactly the documented
residual (P4 ×2 seeds, P6, P7 ×2, P8, P9 ×2, P11, P12). Rendered table:
`runs/full-close-1.6e-3.log`; report: `runs/full-report.json`. WP-A7 is
closed; the residual and this record go to Gate A-2.

### Superseded by (a) above: the trade-off as A7 first read it

**Kept because the correlation is real and the reasoning from it was wrong** —
it is exactly the kind of "settled" conclusion the design record exists to stop
someone re-deriving. Read (a) first: raising the mutation rate makes P6 and P9
green together, so the pattern below is a property of the configs A7 sampled at
a fixed mutation rate, not a law of the model.

Across every configuration measured on three seeds **at `quantMutationRate`
1.6e-3**, a live predator guild and retained locus variance move in opposite
directions:

| Config | P9 guild present | P6 loci alive | P4 V_A ratio |
|---|---|---|---|
| Food-only (before the size window) | 0% / 0% / 1% | 0.896 / 0.854 / 0.833 | 0.201 / 7.20 / 7.58 |
| **Accepted** (size window + `baseLogit`) | **92% / 19% / 86%** | 0.625 / 0.771 / 0.771 | 0.179 / 0.272 / 0.214 |
| `attemptRadiusWu` 75 | 0% / 0% / 7% | 0.917 / 0.792 / 0.875 | 0.155 / 5.39 / 6.87 |

Single-seed screens land in the same ordering: `sizeRatioOptimum` 0.88 alone
gave 100% guild and P6 0.708; `energyPerPreySize` 2.2 gave 98% guild and P6
0.583. **Every config with a living predator guild has P6 ≤ 0.771; every config
without one has P6 ≥ 0.79.** The mechanism-table result says the same thing from
the other side: five of six toggle-off runs keep more loci alive than the
reference, and the reference is the run with the fiercest selection.

The causal story A7 inferred: a live guild means intense predation, intense
predation means a large defense sweep (+5.8…+6.6 SD), and a sweep of that size
drags linked loci and eats variance ratios — therefore P6 and P9 could not both
be green until defense was made expensive, a genome-table change.

**That inference was wrong, and discriminator (a) is what caught it.** The
sweep-consumption effect is real but small (~0.12 of loci alive, inside the
seed spread); the dominant term is mutation input (~0.41), and at 3.2e-3 both
probes go green together on s1 *with* a 73% predator guild — and with the
campaign's only two-sided arms race, attack 2.95 SD against defense 2.93 SD.
The correct reading of the table above is "at a fixed mutation rate, guild
persistence is bought with locus variance", not "the suite asks for two
incompatible things".

### `attemptRadiusWu` 75 — rejected, and it is the cleanest demonstration

Reasoning was: s2 loses its guild in generations 50–120 while it is the
*poorer* world at that moment (population 1061 against 1632 and 1376 on the
seeds that keep theirs) and while its defense is *lower* (+3.52 against +3.91
and +4.73) — so the guild dies of prey scarcity, not of defense escaping, and a
wider attempt radius should raise predator income without adding food.

It did the opposite: guild present 0% / 0% / 7%, starvation 80/80/73%. Raising
encounter rate raised early predation hard enough to push every seed into the
poor basin. P6 rose to 0.917 / 0.792 / 0.875 and P4 passed on two seeds — the
trade above, running in the direction nobody wanted. Also non-monotone at the
cliff, as ever: `attemptRadiusWu` 60 is extinct on s1 at generation 10.7 while
75 survives on all three.

### P8's acceptance criterion: the first diagnosis was wrong, and so was the second

**Both explanations below were later falsified — see discriminator (b).** The
preference window is not the constraint, and neither is frequency-dependent
predation. Kept for the measurements and because the reasoning is a good
example of a plausible mechanism that measurement did not support.

A7's first reading was that `mating.prefSigmaBaseDeg` 70° is simply too wide —
the Gaussian acceptance kernel needs 82° of hue divergence to halve, and
narrowing to 32° would need only 38°. Measured on the barrier scenario at 300
generations, that is **not** what is happening:

| `prefSigmaBaseDeg` | Fst across the ridge | cross/within acceptance |
|---|---|---|
| 70 (default) | 0.063 → 0.723 | 1.03 |
| 45 | 0.161 → 0.760 | 1.01 |
| 32 | 0.144 → 0.798 | 1.04 |

Acceptance does not move at all. A ratio pinned at 1.0 under a Gaussian kernel
means the cross-side hue-to-preference distances *equal* the within-side ones —
i.e. **`displayHue` is not diverging across the barrier**, after 250
generations of complete isolation with Fst at 0.72–0.80. The preference window
is not the binding constraint; there is nothing for it to discriminate.

A7's hypothesis at this point was frequency-dependent predation acting as
balancing selection that holds both sides' hue distributions at the same spread
around the same centre, supported by the toggle-off run in which `displayHue`
moves +0.90 SD directionally against +0.25 SD with it on. **Discriminator (b)
tested it directly and falsified it**: with the mechanism off, acceptance is
1.02 and Fst reaches 0.931. The live explanations are now that `displayHue`'s
within-side spread exceeds any between-side divergence available in 250
generations, or that the magic-trait pleiotropy pins hue to an ecology both
sides share.

So P8's second criterion and the hue-variance mechanism are in direct conflict,
which is the same shape of finding as the P6/P9 trade above. Narrowing
preference also costs: at 45° P14 fell to 0.092, under its 0.10 floor, because
choosier mating skews reproductive success and lowers Ne. **Knob not moved.**
That test has since been run; see discriminator (b) for the result and for the
instrument gap that now blocks the question.

### Structural finding for a human or Sol: what the defense loci buy

A7 was told to stop and report rather than edit `genome.ts` if the conclusion
was "the table gives defense too much un-paid-for input and no knob fixes it".
The measured answer is narrower than that, and worth stating precisely because
the loose version would licence a table edit that the evidence does not.

**A knob did fix the headline failure.** Guild persistence went from 0–1% to
82–92% on two of three seeds without touching `genome.ts`, because the binding
problem was a mis-sized *config* default (the size-ratio window), not the
genome.

**What no config knob reached.** Two facts about `W` that A7 can measure but
not change:

1. `defense` carries **1.5× the genetic input mass of `attack`** — Σ|w| of 2.06
   across 9 loci against 1.38 across 5. A trait with more input responds faster
   to the same selection, which is one reason the race is lopsided in every run.
2. **8 of the 9 defense loci carry no `armorPlating` load at all** (only q07
   pairs them, +0.20 defense with +0.10 armour). The contract note above says
   "armour is the thing you pay for; defense is the outcome armour and several
   other loci buy" — that is not what the table implements. Whatever those
   other eight loci charge for defense, it is not the metabolic armour bill the
   design record describes, and the mismatch between the note and the table is
   itself worth a reviewer's attention.

**What A7 tried and could not make work.** The only config knob that reaches
the defense payoff directly is `attackDefenseCoef`, and cutting it to 0.35
emptied the world by generation 9 — defense is also the founders' only
protection from each other, so the knob that slows the escape also removes the
thing keeping 600 mutual half-predators alive. Every other lever changed the
*shape* of predation rather than the price of defense.

**The residue, stated as a hypothesis rather than a conclusion.** At the
accepted config, defense moves +5.8…+6.6 SD while attack moves +0.75…+2.3 SD,
and the two probes still red on all seeds are the two a large sweep would
predict: P6 (63–77% of quantitative loci retain variance, against an 80% bar)
and P4 (V_A ratios 0.18–0.27 against a 0.25 floor). A7 could not separate "the
defense sweep is eating the variance" from "mutation input is short at this
selection intensity" with the levers it owns — both predict the same two
breaches. Distinguishing them is the first question for whoever picks this up,
and the cheapest discriminator is a `no-mutation` versus baseline comparison at
matched selection intensity, not another knob sweep.

### Threshold ratchet

"A probe that has never failed is not testing anything." Ratcheted against the
three-seed readings at the accepted config above; every moved threshold sits
just outside measured behaviour, and severity moves to `gate` only where three
seeds passed with margin.

| Probe | Threshold before → after | Severity | Measured on 3 seeds | Why this number |
|---|---|---|---|---|
| P3 viability | ≥98% of samples in band → **≥99%** | warn → **gate** | 1.00 / 1.00 / 1.00 | Every other reading in the suite is meaningless over an empty ocean, and the tuned world never leaves the band. |
| P5 no flatline | ≥2 of 4 focal traits, **unchanged** | warn → **gate** | 4 / 4 / 4 at 300 gens, but **2 / 4 at quick length** | Ratcheted to 3, then **reverted by measurement**: `probe:quick` went red immediately. P5's count is a function of the window, not only of the world — the window is the last third of the run capped at 50 generations, so a 60-generation quick run scores traits over 10 generations and only the fastest two clear 0.3 SD (0.26 / 0.31 / 0.21 / 0.87). A threshold ratcheted from spec-length data alone is invalid for this probe. Severity ratchet stands; the number does not move until the probe scores something length-independent. |
| P13 heritability | h² ∈ [0.2, 0.8] → **[0.25, 0.78]** | warn → **gate** | 0.707 / 0.408 / 0.609 | The old band spanned nearly every value a sane estimator can return. |
| P14 drift | Ne/N ∈ [0.1, 1.2] → **[0.1, 0.6]** | stays warn | 0.108 / 0.206 / 0.141 | Ne/N never exceeded 0.22 on any config or seed, so a 1.2 ceiling could not catch the census-sized Ne it exists to catch. **Floor left alone and severity left at warn deliberately**: the best seed reads 0.108 against a 0.10 floor, and a probe 8% from a breach would gate on seed luck. |
| P4, P6, P7, P9 | unchanged | stay warn | still breaching | These are the open front; ratcheting a red probe would be backwards. **Discriminator (a) since added a reason not to touch P4's ceiling either**: at `quantMutationRate` 3.2e-3, P4 reads 8.27 against its 8.0 maximum while P6 and P9 both go green, so the ceiling is a live constraint on the very knob that fixes the other two, not slack. |
| P14 floor | unchanged at 0.10 | stays warn | 0.081 at 3.2e-3 mutation, 0.092 at `prefSigmaBaseDeg` 45 | Two separate configs have now pushed P14 under its floor. Leaving it warn was right, and the floor is doing real work rather than sitting unreachable. |
| P8, P10, P11, P12 | unchanged | stay warn | P10 passes on s1 only; P8 half-passes; P11/P12 pre-adjudicated | Not demonstrated on three seeds yet. |

### Mechanism marginal contributions

Toggle-off runs measuring what each variance mechanism actually buys. A
mechanism that shows no marginal contribution is a mechanism to delete, not to
keep for comfort.

**Read the caveat before the table.** These are **one seed** (s1), 300
generations, at the accepted config, and the seed-to-seed spread of P4's own
V_A ratio at a *fixed* config spans 0.18–7.58. So a 2× difference between two
rows here is inside the noise. Only two mechanisms separate from it, and the
table says so rather than assigning six confident verdicts. Promoting the rest
needs three seeds each — 18 runs, ~2 hours — which is the honest price of this
table and was not payable in this session.

V_A ratio is late/early additive variance on P4's own windows (generations
20–50 against 250–300). "Loci alive" is P6's fraction of the 48 quantitative
loci still above the variance floor at generation 300.

| Mechanism | Toggle | V_A(size) | V_A(diet) | V_A(defense) | Loci alive | Predators | Verdict |
|---|---|---|---|---|---|---|---|
| *(all on — reference)* | — | 1.38 | 0.18 | 0.21 | 0.625 | 95% | |
| Spatial GxE | `enableSpatialGxE` | 0.71 | 0.41 | 1.10 | 0.875 | 83% | Not separable at n=1 |
| Frequency-dependent predation | `enableFrequencyDependentPredation` | **28.1** | 0.07 | 0.72 | 0.771 | 83% | **Measured.** Turning it off lets `displayHue` run directionally (+0.90 SD against +0.25 SD with it on) and blows the size-variance ratio out by ~20×. The mechanism is doing its advertised job — penalising the common morph — and it is load-bearing for hue. |
| Climate red-noise walk | `enableClimateWalk` | 0.72 | 0.06 | 0.55 | 0.875 | 99% | Not separable at n=1 |
| Mutation input | `enableMutation` | 0.28 | 0.11 | **0.05** | **0.438** | **0%** | **Measured, and the largest single effect.** Loci alive fall from 0.625 to 0.438, V_A(defense) collapses to 0.05, and the predator guild goes extinct — without mutation the world cannot hold the diet variance a second guild needs. |
| Seasonality | `enableSeasonality` | 0.85 | 0.65 | 0.87 | 0.833 | 91% | Not separable at n=1 |
| Assortative mating | `enableAssortativeMating` | 0.37 | 0.94 | 0.20 | 0.958 | 91% | Not separable at n=1, but note `displayHue` moves −1.01 SD with it off against +0.25 SD on — the signal drifts freely once nothing is choosing on it. |

**The finding nobody expected, and it matters for the open front:** *five of
six toggle-off runs keep MORE loci alive than the reference* (0.77–0.96 against
0.625). Turning mechanisms off makes P6 look better. The reference run is the
one with the fiercest selection — a +6.57 SD defense sweep and 95% predators —
and selection that intense consumes variance and drags linked loci. So P6's
current breach is not evidence that a variance mechanism is missing; it is the
cost of the aliveness the other probes are asking for. Anyone tempted to fix P6
by adding variance input should read this row first.

**A runner gap found while measuring this** (reported, not fixed — it is A5's
file): every aliveness probe carries `scenario: 'baseline'` in its
`ProbeDefinition`, so `--scenario=no-mutation` runs the sim and writes the
series but evaluates **no probes at all** ("P3 (needs baseline)"). The six
toggle scenarios exist specifically for this table and no probe can read them.
The numbers above were computed from the JSONL series directly. Either the
probes should accept the toggle variants of their scenario, or the runner
should refuse a scenario no selected probe can read instead of burning 40
minutes of compute to produce an empty table.

## Deep time — the user's 2,000-generation watch (2026-08-09)

The user ran the app sim (`seed=colour-test`) to generation ~1,998 — 3–6×
past what the probe suite certifies (300–600 generations) — and shared the
trend panel. It is the longest run this project has, and it recorded a clean
three-act story worth keeping:

1. **Predator bloom and collapse.** The predator fraction spiked toward 1.0
   early, overshot its prey base, and crashed to ~0 within roughly the first
   10% of the run. It never recovered. Final tallies: predation 110k of 4.85M
   deaths (2.3%); starvation 82%.
2. **Relaxed selection on defense, visible over ~1,500 generations.** Defense
   rose fast under predation, then decayed slowly and monotonically for the
   rest of the run — vestigialization: armor costs metabolism and nothing was
   attacking. The charts caught a textbook phenomenon. Attack stayed at the
   floor throughout.
3. **The aftermath economy.** `speedCap` ran away ~8× (corrected at Gate
   A-2: speed feeds every movement policy, mate-seeking and the predation
   kernel, not only foraging, and its realized-work pricing was ruled
   honest); heterozygosity eroded 0.87 → ~0.1 (the
   frequency-dependent predation that pumps variance died with the predators —
   consistent with the marginal-contribution table's hue row); population rode
   the 4,096 slot cap in a fill-and-starve sawtooth, then crashed late to ~538.
   `species 1, clades 1` after 2,000 generations.

The read: real dynamics unfolded, but the engine of ongoing surprise —
predator–prey coevolution — died at ~generation 150, and 90% of the run was
aftermath. This is P9's open front observed at depth, and it is why the user
found the trends "a bit predictable."

**Kelp is inert, verified in code.** Its only coupling to organisms is the
predation shield: `kelpCoverAt` discounts kill probability at the victim's
position, further discounted by the victim's forage boldness
(`predation.ts:186`). It is not food, it does not affect mating, and no
behavior policy reads it — nothing seeks kelp, even when fleeing. In a
predator-free world it therefore does exactly nothing, which is what the user
noticed.

**`catas 0` is expected, not a bug.** The catastrophe death cause is reachable
only through the `meteor` protocol command (a god tool); no disturbance fires
spontaneously. The climate walk wobbled ±0.02 °C the whole run.

**Why predators never re-evolved (user question, answered from code).**
"Predator" is a statistical label on the continuous `diet` trait, not a
species — expressed diet is a share in (0,1), plankton efficiency is
`(1−diet)^q`, prey efficiency `diet^q` (`formulas.ts`), the recorder bins the
guild at 0.5, and predation attempts are rate-gated by diet with deliberately
no hard cutoff (`predation.ts`). The run's own `species 1` confirms the act-one
predators were a diet morph of the forager population. Re-evolution is
therefore structurally possible, and its absence over 1,800 predator-free
generations has three compounding causes: (1) the q=1.6 convexity is a
two-sided fitness valley — a mid-diet organism is bad at both jobs, so
selection pushes diet-ward drift back to the filterer pole; (2) the toolkit
rusted — attack sat at the floor and heterozygosity eroded to ~0.1, so the
standing variance a guild transition would draw on is gone; (3) the rare-morph
advantage operates *through* predation, so a rare proto-predator in a
predator-free world gets no invader's bonus. Real carnivory evolves up a ramp
(scavenging, egg-eating, juvenile predation); the model has a valley and no
ramp. Candidate fix recorded on the STATUS.md roadmap under item 1.

**Audit question raised, not adjudicated:** is speed's cost fully paid?
Metabolic cost charges *realized* speed, so an evolving `speedCap` is free
until used — an 8× runaway in a world selecting only on foraging is either
honest (fast foragers out-eat their burn) or a cheap-trait leak, the same
shape as the defense-pricing question already on the Gate A-2 agenda. Added
there.

### The same run at 5,277 generations (2026-08-09, overnight)

The user kept the same world running overnight to generation ~5,277 (tick
4.75M, pop 2,716) and shared the panel again. Mostly it deepens act three —
starvation 82.8% of 11.9M deaths, predation ~1%, `species 1, clades 1`, size
up ~2.7× (10.2 → 27.8 cm) and `speedCap` now ~11× its floor, both still
climbing — but two things in the late window are *new*, and they are the most
hopeful data the project has:

- **Heterozygosity partially recovered.** After bottoming near 0.1 around the
  run's midpoint it climbs visibly in the last ~500 generations. With the
  frequency-dependent pump dead, the remaining variance source is mutation
  input — i.e. deep time directly demonstrates mutation input rebuilding
  standing variance, which is exactly the lever the dose batch (tuning log)
  raises. The dose experiment's mechanism is confirmed at depth before the
  experiment ran.
- **Attack rose off its floor for the first time in ~5,000 generations.**
  Defense's vestigial decay continued as before, but attack — floor-bound
  since act one — climbed late and converged with it, in the same window as
  the heterozygosity recovery and with the climate walk sitting at −2.00 °C
  (the HUD log shows it pinned there; the earlier watch saw ±0.02 °C wobble).
  The honest reading is *not* incipient re-carnivory: predation is still ~0,
  so rising attack is more plausibly mutation-driven drift on a
  weakly-selected trait — and possibly an unpaid-trait leak, since the Gate
  A-2 pricing question covers attack's cost too. But drift or not, rebuilt
  attack variance is exactly the standing variance a guild rebirth would draw
  on (barrier 2 of the re-evolution analysis above). The late window is the
  most re-evolution-favorable state this world has been in since act one —
  what is missing is the selective push, which is roadmap items 1+2's job.

One more reading: at gen 5,277 the population sits at 2,716, off the slot cap
— the late-run sawtooth-and-crash pattern from the 2,000-gen watch resolved
into something that looks more like resource-tracking than cap-bouncing. Worth
re-examining after roadmap item 4 rather than assuming either way.

## Roadmap 1+2 — the D-wave (2026-08-09)

The go arrived the same day the pause lifted ("Please go ahead and launch the
next phase"), with a standing instruction to delegate for token efficiency.
**Sol (GPT-5.6, effort high) implemented the entire wave** — D0 contracts
through D4 HUD per `briefs/d-wave-sol.md` — in an isolated worktree with a
real `npm ci` (no dependency symlink, closing out the G1 incident's trap).
Merged as `b491a45`; Sol's full report is preserved at
`briefs/d-wave-sol-report.md`.

What shipped:

- **Disturbance regime.** A deterministic per-tick Poisson scheduler
  (tick-keyed forked RNG streams per shock type): thermal excursions as
  normalized-exponential-decay jumps on the climate walk, plankton crashes
  (global or disc-regional productivity multipliers), kelp storms (rect
  swaths cleared, regrowing). All three raise `SimEvent`s; scheduler state
  round-trips snapshots (format v3) and participates in `stateHash`.
- **Carrion / scavenging on-ramp.** Deaths deposit `depositFraction` (0.3) of
  size-biomass into a carrion grid; exponential decay, half-life one
  generation; feeding takes plankton first, then carrion under remaining
  headroom via concave `diet^0.7` type-II intake with no combat checks. The
  diet valley now has a floor.
- **Scripted shocks.** `triggerDisturbance` command, so scenarios (and later
  god-tools) can force a specific shock at a specific tick.
- **Probes P15/P16** at warn. P15: smoke mode in `probe:quick` (all three
  scripted shock types fire, mid-shock snapshot round-trips) and a
  spec-length regime mode (natural rates ±40%, ≥95% shock survival,
  post-shock trait movement above the quiet baseline). P16: filterer-side
  founders, scripted global crash at generation 60, asserts diet rise +
  attack-SD rise + predator-guild persistence, aggregated ≥1/3 seeds.
- **The off arm is byte-identical to the pre-wave world.** Disturbances-off
  runs preserve the golden trajectory hash — independently reproduced by the
  orchestrator against pre-wave source (`6922907c6421d7bf`), so the master
  toggle is a strict marginal-contribution control, not a same-seed argument.

Verification (orchestrator, not delegate self-report): full diff review,
independent 260/260 test run, golden-hash cross-check above, merge-tree
`probe:quick` green with P15 smoke passing (`runs/quick-post-dwave.log`).

Sol's brief-findings, accepted: (a) the brief's "concave beats convex at
mid-diet, loses at extremes" was imprecise — for the efficiency functions
alone concave wins everywhere strictly between 0 and 1; the high end loses on
the carrion channel's lower intake asymptote, which is the actual mechanism.
(b) `diet baseline −1.4` alone no longer yields predator-free founders (68 of
600 founders crossed 0.5 at current founder variance); P16's scenario adds
`founderSdScale: 0.1`. (c) P15's per-seed ±40% rate criterion is noisy at
~2–4 expected events per seed; a pooled cross-seed rate would be more stable.

Open D5 agenda, from the wave: pooled P15 rates (per Sol's finding); carrion
shares `enableDisturbances` with the shocks, so the marginal-contribution
table cannot yet separate recycling from disturbance; the carrying-capacity
loop pays a per-cell region check even with zero active crashes (P12 sat at
8.98–9.34e5 around its 9.0e5 warn line); P15/P16 thresholds are provisional
until spec-length measurement ratchets them; P7's mix bands re-measured under
scavenging (60-gen reading: starvation 23%, predation 58% — within bands).

### D5 measurement — spec-length adjudication (2026-08-10)

First spec-length `probe:full` under the regime (`runs/full-dwave.log`,
481 min, gates all PASS, suite WARN). Reference for every comparison below is
the last pre-D-wave spec run (`runs/full-close-1.6e-3.log`, same seeds).
Verdict-by-verdict:

- **P4 flipped from decay to growth.** Pre-wave the variance ratio hugged the
  floor (0.18/0.27/0.21, two seeds under 0.25); under the regime it reads
  0.26/5.4/11.1 — the shock regime is a working variance pump, and s3's tOpt
  ratio (11.1) now exceeds the 8× ceiling. Band left alone: one breach in
  three seeds on the intended mechanism is the ceiling doing its job as a
  watch line; widen only if more seeds land there.
- **P6 improved** (71/90/92% quantitative loci alive vs 63/77/77%). The
  across-replicate row still warns: `cladeMacroA:0` and now `cladeMacroB:0`
  fixed everywhere — clades still never establish (see P11).
- **P7: the predation collapse predates the D-wave.** Sol's 60-gen reading
  (predation 58%) was the early-run transient. At spec length predation is
  1/10/3% of deaths (pre-wave: 6/7/10%), starvation 73–79% (pre-wave 67–75%).
  Bands left alone — the probe is honestly reporting a real model weakness,
  now the top open tuning problem (below).
- **P8 unchanged**: Fst divergence strong both eras (0.48–0.78); the
  mate-acceptance criterion warned all seeds before and after (~0.88–1.0
  cross/within). Pre-existing; untouched by this wave.
- **P9 livelier**: attack movement 2.4–3.6 SD (pre-wave 0.75–2.3), guild
  presence 78–100% (pre-wave 19–92%). Still 1/3 seeds passing every
  criterion; the across-seed row wants all three.
- **P10 regressed 3/3 PASS → 0/3, and the mechanism is informative.** The
  injected +1.5σ size allele used to fix in 18–46 generations; under the
  regime it peaks at 0.27/0.02/0.06 and dies. `q21` was chosen as the locus
  where "bigger is unambiguously better" — the disturbance regime breaks that
  premise: crashes starve large bodies (size^0.75 cost against ×0.2–0.5
  productivity), so the sweep that establishes (s1 reached 27%) is reversed
  by the next shock. Fluctuating selection interrupting sweeps is real
  biology and watchable, but it means P10 as specced no longer measures
  sweep *visibility*. Disposition: recorded, not retuned — P10 needs a
  redesign decision (regime-off scenario, a crash-neutral locus, or a
  higher-copy injection), queued with the P5/P13 metric redesigns from Gate
  A-2.
- **P11 unchanged** at zero species; clade foundings 12/3/4 (pre 206/1/22).
  Roadmap 3 territory.
- **P15: per-seed rate criterion retired, pooled row added** (this commit).
  Measured per-seed ratios ranged 0.42–1.67 with all three seeds' schedulers
  in-rate pooled: thermal 11 obs/12 exp (0.92), crash 10/9 (1.11), kelp
  5/7.2 (0.69). Survival 100% everywhere; adaptation ratio 1.06/1.13/1.39×
  quiet — the regime measurably speeds trait movement. Per-seed rows now
  assert survival + adaptation only; `pooledRateReport` asserts the ±40%
  band over the panel (revert-sensitive test in probe-suite.test.ts).
- **P16: 0/3, with partial signals in every seed** — s1 kept a post-crash
  guild 50 generations but mean diet fell; s2 rose +0.026 diet with attack
  SD ×1.50 but the guild lapsed; s3 attack SD ×1.88, no diet rise. A 6-seed
  panel (s4–s9, `runs/p16-panel.log`) is measuring the base rate before any
  threshold moves — ratcheting on n=3 would be tuning to noise.

**The P16 seed panel (s4–s9 + the suite's s1–s3, 2026-08-10).** Nine seeds
of the re-evolvability scenario, measured before touching any threshold:
**one full pass** — s9's crash produced the designed moment outright (diet
Δ+0.349, seventeen times the 0.02 bar; attack SD ×2.27; guild persisted 50
generations) — plus seven evaluable misses and one extinction (s8's world
died at generation 66.4, six generations into the scripted crash). Attack-SD
radiation ≥1.37 appeared in 6 of 8 evaluable seeds; the discriminating
criteria are the mean-diet rise and guild persistence. Measured base rate
~1/8, so at the full suite's n=3 the ≥1/3 aggregate passes only ~1 run in 3.
Ruling: **no ratchet** — thresholds and the 1/3 aggregate stay, severity
stays warn, and the warning is the honest state of the world: re-ignition is
real but rarer than designed. The base rate is the target metric for the
predation-pays campaign below; moving the thresholds instead would tune the
probe to the phenomenon's absence.

**A gate bug the panel caught for free.** P1 determinism FAILED on fresh
seeds s5/s9: repeat runs identical, snapshot hashes agreeing, but the
restored continuation diverging from the uninterrupted run. Root cause
(pre-existing since Phase A, never triggered by s1–s3/q1): the spatial grid
was built mid-tick — post-movement, pre-birth/death — so the next tick's
behavior stage consumed a structure that is not a function of end-of-tick
`SimState`; a restored run rebuilds from the snapshot with newborns present
and the dead removed, and one boundary birth/death near a deciding organism
flips a decision. The first fix (`56dceab`) moved the single build to the
tick boundary — and its own re-certifying spec run then **failed P3** on
s2/s3: feeding/predation/mating candidates went one stage stale, an input
set the A7 campaign never tuned against, and the world ran hot into the
slot cap with births dropped (3,106 / 32,405 — a density-dependence-via-
resources violation, `runs/full-postfix.log`). The standing fix (`ad2ef3b`)
builds twice per tick: the post-movement build keeps feeding/predation/
mating on fresh positions (A7's tuned input set), and a boundary build
after `applyBirths` is what the next tick's behavior consumes — a pure
function of end-of-tick `SimState`, so restored runs stay equivalent.
Verified P1 PASS on s1–s9 + q1; P12 9.04e5 (the second build costs ~1–3%);
45-gen cliff P3 PASS ×3. Deliberate trajectory change: the disturbances-off
golden hash re-baselined `6922907c6421d7bf` → `d60c12703108a788`
(reproduced twice via an independent harness; unchanged between the two fix
variants — on the golden world the feeding-freshness delta never altered an
outcome). Two lessons for the suite: fresh-seed panels are cheap gate
audits and D-waves should end with one; and a 45-generation cliff screen
cannot see an operating-point shift that only saturates at spec length —
engine-timing changes need a spec-length gate check before the record calls
them fixed. Spec-length re-certification of `ad2ef3b` in
`runs/full-postfix2.log`.

**The headline finding — scavenging pays too well as a terminal strategy.**
In the 600-generation regime runs, mean diet ratchets to +1.4/+1.6 with
predator-classified fraction 0.95–0.97, while predation deaths *fall* to
4–7%: high-diet organisms live on carrion + plankton without hunting, so the
carrion ramp built as an on-ramp back to predation instead functions as a
destination. Carrion pulses (up to ×4.2 median biomass) produce population
punctuation but no predation re-ignition. One seed (s3) adds a spectacular
late punctuation the renderer should someday show: the entire high-diet guild
collapsed between gens ~350–500 to pure filter-feeding (diet −1.9, predator
fraction 0.02) and the world carried on. Next tuning lever is making hunting
pay relative to scavenging (candidates: lower `carrion.maxIntake` or `qScav`,
raise prey-capture payoff, or let carrion decay faster), measured against
P7's predation share at spec length — that, not the shock machinery, is now
the predator-persistence problem's centre.

### The maxIntake lever at spec length — adjudicated (2026-08-16, ~03:15)

`runs/full-maxintake05.log` (started 18:45, ~8.5 h): **suite WARN, zero
FAILs.** The verdicts against the pre-lever reference
(`runs/full-postfix2.log`):

- **P3 is GREEN at spec length on all three seeds** (1.00 / 0.995 / 1.00
  against ≥0.99) — the red that motivated the lever is fixed; no seed rides
  the slot cap, no births dropped. The lever did its job.
- **P7 predation share is in-band on all three seeds** (8.5 / 7.6 / 9.6%
  against [5, 70]) — up from the 4–7% that triggered the D5 "scavenging as
  terminal strategy" finding. Hunting is legal again, though barely; the
  predation-pays campaign is still worth running.
- **P16 re-ignition: 0/3, inconclusive and unmoved.** s3 reached 0.411 with
  partial signals, s1 negative, s2 flat. Given the measured ~1/8 base rate,
  0/3 has probability ≈ 0.67 under no-change — this neither shows the halved
  scavenging depressed re-ignition nor that it helped. The D5 ruling stands:
  the base rate is the campaign metric, and it needs a panel, not 3 seeds.
- **New watch-item: P4 variance decay on s1/s2** (0.118 / 0.169 against a
  0.25 floor; s3 3.49). The D-wave regime previously pumped variance
  (variance-growth flip in the D5 record); the cooled world erodes it on two
  seeds — plausibly smaller populations drifting harder now the carrion
  subsidy is halved. Candidate coupling for the predation-pays campaign, not
  a reason to revisit the lever.
- Rest of the suite in line with history: P5 4.0×3 PASS, P9 1/3 (s2 0.992),
  P15 pooled PASS, P11 0×3 (unchanged), P12 9.01e5 PASS on a busy machine.

**Ruling: `carrion.maxIntake = 0.5` stands as the default.**

### The maxIntake lever lands (2026-08-15, task #18 decided)

The user chose `carrion.maxIntake` 0.7 → 0.5 — the only screened lever that
cooled both failing seeds (lever screens, 200 gens: control s2 maxPop 4089
with 5,025 births dropped; intake-0.5 s2 2902 and s3 2144, zero drops both;
the decay-0.5 alternative failed s3 at 4087 with 2,472 drops). Applied as the
new default, cliff-screened green (45 gens × s1–s3, no FAIL, predator guilds
51–64%), and sent to a spec-length `probe:full` (`runs/full-maxintake05.log`,
detached pid 9533) whose adjudication — especially whether halved scavenging
depresses P16's ~1/8 re-ignition base rate — is pending.

One unit test re-scoped with the lever, deliberately: the carrion on-ramp
assertion (`disturbance-units.test.ts`) previously demanded mid-diet
scavenging beat convex hunting at abundance (resource=10). Measured under
0.5, the crossover moves to scarcity: mid-diet carrion wins at resource ≤ 1
and loses at abundance, while the high-diet live channel is richer
everywhere. That is a better-shaped on-ramp than the one the D-wave shipped —
scavenging is now a famine bridge (paying exactly in the post-crash windows
where re-evolution should fire) instead of the terminal strategy D5 caught.
The test now asserts the crossover structure rather than the old
abundance-time dominance.

## Phase B — the render wave (2026-08-15 evening)

The user gave the explicit Phase B go and four scope decisions (B1–B3 + UI
restyle; deep-water cinematic; adaptive LOD; apply the carrion lever). Four
parallel Opus implementers built against an orchestrator-authored seam
(`src/render/contracts.ts`): R1 shell/camera/LOD/interpolation/colourMap,
R2 procedural creatures, R3 ambience/flourishes, R4 the R/V Panthalassa
chrome. The sample slice was widened 9→13 floats (contracts v1.5) so bodies
draw from each organism's real evolving morphology traits — the point of the
wave is watching bodies evolve, and deriving them from archetype typicals
would have painted fabricated variation.

**Verified on glass**: teal abyssal ocean with god rays, marine snow, field
haze and procedural kelp; creatures at four LOD tiers from glow-motes at
fit-all to full animated bodies (fins, eyes, undulation) at 60 fps near-tier;
all six colour modes; meteor shockwave and event flourishes; the trends
survey-trace; the specimen-label inspector with sonar-ping halo; 256× with
~1,000 animals at ~50 fps and 0.7 ms render cost; a 35-generation deep-time
run without a stutter. 399 tests, build, lint, probe:quick green.

Bugs the browser review caught that headless probes could not (each fixed in
an agent round, each now regression-tested): Pixi 8's `ParticleContainer
.update()` never marks the view dirty (far/abyss rendered nothing, silently);
the abyss tier billed 11× the far tier so the governor's escape tier bought
no headroom (twice — the second time only at the default zoom, caught by
enumerating the camera-reachable range instead of sample points); a
hand-baked RGBA gradient rendered amber because buffer channel order is
backend-dependent (the khaki ocean — now Pixi's own FillGradient); the WebGL
probe context was never released so the same URL nondeterministically fell
back to the crude renderer; MSAA on top of resolution 2 double-paid fill;
zoom froze at the pan-clamp boundary; measurement-mode colours tuned against
the crude renderer's light ground vanished on the abyss. Cross-layer fill
figures must always name their unit — CSS px and device samples got summed
once (`renderer.ts` MAX_RESOLUTION doc block is the durable rule).

Residual polish queue: measurement modes still read subtle at fit-all; far
tier and species-ring legibility by zoom; flourish timing review at 256×.
Hidden-tab throttling stalls the ambient aquarium (Chrome suspends rAF and
worker timers) — a Phase C catch-up concern, recorded here so it is not
rediscovered as a bug.

Directions we tried, considered seriously, or inherited and then abandoned —
kept so they are not silently retried.

| Direction | Why it was rejected | When |
|---|---|---|
| Bounded 0–10 trait scales (herdloom) | Every trait pinned at the clamp by generation 4; evolution had nowhere to go | Inherited, rejected at design time |
| Zero-effect "null" founder alleles (herdloom) | Collapsed founder variance; generation 0 had almost nothing to select on | Inherited, rejected at design time |
| Old age as the only mortality channel (herdloom) | Produced no natural selection whatsoever | Inherited, rejected at design time |
| `Math.max(0, x)` floors on non-negative traits | Recreates the pinning failure at the bottom of the range; softplus instead | WP-A0 |

## G-wave — the richer genome (Wave 1 approved 2026-08-16 morning)

The user approved Wave 1 of `briefs/g-wave-design.md` ("Go ahead with your
Wave 1 experiments you need in order to build up to the richer genome"),
which per that document's §9 recommendations means: G0 first with its own
`probe:full`, then G-A ontogeny + G-B aposematism, cannibalism allowed with a
`conspecificLogit` cost knob, and P3 restated in biomass as a mandatory
sub-package. The same morning message asked for more divergent creature
morphology — that ran as render package R5 (below), disjoint from the sim.

### G0 — the genome made growable (2026-08-16 morning)

The structural fix the whole wave depends on: genome creation used to consume
the caller's RNG stream in proportion to genome size, so *any* enlargement
(a new chromosome, a new trait) shifted the stream and therefore the
trajectory of every run — even runs that never express the new machinery.
After G0, every genome-creating function consumes its caller's stream
**exactly once per organism** (a salt draw that keeps successive organisms
distinct), and all size-dependent draws live on private forks:

- `buildFounderGenome`: per-chromosome forks (`founder:A1`…) carry the allele
  draws; the karyotype has its own fork, which also strengthens the old
  guarantee that the sex argument cannot change allele material.
- `makeOffspringGenome`: each (gamete, chromosome) pair gets a fork carrying
  its assortment coin, crossover draws and mutation draws; karyotype + clade
  macro roll live on `meiosis:misc`. Mutation lambda is now per-chromosome
  (sums to the same Poisson total); `enableMutation` off truncates each
  chromosome stream at its tail, so the toggle stays shape-preserving.
- `computePhenotype`: birth environmental deviations come from an
  `envDeviation` fork — appending a trait appends draws nothing else reads.

`src/sim/genetics/g0-streams.test.ts` pins the exact parent consumption of
all three functions, so a regression fails a unit test instead of surfacing
as a golden-hash surprise months later. The conventions that ride along
(append chromosomes, never reindex; append trait keys; old loci may gain
loads onto new traits for free) are recorded in CLAUDE.md's determinism
section.

**Cost, paid once as planned:** the golden trajectory hash re-baselined
`d60c12703108a788` → `2937150f89939ef6` — a deliberate trajectory change,
recorded in `disturbance-units.test.ts`. 498 tests green. probe:quick and a
G0 `probe:full` (regime-unchanged-in-kind check) adjudicate below.

### G1 — the v1.7 contracts land, and the dark-chromosome rule (2026-08-16 morning)

The full Wave 1 contract surface is in: 5 traits appended (`growthAllocation`,
`offspringSize`, `fecundity`, `toxicity`, `conspicuousness`), autosomes A5
(12q: q49–q60, the life-history bank with the q53/q54 provisioning linkage
block) and A6 (8q: q61–q68, chemical defence with the q63/q64 aposematism
block), six cross-loads on existing loci, the founder-fixed strategy macros
(`lifeHistoryMacro`, `toxinMacro` — ancestral 0/0, neighbour-step mutable, so
a strategy or the invention of toxin arrives as an *event*), `pigmentE/F` +
`neutralE/F` (drift instrumentation 4 → 6 markers — the free measurement win),
`growth` + `aposematism` config blocks, `growth.conspecificLogit` (cannibalism
as a cost, per the user's §9 approval), six pure formulas
(`tissueCostPerCm`, `somaticGrowthPerTick`, `clutchInvestment`,
`toxinYieldMultiplier`/`toxinConsumptionHazard`, `aposematismLogit`,
`toxinMetabolicCostPerTick`), optional `SampleRow` detection shapes
(`lifeHistory`, `hueBins`, `mimicryIndex`, `traitsByDeme`), the
`toxinInvention` event, snapshot v4, and the D-wave's owed debt paid:
**`enableCarrion` split from `enableDisturbances`** (independent; the golden
off-arm test now disables both, and `TOGGLE_KEYS` gained the carrion arm).

**The design doc contradicted itself, and the resolution is the wave's most
important structural decision.** Its §4 tables load A5/A6 loci onto *old*
traits (q52→size, q64→displayHue — deliberate entanglement), and seed
pigmentE/F morphs at founding; its §7 acceptance requires the off-arm to
reproduce G0's world byte-for-byte. Both cannot hold: founder-seeded new loci
loading old traits necessarily shift old traits' founder distributions. The
first equivalence run measured exactly that (plankton fields diverging by
tick 50 through hue→mating→behaviour). Resolution: **dark chromosomes**
(`chromosomeGate` in genome.ts). A5/A6 recombine, mutate and accumulate
variation from tick 0, but no effect of theirs — quant load or discrete
effect — expresses until the wave's toggle is on. `founderGeneticVariance`
and the phenotype pass are gate-aware, so the off-arm's derived environmental
SDs match the pre-wave world exactly. Two payoffs: the toggles are strict
marginal-contribution controls (the G0 doctrine survives contact with the
authored tables), and when a toggle flips on mid-run it reveals variation
that has been accumulating cryptically — standing genetic variation, ready
for selection, which is more biologically honest than a cold start.

**Off-arm equivalence: verified against G0 source, byte-for-byte.** The
D-wave's cross-source pattern: the golden scenario (seed
`disturbance-off-golden`, 50 ticks) dumped organism ids/positions/energies/
first-18 latent traits + both resource fields from a G0-commit worktree
(fa6c990) and from the G1 tree — `diff` exit 0. The golden hash moved anyway
(`2937150f89939ef6` → `67c311b3a0e40aa6`) because the hashed arrays grew
(23-trait stride, 136-allele genomes); that is a layout change, not a
trajectory change, and the dump is what proves it. A corollary worth having:
**the G0 spec run adjudicates G1's defaults too**, since they are provably
the same trajectory.

Tests: 540 green (contracts shape tests updated to the v1.7 layout;
append-only spot pins added; the dark rule pinned against the gate-aware
analytic in genetics-units). All numbers in the new tables are authored
starting guesses in exactly the DEFAULT_SIM_CONFIG sense — G6 moves them.

G1's probe:quick: exit 0, gates PASS (`runs/quick-post-g1.log`). P12 read
7.84e5 against the 9.0e5 warn line, measured while the G0 spec run's three
sims were live on the same machine — the known ~35% busy-machine effect, so
the number is discounted per the convention and P12 must be re-measured quiet
after the spec run drains before anyone treats it as a G1 regression. A real
component is plausible (136-allele meiosis, 23-trait loops) and worth the
quiet measurement.

### G0 spec-length adjudication (2026-08-16 afternoon)

`runs/full-g0.log` (report `runs/full-4f54b9db-2fb94d0af2-report.json`,
~7.2 h): **suite FAIL — one gate red, P3 baseline-s3 0.954 against ≥ 0.990**,
and the adjudication is that the failure is the *headcount-band artifact the
wave design already scheduled a fix for*, not a G0 defect. The evidence, in
provenance order:

- **The red is numerical, not energetic.** s3's late window (gens 200–300)
  oscillates 535–4096 with 0.7% of samples at the slot cap and 10,843 births
  dropped — ≤3.4% of all matings, ≤9.1% of late-window matings (upper bounds;
  clutches are multi-birth). The cause is a small-body trajectory: late size
  mean 14.9 vs 21.5 in the maxIntake-0.5 baseline run, so the same energy
  carries ~24% more heads. In biomass terms (census × mean size) s3 sits
  ~32k, *below* the baseline s3's ~38k. The band was always trying to bound
  biomass; the headcount statement of it is what broke.
- **No distributional signature.** Late size means moved in both directions
  across seeds (s1 16.1→19.6, s2 14.2→15.6, s3 21.5→14.9); late diet means
  likewise (s1/s2 to grazer-heavy −1.65, s3 predatory 1.08). That is a
  trajectory redraw — exactly what G0's stream re-layout promised — not a
  shifted distribution. A systematic G0 bug would push one way.
- **Everything else is the same regime in kind.** All three seeds alive at
  300 generations, single-species boom-bust, P4 variance *improved* to PASS
  on s1/s2 (baseline had two WARNs), P13 heritability all-PASS, P14/P15/P16
  the known open fronts at the same grades. P12 8.69e5 WARN — measured on the
  machine that was also running the dev server; still owed a quiet
  measurement.
- **The verdict follows the design's own text** (g-wave-design §4 G-A): "The
  fix is not a bigger cap. P3 should be restated in biomass rather than head
  count… a mandatory sub-package of this wave." The user approved that §9
  decision explicitly. The restatement lands in G4; the next spec-length
  adjudication (post-ontogeny) runs against the restated gate.

**Decision: G0/G1 are verified — the genome machinery is sound and the world
it produces is the same world — and Wave 1 biology (G2) launches now.** The
P3-s3 red is recorded as a known exception attributed to the headcount
statement of the band, with the fix already scheduled inside the same wave.
The one watch item this creates: cap-clipping did *some* real regulation on
s3 (up to ~9% of late births), so G4's restated P3 must keep an explicit
cap-contact criterion rather than silently blessing cap-and-starve — the
band exists to force density dependence through resources.

**P12 re-measured quiet (post-drain):** 8.7–8.9e5 organism-ticks/s over two
runs against the 9.0e5 warn line (pre-G-wave: 9.01e5). The busy-machine
discount is cashed out: G1's real cost is ~2–3% — 136-allele meiosis and
23-trait phenotype loops. WARN tier, no ratchet action; the wave design
already lists P12 among the probes G-A disturbs, and G6 owns the recovery
if ontogeny's extra work pushes it further.

### G2 — ontogeny lands: juveniles, growth, priced cannibalism (2026-08-16 afternoon)

Built by an Opus agent against `briefs/g2-ontogeny.md`; acceptance probe
re-run by the orchestrator, exit 0 (556 tests; cliff 3 seeds × 45
generations: populations 709–1192, juvenile fraction 0.305–0.362,
realised-length CV 0.45–0.52, range 0.49–54.6 cm, zero dropped births).
Golden hash untouched — the off arm is inert by construction: `sizeCurrent`
is written at birth from the same float32 the trait column holds, the
Poisson clutch draw happens once on both arms, and the hash folds the new
column in only when the toggle is on (the carrion-field pattern).

Decisions the brief left open, as resolved (full rationale in the G2 report):
surplus = tick intake minus burn via a tick-local `runtime.tickIntake` that
never crosses a snapshot; a claimed kill counts as intake in the same tick
(else pure carnivores can never grow) with the spend bounded by energy on
hand; hatchlings express their *own* `offspringSize`; birth reserve scales
by `(offspringSize/baseline)^provisionExponent`, mean-preserving at the
baseline; provisioning replaces the maternal flat cost, the paternal share
stays flat (anisogamy knob preserved); cannibalism is an odds multiplier on
the frozen kernel's output so `formulas.ts` stays the single source.

Contract follow-ups landed by the orchestrator the same hour: **v1.7.1**
(`sizeCurrent` joins `OrganismPools` — closes the report's gap 1, removes a
hot-path cast, unblocks `SampleRow.lifeHistory` for G4) and **v1.7.2**
(`'toxin'` death cause for G-B, digest-gated off-arm).

Carried to G6 from the report's measurements: (1) `metabolism.birthEnergy` 8
exceeds a baseline hatchling's storage ceiling 5.5, so the provisioning
ratio only bites above baseline; (2) with one founding species tag the
conspecific penalty damps *all* predation until the detector splits species
— measured 20-generation predation death-share 0.78 → 0.34–0.39 with the
axis on (0.60 with the logit zeroed), starvation up from ~0.07 to ~0.40.
Not a defect — every endogenous channel stays in [0.05, 0.70] — but it is
the first knob G6 should look at if the on-arm death mix reads starved.
Carried to G4: stats report only target `size`; realised length needs its
own series (the design says the recorder must report both).

### G3 — aposematism lands: toxin, signal, and the population's memory (2026-08-16 afternoon)

Built by an Opus agent against `briefs/g3-aposematism.md`; acceptance probe
re-run by the orchestrator, exit 0 (575 tests; cliff 3 seeds × 45
generations, sane death mix, zero dropped births). Off arm bit-identical:
golden hash untouched, plus a direct ablation pin — every `aposematism.*`
coefficient ×100 on one of two sims, hashes compared every 60 ticks over
300 ticks.

Shape of the mechanism as landed: toxin is a post-kill penalty (yield ×
`toxinYieldMultiplier`, one-off predator hazard → the v1.7.2 `'toxin'`
death cause; the kill stands — both die, which is the point of the trade);
avoidance is the population statistic `hueBinToxicityAt`, riding the
existing hue-grid pass with a gated accumulator (no second sweep);
`aposematismLogit` and the G2 conspecific term both land as odds
multipliers on the frozen kernel, so `formulas.ts` remains the single
source of the probability. Conspicuousness pays in mate acceptance and
costs in detection; toxicity bills metabolism against realised length.
Fresh `toxinMacro` alleles emit `ToxinInventionEvent` via parent-genome
comparison at the birth site (the one legal genome read outside birth
phenotyping; no RNG). One deviation from the brief's letter, accepted on
review: the hazard is rolled engine-side at the exact stream position of
the kill, because `EcologyApi.tryPredation` is handed a `KillSink` and no
`DeathSink`; if a future contract revision adds one, the roll moves into
`predation.ts` with no stream change. `killerId` on a `'toxin'` death
names the victim whose flesh did it — the contract doc was completed to
say so (orchestrator edit, events.ts).

**Tuning-log entry — the bootstrap fires early.** In the 45-generation
cliff runs (defaults, toggle on), mean expressed toxicity rose from ~0.26
at founding to 0.34–1.33 and mean conspicuousness reached +1.69 (s1) /
+1.08 (s2) while staying slightly negative on s3 (−0.10). The
chicken-and-egg the design worried over resolves inside 45 generations on
two of three seeds — the authored q63 coupling plus the macro route are
enough. Toxin deaths are a trace channel (0.4–0.9%). Founding mean
toxicity is 0.25–0.27 rather than softplus(0)=0.10 because the link's
convexity lifts the mean over the founding variance — worth remembering
when G6 reads "toxicity at founding" off a chart. G6 gets the
`toxinMacro`-disabled ablation to separate the polygenic route from the
macro route.

Process note: the G3 agent caught a red contracts-shape test on a clean
tree — my v1.7.2 commit had missed the DEATH_CAUSES pin, and my
verification had piped `npm test` through `tail`, which returns the pipe
tail's exit code. Fixed in c8f4dae. Lesson, now standing: **capture the
exit code directly; never pipe a gate command's output through anything.**
