# G-wave — design proposal for a richer genome and trait system (2026-08-15)

The user's brief, verbatim: *"a much much richer and deeper set of traits and
genes. The more complex the organism, the more surprises are possible."*

This is a design document, not an implementation. Nothing here has been built,
no contract has been touched, and the numbers in the locus tables are authored
starting guesses in exactly the sense `DEFAULT_SIM_CONFIG`'s were — every one of
them expects to be moved by a measured tuning row. Read it for the shape of the
argument and the cost accounting; the tables are there so the argument is
concrete, not because the weights are right.

The document assumes the reader knows `src/contracts/genome.ts`, `traits.ts`,
and `formulas.ts`, and the tuning log in `DESIGN.md`.

---

## 1. What exists, and where it is thin

The current genotype→phenotype map is 4 autosomes × (12 quantitative + 3
discrete) loci feeding 18 traits through a sparse pleiotropy matrix `W`, with
~17 loci carrying authored antagonistic signs, two tight linkage blocks
(q07/q08 armour, q29/q30 predation), and the magic trait — q36 loading `diet`,
`size` and `displayHue` together while q38 loads `displayHue` with `prefTarget`.
That structure is good. It is not the problem. The problem is that the *space of
strategies* it can express is narrow in four specific, measured ways.

**a. There is one body and it has one size, forever.** `size` is written once
at birth. The tuning log records the consequence in the plainest possible terms:
realised size CV is 6–10% in every run, "the window's peak sits ~3.5 SD outside
the distribution that exists," a predator "collects 0.26–0.35 of the 2.0 logits
on offer," and `sizeRatioOptimum` had to be pushed from 0.55 to **0.88** —
i.e. "you may only eat things nearly as long as you are" — to make predation
arithmetically possible at all. The record's own gloss: *"the genome does not
produce [a 2× spread of body sizes], and cannot — `size` is written once at
birth, so there are no small juveniles to eat either."* This single fact is
upstream of the project's named open front (predator persistence: predation is
1–10% of deaths at spec length against a 5–70% P7 band, starvation 73–79%).

**b. Colour is a signal with exactly one meaning.** `displayHue` is the mating
signal, the render colour, and the search-image target, and the only force
acting on it besides mate choice is negative frequency dependence. When A7
asked why hue never diverges across a barrier, the frequency-dependence
hypothesis was **falsified** (turning it off *raised* Fst to 0.931 and left the
acceptance ratio at 1.02). The surviving suspicion is that the authored magic
trait pins hue to `diet`, and both sides of a ridge experience the same
ecology. Hue needs a second, ecologically independent selective force before
that question is answerable.

**c. Behaviour has parameters but no perceptual apparatus.** `wariness`,
`forageBoldness` and `givingUpTime` parameterise a fixed policy set, but the
radii that decide what an organism can perceive — `behavior.neighborScanRadiusWu`
90, `predation.attemptRadiusWu` 45, `mating.surveyRadiusWu` 120 — are *config
constants shared by every organism in the world*. Gate A-1 defect 12 caught the
consequence from one side (wariness saturating at the scan radius, fixed with a
vigilance cost); the other side is that no organism can be better or worse at
seeing than any other.

**d. Everything is additive, and lineages can never become incompatible.**
There is no dominance at quantitative loci and no epistasis anywhere;
`traitsGenotypic` is documented as the "pure genotypic contribution." I found no
recorded decision on either in `DESIGN.md`, so this is open ground rather than a
settled question. It matters because the only route to reproductive isolation in
the model is behavioural (preference on hue), and P11 has produced **zero
species in every run to date**.

Two more facts frame everything below. `cladeMacroA:0` and `cladeMacroB:0` are
**fixed in every seed at spec length** — clades are founded (12/3/4 events per
run) and never establish. And the D5 headline: *"scavenging pays too well as a
terminal strategy"* — the carrion ramp built as an on-ramp back to predation
became a destination instead.

---

## 2. The rules any new axis inherits

These are not restated for ceremony; each one has killed a proposal that looked
fine on paper.

1. **No bounded scales, no clamps.** A limit is a cost in a currency the
   organism also needs. If a new axis wants a `Math.min`, it needs another cost.
2. **Softplus for non-negative traits, logistic for allocation shares**, identity
   where negatives are meaningful, circular for angles. There is no upper link
   anywhere and there will not be one.
3. **Environment shifts expression additively; it never multiplies
   deviation-from-mean.** (Gate A-1 defect 1, the axiom that killed herdloom.)
4. **Every mechanism is individually toggleable, and every toggle is
   shape-preserving in its mean.** The frequency-dependence term is centred on
   `1/hueBinCount` and the thermal tax is a power law with κ=0 precisely so that
   switching a mechanism off does not also move the operating point. Any new
   term must be zero — or mean-centred to zero — at the founding population, or
   A7 cannot attribute anything.
5. **Genome-table changes are not won by argument.** Gate A-2 refused two of
   them and ruled: *"Balance work, if any, goes through locus ablations, not
   input-mass fiat."* Every axis below therefore ships with a toggle and an
   ablation plan, not with a claim that its weights are right.
6. **A probe that has never failed is not testing anything**, and per the P16
   ruling, *measure a phenomenon's base rate before setting a bar* — otherwise
   the threshold gets tuned to the phenomenon's absence.

