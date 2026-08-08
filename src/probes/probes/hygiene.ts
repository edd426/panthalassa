/**
 * P2 — RNG hygiene. A gate from day one.
 *
 * ESLint is the authoritative enforcement (see the determinism block in
 * `eslint.config.js`, which CI runs with `--max-warnings=0`). This probe scans
 * the same file set for the same tokens so that a probe run reports the
 * invariant's state without shelling out to a linter, and so that the suite
 * table has a row for it — the plan's probe table lists P2, and a probe nobody
 * can see the result of is not doing its job.
 *
 * The scan is a substring match, so it is strictly more conservative than the
 * lint rule: a banned token inside a comment or a string counts. That is the
 * right direction to be wrong in for a gate.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import type { ProbeReport } from '../../contracts/stats';
import type { ProbeDefinition } from '../probe';
import { makeReport } from '../probe';

/** The directories CLAUDE.md names as bound by the determinism invariant. */
const SCANNED_DIRECTORIES = ['sim', 'stats', 'probes', 'contracts'];

/**
 * The single sanctioned exception: P12 has to read a clock. Every other file in
 * the scanned tree is forbidden one.
 */
const EXEMPT_FILES = ['probes/timing.ts'];

/**
 * Banned member expressions, held split so that this file — which the scan
 * covers, like every other file under `src/probes` — does not contain the
 * tokens it is looking for and report itself.
 */
const BANNED_MEMBERS: readonly (readonly [string, string])[] = [
  ['Math', 'random'],
  ['Date', 'now'],
  ['performance', 'now'],
  ['crypto', 'randomUUID'],
  ['crypto', 'getRandomValues'],
];

/** A `Date` construction, assembled at runtime for the same reason. */
const BANNED_CONSTRUCTOR = new RegExp(['new', '\\s+', 'Date', '\\s*', '\\('].join(''));

/** What the report calls a hit on {@link BANNED_CONSTRUCTOR}, spelled so this file does not match itself. */
const BANNED_CONSTRUCTOR_LABEL = ['new', 'Date()'].join(' ');

export interface HygieneViolation {
  readonly file: string;
  readonly line: number;
  readonly token: string;
}

function sourceRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

function collectFiles(root: string, relative: string, out: string[]): void {
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) collectFiles(root, path, out);
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
}

export function scanForBannedEntropy(): HygieneViolation[] {
  const root = sourceRoot();
  const files: string[] = [];
  for (const directory of SCANNED_DIRECTORIES) collectFiles(root, directory, files);

  const violations: HygieneViolation[] = [];
  for (const file of files) {
    if (EXEMPT_FILES.includes(file)) continue;
    const lines = readFileSync(join(root, file), 'utf8').split('\n');
    lines.forEach((text, index) => {
      for (const [object, property] of BANNED_MEMBERS) {
        const token = `${object}.${property}`;
        if (text.includes(token)) violations.push({ file, line: index + 1, token });
      }
      if (BANNED_CONSTRUCTOR.test(text)) violations.push({ file, line: index + 1, token: BANNED_CONSTRUCTOR_LABEL });
    });
  }
  return violations;
}

export function evaluateHygiene(seed: string): ProbeReport {
  const violations = scanForBannedEntropy();
  const detail =
    violations.length === 0
      ? `${SCANNED_DIRECTORIES.map((directory) => `src/${directory}`).join(', ')} clean; only src/${EXEMPT_FILES[0]} may read a clock`
      : violations.map((violation) => `${violation.file}:${violation.line} ${violation.token}`).join(', ');

  return makeReport({
    probeId: 'P2',
    name: 'RNG hygiene',
    scenario: 'static',
    seed,
    severity: 'gate',
    value: violations.length,
    threshold: { max: 0, label: 'banned entropy/clock references = 0' },
    generationsRun: 0,
    detail,
  });
}

export const hygieneProbe: ProbeDefinition = {
  id: 'P2',
  name: 'RNG hygiene',
  scenario: 'static',
  severity: 'gate',
  standalone: true,
  evaluate(_runs, context) {
    const seed = context.runs[0]?.seed ?? 'static';
    return [evaluateHygiene(seed)];
  },
};
