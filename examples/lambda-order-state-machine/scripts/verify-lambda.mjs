import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const asset = mkdtempSync(join(tmpdir(), 'nestflow-lambda-'));
try {
  cpSync('dist', asset, { recursive: true });
  execFileSync(process.execPath, [
    '--no-experimental-require-module',
    '--no-experimental-detect-module',
    '--input-type=module',
    '-e',
    "import assert from 'node:assert/strict'; const { handler } = await import('./lambda.mjs'); assert.equal(typeof handler, 'function');",
  ], { cwd: asset, stdio: 'inherit' });
  console.log('Isolated Lambda handler loaded without experimental module features.');
} finally {
  rmSync(asset, { recursive: true, force: true });
}
