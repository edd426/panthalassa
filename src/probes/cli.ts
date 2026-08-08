/**
 * Argument parsing and the run-print-exit sequence, kept out of `runner.ts` so
 * that importing this logic does not start a probe suite.
 *
 * `scripts/probe.mjs` imports `runner.ts` for its side effect; anything that
 * wants to *test* the CLI imports this module instead.
 */

import { renderTable, writeArtifacts } from './report';
import { defaultSuiteOptions, runSuite } from './suite';
import type { SuiteName, SuiteOptions } from './suite';
import { scenarioNames } from './scenarios';

export interface ParsedArguments {
  readonly options: SuiteOptions;
  readonly help: boolean;
}

export const USAGE = `
Panthalassa probe runner

  --suite=quick|full     Named suite. Default: quick, or custom when --scenario is given.
  --scenario=NAME        Run one scenario (or a comma-separated list).
  --seed=SEED            One seed. --seeds=a,b,c for several.
  --generations=N        Override the scenario's own generation count.
  --probes=P4,P5         Evaluate only these probes. Default: all of them.
  --help                 This text.

Scenarios: ${scenarioNames().join(', ')}
`;

function readFlag(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const argument = argv[index];
    if (argument !== undefined && argument.startsWith(prefix)) return argument.slice(prefix.length);
  }
  return undefined;
}

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : undefined;
}

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const scenarios = splitList(readFlag(argv, 'scenario')) ?? splitList(readFlag(argv, 'scenarios'));
  const seeds = splitList(readFlag(argv, 'seeds')) ?? splitList(readFlag(argv, 'seed'));
  const requested = readFlag(argv, 'suite');
  const suite: SuiteName =
    requested === 'full' ? 'full' : requested === 'quick' ? 'quick' : scenarios === undefined ? 'quick' : 'custom';
  const defaults = defaultSuiteOptions(suite === 'custom' ? 'quick' : suite);
  const generations = readFlag(argv, 'generations');
  const probes = splitList(readFlag(argv, 'probes'))?.map((id) => id.toUpperCase());

  return {
    help: argv.includes('--help') || argv.includes('-h'),
    options: {
      suite,
      seeds: seeds ?? defaults.seeds,
      scenarios: scenarios ?? defaults.scenarios,
      ...(generations === undefined ? {} : { generations: Number(generations) }),
      ...(probes === undefined ? {} : { probes }),
      log: (message: string) => {
        console.log(message);
      },
    },
  };
}

export function main(argv: readonly string[]): number {
  const { options, help } = parseArguments(argv);
  if (help) {
    console.log(USAGE);
    return 0;
  }

  if (options.generations !== undefined && !Number.isFinite(options.generations)) {
    console.error(`--generations must be a number; got '${readFlag(argv, 'generations')}'.`);
    return 2;
  }

  if (options.suite === 'full' && process.env.LONG_SIM !== '1') {
    console.log('note: --suite=full without LONG_SIM=1. `npm run probe:full` sets it; running anyway.');
  }

  console.log(`probe suite '${options.suite}': ${options.scenarios.join(', ')} × seeds ${options.seeds.join(', ')}`);
  const { report, runs, skipped } = runSuite(options);
  const artifacts = writeArtifacts(report, runs);

  console.log(renderTable(report, skipped));
  console.log(`series: ${artifacts.seriesFiles.length} JSONL files in runs/`);
  console.log(`report: ${artifacts.reportFile}`);

  return report.status === 'fail' ? 1 : 0;
}
