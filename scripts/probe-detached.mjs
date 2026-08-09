// Launches the probe runner in its own session so a supervisor killing the
// launching shell's process group cannot take the run with it. STATUS.md
// records two ~3-hour `probe:full` runs lost to exactly that (exit=143):
// an agent's polling loop timed out, SIGTERM went to the process group, and
// the suite died at hour two. macOS ships no setsid(1); `detached: true`
// makes the child a session leader, which is the same escape.
//
//   node scripts/probe-detached.mjs runs/full-<label>.log [probe args...]
//
// Prints the child pid and exits immediately. Watch the log to follow the
// run; `ps -p <pid>` to check liveness. LONG_SIM is inherited from the
// caller's environment, so prefix with LONG_SIM=1 for the full suite.
import { openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [, , logPath, ...probeArgs] = process.argv;
if (!logPath) {
  console.error('usage: node scripts/probe-detached.mjs <logfile> [-- probe args]');
  process.exit(2);
}

const log = openSync(logPath, 'a');
const runner = fileURLToPath(new URL('./probe.mjs', import.meta.url));
const child = spawn(process.execPath, ['--import', 'tsx', runner, ...probeArgs], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  detached: true,
  stdio: ['ignore', log, log],
  env: process.env,
});
child.unref();
console.log(`detached probe run: pid=${child.pid} log=${logPath}`);
console.log(`verify its own group: ps -o pid,pgid,command -p ${child.pid}`);
