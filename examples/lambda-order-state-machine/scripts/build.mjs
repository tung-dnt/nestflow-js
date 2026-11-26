import { rmSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });

await build({
  entryPoints: ['.build/src/lambda.js'],
  outfile: 'dist/lambda.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node26',
  sourcemap: true,
  banner: { js: "import { createRequire as __nestflowRequire } from 'node:module'; const require = __nestflowRequire(import.meta.url);" },
  external: ['@nestjs/microservices', '@nestjs/platform-express', '@nestjs/websockets'],
});
