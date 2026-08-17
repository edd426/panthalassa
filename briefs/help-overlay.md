# X2 — the help overlay (`h`)

## Why

The experiment bench (godTools.ts, toggled with `g`) already carries every
interaction the user asked for — walls with a permeability slider, meteor,
plankton crash, thermal shock, climate ramp, founding cohorts — but the user
could not find any of it. The HUD key legend (`hud.ts` `KEY_BINDINGS`) does not
even list `g`, and its own comment says "a binding missing from this list is a
feature that does not exist." That is the bug being fixed: discoverability.

## Deliverable

A help overlay toggled with `h`, in `src/app/`, that documents **every**
control the app answers to:

1. **Global keys** — read them out of `main.ts`'s keydown handler, do not
   invent: `space` pause, `1–9` sim speed, `f` field overlay, `c` colour mode,
   `t` trends, `g` experiment bench, `h` this help, `Esc` cancel armed tool /
   close help, `r` reseed (only after extinction), wheel zoom, drag pan,
   dbl-click / `0` fit, click inspect.
2. **The experiment bench workflow** — read `godTools.ts` and describe what is
   actually there, per tool: how to raise a wall (press `g`, arm the wall tool,
   click two points; the long axis picks the wall direction; permeability
   slider = fraction of open water; lower/clear), meteor (arm + click, radius
   setting), plankton crash (global vs regional), thermal shock presets,
   climate target, founding-cohort / mutant introduction. One line each on
   *what the experiment shows* (e.g. wall off two halves, let them diverge,
   drop the wall).

## Files

- New: `src/app/helpOverlay.ts` (or similar) — DOM + toggle logic. Pure
  presentation; a static overlay needs no separate model, so a test file is
  optional — add one only if you put non-trivial logic in it.
- `src/app/main.ts` — wire `h` into the keydown handler. It must work in the
  extinction branch too (reading the manual on a dead ocean is fine). `Esc`
  closes the help overlay **first** if open, else falls through to
  `bench.cancelArmed()` as today. `h` must not fire while typing in an input
  (the bench has sliders/selects — follow the existing guard pattern if there
  is one, else check `event.target`).
- `src/app/hud.ts` — add `['h', 'help']` to `KEY_BINDINGS`, and add the
  missing `['g', 'bench']` entry while you are there.
- `index.html` — style block additions only if needed; use the existing
  `:root` tokens (station-log register: small-caps letter-spaced labels, mono
  data, `--phosphor` accents, hairline rules). Match the bench's visual
  language (`gt-*` classes are a reference, use your own prefix).

## Constraints

- Presentation only: no sim RNG, no worker protocol changes, no `SimCommand`
  additions. Wall-clock time is legal here.
- Do not touch anything outside `src/app/` and `index.html`.
- Do not rename DOM ids, HudModel fields, or existing key behaviour.
- Content accuracy over completeness of prose: every claim in the overlay must
  correspond to something the code actually does. If a bench tool's behaviour
  is unclear, read the tool's handler, don't guess.
- Comments follow house style: constraints and non-obvious why only.

## Acceptance probe (machine-checkable)

All must pass, run exactly as written (capture exit codes directly, never
through a pipe):

```
npm run build > /tmp/x2-build.log 2>&1; echo "build=$?"
npm run lint  > /tmp/x2-lint.log  2>&1; echo "lint=$?"
npm test      > /tmp/x2-test.log  2>&1; echo "test=$?"
grep -c "'h'" src/app/main.ts        # ≥ 1
grep -c "help" src/app/hud.ts        # ≥ 1 (legend entry)
test -f src/app/helpOverlay.ts && echo exists
```

All three exit codes 0; both greps non-zero; file exists. Report the actual
exit codes and grep outputs in your final message. Do not commit — the
orchestrator reviews the diff and commits.
