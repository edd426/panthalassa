/**
 * The probe CLI entry point. `scripts/probe.mjs` imports this module for its
 * side effect, so landing this file is what turns `npm run probe*` on — nobody
 * has to edit `package.json`.
 *
 * ```
 * npm run probe:quick
 * npm run probe:full
 * npm run probe -- --scenario=barrier --seed=s1
 * npm run probe -- --scenario=no-mutation --generations=300 --seeds=s1,s2,s3
 * ```
 *
 * The exit code is the suite's verdict: non-zero when a `gate` probe failed.
 * Warn-severity breaches print yellow and exit 0, which is the whole point of
 * the severity split while the model is untuned.
 *
 * Everything except the side effect lives in `cli.ts`, so that tests can drive
 * the argument parser without starting a suite.
 */

import { main } from './cli';

process.exitCode = main(process.argv.slice(2));
