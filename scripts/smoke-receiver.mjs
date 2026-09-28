import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Execute from the host against an already migrated Compose stack. The receiver
// stays internal; HTTP and SQL checks run inside its container using its env.
const composeArgs = [
  'compose',
  '-f',
  process.env.RECEIVER_COMPOSE_FILE ?? 'docker-compose.yml',
];
if (process.env.RECEIVER_COMPOSE_PROJECT)
  composeArgs.push('-p', process.env.RECEIVER_COMPOSE_PROJECT);
const compose = (...args) =>
  execFileSync('docker', [...composeArgs, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });
const ids = Array.from({ length: 4 }, () => randomUUID());

async function check(stage, ids) {
  const { default: assert } = await import('node:assert/strict');
  const { Pool } = await import('pg');
  const { setTimeout: sleep } = await import('node:timers/promises');
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    ssl: process.env.DB_SSL === 'true',
  });
  const url = 'http://127.0.0.1:3001';
  const event = (id) => ({
    id,
    type: 'receiver.test',
    payload: { orderId: id, amount: 100 },
  });
  async function send(body) {
    const response = await fetch(`${url}/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    await response.text();
    return response.status;
  }
  async function counts(id, expected) {
    for (const table of ['received_events', 'receiver_effects']) {
      const result = await pool.query(
        `SELECT count(*)::int AS count FROM ${table} WHERE event_id = $1`,
        [id],
      );
      assert.equal(result.rows[0].count, expected, `${table}: ${id}`);
    }
  }
  try {
    if (stage === 'cleanup') {
      await pool.query(
        'DELETE FROM receiver_effects WHERE event_id = ANY($1::uuid[])',
        [ids],
      );
      await pool.query(
        'DELETE FROM received_events WHERE event_id = ANY($1::uuid[])',
        [ids],
      );
      return;
    }
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(1000),
        });
        await response.text();
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        /* Receiver may still be starting after restart. */
      }
      await sleep(500);
    }
    assert.ok(ready, 'Receiver must be ready');
    if (stage === 'restart') {
      for (const id of ids.slice(0, 3)) {
        assert.equal(await send(event(id)), 204);
        await counts(id, 1);
      }
      console.log('PASS: deduplication survives receiver restart');
      return;
    }

    assert.equal(await send(event(ids[0])), 204);
    assert.equal(await send(event(ids[0])), 204);
    // Event ID is the identity; the first committed payload remains authoritative.
    assert.equal(
      await send({ ...event(ids[0]), payload: { amount: 999 } }),
      204,
    );
    await counts(ids[0], 1);
    const effect = await pool.query(
      'SELECT payload FROM receiver_effects WHERE event_id = $1',
      [ids[0]],
    );
    assert.deepEqual(effect.rows[0].payload, event(ids[0]).payload);
    console.log(
      'PASS: sequential duplicates create one effect and preserve the first payload',
    );

    const responses = await Promise.all(
      Array.from({ length: 12 }, () => send(event(ids[1]))),
    );
    assert.ok(
      responses.every((status) => status === 204),
      JSON.stringify(responses),
    );
    await counts(ids[1], 1);
    console.log('PASS: 12 concurrent duplicates create one effect');

    for (const invalid of [
      null,
      {},
      { ...event(ids[3]), id: 'invalid' },
      { id: ids[3], type: 'receiver.test' },
      { ...event(ids[3]), type: '' },
    ]) {
      assert.equal(await send(invalid), 400);
    }
    await counts(ids[3], 0);
    console.log('PASS: malformed events return 400 without persistence');

    // Test-only, event-scoped deferred trigger: fail COMMIT after both INSERTs.
    // No fault-injection switch or endpoint is added to the application.
    const name = `receiver_smoke_${ids[2].replaceAll('-', '')}`;
    try {
      await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'receiver smoke forced commit failure'; END; $$`);
      await pool.query(`CREATE CONSTRAINT TRIGGER ${name}
        AFTER INSERT ON receiver_effects DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW WHEN (NEW.event_id = '${ids[2]}'::uuid) EXECUTE FUNCTION ${name}()`);
      assert.equal(await send(event(ids[2])), 500);
      await counts(ids[2], 0);
      console.log(
        'PASS: commit failure returns 500 and rolls back marker and effect',
      );
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${name} ON receiver_effects`);
      await pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
    }
    assert.equal(await send(event(ids[2])), 204);
    await counts(ids[2], 1);
    console.log('PASS: retry after rollback applies the effect');
  } finally {
    await pool.end();
  }
}

function run(stage) {
  const source = `await (${check.toString()})(${JSON.stringify(stage)}, ${JSON.stringify(ids)});`;
  const output = execFileSync(
    'docker',
    [
      ...composeArgs,
      'exec',
      '-T',
      'test-receiver',
      'node',
      '--input-type=module',
      '-',
    ],
    {
      input: source,
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  process.stdout.write(output);
}

try {
  run('initial');
  compose('restart', 'test-receiver');
  run('restart');
} finally {
  run('cleanup');
}
