# Gate A-2 verdict: FAIL

The campaign evidence is credible: I confirmed the closing report has 39 readings, zero FAILs, the stated gate set, and P12 at 1.008×10⁶ organism-ticks/s. I also confirm that every tested mutation dose was rejected under the campaign policy.

I do not accept the current suite as a defensible certificate that “evolution stays interesting.” P3 is an incomplete density gate, P5 is not a valid gate, P13’s ratchet is post-hoc and does not perform its documented cross-check, and replicate aggregation is unspecified.

## Rulings on the six agenda items

1. Threshold ratchets

- P3 — legitimate subject, tuned cutoff, incomplete implementation. Survival must gate, but 99% was chosen after observing 1.00 on the certification seeds, with no independent allowable-excursion rationale. More seriously, dropped births are only printed, not asserted: [population.ts](/Users/eddelord/Documents/Projects/quick_game/panthalassa/src/probes/probes/population.ts:71). At 2.4e-3/s1, P3 passed at 0.993 despite 363 dropped births. Split P3 into survival, density-band occupancy, and container-interference assertions; the latter should directly constrain dropped births.

- P5 — tuned-to-pass; gate promotion rejected. It selects the largest excursion among many overlapping intervals in the final third: [genetics.ts](/Users/eddelord/Documents/Projects/quick_game/panthalassa/src/probes/probes/genetics.ts:128). That rewards noise, drift, longer observation, and denser sampling. As a sensitivity check, replacing the maximization with the final 50-generation endpoint change reduced the closing run’s moving-trait counts from 4/4/4 to 2/2/0. The campaign correctly reverted the 3-of-4 ratchet, but that same finding invalidates promoting the unchanged metric to a gate. Demote until it measures a fixed-length, sampling-invariant quantity with a stationary null calibration.

- P13 — partly an aliveness measure, but the `[0.25, 0.78]` ratchet is tuned-to-pass. A lower bound on inherited variation is relevant; an upper bound of 0.78 is not an aliveness boundary—0.82 can be biologically plausible. The implementation also does not perform the documented comparison with `V_A/V_P`; it merely prints it: [genetics.ts](/Users/eddelord/Documents/Projects/quick_game/panthalassa/src/probes/probes/genetics.ts:230), despite the contract saying P13 cross-checks the two estimators: [stats.ts](/Users/eddelord/Documents/Projects/quick_game/panthalassa/src/contracts/stats.ts:20). Demote P13 until the criterion is preregistered and includes estimator agreement or uncertainty.

- P14 ceiling — defensible sentinel, not validated threshold. Tightening 1.2 to 0.6 is not obviously tuned-to-pass because observed values were below 0.22, and catching near-census Ne is a legitimate purpose. But temporal Ne spans four generations while P14 divides by instantaneous census size: [genetics.ts](/Users/eddelord/Documents/Projects/quick_game/panthalassa/src/probes/probes/genetics.ts:292). Using mean census over the corresponding window changed closing s1 from 0.108 to approximately 0.100. Keep P14 warn and treat 0.6 as provisional until the denominator and biological target are derived together.

The P6↔P9 discriminator is good scientific practice—it falsified a campaign interpretation. It does not validate thresholds selected on the same three seeds later used for certification.

2. Defense pricing

No genome-table change is warranted from the supplied evidence.

The 1.5× figure is the L1 weight sum, 2.06/1.38. A more relevant founder/mutation variance mass, `Σ(w·founderSd)²`, is about 1.43×. The “8 of 9 charge no metabolic cost” claim is also false: q33 raises both defense and billed wariness. Several other loci impose non-metabolic tradeoffs—speed capacity, attack, foraging boldness, or thermal breadth: [genome.ts](/Users/eddelord/Documents/Projects/quick_game/panthalassa/src/contracts/genome.ts:117).

The design note is not contradicted merely because defense can also come from escape, spines, shape, or behavior; charging all defense through armour would erase those mechanisms. The balanced 3.2e-3 seed further shows that the genome table does not make a two-sided race impossible.

If balance work continues, use locus-level ablations or selection-response measurements. Do not equalize attack and defense input mass by fiat.

3. Speed pricing

The deep-time observation does not establish a cheap-trait leak. Keep realized-speed pricing for now.

`speedCap` is not ordinarily unused: every movement policy requests a positive fraction of it, and metabolic cost is quadratic in actual velocity: [behavior.ts](/Users/eddelord/Documents/Projects/quick_game/panthalassa/src/sim/ecology/behavior.ts:46), [formulas.ts](/Users/eddelord/Documents/Projects/quick_game/panthalassa/src/contracts/formulas.ts:54). It also affects mate seeking, wandering, habitat tracking, and the predation kernel—not only foraging.

Before adding maintenance cost, record:

- mean realized speed and speed-squared energy expenditure;
- behavior-mode fractions;
- `speedCap`–fitness covariance or parent/offspring selection differential;
- ideally a matched counterfactual where movement benefit is removed.

If cap continues rising after realized use and fitness benefit saturate, add a small capacity-maintenance term while retaining the realized-work term. Unused drift may be realistic, but it must not count as evidence for P5-style aliveness.

4. P8

The brief’s wording is wrong: the second criterion is falsifiable and has been falsified—approximately 1.0 is not below 0.5. What is currently unidentifiable is why mate discrimination failed.

Reformulate P8 into separate reports:

- P8a: neutral spatial divergence—Fst level and increase.
- P8b: reproductive isolation—cross/within acceptance ratio, with its own displayed value and threshold.
- Diagnostic series: side-to-side signal separation and within-side spread.

Today the table displays a passing Fst value against an Fst threshold but reports WARN because of a hidden acceptance subcriterion: [barrier.ts](/Users/eddelord/Documents/Projects/quick_game/panthalassa/src/probes/probes/barrier.ts:128). That is poor instrument reporting.

