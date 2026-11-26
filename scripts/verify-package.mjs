import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { accessSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = join(root, '.cache');
mkdirSync(cache, { recursive: true });
const consumer = mkdtempSync(join(cache, 'pack-'));

try {
  execFileSync('pnpm', ['pack', '--pack-destination', consumer], { cwd: root });
  const archive = readdirSync(consumer).find((name) => name.endsWith('.tgz'));
  assert.ok(archive, 'pnpm pack did not emit an archive');
  const installed = join(consumer, 'node_modules', 'nestflow-js');
  mkdirSync(installed, { recursive: true });
  execFileSync('tar', ['-xzf', join(consumer, archive), '--strip-components', '1', '-C', installed]);

  const { name, exports } = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  const specifiers = [];
  for (const [subpath, target] of Object.entries(exports)) {
    if (typeof target === 'string') {
      accessSync(join(installed, target));
      continue;
    }
    for (const path of Object.values(target)) accessSync(join(installed, path));
    specifiers.push(`${name}${subpath.slice(1)}`);
  }
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { NestFactory } from '@nestjs/core';
    import { OrchestratorService, WorkflowModule } from 'nestflow-js/core';

    for (const specifier of process.argv.slice(1)) await import(specifier);
    const app = await NestFactory.createApplicationContext(
      WorkflowModule.register({ entities: [], workflows: [] }), { logger: false },
    );
    assert.ok(app.get(OrchestratorService) instanceof OrchestratorService);
    await app.close();
  `,
      ...specifiers,
    ],
    { cwd: consumer, stdio: 'inherit' },
  );
  console.log('Packed Nestflow exports loaded and Nest DI bootstrapped.');
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