---

## 3. G0 — make the genome growable (do this first, once)

This is the most important package in the document and it adds no biology.

Right now, growing the genome is expensive *for a structural reason that is
fixable*: adding loci changes how much entropy founder construction and meiosis
consume, and adding traits changes how many birth-time environmental deviations
are drawn, so **any** enlargement shifts the RNG stream and therefore the
trajectory of every run — including runs that do not use the new machinery. That
is why the D-wave's byte-identical off-arm (golden hash `d60c12703108a788`) is
not reproducible for a genome change as things stand.

`CLAUDE.md` already names the fix: *"`SeededRng.fork(label)` gives a stage its
own sub-stream without consuming parent entropy, so adding a consumer cannot
shift the trajectory."* G0 applies that rule to the two places genome growth
touches:

- **Per-chromosome forked streams in founder construction and meiosis.** A5's
  crossover draws come from `fork('meiosis:A5:' + tick)`, not from the parent
  stream. Adding a chromosome then costs the existing chromosomes nothing.
- **Per-trait (or per-organism) forked streams for the birth environmental
  deviation.** Trait keys are append-only, so the first 18 draws would be
  identical — but the parent stream would still advance five extra steps per
  birth, and the next consumer would see different numbers. Forking removes that
  coupling permanently.

G0 costs **one deliberate golden-hash re-baseline** (the fork change itself
moves the trajectory, once) plus a `probe:full` to confirm the regime is
unchanged in kind. After it, every subsequent axis can be built with its toggle
off producing a bit-identical world, which makes each toggle a strict
marginal-contribution control rather than a same-seed argument. **The expensive
part of a genome change is paid once, in G0.** Everything downstream gets
cheaper, and the project gets the ability to keep enriching the genome for as
many waves as it wants.

Two structural conventions ride along with G0, both trajectory-neutral:

- **Append new chromosomes; never reindex.** New loci go on new autosomes (A5,
  A6, …), so `QUANT_LOCI` indices 0..47 keep their meaning, `W_ROWS_BY_TRAIT`
  rows for existing traits are untouched, and the two authored linkage blocks
  stay exactly where the sweep probe expects them.
- **Old loci may gain loads onto new traits, and this is free.**
  `founderGeneticVariance(trait)` sums only entries matching that trait, so
  appending `['toxicity', 0.16]` to q31's `loads` changes nothing about q31's
  contribution to `defense`, consumes no additional entropy, and does not move
  the old trait's genetics. It is the cheapest possible way to entangle the new
  system with the existing arms race — and entanglement is where surprises come
  from. Every axis below uses it.

---

## 4. The axis catalogue

Ten axes, ranked by surprise-per-retuning-cost. Two are scheduled for Wave 1;
the rest are catalogued so they are not reinvented from scratch, in the spirit of
DESIGN.md's rejected-directions table.

| Axis | New traits | Loci | Blast radius | Surprise class |
|---|---|---|---|---|
| **G-A Ontogeny & provisioning** | 3 | A5: 12q+3d | **High** | juvenile bottleneck, stunting, r/K split, cannibalism |
| **G-B Toxicity & aposematism** | 2 | A6: 8q+3d | Medium | Müllerian convergence, Batesian mimicry and its collapse |
| G-C Sociality & schooling | 1 | 5q | Low–med | selfish herd; schools that dissolve when predators die |
| G-D Sensory & neural cost | 2 | 6q | Med (**P12**) | ambush vs search polymorphism; sensory arms race |
| G-E Epistasis & hybrid incompatibility | 0 | reuses W | High (stats) | intrinsic isolation; the first real speciation route |
| G-F Sex-limited expression | 0 | modifier loci | High (stats) | runaway ornament; sex-biased mortality |
| G-G Dormancy & diapause | 2 | 5q | Med (**P3**) | resting stages riding out crashes; bet-hedging |
| G-H Ontogenetic diet shift | 1 | 4q | Low (needs G-A) | one lineage occupying two guilds at once |
| G-I Parental guarding | 1 | 4q | High (engine) | brood defence; a second reason to aggregate |
| G-J Sublethal injury & regeneration | 1 | 4q | Med (ecology) | graded defence; armour with an ongoing payoff |

Three of the user's suggested axes are deliberately folded or deferred rather
than given their own slot, with reasons in §8: bioluminescence (folded into
G-B's `conspicuousness` — whether a loud signal reads as pigment or as light is
a render decision, not a model one), reaction-norm slope loci (a recorded Gate
A-1 deferral, "roadmap not v1"), and sex linkage proper (deferred at WP-A0
because hemizygous males break the diploid variance formulas in `src/stats`;
G-F routes around it).

---

### G-A — Ontogeny and provisioning (Wave 1, the load-bearing axis)

**What changes.** `size` stops being "your length" and becomes **your target
adult length** — the trait key, its position in `TRAIT_KEYS`, and all seven of
its loci keep their meaning to selection, which is what keeps P4/P5/P13
comparable across the change. Actual length becomes a **state variable**,
`sizeCurrent`, living in `OrganismPools` beside `energy` and `gutFill`.

This does not violate "phenotype is computed once at birth." The phenotype —
target length, growth allocation, provisioning — is still computed once at birth
and cached. `sizeCurrent` is state, like energy, and the tick loop still never
reads a genome.

