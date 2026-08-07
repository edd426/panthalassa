// Stable entry point for `npm run probe*`. The probe runner itself is WP-A5's
// artifact; this shim exists so that landing src/probes/runner.ts turns the
// scripts on without anyone editing package.json (which A5 does not own).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const runnerUrl = new URL('../src/probes/runner.ts', import.meta.url);

if (!existsSync(fileURLToPath(runnerUrl))) {
  console.error('probe runner not yet implemented (WP-A5): expected src/probes/runner.ts');
  process.exit(1);
}

await import(runnerUrl.href);
