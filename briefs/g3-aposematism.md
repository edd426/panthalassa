# G3 — Aposematism: toxin, signal, and the mimicry machine

Wave 1's rider package. Read `CLAUDE.md` first (determinism section, G0
conventions), then DESIGN.md "G-wave" through "G2", then
`briefs/g-wave-design.md` §4 G-B — the design you are implementing. The
contracts are ALREADY LANDED (v1.7.2): traits `toxicity` (softplus s=0.15,
baseline 0) and `conspicuousness` (identity, baseline 0), the A6 locus bank
with `toxinMacro`, `AposematismConfig` (`config.aposematism.*`),
`toggles.enableAposematism`, the `'toxin'` death cause, the
`ToxinInventionEvent`, and the pure formulas `toxinYieldMultiplier`,
`toxinConsumptionHazard`, `aposematismLogit`, `toxinMetabolicCostPerTick` in
`src/contracts/formulas.ts`.

## You own

`src/sim/ecology/**`, `src/sim/mating.ts`, `src/sim/engine.ts`, plus your new
test files. Nothing else. `src/contracts/**` is FROZEN — a missing contract is
a STOP-and-report, never an edit or a shadow type. Do not touch
`src/sim/genetics/**`, `src/sim/organisms.ts`, `src/sim/snapshot.ts`,
`src/render/**`, `src/app/**`, `src/probes/**` (exception: a probe test whose
*fixture* your change legitimately breaks may be updated with a documented
why — the golden-hash test in `src/probes/disturbance-units.test.ts` must
pass UNTOUCHED). No commits; the orchestrator re-runs your probe, reviews,
and commits.

## The cardinal constraint: the off-arm is bit-identical

With `enableAposematism` false (the default), the world is BYTE-IDENTICAL to
today's: golden hash `67c311b3a0e40aa6` untouched. Both new traits express ≈0
at founding *even on the on-arm* (the axis is nearly inert until toxicity
evolves), but the off-arm discipline is stricter than "≈0": **every new RNG
draw, every new term, every new statistic is gated on
`state.config.toggles.enableAposematism`** (read fresh from `state.config`,
never cached). A gated mechanism may consume extra draws on the on-arm — the
on-arm is a new trajectory anyway — but the off-arm streams must not shift by
a single draw. The `'toxin'` death counter is already digest-gated off-arm
(snapshot.ts); you never write it off-arm, so it stays 0 there.

## The biology (toggle on)

1. **Toxin is a post-kill penalty, never a lower kill probability** — this is
   the crucial modelling choice; if toxicity reduced kill probability it
   would just be `defense` under another name. In `tryPredation`, on a
   successful kill: the energy yield is multiplied by
   `toxinYieldMultiplier(victimToxicity, config)`, and the predator takes a
   one-off hazard `toxinConsumptionHazard(victimToxicity, config)` — roll it
   on the predation stage's existing rng (gated), and on death push the
   predator into the death queue with cause `'toxin'` (queued, applied at the
   stage boundary like every death; a dead predator's kill still stands —
   both died, which is the point of the trade).
2. **Predator avoidance through the population statistic.** Beside
   `hueMorphFrequencyAt` build the sibling `hueBinToxicityAt(state, x, y,
   hueDeg)`: the local mean toxicity of that hue bin, from the same grid
   machinery. The kill logit gains `aposematismLogit(victimConspicuousness,
   binMeanToxicity, config)` — apply it the way G2 applied the conspecific
   term, as an odds multiplier on the frozen kernel's output, so
   `formulas.ts` stays the single source of the probability. The predator has
   no memory; the population's avoidance is a function of the local
   statistic, exactly like the existing frequency-dependence term.
3. **Conspicuousness costs and pays.** The detection half
   (`+conspicuousnessDetectionCoef · conspicuousness`) is inside
   `aposematismLogit` — check the landed formula's signature and do not
   double-apply. The mating half: `conspicuousnessMatingCoef ·
   conspicuousness` added to the male-acceptance weight in `mating.ts`
   (gated), so loud males are chosen more and eaten more — the sex-biased
   mortality surprise needs no other machinery.
4. **Toxicity costs metabolism**: add
   `toxinMetabolicCostPerTick(toxicity, sizeCurrent, config)` to the tick's
   metabolic burn (gated). Use realised length, matching G2's rewiring.
5. **The invention event.** Emit `ToxinInventionEvent` when a birth is the
   *arrival* of macro-borne toxicity: the newborn carries a non-ancestral
   `toxinMacro` allele that neither parent carries (a fresh step-mutation at
   that locus). Genomes of both parents are on the pools at reproduction
   time; compare allele sets, no new RNG. `viaMacroLocus: true` for this
   path. Do not attempt a polygenic-invention detector — that is G4's
   recorder work, not an event.
6. **Nothing new is state.** No new pool columns, no new fields, no snapshot
   surface: the hue-bin toxicity statistic is runtime-rebuilt like the
   frequency grid.

## Determinism rules that will bite you

- Slot-order iteration; deaths through the queues; no allocation in per-tick
  loops (extend the existing hue-bin grid accumulation pass, do not add a
  second sweep).
- The toxin-hazard roll is a NEW draw on an existing stream — gate it so the
  off-arm stream is untouched. Same for any statistic that would reorder
  draws.
- Phenotype is computed once at birth; the tick loop never reads a genome —
  the invention check reads parent *genomes* at the birth site, which is the
  one place genomes are legitimately in hand.

## Tests you must add (node, deterministic)

- Off-arm: golden hash test untouched and green.
- Yield: a toxic victim's kill yields `exp(−coef·toxicity)` of the clean
  yield; toxicity 0 is exactly 1.
- Hazard: scripted-rng predator dies after eating a toxic victim, death
  recorded under `'toxin'`; clean victim = no roll consumed on the off-arm
  and no death on the on-arm at hazard 0.
- Aposematic credit: kill probability drops only when the victim is BOTH
  conspicuous AND its local hue bin is toxic; conspicuous+palatable bin =
  detection cost only (probability rises); cryptic (negative
  conspicuousness) reduces detection.
- Mating: conspicuous males gain acceptance weight on-arm; off-arm weight
  bit-identical.
- Metabolic cost: burn rises with toxicity, scales with realised length per
  the formula; off-arm burn bit-identical.
- Invention: constructed birth where the newborn's toxinMacro allele is
  fresh emits the event once with the right payload; inherited allele does
  not emit.
- A LONG_SIM-gated 45-generation aposematism-on smoke run (3 seeds)
  asserting survival, a sane death mix (every endogenous channel < 0.8), and
  that founding mean expressed toxicity is ≈0 (the axis starts inert — do
  NOT assert toxicity evolves in 45 generations; bootstrapping is G6's
  question).

## Acceptance probe (orchestrator re-runs verbatim)

```
npm run typecheck && npx eslint src/sim --max-warnings=0 && npm test && LONG_SIM=1 npx vitest run src/sim/aposematism-cliff.test.ts
```

(Name your cliff test exactly `src/sim/aposematism-cliff.test.ts`.) Report:
what you built per file, every design decision the brief left to you with
its why, probe output tail, and any contract gaps. TS strict; comments =
constraints/why; no commits.