**New traits (appended, indices 18–20):**

| Key | Unit | Link | Baseline | Sense | Meaning |
|---|---|---|---|---|---|
| `growthAllocation` | share | logistic (s=1) | 0 → 0.5 | allocation | share of energy surplus directed to soma vs storage/reproduction |
| `offspringSize` | cm | softplus (s=0.2) | 2.5 | matching | length at birth |
| `fecundity` | count | softplus (s=0.3) | 3.0 | matching | Poisson clutch mean (replaces `mating.clutchLambda` as a per-female value) |

**Formulas.** One new function, folded into the existing per-organism metabolism
pass so no new sweep over the pool is added (P12 discipline):

```
somaticGrowthPerTick(surplus, L, Ltarget, alloc, config) =
    alloc · surplus / tissueCostPerCm(L, Ltarget, config)

tissueCostPerCm(L, Ltarget, config) =
    c · L² · (1 + (L / softplusFloor(Ltarget, minLength))^overshootExponent)
```

Note what this does **not** do: it does not cap `L` at `Ltarget`. Growth past
target is permitted and simply gets expensive, so the asymptote is a receding
ceiling in the project's exact sense. And because `surplus` is what is left after
metabolism, the realised asymptote is **environment-dependent** — a fish in a
crashed patch never reaches its target. Stunting is not a feature that needs
writing; it falls out.

```
clutchInvestment(offspringSize, fecundity, config) =
    fecundity · provisionEnergyPerCm · offspringSize^provisionExponent
```

charged against the mother's energy. If she cannot afford the full clutch, the
realised clutch is the affordable count — an energy constraint, not a clamp on
the trait. This is the offspring size/number tradeoff with nothing authored: the
two traits share one budget, and `q53`/`q54` (a new tight linkage block at
37.0/38.5 cM) put them in opposition genetically as well.

**Maturity becomes size-based**: mature when `sizeCurrent ≥
maturityLengthFraction · size`, with the existing `time.maturityTicks` retained
as an age floor so the off-arm is unchanged. Age at maturity therefore becomes an
*emergent, environment-dependent* quantity rather than a config constant — and
selection for early maturity under a crash regime becomes possible.

**Locus budget — A5, "life history & ontogeny" (12 quant, 3 discrete):**

| id | cM | σ | label | loads |
|---|---|---|---|---|
| q49 | 4 | .50 | growth allocation A | growthAllocation +0.45 |
| q50 | 11 | .45 | anabolic drive | growthAllocation +0.35, metabolicEff −0.04 |
| q51 | 17 | .45 | tissue turnover | growthAllocation +0.30, **defense −0.16** |
| q52 | 24 | .40 | skeletal deposition | growthAllocation +0.25, size +0.28 |
| q53 | **37.0** | .45 | yolk provisioning | offspringSize +0.40, fecundity −0.30 |
| q54 | **38.5** | .40 | follicle number | fecundity +0.45, offspringSize −0.25 |
| q55 | 46 | .45 | gonad allocation | fecundity +0.35, growthAllocation −0.30 |
| q56 | 54 | .40 | egg lipid load | offspringSize +0.35, metabolicEff −0.03 |
| q57 | 63 | .45 | maturation timing | growthAllocation −0.28, fecundity +0.25 |
| q58 | 72 | .50 | juvenile robustness | offspringSize +0.30, defense +0.18 |
| q59 | 84 | .45 | somatic maintenance | growthAllocation −0.22, metabolicEff +0.05 |
| q60 | 93 | .45 | compensatory growth | growthAllocation +0.32, speedCap −0.05 |

Discrete: `lifeHistoryMacro` (k=3, 20 cM), `pigmentE` (k=4, 58 cM), `neutralE`
(k=8, 90 cM). The macro-locus carries the two strategy jumps — allele 1:
offspringSize +0.9 / fecundity −1.2 (few large); allele 2: fecundity +1.6 /
offspringSize −0.6 (many small) — so a life-history strategy can appear as an
event rather than waiting on the polygenic tail, exactly the rationale the
preference modifiers already use.

Cross-loads onto existing loci (free, per §3): q10 'growth rate'
+growthAllocation 0.30; q21 'lipid reserve' −growthAllocation 0.24 (storage
against growth); q05 'gill surface' +growthAllocation 0.18.

**Surprise classes.** In rough order of how likely they are to be the first
thing the user notices:

- **Recruitment pulses and a real age structure.** The population curve stops
  being a smooth resource-limited line and gains cohorts.
- **Stunting.** A plankton crash produces a cohort that never reaches target
  length. If those fish breed at that length, selection for early maturity
  follows — and that is a *heritable response to a disturbance*, which is
  precisely what the D-wave was built to produce and what P15's adaptation ratio
  is trying to measure.
- **r versus K, sympatrically.** Many small versus few large, held apart by the
  predation size window rather than by an authored valley.
- **Cannibalism.** The predation kernel does not check species or clade, so the
  moment juveniles exist, adults can eat them. This needs no new mechanism and
  it is the most surprising thing in this document. It also has teeth: a
  population that eats its own recruitment can oscillate hard. **Decision needed
  from the user** — I recommend allowing it, with a `predation.conspecificLogit`
  penalty knob so it is a cost rather than a ban.
