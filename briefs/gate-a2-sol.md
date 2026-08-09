# Gate A-2 — review brief (Sol, read-only)

You are the Gate A-2 reviewer for Panthalassa, an aquatic evolution
simulation whose central claim is that "evolution stays interesting" is a
measured property. A tuning campaign (WP-A7) has just closed. Your job is to
audit the probe suite and its thresholds — the instrument, not the vibes.

**Do not modify any file.** Report findings only.

## State

- HEAD: `<COMMIT>` on main; working tree clean.
- The design record is `DESIGN.md` (read "Tuning log", "The two
  discriminators", "Threshold ratchet", "Mechanism marginal contributions",
  "Deep time"). The campaign state summary is `STATUS.md`.
- The probe suite is `src/probes/**`; thresholds live with each probe.
  Gates today: P1, P2, P3, P5, P13. The suite certifies 300–600 generations.
- Acceptance evidence: `runs/` holds report JSON + JSONL series from the
  campaign-closing `LONG_SIM=1 npm run probe:full` (report file named in the
  section below).
- Sandbox note: you are read-only. Any test needing a write/tempdir/network
  will fail on EPERM — report such failures separately from findings, not as
  defects.

## The dose-batch result you are confirming

<DOSE-RESULT — filled in after the batch: accepted rate, per-seed P3/P4/P6/
P9/P14 readings, arms-race SDs, and the probe:full report path.>

## Agenda — rule on each

1. **Threshold ratchet legitimacy.** For each ratcheted gate (P3, P5, P13,
   P14's ceiling): aliveness measure or tuned-to-pass? Worked example of the
   campaign catching itself: the P6↔P9 tradeoff was first read as a model
   law and then falsified by the mutation-dose discriminator (DESIGN.md "The
   two discriminators" — the superseded reading is kept, marked, below it).
   Challenge the specification, not just the numbers.
2. **Defense pricing.** The genome table gives defense 1.5× attack's input
   mass and 8 of 9 defense loci charge no metabolic cost, contradicting the
   design record's own "armour is the thing you pay for" note (DESIGN.md
   "Structural finding: what the defense loci buy"). Rule whether a
   genome-table change is warranted. A7 was barred from editing it; the
   change would land after your ruling.
3. **Speed pricing — same shape.** Metabolic cost charges *realized* speed;
   the evolving `speedCap` is free until used. In the user's deep-time watch
   the cap ran away ~8–11× in a predator-free world where its only benefit
   is foraging (DESIGN.md "Deep time"). Honest selection or cheap-trait
   leak? If leak: is the fix pricing the cap (maintenance cost on capacity)
   or accepting drift on an unused trait as realism?
4. **P8's second criterion is unfalsifiable, not merely unmet.** Cross/within
   mate acceptance sits at ~1.0 under every knob tried, including with
   frequency-dependent predation off (Fst reaches 0.93 — divergence is
   real, mate choice is blind to it). `SampleRow` carries `populationByDeme`
   but no per-deme trait moments, so the two surviving explanations (hue
   within-side spread swamps between-side divergence vs. q36 pleiotropy
   pinning hue under parallel ecology) cannot be separated. Rule on (a) the
   criterion's reformulation and (b) the minimal instrument to add.
5. **P12's threshold.** 2×10⁶ organism-ticks/s predates the model; measured
   ~1.0×10⁶ on a quiet machine after the F4 performance wave. Keep, lower,
   or re-derive from a watchability requirement (what multiple of real-time
   must 256× actually deliver)?
6. **P6 ∧ P9 simultaneity.** Evidence now says the suite may demand both
   green at once (mutation input buys both; s1 at 3.2e-3 showed P6 0.958
   with a 99% guild and the campaign's only two-sided arms race). Confirm
   against the dose-batch result above, or say why not.

## Reporting

Separate clearly: rulings on the six agenda items / other defects found
(introduced vs. pre-existing) / could-not-verify / not-examined. Report
every deviation from this brief and anything in it you believe is wrong —
that instruction is meant literally and past reviews' best findings came
from it.
