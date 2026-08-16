# G4 — Probes and stats: measuring the world G2/G3 built

The wave's measurement package. Read `CLAUDE.md`, then DESIGN.md "G-wave"
through "G3" (especially "G0 spec-length adjudication" — your P3 work
answers it), then `briefs/g-wave-design.md` §4 (G-A "Detection", G-B
"Detection") and §6's G4 row. Contracts are landed through v1.8:
`SampleRow.lifeHistory/hueBins/mimicryIndex/traitsByDeme` (stats.ts),
`LifeHistorySample`, `HueBinSample`, `sizeCurrent` on `OrganismPools`
(v1.7.1), the `'toxin'` death cause (v1.7.2).

## You own

`src/probes/**`, `src/stats/**`. Nothing else. `src/contracts/**` FROZEN —
missing contract = STOP and report. Do not touch `src/sim/**`,
`src/render/**`, `src/app/**`. The golden-hash test in
`src/probes/disturbance-units.test.ts` is yours to run but NOT to edit. No
commits — the orchestrator re-runs your probe, reviews, and commits.

A render package (G5) runs concurrently in `src/render/**`/`src/app/**` —
expect its uncommitted edits in the tree; never touch its files. If
`npm test` shows failures in render/app tests, ignore them and say so in
your report; your acceptance gates are the probe/stats/sim suites.

## 1. P3 restated in biomass (THE GATE — the package's centerpiece)

Read DESIGN.md "G0 spec-length adjudication" first. The standing failure it
records: baseline-s3 at spec length evolved small bodies (late mean size
14.9 vs 21.5), headcount peaks grazed the 4096 cap (0.7% of samples,
10,843 dropped births ≈ ≤3.4% of matings), while biomass (census × mean
size) sat BELOW the baseline envelope (~32k vs ~38k). The design's ruling
(§4 G-A): "the fix is not a bigger cap; P3 should be restated in biomass
rather than head count — biomass is the conserved quantity the band was
always trying to bound."

Requirements:
- The band becomes a **biomass band** (Σ over live organisms of realised
  length `sizeCurrent` — the recorder must produce this series; see §4).
  Derive the band from the historical run reports in `runs/` (the
  `full-*.jsonl` series carry population and size means; state your
  derivation and the numbers).
- **Cap contact stays a criterion.** The adjudication's watch item is
  explicit: the restated P3 must not silently bless cap-and-starve — the
  band exists to force density dependence through resources, and on s3 the
  cap did real regulation (~9% of late-window matings clipped). Replace the
  hard `0 births dropped` with a bounded tolerance stated as a fraction of
  total births, derived from the data (the artifact seed must pass; a seed
  where the cap does sustained regulation must fail). State the number and
  its rationale. Never-empty stays a gate.
- The existing baseline scenarios (off-arm) must adjudicate correctly under
  the restated gate: s1/s2/s3 of the G0 run would all pass, and all seeds
  of `runs/full-c2fb508e-*` (maxIntake-0.5 baseline) would too. Verify
  against the stored JSONL/reports where lengths permit and show the
  arithmetic in your report.

## 2. New probes (all ship at `warn`)

- **P17 (age structure)** — ontogeny-on scenario. Asserts: realised-length
  CV above a ratcheted floor (cliff runs achieved 0.45–0.52; today's
  off-arm sits at 0.06–0.10 — ratchet just under achieved per the
  convention), juvenile fraction in a band, and that the realised
  predator/prey length-ratio distribution overlaps the kill window. P17 is
  the probe that would have caught the original write-once-size defect.
- **P18 (aposematic coupling)** — aposematism-on scenario. The
  within-population correlation between expressed `toxicity` and
  `conspicuousness` rises above the correlation implied by the authored q63
  pleiotropy alone (compute the authored-only expectation analytically from
  the W matrix and say how). Passing must require that *selection* did it,
  not the locus.
- **P19 (mimicry cycle)** — the fill-and-empty signature: within a hue bin,
  free-rider fraction (`mimicryIndex`) rising past a bar, bin mean toxicity
  falling, then the bin emptying. Ship the detector with provisional
  thresholds at `warn` and a `TODO(G6)` note: per the P16 ruling the final
  criterion must be stated against a 9-seed base-rate panel, which is G6
  campaign work. Do not tune thresholds to make it pass.
- **P10 redesign on a crash-neutral locus** — read the current P10 and its
  DESIGN.md history first. The v1.7 genome carries pure neutral markers
  (`neutralD/E/F`); move P10's tracked allele onto one so disturbance
  dynamics cannot confound the fixation-rate read. Document what changes in
  the probe's meaning.

## 3. Toggle-scenario wiring

`TOGGLE_KEYS` in `src/probes/scenarios.ts` gains `enableOntogeny` and
`enableAposematism`, so each gets its marginal-contribution scenario like
every mechanism before it. P1 restore-continuation coverage for both
toggles already exists in the sim-side tests (`ontogeny.test.ts`); your job
is only the scenario wiring plus whatever the quick suite needs to run
P17/P18 (a P19-capable scenario may be spec-length only — say so if so).

## 4. Recorder series (`src/stats/**`)

Populate the declared-but-empty `SampleRow` fields, ontogeny/aposematism
arms only (`undefined` off-arm, so off-arm JSONL is byte-identical):
- `lifeHistory`: per `LifeHistorySample` — realised length mean/sd,
  juvenile fraction, mean age at maturity (emergent — you will need to
  track when organisms cross maturity; if that needs sim-side state you
  cannot reach, STOP and report the gap rather than approximating), and
  recruitment.
- `hueBins`: global per-hue-bin count/meanToxicity/meanConspicuousness
  from the trait pools (`predation.hueBinCount` bins). Do not import from
  `src/sim/ecology` — stats reads pools through its own pass.
- `mimicryIndex`: within the most-toxic bin, the fraction of individuals
  whose toxicity is below the population median.
- `traitsByDeme`: per-deme `TraitSample`s for at least `size`, `diet`,
  `toxicity`, `conspicuousness`.
- **Both lengths**: wherever the recorder reports `size`, realised length
  gets its own series (the design: "the recorder must report both").
- The biomass series P3 needs (§1).

## Determinism and honesty rules

- Everything gated: off-arm samples and probe behaviour byte-identical to
  today's (golden hash untouched; off-arm JSONL fields absent, not zero).
- No RNG in stats beyond what exists; slot-order pool walks.
- Thresholds ratchet to sit just under achieved behaviour — a probe that
  has never failed is not testing anything. State every threshold's
  provenance in your report.
- P12 may read low while G5 runs concurrently — the known busy-machine
  effect; note it, do not chase it.

## Acceptance probe (orchestrator re-runs verbatim)

```
npm run typecheck && npx eslint src/probes src/stats --max-warnings=0 && npx vitest run src/probes src/stats src/sim && npm run probe:quick
```

`probe:quick` must exit 0 with the restated P3 at gate and P17/P18 at warn
appearing in the table. Report: what you built per file, the biomass band
and cap-contact tolerance with their derivations, every threshold's
provenance, the P10 meaning change, probe:quick verdict table tail, and
any contract gaps. No commits.