- **Predation re-ignition without nerfing carrion further.** The D5 lever
  (`carrion.maxIntake` 0.7→0.5) made scavenging a famine bridge. Ontogeny
  attacks the same problem from the supply side: for the first time there is
  prey that fits inside the size window. The predation-pays campaign gets a
  mechanism instead of another knob.

**Renderer.** Almost free, and immediately spectacular. `size` is already channel
4 of the sample slice; it simply carries `sizeCurrent` instead, and juveniles
draw small. One added slice float, `lifeStage` (`sizeCurrent / size`), lets the
renderer tint or simplify juveniles and lets the LOD system treat a cloud of fry
differently from adults. The world gains a visible size distribution, which is
the single most legible sign of a living population.

**Detection.** New `SampleRow.lifeHistory`: `{ meanLengthCm, sdLengthCm,
juvenileFraction, meanAgeAtMaturityTicks, recruitment }` — the last being births
surviving to maturity in the window, which is the demographic quantity the model
currently cannot report at all. Plus a **P17 (age structure)** probe asserting
that realised length CV exceeds a ratcheted floor (against today's 0.06–0.10)
and that the realised predator/prey length-ratio distribution actually overlaps
the kill window. P17 is the probe that would have caught the original defect.

**Blast radius: high, and honestly so.**

- Contracts: 3 traits (`TRAIT_COUNT` 18→21, hence the trait-array stride,
  hence snapshot format v4), 1 pool column, 1 config block (`growth`), 1 toggle,
  2 formulas, slice stride 13→14, `SampleRow` addition.
- Retuning, at minimum: the `sizeRatioOptimum` / `baseLogit` pair (which returns
  from its emergency 0.88 toward ~0.5 — A7 has already moved this pair together
  once and the precedent is on file), `growth.*` from scratch,
  `metabolism.birthEnergy` and `reproductionEnergyCost` (now genetic in effect),
  `resources.grazingMaxIntake` (bite scale now varies with length).
- Probes disturbed: P3, P4/P5/P13 on `size` (now the target, not the realised
  length — the recorder must report both), P7 (the whole mix, which is the
  point), P9, P10, P12.
- **The P3 exposure is the real risk and must be planned for, not discovered.**
  Juveniles are individuals: more organisms per calorie, against a 4096-slot cap
  and a headcount band of [100, 3500] that the record calls the binding gate for
  anything that adds capacity. The fix is not a bigger cap. **P3 should be
  restated in biomass rather than head count** — biomass is the conserved
  quantity the band was always trying to bound, and a headcount band stops
  meaning what it meant the moment an age structure exists. That restatement is
  a mandatory sub-package of this wave, and it is roadmap item 4 (density
  regulation that is not cap-and-starve) arriving through the side door — which
  is a second payoff, since item 4 is what currently pins `quantMutationRate`.

---

### G-B — Toxicity and aposematism (Wave 1, the cheap rider)

**Why it rides along with an expensive axis.** Both of its traits sit at or near
zero in the founding population by construction (`toxicity` softplus with
baseline 0; `conspicuousness` identity with baseline 0), so both new predation
terms contribute **≈0 at the operating point A7 tuned**. The axis is nearly inert
at founding and only bites once toxicity evolves. It therefore does not confound
G-A's retuning campaign, and it can be tuned after that campaign closes without
a second `probe:full` of G-A's work.

**New traits (indices 21–22):**

| Key | Unit | Link | Baseline | Sense | Meaning |
|---|---|---|---|---|---|
| `toxicity` | toxin load | softplus (s=0.15) | 0 | directional | defensive chemistry concentration |
| `conspicuousness` | amplitude | identity | 0 | matching | how loud the signal is (negative = cryptic) |

`conspicuousness` is deliberately orthogonal to `displayHue`: hue is *which*
colour, conspicuousness is *how loud*. That separation is what makes mimicry
expressible.

**Mechanisms, and the costs that bound them:**

1. **Toxin is a post-kill penalty, not a lower kill probability.** A toxic
   victim still dies; the predator's energy yield is multiplied by
   `exp(−toxinYieldCoef · toxicity)` and it takes a one-off hazard
   `toxinHazardCoef · toxicity`. This is the crucial modelling choice — if
   toxicity reduced kill probability it would just be `defense` under another
   name. Because it does not, **toxin only pays if predators can learn**, which
   is what makes a signal necessary.
2. **Predator learning reuses the search-image machinery.** `hueMorphFrequencyAt`
   already computes a local per-hue-bin statistic; a sibling
   `hueBinToxicityAt(state, x, y, hueDeg)` computes the local mean toxicity of
   that bin. The kill logit gains
   `−aposematismCoef · conspicuousness_victim · binMeanToxicity`. The predator
   has no memory; the *population's* avoidance is expressed as a function of a
   local statistic — exactly the abstraction the existing frequency-dependence
   term already makes, and it inherits that term's honesty.
3. **Conspicuousness costs.** `+conspicuousnessDetectionCoef · conspicuousness`
   in the kill logit (loud animals get attacked more) and `+` in the mating
   acceptance weight (loud animals get chosen more). Three-way tug: predation
   cost, mating benefit, aposematic credit conditional on your hue bin actually
   being toxic.
4. **Toxicity costs metabolism.** An additive `toxinCostCoef · toxicity ·
   size^0.75` term — sequestration scales with tissue.

**Bootstrapping.** Aposematism is a chicken-and-egg: toxin without a signal is
unrewarded, a signal without toxin is suicide. The project's own answer is to
author the coupling rather than hope for it, as with q36/q38. So A6 carries a new
tight block at 28.0/29.5 cM — **q63 loading `toxicity` and `conspicuousness`
together** (the aposematism magic locus) beside q64 loading `conspicuousness`
with `displayHue`. Plus a discrete `toxinMacro` (k=3) whose rare allele jumps
toxicity outright, so the invention can be an *event* worth logging rather than a
polygenic wait.

**Locus budget — A6, "chemical defence & signalling" (8 quant, 3 discrete):**

| id | cM | σ | label | loads |
|---|---|---|---|---|
| q61 | 6 | .50 | toxin synthesis | toxicity +0.40, **metabolicEff −0.05** |
| q62 | 13 | .45 | sequestration capacity | toxicity +0.32, growthAllocation −0.25 |
| q63 | **28.0** | .45 | toxin–pigment coupling | toxicity +0.28, conspicuousness +0.35 |
| q64 | **29.5** | .40 | chromatophore gain | conspicuousness +0.40, displayHue +9 |
| q65 | 44 | .45 | signal contrast | conspicuousness +0.38, **defense −0.14** |
| q66 | 57 | .40 | crypsis | conspicuousness −0.42, forageBoldness −0.20 |
| q67 | 70 | .45 | display musculature | conspicuousness +0.30, prefTarget +8 |
| q68 | 88 | .45 | toxin tolerance | toxicity +0.25, tWidth +0.18 |

Discrete: `toxinMacro` (k=3, 21 cM), `pigmentF` (k=4, 52 cM), `neutralF` (k=8,
92 cM). Cross-loads onto existing loci: q31 'integument thickness' +toxicity
0.16 and q32 'spination' +toxicity 0.14 (chemical and physical defence share
tissue); q37 'pigment cell density' +conspicuousness 0.30.

q67 mirrors q38 deliberately: the new signal and the old preference share a
locus, so sexual selection and predator avoidance are pulling on genetically
correlated machinery. That conflict is a surprise generator, not an accident.

**Surprise classes.**

- **Aposematism proper** — a toxic lineage going loud, but only after toxicity
  is common enough locally for the bin to earn avoidance.
- **Müllerian convergence** — two toxic lineages converging on one hue because
  sharing a bin means sharing the credit. This is the model's **first force that
  makes hue converge across lineages**, and given that the outstanding question
  is why hue never diverges, having a second, ecologically independent force on
  that axis is what makes the question answerable at all.
- **Batesian mimicry and its collapse** — a palatable lineage moving into a toxic
  lineage's hue bin, gaining protection, and then losing it as mimics dilute the
  bin's mean toxicity. A negative-frequency-dependent cycle in hue space that
  should read on a hue histogram as **a bin that fills and empties**. If this
  document produces one nameable, watchable moment, this is it.
- **Signal conflict and sex-biased mortality** — because conspicuousness feeds
  both predator detection and mate acceptance, males can be driven loud and
  eaten. Detectable as a sex difference in the death mix, with no sex-limited
  expression machinery required.

**Renderer.** `conspicuousness` maps to saturation and contrast; the slice gains
one float. **`toxicity` is deliberately kept off the slice** — it appears in the
inspector and the charts but not in the world view. If the watcher could see who
is toxic, the mimicry read would be given away for free; keeping it hidden makes
the eye do the same inference the predators do, and makes the charts worth
reading.

**Detection.** `SampleRow.hueBins: readonly { count, meanToxicity,
meanConspicuousness }[]` of length `predation.hueBinCount` — a cheap array that
makes every claim above assertable. Plus a `mimicryIndex`: within the most-toxic
bin, the fraction of individuals whose toxicity is below the population median
(the free-rider fraction). Two probes:

- **P18 (aposematic coupling)** — the within-population correlation between
  `toxicity` and `conspicuousness` rises above the correlation implied by the
  authored q63 pleiotropy alone. Passing requires that *selection*, not the
  locus, did it.
- **P19 (mimicry cycle)** — at least one hue bin shows the fill-and-empty
  signature: free-rider fraction rising past a bar, bin mean toxicity falling,
  then the bin emptying. Ships at `warn` with thresholds set **from a 9-seed
  base-rate panel**, per the P16 ruling; if the base rate is ~1/8 as P16's was,
  the aggregate criterion must be stated in those terms rather than tuned to
  make the probe pass.

**Blast radius: medium.** 2 traits, 1 config block, 4 formula additions, 1
`EcologyApi` method, 1 `SampleRow` addition, 1 slice float. No new field grid, no
new pool column, no new engine stage. Retuning is mostly a question of whether
toxicity bootstraps at all — and the ablation that answers it is running with
`toxinMacro` disabled, which isolates the polygenic route from the macro-mutation
route.

---

### The catalogued rest (Waves 2–3 and beyond)

**G-C Sociality and schooling** — one trait, `sociality` (identity, baseline 0,
negative = territorial). Conspecific attraction in the movement policy; dilution
in the predation kernel (per-victim kill probability falls with local group
size); and the cost is **already implemented** — the plankton grid is per-cell,
so a school depletes its own cell, and predators querying neighbours find more
candidates where density is high. Detection up, per-capita risk down: the honest
selfish-herd tradeoff, with the competition side free. Highest visible payoff per
line of code in the document, since schooling is *motion* and needs no render
contract change at all. The design risk is that dilution is a group benefit and
group benefits are easy to make free; it must be paired with the detection cost
and both mean-centred.

**G-D Sensory and neural cost** — `senseRange` (wu, softplus) and `senseAcuity`,
turning `behavior.neighborScanRadiusWu`, `predation.attemptRadiusWu` and
`mating.surveyRadiusWu` from world constants into per-organism genetics, paid for
by a neural metabolic term that burns at rest (the second trait after `wariness`
to cost energy at zero speed). It changes *behaviour policies*, which is the
richest kind of change available. **It is also the one axis with a direct P12
threat**: per-organism radii mean the spatial grid can no longer serve one radius
per query, and P12 already sits at 0.9–1.0×10⁶ against a 0.9×10⁶ warn line with
three neighbour queries per organism per tick. Mitigation is to query once at the
population maximum and filter, or to bucket organisms into radius tiers — both
are model changes, not knobs, and both need measuring before this axis is
scheduled. Wave 2 at the earliest, and only with a performance spike first.

**G-E Epistasis and hybrid incompatibility** — no new traits; pairwise
interaction terms over existing loci, plus a small set of
Bateson–Dobzhansky–Muller pairs whose incompatible combinations reduce offspring
viability. This is the highest-value axis for the project's most stubborn failure
(P11: zero species, ever), because it is the only proposal here that produces
**intrinsic** reproductive isolation — isolation that accumulates neutrally in
allopatry and does not require the hue-preference route that has never worked.
The cost is in `src/stats`: dominance and epistasis mean `traitsGenotypic` stops
being purely additive, V_A must be separated from V_D and V_I, and P13's
midparent regression estimates narrow-sense h² only if that separation is done
correctly. That is the same class of statistical work the sex-linkage deferral
was avoiding, and it deserves its own wave rather than a corner of someone
else's. Note that no prior decision on dominance or epistasis exists in
`DESIGN.md`, so this is open ground, not a settled question being reopened.

**G-F Sex-limited expression** — dimorphism without sex linkage: autosomal
modifier loci whose effect is conditioned on sex, so loci stay diploid in both
sexes and the diploid variance formulas survive. It buys runaway ornamentation
(female choice already exists) and sex-biased mortality. It still makes
`traitsGenotypic` sex-conditional, so per-sex V_A handling is required; pair it
with G-E's stats wave.

**G-G Dormancy and diapause** — `dormancyThreshold` and `dormancyEfficiency`,
coupling directly to the D-wave shock machinery: resting stages that ride out a
plankton crash, and bet-hedging polymorphism in when to enter. Deferred for a
specific measured reason: starvation is already 73–79% of deaths, and dormancy is
a mechanism that *reduces* starvation, which pushes population straight into the
slot cap and P3. It should follow the P3-as-biomass restatement, not precede it.

**G-H Ontogenetic diet shift** — one trait, `dietShiftSlope`, making expressed
`diet` a function of `sizeCurrent / size`. A single lineage then occupies both
guilds across its life, which is the cleanest possible answer to P9's
guild-persistence criterion and a plausible route around the D5 finding that
scavenging is a terminal strategy. Cheap, but strictly downstream of G-A.

**G-I Parental guarding** — needs a parent–offspring association that survives
across ticks and a new behaviour policy, i.e. engine work in A3's territory. The
*provisioning* half of parental investment is already in G-A, which is where most
of the strategy space lives; guarding is the expensive remainder.

**G-J Sublethal injury and regeneration** — makes a failed predation attempt cost
the victim tissue rather than nothing, giving `defense` a graded meaning and
armour an ongoing payoff. It is more an ecology change than a genome change, and
it interacts with the P7 mortality bands. Worth remembering when the
predation-pays campaign runs out of knobs.

---

## 5. Detection must scale with complexity

The user asked for this explicitly, and it is the part most likely to be
under-built. Three things beyond the per-axis probes above:

**The free instrumentation win.** Adding A5 and A6 adds `neutralE` and
`neutralF`, taking neutral markers from 4 to 6. Gate A-1 recorded the 4-marker
estimate width as a known risk; 6 markers narrow both the temporal-Ne estimate
(P14, whose 0.10 floor is currently only 8% from the best seed and has already
been breached twice by unrelated knob moves) and the Fst estimate (P8a). The
genome expansion pays for some of its own measurement.

**Per-deme trait moments.** The A7 log names the blocking gap precisely:
*"Distinguishing them needs a per-side trait mean, which `SampleRow` does not
carry… That is the concrete instrumentation gap blocking P8's second criterion."*
This is also the user's own overnight item (2). Adding
`traitsByDeme: readonly Readonly<Record<TraitKey, { mean, sd }>>[]`, restricted
to `speciation.clusterTraits` plus the new axes' traits to keep the row from
ballooning, closes it — and it becomes far more valuable with more traits, not
less, since divergence in a 23-trait space is exactly the thing a single global
mean hides.

**Toggle scenarios that actually evaluate probes.** The marginal-contribution
table cannot currently be produced by the probe runner: *"every aliveness probe
carries `scenario: 'baseline'`… so `--scenario=no-mutation` runs the sim and
writes the series but evaluates no probes at all."* Adding two more toggles makes
the table twice as valuable and the gap twice as expensive. Either the probes
accept toggle variants of their scenario, or the runner refuses a scenario no
selected probe can read — a small A5 change that the G-wave should not proceed
without, since ablation is how Gate A-2 said this kind of work must be
adjudicated. While there, pay the D-wave's owed debt: split `enableCarrion` out
of `enableDisturbances` so recycling and shocks can finally be separated.

---

## 6. Cost honesty

What a genome change actually costs, stated plainly so nobody is surprised at
02:00.

**Invalidated by any Wave 1 landing:** the golden trajectory hash (re-baselined
once at G0, deliberately, and recorded as such); snapshot format v3 → v4; and
**every accepted tuning row in the A7 log measured at the 48-locus/18-trait
layout** — `planktonCarryingCapacityBase` 40, `grazingMaxIntake` 1.2,
`gompertzA` 9e-5, `quantMutationRate` 1.6e-3, the `sizeRatioOptimum` 0.88 /
`baseLogit` −4.45 pair, and `carrion.maxIntake` 0.5. The record's own standard is
that *"a knob that moved without a measured justification is a knob that will be
moved back"* — so those values do not automatically survive; they need
re-derivation, and `sizeRatioOptimum` is expected to move a long way.

**Frozen contracts touched (all orchestrator-owned, D-wave style
authorization):** `traits.ts` (append 5 keys — append only, never reorder),
`genome.ts` (append A5/A6; append `loads` entries to six existing loci),
`types.ts` (2 config blocks, 2–3 toggles, 1 pool column, snapshot version),
`formulas.ts` (6 pure functions), `stats.ts` (3 `SampleRow` additions),
`apis.ts` (1 `EcologyApi` method), `protocol.ts` (slice stride 13 → 15),
`events.ts` (a toxin-invention event is worth having in the feed).

**Compute budget, from the record's own measurements** (300-gen baseline run ≈ 13
min; `probe:quick` ≈ 5m24s; `probe:full` ≈ 3–8 h; cliff screen 45 gens × 3 seeds
≈ 2 min per dose):

