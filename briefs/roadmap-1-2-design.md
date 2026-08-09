# Roadmap items 1+2 — design brief (drafted 2026-08-09, pre-Gate A-2)

"1 and 2 together are the game" (user, 2026-08-09). This brief turns the
endorsed roadmap into implementable mechanisms. Implementation starts only
after Gate A-2, because two of Sol's rulings (defense pricing, speed pricing)
may change the trait economy these mechanisms feed into, and nobody wants to
tune twice. Contract changes are orchestrator-owned as always.

## Design goal, stated once

The deep-time watches (DESIGN.md "Deep time") showed the failure mode of a
quiet world: coevolution dies early, then thousands of generations of
aftermath — vestigial decay, variance erosion, cap-and-starve stasis. The two
mechanisms here attack that from both ends: **disturbances regenerate the
variance and the selective openings that quiet eras consume**, and the
**scavenging on-ramp turns one of those openings into guild rebirth**. The
headline moment this design is built to produce: a plankton crash starves the
world, carrion spikes, diet climbs the scavenging ramp, predation re-ignites,
and the arms race restarts — visible on the trend charts as punctuated
equilibrium.

## Mechanism 1 — the disturbance regime

Rare spontaneous shocks, all drawn from a dedicated `SeededRng` fork
(`disturbance`, tick-keyed) so determinism holds; every shock is a `SimEvent`
so the feed, the charts, and the recorder can annotate it.

Ship in this order (cheapest and most watchable first):

1. **Thermal excursions (heatwaves / cold snaps).** A jump component on the
   existing OU climate walk: Poisson-rare (order 1 per 100–200 generations),
   magnitude ±2–5 °C, decaying over 10–30 generations. Rationale: the
   5,277-generation watch showed a −2 °C excursion coinciding with the only
   trait-economy reorganization in 5,000 generations — this is the shock type
   with observed payoff, and it touches only the climate field.
2. **Plankton crashes.** Productivity multiplier 0.2–0.5× for 5–20
   generations, either global or as a regional dead zone (a disc or band, so
   there is geography to flee). This is the selective window the scavenging
   on-ramp needs (below), and the direct answer to "population rise and fall"
   reading as a cap artifact: crashes give the population curve an ecological
   story.
3. **Kelp storms.** A swath of kelp cover cleared to ~0, regrowing over
   generations. Only meaningful while predators exist (kelp is a predation
   shield), which is exactly why it ships with this bundle and not before.

**Deferred, recorded so it is not silently retried:** disease outbreaks. A
density-dependent contagious mortality channel is the right long-term answer
to monoculture stasis, but it adds a new death cause and a contact process,
interacts with P7's mix bands, and none of the headline moments need it.
Revisit after the regime above is measured.

Config: a `disturbance` block (per-type rate, magnitude, duration, plus a
master `enableDisturbances` toggle wired into the mechanism-toggle set so the
marginal-contribution table can carry a disturbance row). Scheduler state
(active shocks, decay clocks) lives in `SimState` and round-trips snapshots —
P1's restore-continuation test must stay green.

**Probe P15 (disturbance regime):** on a spec-length run with the regime on —
(a) shocks fire within ±40% of configured rate; (b) the world survives ≥95%
of shocks (P3 never breached by a shock of default magnitude); (c)
re-adaptation is visible: mean focal-trait movement in the 50 generations
after a shock exceeds the quiet-era rolling baseline (this is P5's "no
flatline" logic given a cause). Threshold numbers get ratcheted from measured
runs per project convention.

## Mechanism 2 — the scavenging on-ramp (predator re-evolvability)

The q=1.6 diet convexity is a two-sided fitness valley: a mid-diet organism
is bad at eating plankton *and* bad at hunting. Real carnivory evolves up a
ramp — scavenging first. The mechanism:

- **Carrion field.** A fraction of deaths deposit biomass into a carrion
  grid (same machinery as plankton), decaying with a half-life around one
  generation. Mass-starvation events therefore produce a carrion pulse —
  the crash itself provisions the recovery.
- **Scavenging intake.** Type-II consumption of carrion with efficiency
  `diet^q_scav` where `q_scav < 1` (concave, contrast the convex `diet^1.6`
  for live prey). No attack roll, no speed contest, no size window — carrion
  does not fight back. Every step from filterer toward hunter now pays
  immediately, *through* the valley floor.
- **The high end stays expensive.** Live predation keeps its convex
  efficiency and its kernel (attack, speed, size window). Scavenging is the
  on-ramp, not the destination: carrion is scarce in good times, so pure
  scavengers lose to filterers in quiet eras and to hunters when prey is
  the richer channel. The diet axis becomes a genuine three-niche continuum.

Interactions to watch: scavenging recycles biomass that starvation currently
deletes, so P7's starvation share will drop — re-measure the mix bands rather
than assuming. And carrion + plankton crash is deliberately a coupled system:
that coupling IS roadmap item 1's fix.

**Probe P16 (re-evolvability):** scenario starts predator-free (founders
seeded filterer-side, as the rejected `diet baseline −1.4` run showed how to
do), runs quiet for N generations, then fires a plankton crash. Assert: mean
expressed diet and attack SD both rise significantly in the post-crash window
versus the pre-crash baseline, and in ≥1/3 replicates the predator guild
(diet > 0.5) reappears and persists 50 generations. This is the probe that
certifies the headline moment.

## Work packages (post-Gate A-2)

| WP | Scope | Owns | Acceptance |
|---|---|---|---|
| D0 (orchestrator) | Contracts: `disturbance` + `carrion` config blocks, `disturbance` SimEvent, carrion field in state/snapshot, `dietEfficiencyCarrion` in formulas.ts | `src/contracts/**` | typecheck + existing suite green |
| D1 (Opus) | Disturbance scheduler + thermal jump + plankton crash + kelp storm | `src/sim/ecology/**` | P15 scenario runs; P1 restore green |
| D2 (Opus) | Carrion field deposit/decay + scavenging intake | `src/sim/ecology/**` (sequenced after D1, same owner is fine) | P16 scenario runs; P7 re-measured |
| D3 (Opus) | P15 + P16 probes, scenarios, recorder series (carrion biomass, shock annotations) | `src/probes/**`, `src/stats/**` | probe:quick green with new probes at warn |
| D4 (Opus) | HUD: event-feed lines for shocks, shock markers on trend charts | `src/app/**` | browser check |
| D5 | Mini tuning campaign: shock rates/magnitudes, carrion economics; cliff-screen every knob at 45 gens × 3 seeds first | config defaults + tuning log | spec-length runs, thresholds ratcheted |

D1/D2 conflict with D3 nowhere; D4 is disjoint. The founding transient rule
applies to every new knob — cliff-screen before spec runs, always.

## Open questions parked for Gate A-2's rulings

- If Sol rules defense/speed pricing a leak and the fix reprices traits, the
  arms-race dynamics change and D5's targets move — hence the sequencing.
- Whether P9's guild-persistence criterion should, after this lands, be
  restated as "persists OR re-evolves within K generations" — the deep-time
  watches argue extinction-and-rebirth is the more interesting equilibrium,
  and demanding permanent persistence may overtune against the very dynamics
  the disturbance regime creates.
