import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: ['src/*.ts'],
    target: 'es2022',
    fixedExtension: false,
    unbundle: true,
  },
});
