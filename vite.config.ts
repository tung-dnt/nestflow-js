import { defineConfig } from 'vite-plus';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  oxc: {
    decorator: { legacy: true, emitDecoratorMetadata: true },
  },
  fmt: {
    singleQuote: true,
    printWidth: 120,
  },
  lint: {
    plugins: ['typescript'],
    rules: { 'typescript/no-floating-promises': 'error' },
    options: { typeAware: true },
  },
  test: {
    include: ['test/**/*.spec.ts'],
    setupFiles: ['reflect-metadata'],
    pool: 'threads',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
