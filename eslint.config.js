import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Determinism ban list. The sim, the stats layer and the probe suite must be a
 * pure function of (config, seed): every random draw comes from a SeededRng and
 * every clock reading comes from the tick counter. Presentation code (src/app,
 * src/render, src/ui) is free to use wall-clock time and Math.random for
 * animation jitter, because it never feeds anything back into the sim.
 */
const DETERMINISM_MESSAGE =
  'Determinism invariant: sim/stats/probes/contracts may not read nondeterministic sources. Use SeededRng for randomness and SimState.tick for time.';

const restrictedProperties = [
  { object: 'Math', property: 'random', message: DETERMINISM_MESSAGE },
  { object: 'Date', property: 'now', message: DETERMINISM_MESSAGE },
  { object: 'performance', property: 'now', message: DETERMINISM_MESSAGE },
  { object: 'performance', property: 'timeOrigin', message: DETERMINISM_MESSAGE },
  { object: 'process', property: 'hrtime', message: DETERMINISM_MESSAGE },
  { object: 'process', property: 'uptime', message: DETERMINISM_MESSAGE },
  { object: 'console', property: 'time', message: DETERMINISM_MESSAGE },
  { object: 'console', property: 'timeEnd', message: DETERMINISM_MESSAGE },
  { object: 'console', property: 'timeLog', message: DETERMINISM_MESSAGE },
  { object: 'crypto', property: 'randomUUID', message: DETERMINISM_MESSAGE },
  { object: 'crypto', property: 'getRandomValues', message: DETERMINISM_MESSAGE },
];

const cryptoRandomImports = [
  'getRandomValues',
  'pseudoRandomBytes',
  'randomBytes',
  'randomFill',
  'randomFillSync',
  'randomInt',
  'randomUUID',
];

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules', 'runs', 'test-results'] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map((config) => ({ ...config, files: ['**/*.ts'] })),
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
    },
  },
  {
    // The determinism ban. Keep this file list in sync with CLAUDE.md.
    files: ['src/sim/**/*.ts', 'src/stats/**/*.ts', 'src/probes/**/*.ts', 'src/contracts/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: DETERMINISM_MESSAGE },
        { name: 'performance', message: DETERMINISM_MESSAGE },
        { name: 'crypto', message: DETERMINISM_MESSAGE },
        { name: 'Temporal', message: DETERMINISM_MESSAGE },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: ['crypto', 'node:crypto'].map((name) => ({
            name,
            importNames: cryptoRandomImports,
            message: DETERMINISM_MESSAGE,
          })),
        },
      ],
      'no-restricted-properties': ['error', ...restrictedProperties],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date']", message: DETERMINISM_MESSAGE },
        {
          selector: "VariableDeclarator[init.name='Math'][id.type='ObjectPattern']",
          message: DETERMINISM_MESSAGE,
        },
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message: DETERMINISM_MESSAGE,
        },
      ],
    },
  },
  {
    // The single exception. P12 is a performance probe and has to read a clock.
    // All timing lives here, behind a helper; a wall-clock reading must never
    // flow back into the sim (it may only be reported).
    files: ['src/probes/timing.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-imports': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs', '*.config.js'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  },
);