| Stage | Runs | Wall clock |
|---|---|---|
| G0 verification (`probe:full`, one re-baseline) | 1 | 3–8 h |
| G-A cliff screens (growth, provisioning, size-window pair) | ~12 doses | ~30 min |
| G-A dose batches at spec length | 3–4 batches × 9 runs | 8–12 h |
| G-A adjudication `probe:full` | 2–3 | 8–20 h |
| P3-as-biomass re-derivation | folded into the above | — |
| G-B cliff screen + one dose batch | ~4 doses | ~2.5 h |
| P19 base-rate panel (9 seeds, per the P16 precedent) | 9 | ~4 h |
| G-B adjudication `probe:full` | 1 | 3–8 h |

Call it **three to five days of mostly-unattended wall clock** for Wave 1, plus
the attended adjudication. That is the same order as the A7 campaign, and the
same order as the D-wave. It is the honest price; the alternative is a genome
change with no measured rows behind it, which the project has already ruled it
will not accept.

**The risks worth naming before starting:**

1. **P3 goes red on juvenile head count.** Expected, and the reason
   P3-as-biomass is a mandatory sub-package rather than a follow-up.
2. **Cannibalism destabilises the population.** Wanted as a phenomenon, dangerous
   as an uncontrolled one; needs the `conspecificLogit` knob and a user decision.
