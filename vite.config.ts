import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: [
    {
      entry: {
        'core/index': 'packages/core/index.ts',
        'exception/index': 'packages/exception/index.ts',
        'adapter/index': 'packages/adapter/index.ts',
      },
      fixedExtension: false,
      dts: true,
      sourcemap: true,
    },
    ...['arktype', 'joi', 'valibot', 'zod'].map((name) => ({
      cwd: `packages/validator/${name}`,
      entry: ['index.ts'],
      fixedExtension: false,
      dts: true,
    })),
  ],
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
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    include: ['test/**/*.spec.ts'],
    setupFiles: ['reflect-metadata'],
    pool: 'threads',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