The minimal added instrument need not be generic per-deme moments for all traits. The barrier scenario can record per-side, per-sample sufficient statistics through `ScenarioNotes`:

- count, circular mean, and resultant length for `displayHue` and `prefTarget`;
- side means for diet and size;
- preferably q36 allelic mean per side.

That separates “side means diverged but spread swamped the signal” from “side means stayed pinned.” The current first-64-slots acceptance sample should also become a deterministic ID-hash or stratified sample; ascending recycled slot order is not representative.

5. P12

Re-derive; reject 2×10⁶.

At 30 ticks/s:

- Literal 256× at 500 organisms requires 3.84×10⁶ organism-ticks/s.
- Literal 256× at 1,000 requires 7.68×10⁶.
- The current 2×10⁶ threshold guarantees neither.

I recommend a Phase-A watchability requirement of at least one simulated generation per wall-clock second at 1,000 organisms. With 900 ticks/generation, that is 0.9×10⁶ organism-ticks/s, equivalent to 30× real-time at 1,000 or 60× at 500. The measured 1.008×10⁶ passes with roughly 12% margin.

Restore it as a gate only on a documented reference environment with repeated measurements; keep it informational on arbitrary developer machines. If the UI promises literal 256× delivery, then the appropriate gate is 3.84–7.68×10⁶, not 2×10⁶.

6. P6 ∧ P9 simultaneity

Confirm simultaneity per run, but not the brief’s stronger interpretation.

The 1.8e-3 dose is stronger evidence than the cited 3.2e-3/s1 run: all three seeds pass P9, with both guilds present in 100% of samples, and all three pass P6’s quantitative-locus fraction. Therefore the suite may legitimately require quantitative variance retention and coevolution in the same run.

However, full P6 is not green at 1.8e-3: its cross-replicate report warns because `cladeMacroA:0` fixed on every seed. The evidence proves P6’s per-seed quantitative half ∧ P9, not the entire named P6 probe.

Nor should “all three fixed seeds” silently become the population-level criterion. The runner has no k-of-n aggregation; when a warn becomes a gate, any failing seed automatically means failure. Given chaotic basin membership, define a preregistered success prevalence over a larger seed panel. Three seeds cannot estimate robustness meaningfully.

The “slot cap is now the binding constraint” claim is also too broad:

- 2.0e-3 fails P3, but fails P9 on all seeds because guild persistence is only 11/39/77%.
- 1.8e-3 passes P9 on all seeds but breaches P3, P4, P6’s replicate half, P7, P13, and P14.

Density regulation is a real blocker, but not the sole blocker to full P6∧P9 plus suite-wide acceptance.

## Other defects found

Introduced by the ratchet:

- P5 and P13 were promoted using the same three seeds that established their current behavior; P5’s metric had already demonstrated observation-length dependence.
- P3’s gate promotion made its pre-existing dropped-birth blind spot acceptance-critical.

Pre-existing:

- The suite documentation claims k-of-n replicate assertions, but P8/P9/P10/P11 only emit independent per-seed reports: [suite.ts](/Users/eddelord/Documents/Projects/quick_game/panthalassa/src/probes/suite.ts:12).
- P10 estimates injected-allele frequency from the locus mean while mutation, drift, and selection move the background mean: [community.ts](/Users/eddelord/Documents/Projects/quick_game/panthalassa/src/probes/probes/community.ts:116). This can false-pass. Use a tagged quantitative allele or subtract a paired no-injection control.
- Toggle scenarios run but no aliveness probe accepts their scenario name, producing an expensive empty report. This is already documented in DESIGN and remains reproducible from the dispatch logic.
- Full-report artifacts contain no source commit, config hash, Node/CPU identity, or benchmark-host provenance and overwrite a generic filename. The brief currently supplies provenance manually.
- P1’s detail says “at the end” but reports `source.state.liveCount` without advancing `source` beyond the snapshot tick: [determinism.ts](/Users/eddelord/Documents/Projects/quick_game/panthalassa/src/probes/probes/determinism.ts:75).
- P2 certifies a specific token blacklist, not exhaustive entropy hygiene. For example, other clocks and aliased crypto sources are outside both its scanner and current lint selectors.

Literal deviations from the brief:

- 1.8e-3 does not “fail four probes.” It has breaches in six probe IDs: P3, P4, P6, P7, P13, and P14. Only P3 and P13 are gate-level FAILs.
- “The suite certifies 300–600 generations” is imprecise: sweep runs 200 generations, P12 about 22, and P1 about 2.7. Baseline/barrier/speciation cover 300/300/600.
- P8’s acceptance criterion is falsified, not unfalsifiable.
- Defense’s “8 of 9 no metabolic cost” and speed’s “only benefit is foraging” are both incorrect as stated.
- Density regulation is a blocker, not the sole constraint demonstrated by the batch.

## Could not verify

- `npm test` could not start because Vitest attempted to write `node_modules/.vite-temp`; it failed with the expected sandbox `EPERM`. This is not a defect.
- I did not rerun `probe:full`, because it writes artifacts and costs roughly three hours. The supplied JSON and rendered log agree.
- The deep-time watch has no raw series or screenshots in the reviewed artifacts, so its 8–11× trajectory and host conditions were audited from the design record, not independently reproduced.
- Machine idleness cannot be independently proven. P12’s best-window/aggregate spread, 1.09×10⁶ versus 1.01×10⁶, does not show an obvious major stall.

Typecheck and lint passed. The working tree remained clean.

## Not examined

Rendering/UI correctness, Phase B work, future P15/P16 designs, network behavior, and simulation correctness unrelated to the probe and pricing paths above.