3. **Toxicity never bootstraps.** The macro-locus is the hedge; the ablation
   (macro disabled) is how the question gets answered rather than argued.
4. **P12 drifts under the growth term.** It must be O(1), allocation-free, and
   folded into the existing metabolism pass rather than added as a new sweep.
5. **Five more traits make P4/P5/P6 noisier.** Note the measured warning in the
   marginal-contribution table: *five of six toggle-off runs keep more loci alive
   than the reference*, and P6's breach *"is not evidence that a variance
   mechanism is missing; it is the cost of the aliveness the other probes are
   asking for."* A wider genome will move P6's denominator (48 → 68 loci); the
   threshold is a fraction, so it should survive, but it must be re-read rather
   than assumed.

---

## 7. Recommended Wave 1 — work packages

Sequenced so G0 lands and is verified before any biology, and so G-B's tuning
happens after G-A's campaign closes rather than beside it.

| WP | Scope | Owns | Acceptance |
|---|---|---|---|
| **G0** (orchestrator) | Per-chromosome and per-trait forked RNG streams; append-only conventions documented in `CLAUDE.md`; one deliberate golden-hash re-baseline | `src/sim/rng.ts`, `src/sim/genetics/**`, `CLAUDE.md`, `DESIGN.md` | Full test suite green; `probe:full` unchanged in kind; new hash recorded in the tuning log as a deliberate trajectory change |
| **G1** (orchestrator) | Contracts: 5 traits appended; A5/A6 appended; 6 cross-loads on existing loci; `growth` + `aposematism` config; `enableOntogeny`, `enableAposematism`, `enableCarrion`; formulas; `SampleRow` additions; slice 13→15; snapshot v4 | `src/contracts/**` | `npm run typecheck` + existing suite green with both toggles off, **and the off-arm reproduces G0's hash byte for byte** |
| **G2** (Opus) | Ontogeny: `sizeCurrent` column, growth folded into the metabolism pass, size-based maturity, genetic clutch and provisioning, size-window call sites reading current length | `src/sim/ecology/**`, `src/sim/organisms.ts`, `src/sim/mating.ts` | P17 scenario runs; P1 restore-continuation green with ontogeny on; off-arm byte-identical |
| **G3** (Opus) | Aposematism: toxin yield penalty and hazard, `hueBinToxicityAt`, kill-logit terms, mating acceptance term, toxin metabolic cost | `src/sim/ecology/**` | P18 scenario runs; both new predation terms measurably ≈0 at founding |
| **G4** (Opus) | P17/P18/P19, their scenarios, recorder series (`lifeHistory`, `hueBins`, `mimicryIndex`, `traitsByDeme`); toggle-scenario probe wiring; **P3 restated in biomass**; P10 redesign on a crash-neutral locus | `src/probes/**`, `src/stats/**` | `probe:quick` green with new probes at `warn`; P3 gate green on the restated criterion |
| **G5** (Opus) | Render: `sizeCurrent` + `lifeStage` + `conspicuousness` on the slice; juvenile draw; saturation from conspicuousness; toxicity in the inspector only | `src/render/**`, `src/app/**` | `npm run build` clean; browser check |
| **G6** | Tuning campaign: cliff-screen every knob at 45 gens × 3 seeds first; G-A dose batches; the `sizeRatioOptimum`/`baseLogit` pair; P19 base-rate panel; G-B last | config defaults + the tuning log | Spec-length runs; thresholds ratcheted from measured data; one knob = one measured row = one commit |

