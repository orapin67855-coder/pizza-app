import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'PizzaCore',
      formats: ['es', 'iife'],
      fileName: (format) => (format === 'es' ? 'pizza-core.js' : 'pizza-core.iife.js'),
    },
    sourcemap: true,
    target: 'es2022',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
