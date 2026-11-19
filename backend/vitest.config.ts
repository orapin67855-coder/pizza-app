import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // PGlite boots a real Postgres in WASM; give the first start some room
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
