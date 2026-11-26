import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const testUrl = process.env.TEST_DATABASE_URL;
assert(testUrl, 'Set TEST_DATABASE_URL to a disposable PostgreSQL database with CREATE SCHEMA permissions');
const schema = `nestflow_smoke_${randomUUID().replaceAll('-', '')}`;
const scopedUrl = new URL(testUrl);
scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
const admin = new pg.Client({ connectionString: testUrl });
const db = new pg.Client({ connectionString: scopedUrl.href });
const directory = mkdtempSync(join(tmpdir(), 'nestflow-broker-'));

function worker(script, expectedSignal = null) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { setTimeout } from 'node:timers/promises';
    import { closeApp, consume, createOrder, dispatchOne } from './dist/app.js';
    import { PostgresOrderStore } from './dist/store.js';

    const directory = process.env.NESTFLOW_SMOKE_DIR;
    const read = (name) => JSON.parse(readFileSync(join(directory, name), 'utf8'));
    const write = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value), { flush: true });
    const crash = async () => {
      await new Promise(resolve => process.stdout.write('', resolve));
      process.kill(process.pid, 'SIGKILL');
    };
    try {
      ${script}
    } finally {
      await closeApp();
    }
  `], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, DATABASE_URL: scopedUrl.href, NESTFLOW_SMOKE_DIR: directory },
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  const diagnostic = result.stdout + result.stderr;
  assert.equal(result.signal, expectedSignal, diagnostic);
  assert.equal(result.status, expectedSignal ? null : 0, diagnostic);
  return result.stdout;
}

function read(name) {
  return JSON.parse(readFileSync(join(directory, name), 'utf8'));
}

async function status(urn) {
  const { rows: [order] } = await db.query('SELECT status FROM workflow_orders WHERE id = $1', [urn]);
  return order?.status;
}

async function verify() {
  const submit = worker(`
    const [urn, otherUrn] = await Promise.all([createOrder(), createOrder()]);
    assert.notEqual(urn, otherUrn);
    const event = { event: 'order.submit', urn, eventId: 'smoke-submit', attempt: 0 };
    write('input.json', event);
    await consume(event);
    await crash();
  `, 'SIGKILL');
  const input = read('input.json');
  assert.equal(await status(input.urn), 'submitted');

  const firstPublish = worker(`
    const input = read('input.json');
    const store = new PostgresOrderStore();
    try {
      const holder = await store.claimTransition(input.urn, 'smoke-lock-holder');
      assert.equal(holder.kind, 'acquired');
      try {
        const contender = await store.claimTransition(input.urn, 'smoke-lock-contender');
        assert.deepEqual(contender, { kind: 'busy' });
        const replay = await store.claimTransition(input.urn, input.eventId);
        assert.equal(replay.kind, 'completed');
      } finally {
        await holder.release();
      }
    } finally {
      await store.onApplicationShutdown();
    }
    await Promise.all([consume(input), consume(input)]);
    await dispatchOne(async (event) => {
      write('first-publish.json', event);
      await crash();
    });
  `, 'SIGKILL');
  const firstEvent = read('first-publish.json');
  assert.equal(firstEvent.event, 'order.finish');
  assert.equal(firstEvent.urn, input.urn);
  assert.deepEqual(firstEvent.payload, { orderId: input.urn });
  assert(typeof firstEvent.eventId === 'string' && firstEvent.eventId.length > 0);
  assert.notEqual(firstEvent.eventId, input.eventId);
  assert.equal(await status(input.urn), 'submitted');

  const finish = worker(`await consume(read('first-publish.json'));`);
  assert.equal(await status(input.urn), 'finished');

  const redelivery = worker(`
    const deadline = performance.now() + 10_000;
    let published;
    while (!published && performance.now() < deadline) {
      await dispatchOne(async (event) => {
        write('second-publish.json', event);
        published = event;
      });
      if (!published) await setTimeout(50);
    }
    assert(published, 'The published but unacknowledged event must become available again');
    await consume(published);
    const unexpectedPublish = async () => assert.fail('A final order produced another event');
    await dispatchOne(unexpectedPublish);
    assert.equal(await dispatchOne(unexpectedPublish), false);
  `);
  assert.deepEqual(read('second-publish.json'), firstEvent);
  assert.equal(await status(input.urn), 'finished');
  const output = submit + firstPublish + finish + redelivery;
  assert.equal(output.split(`Submitted order ${input.urn}`).length - 1, 1);
  assert.equal(output.split(`Finished order ${input.urn}`).length - 1, 1);
}

try {
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    await db.connect();
    const { rows: [scope] } = await db.query('SELECT current_schema()');
    assert.equal(scope.current_schema, schema);
    await db.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    await verify();
  } finally {
    try {
      await db.end();
    } finally {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    }
  }
} finally {
  try {
    await admin.end();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

console.log('PostgreSQL crash recovery and duplicate delivery verified.');
