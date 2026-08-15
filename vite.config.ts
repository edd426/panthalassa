import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // pixi.js must live in its own chunk. main.ts holds a top-level await
        // (the async renderer boot); with pixi-core bundled into the index
        // chunk, Pixi's dynamically imported renderer backends depend on a
        // chunk that cannot finish evaluating until that await resolves —
        // which is itself waiting on the backend import. The production-only
        // deadlock presented as `Application.init` timing out for every
        // backend while the dev server (unbundled modules) worked fine.
        manualChunks: { pixi: ['pixi.js'] },
      },
    },
  },
  worker: {
    format: 'es',
  },
});
