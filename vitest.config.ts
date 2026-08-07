import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The sim core is dependency-free and must run headless; no jsdom anywhere
    // in Phase A. Presentation tests (Phase B) get their own environment.
    environment: 'node',
    // Statistical RNG tests draw 100k+ samples; the default 5s can be tight on
    // a cold JIT.
    testTimeout: 30_000,
  },
});
