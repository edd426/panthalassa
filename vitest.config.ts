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
    // The suite is CPU-bound sim code. The default forks pool oversubscribes
    // every core, starving the reporter process until a worker's onTaskUpdate
    // RPC times out — which fails a run with 222 green tests (or warns about
    // "false positive tests" and exits 0). Neither is acceptable for the
    // artifact this project treats as its definition of done, and sequential
    // costs ~nothing because determinism.test.ts dominates the wall clock
    // anyway. Diagnosed by WP-A5/A6, 2026-08-08.
    fileParallelism: false,
  },
});
