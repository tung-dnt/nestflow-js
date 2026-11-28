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
  const specifiers = [];
  const validatorRoot = join(root, 'packages/validator');
  const directories = [root, ...readdirSync(validatorRoot).map((name) => join(validatorRoot, name))];
  const releaseVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  for (const cwd of directories) {
    const { name } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    const destination = join(consumer, 'archives', name);
    mkdirSync(destination, { recursive: true });
    execFileSync('pnpm', ['pack', '--pack-destination', destination], { cwd });
    const archive = readdirSync(destination).find((file) => file.endsWith('.tgz'));
    assert.ok(archive, `No npm archive for ${name}`);
    const installed = join(consumer, 'node_modules', name);
    mkdirSync(installed, { recursive: true });
    execFileSync('tar', ['-xzf', join(destination, archive), '--strip-components', '1', '-C', installed]);

    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    assert.equal(manifest.version, releaseVersion, `${name} version differs from core`);
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      if (typeof target === 'string') {
        accessSync(join(installed, target));
        continue;
      }
      for (const path of Object.values(target)) accessSync(join(installed, path));
      specifiers.push(`${name}${subpath.slice(1)}`);
    }
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
    import { zodPayloadValidator } from '@nestflow-js/validator-zod';
    import { valibotPayloadValidator } from '@nestflow-js/validator-valibot';
    import { arkTypePayloadValidator } from '@nestflow-js/validator-arktype';
    import { joiPayloadValidator } from '@nestflow-js/validator-joi';
    import { z } from 'zod';
    import * as v from 'valibot';
    import { type } from 'arktype';
    import Joi from 'joi';

    assert.equal(await zodPayloadValidator(z.coerce.number(), '42'), 42);
    assert.equal(await valibotPayloadValidator(v.pipe(v.string(), v.toNumber()), '42'), 42);
    assert.equal(await arkTypePayloadValidator(type('string.numeric.parse'), '42'), 42);
    assert.equal(await joiPayloadValidator(Joi.number(), '42'), 42);

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
  console.log('Packed core and all four npm validator plugins loaded and validated; Nest DI bootstrapped.');
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