G2 and G3 are disjoint in the ecology directory only by file; sequence them
rather than parallelising, since both touch the predation kernel's call sites.
G4 and G5 are disjoint from both and from each other. Per the D5 lesson, the wave
ends with a **fresh-seed P1 panel** — *"fresh-seed panels are cheap gate audits
and D-waves should end with one."*

---

## 8. Considered and not proposed (so it is not silently retried)

| Direction | Why not |
|---|---|
| Separate bioluminescence axis | Folded into `conspicuousness`. Whether a loud signal reads as pigment or as emitted light is a render decision; a separate trait would duplicate the same predation/mating tug with different words. |
| Bounded "brain size 0–10" or any capped sensory scale | The herdloom failure. G-D's sensory range is unbounded and paid for by a resting metabolic cost. |
| Sex-linked loci for dimorphism | Deferred at WP-A0 for a stated reason (hemizygous males break the diploid variance formulas in `src/stats`). G-F routes around it with sex-conditioned autosomal expression, which still costs per-sex V_A handling but does not break ploidy. |
| Reaction-norm slope loci | Gate A-1 ruled these "roadmap, not v1" when it fixed the multiplicative GxE defect. Reopening them belongs with G-E's stats wave, not with a trait-axis wave. |
| Disease as a contagious mortality channel | Explicitly deferred in `briefs/roadmap-1-2-design.md`; it adds a fifth death cause and a contact process, and it interacts with P7's bands. Nothing in this proposal needs it. |
| Retuning `carrion.maxIntake` again to fix predation | The D5 lever has been pulled and measured; ontogeny attacks the same problem from the supply side (prey that fits the window) rather than by nerfing the alternative further. |
| Raising `world.slotCapacity` to absorb juveniles | Trades the P3 symptom for a linear P12 cost and abandons the density-dependence-via-resources requirement the band exists to enforce. Restating P3 in biomass is the honest fix. |
| Making toxicity reduce kill probability | Then it is `defense` with a new name, and no signal is ever needed. The post-kill penalty is what makes aposematism a real problem the population has to solve. |
| Putting toxicity on the render slice | It would hand the watcher the answer to the mimicry puzzle for free and make the hue-bin charts redundant. Inspector and charts only. |
| Reindexing existing loci to interleave new ones | `QUANT_LOCI` indices are the layout contract; reordering is a data-corrupting change, and it would move the two authored linkage blocks the sweep probe depends on. Append new chromosomes instead. |

---

## 9. Decisions I need from the user

1. **Wave 1 scope.** Ontogeny is the expensive axis and the one the project's own
   record has been pointing at for three waves; aposematism is the cheap one with
   the most nameable moment. I recommend both, in that order. Dropping to
   aposematism alone gets a result in about a day; dropping to ontogeny alone is
   the same campaign cost as both.
2. **Cannibalism: allowed with a cost knob, or blocked?** I recommend allowed. It
   is the biggest surprise available and it needs no new mechanism, but it can
   destabilise recruitment and the user may prefer to meet it deliberately.
3. **P3 restated in biomass** — this changes what a gate probe means, which is a
   bigger decision than a threshold ratchet and should be made explicitly rather
   than absorbed into a work package.
4. **Whether G0 lands on its own first**, with its own `probe:full`, before any
   biology is written. I recommend yes: it is a day of work that makes every
   future genome wave cheap, and it is the only way the toggles become strict
   controls rather than arguments.
