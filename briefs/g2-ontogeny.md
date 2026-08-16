# G2 — Ontogeny: juveniles, growth, and the size structure

Wave 1's load-bearing biology package. Read `CLAUDE.md` first (especially the
determinism section and the G0 genome-growth conventions), then DESIGN.md
"G-wave" + "G0" + "G1" records, then `briefs/g-wave-design.md` §4 G-A — the
design you are implementing. The contracts are ALREADY LANDED (v1.7, commit
512807e): traits `growthAllocation`/`offspringSize`/`fecundity`, the A5 locus
bank, `GrowthConfig` (`config.growth.*` including `conspecificLogit`),
`toggles.enableOntogeny`, and the pure formulas `tissueCostPerCm`,
`somaticGrowthPerTick`, `clutchInvestment` in `src/contracts/formulas.ts`.

## You own

`src/sim/organisms.ts`, `src/sim/engine.ts`, `src/sim/mating.ts`,
`src/sim/snapshot.ts`, `src/sim/ecology/**`. Nothing else. `src/contracts/**`
is FROZEN — if a contract is missing something, STOP and report the gap in
your final message instead of editing or shadow-typing around it. Do not
touch `src/sim/genetics/**` (G0's stream contracts live there; `g0-streams.test.ts`
pins them), `src/probes/**` except where a test you legitimately break needs
its expectation updated with a documented why, `src/render/**`, `src/app/**`.
No commits — the orchestrator re-runs your probe, reviews, and commits.

## The cardinal constraint: the off-arm is bit-identical

With `enableOntogeny` false (the default), the world must be BYTE-IDENTICAL
to today's: the golden trajectory hash `67c311b3a0e40aa6` in
`src/probes/disturbance-units.test.ts` must still pass, untouched. The
pattern that achieves this cheaply:

- Add a `sizeCurrent` Float32 pool column (organisms.ts), initialised at
  birth to the organism's **expressed `size` trait, exactly** (same Float32
  value). When the toggle is off it never changes, so every read of
  `sizeCurrent` equals the old read of the size trait bit-for-bit.
- Rewire every ecology/engine site whose meaning is "this organism's current
  body length" — metabolic cost, energy capacity (`energyCapacityOf`), the
  predation size-ratio window, carrion deposit biomass, grazing bite scale,
  sample-slice channel 4 (`SAMPLE_SLICE.size` now carries `sizeCurrent`; the
  renderer then draws juveniles small for free) — to read `sizeCurrent`
  unconditionally. Sites whose meaning is genuinely "the genetic target"
  keep reading the trait.
- Every NEW dynamic (growth, provisioning, size-based maturity, the
  conspecific term) is gated on `state.config.toggles.enableOntogeny`
  (read fresh from state.config — never cached).

## The biology (toggle on)

1. **Growth, folded into the existing per-organism metabolism pass** — no new
   sweep over the pool (P12 discipline), no allocation in the loop. Each tick
   an organism with an energy surplus (define surplus as intake minus the
   tick's metabolic burn; if the pass structure makes that awkward, energy
   above a fraction of capacity is an acceptable operationalisation — state
   your choice and why in the report) grows by
   `somaticGrowthPerTick(surplus·alloc-share spent, …)` cm, paying the energy.
   `growthAllocation` (expressed share) says how much of the surplus goes to
   soma. No cap at target: `tissueCostPerCm` makes overshoot expensive —
   NEVER write a clamp.
2. **Size-based maturity**: mature when
   `sizeCurrent ≥ growth.maturityLengthFraction · sizeTarget`, with
   `time.maturityTicks` retained as an AGE FLOOR (both conditions required).
   Applies to female readiness and to whatever male eligibility exists.
   Age at maturity becomes emergent — do not add a config constant for it.
3. **Genetic clutch and provisioning** (engine reproduction stage): with the
   toggle on, the Poisson clutch mean is the female's expressed `fecundity`
   (not `mating.clutchLambda`), and the mother is charged
   `clutchInvestment(offspringSize_expressed, realisedClutch, config)` —
   truncate the clutch to what she can pay, an energy constraint, never a
   trait clamp. Decide and document how `metabolism.reproductionEnergyCost`
   and the paternal share compose with this (recommendation: provisioning
   REPLACES the maternal per-offspring cost when on; the paternal share stays
   as-is on its existing base so anisogamy keeps its knob).
4. **Offspring are born small**: `sizeCurrent` at birth = the newborn's own
   expressed `offspringSize` (its trait, so provisioning genetics are the
   mother's but the realised egg size is the offspring's genotype expressed —
   if you instead use the MOTHER's offspringSize, justify it; either is
   defensible, the report must say which and why). Birth energy: scale
   `metabolism.birthEnergy` by the provisioning ratio
   `(offspringSize / TRAIT_META baseline)^provisionExponent` so a big egg
   buys a big reserve — or propose better; mean-preserving at the baseline
   either way.
5. **Cannibalism arrives free — keep it, price it**: the predation kernel
   does not check species. With juveniles in the size window, conspecific
   predation happens. Add `growth.conspecificLogit` (negative) to the kill
   logit when predator and victim share a species tag, gated on the toggle.
6. **Senescence stays age-based.** Do not couple it to size this wave.

## Determinism rules that will bite you

- Slot-order iteration only; births/deaths through the existing queues.
- Any new RNG use comes from the existing stage streams; do NOT add draws to
  a shared stream in a way that shifts when the toggle is off (gate the
  draws with the mechanism).
- `sizeCurrent` must round-trip through snapshots (snapshot.ts: add the
  column to the serialised set; the format is already v4 — do not bump).
  P1's restore-equivalence probes must pass with the toggle ON as well as
  off: add a restore-continuation unit test with ontogeny enabled.
- Phenotype is still computed once at birth; the tick loop still never reads
  a genome. `sizeCurrent` is state (like energy), not phenotype.

## Tests you must add (node, deterministic)

- Off-arm: golden hash test untouched and green (do not edit it).
- Growth: an organism with surplus grows toward target and decelerates;
  growth past target is possible but sharply more expensive; zero surplus =
  zero growth (stunting under starvation, asserted with a starved world).
- Maturity: emergent age-at-maturity moves with food availability; age floor
  binds when growth is fast.
- Clutch: fecundity trait drives the Poisson mean; an energy-poor mother
  realises a truncated clutch; energy is conserved (mother's loss ≥ clutch
  investment, no minting).
- Cannibalism: same-species kill logit carries the penalty; cross-species
  does not; toggle off = no term.
- Snapshot: sizeCurrent round-trips; restore-continuation with ontogeny on
  is tick-for-tick identical to uninterrupted.
- A LONG_SIM-gated 45-generation ontogeny-on smoke run (3 seeds) asserting
  survival and a nonzero juvenile fraction — the cliff screen in test form.

## Acceptance probe (orchestrator re-runs verbatim)

```
npm run typecheck && npx eslint src/sim --max-warnings=0 && npm test && LONG_SIM=1 npx vitest run src/sim/ontogeny-cliff.test.ts
```

(Name your cliff test exactly `src/sim/ontogeny-cliff.test.ts`.) Report: what
you built, every design decision the brief left to you with its why, probe
output, and any contract gaps. TS strict; comments = constraints/why; no
commits.
