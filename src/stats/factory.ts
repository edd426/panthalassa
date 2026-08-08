/**
 * The `StatsApi` factory WP-A5 injects into `createSim({ modules })`.
 *
 * Kept in its own file so `index.ts` can re-export the whole package without
 * `recorder.ts` and the estimator modules forming an import cycle through it.
 */

import { StatsRecorder } from './recorder';
import type { StatsOptions, StatsRecorderApi } from './recorder';

/**
 * Build the recorder. The config is all it needs — every other input arrives
 * through the `StatsApi` hooks or off `SimState`, so there is nothing for A5 to
 * wire beyond dropping the result into `createSim({ modules })`.
 */
export function createStats(options: StatsOptions): StatsRecorderApi {
  return new StatsRecorder(options);
}
