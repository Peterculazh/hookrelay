// Executed inside the relay container by smoke-worker-crash.mjs, not directly.
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { Queue } from 'bullmq';

const input = createInterface({ input: process.stdin });
const replies = input[Symbol.asyncIterator]();
async function control(command) {
  console.log(`CONTROL:${command}`);
  const reply = await replies.next();
  assert.equal(reply.value, 'OK', `Host failed to ${command}`);
}
// A disconnected host must not leave a permanent advisory lock behind.
const watchdog = setTimeout(() => process.exit(1), 300_000);
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'true',
  connectionTimeoutMillis: 5000,
  query_timeout: 5000,
});
const queue = new Queue('events', {
  connection: {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    db: Number(process.env.REDIS_DB ?? 0),
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
  },
});
const key = randomInt(1, 2 ** 30);
let holder;
let trigger;
let eventId;

async function until(description, check, timeout = 30_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await check()) {
      console.log(`PASS: ${description}`);
      return;
    }
    await sleep(250);
  }
  throw new Error(`Timed out: ${description}; event ${eventId}`);
}
async function state() {
  const event = (
    await pool.query('SELECT status, delivered_at FROM events WHERE id = $1', [
      eventId,
    ])
  ).rows[0];
  const attempts = (
    await pool.query(
      'SELECT id, status, finished_at, http_status, error_code FROM delivery_attempts WHERE event_id = $1 ORDER BY started_at, id',
      [eventId],
    )
  ).rows;
  const effects = (
    await pool.query('SELECT id FROM receiver_effects WHERE event_id = $1', [
      eventId,
    ])
  ).rows;
  const markers = (
    await pool.query(
      'SELECT event_id FROM received_events WHERE event_id = $1',
      [eventId],
    )
  ).rows;
  return { event, attempts, effects, markers };
}
try {
  const response = await fetch('http://hookrelay:3000/v1/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'worker.crash.test',
      payload: { source: 'smoke-worker-crash' },
    }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 202);
  eventId = (await response.json()).id;
  assert.match(eventId, /^[0-9a-f-]{36}$/);
  console.log(`Worker ${mode} test event: ${eventId}`);
  trigger = `worker_crash_${eventId.replaceAll('-', '')}`;
  holder = await pool.connect();
  await holder.query('SELECT pg_advisory_lock($1::bigint)', [key]);
  await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(${key}::bigint); RETURN NEW; END; $$`);
  await pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON delivery_attempts
    FOR EACH ROW WHEN (NEW.event_id = '${eventId}'::uuid AND NEW.status = 'succeeded')
    EXECUTE FUNCTION ${trigger}()`);

  await control('START');
  await until(
    'worker reached success persistence after receiver acceptance',
    async () => {
      const locks = await pool.query(
        `SELECT pid FROM pg_locks WHERE locktype = 'advisory'
      AND classid = 0 AND objid = $1::oid AND objsubid = 1 AND NOT granted`,
        [key],
      );
      return locks.rowCount === 1;
    },
  );
  const before = await state();
  assert.equal(before.event.status, 'pending');
  assert.equal(before.event.delivered_at, null);
  assert.equal(before.attempts.length, 1);
  assert.equal(before.attempts[0].status, 'in_progress');
  assert.equal(before.attempts[0].finished_at, null);
  assert.equal(before.effects.length, 1);
  assert.equal(before.markers.length, 1);
  console.log(
    'PASS: receiver effect committed while event and attempt remain unfinished',
  );

  let queuedId;
  if (mode === 'shutdown') {
    const queued = await fetch('http://hookrelay:3000/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'worker.shutdown.queued', payload: {} }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(queued.status, 202);
    queuedId = (await queued.json()).id;
    await until(
      'second event is queued behind the active delivery',
      async () =>
        (await (await queue.getJob(queuedId))?.getState()) === 'waiting',
    );
    await control('TERM');
    assert.deepEqual(
      await state(),
      before,
      'Shutdown must wait for active persistence',
    );
    await holder.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
    await control('STOPPED');
    const drained = await state();
    assert.equal(drained.event.status, 'delivered');
    assert.equal(drained.attempts.length, 1);
    assert.equal(drained.attempts[0].status, 'succeeded');
    assert.equal(drained.attempts[0].http_status, 204);
    assert.deepEqual(drained.effects, before.effects);
    assert.equal(await (await queue.getJob(eventId)).getState(), 'completed');
    assert.equal(await (await queue.getJob(queuedId)).getState(), 'waiting');
    assert.equal(
      (
        await pool.query(
          'SELECT id FROM delivery_attempts WHERE event_id = $1',
          [queuedId],
        )
      ).rowCount,
      0,
    );
    await control('START');
    await until(
      'queued work resumes after graceful restart',
      async () =>
        (await (await queue.getJob(queuedId))?.getState()) === 'completed',
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM receiver_effects WHERE event_id = $1',
          [queuedId],
        )
      ).rows[0].count,
      1,
    );
    console.log(
      'PASS: active delivery drained, no next job taken during shutdown, queued work recovered',
    );
  } else {
    await control('KILL');
    // Release after confirmed process death so PostgreSQL can finish the blocked
    // statement, notice the disconnected client, and roll back its transaction.
    await holder.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
    await until('SIGKILL closes the blocked worker transaction', async () => {
      const locks = await pool.query(
        `SELECT pid FROM pg_locks WHERE locktype = 'advisory'
      AND classid = 0 AND objid = $1::oid AND objsubid = 1 AND NOT granted`,
        [key],
      );
      return locks.rowCount === 0;
    });
    assert.deepEqual(
      await state(),
      before,
      'Crash must not persist a successful attempt',
    );
    if (mode === 'exhaustion') {
      await holder.query('SELECT pg_advisory_lock($1::bigint)', [key]);
      await control('START');
      await until(
        'recovered execution reaches persistence before second crash',
        async () => {
          const locks = await pool.query(
            `SELECT pid FROM pg_locks WHERE locktype = 'advisory'
        AND classid = 0 AND objid = $1::oid AND objsubid = 1 AND NOT granted`,
            [key],
          );
          return locks.rowCount === 1;
        },
        150_000,
      );
      const retry = await state();
      assert.equal(retry.attempts.length, 2);
      assert.equal(retry.attempts[0].error_code, 'INTERRUPTED');
      await control('KILL');
      await holder.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
    }
    await pool.query(`DROP TRIGGER ${trigger} ON delivery_attempts`);
    await pool.query(`DROP FUNCTION ${trigger}()`);
    trigger = undefined;
    await control('START');

    // Default BullMQ lock duration and stalled interval are both 30 seconds.
    // Recover naturally: do not manually retry, re-add, or remove the job.
    await until(
      mode === 'exhaustion'
        ? 'BullMQ exhausts stalled recovery and the relay reconciles the event'
        : 'BullMQ recovers the stalled job and delivery completes',
      async () => {
        const job = await queue.getJob(eventId);
        return (
          (await state()).event.status ===
            (mode === 'exhaustion' ? 'failed' : 'delivered') &&
          job &&
          (await job.getState()) ===
            (mode === 'exhaustion' ? 'failed' : 'completed')
        );
      },
      150_000,
    );
    const after = await state();
    assert.equal(after.attempts.length, 2);
    const interrupted = after.attempts.find(
      (row) => row.id === before.attempts[0].id,
    );
    assert.equal(interrupted.status, 'failed');
    assert.equal(interrupted.error_code, 'INTERRUPTED');
    assert.equal(interrupted.http_status, null);
    assert.ok(interrupted.finished_at);
    const success = after.attempts.find(
      (row) => row.id !== before.attempts[0].id,
    );
    assert.equal(
      success.status,
      mode === 'exhaustion' ? 'failed' : 'succeeded',
    );
    assert.equal(success.http_status, mode === 'exhaustion' ? null : 204);
    assert.equal(
      success.error_code,
      mode === 'exhaustion' ? 'INTERRUPTED' : null,
    );
    assert.ok(success.finished_at);
    if (mode === 'exhaustion') assert.equal(after.event.delivered_at, null);
    else assert.ok(after.event.delivered_at);
    assert.deepEqual(
      after.effects,
      before.effects,
      'No second effect or replacement effect',
    );
    assert.equal(after.markers.length, 1);
    const job = await queue.getJob(eventId);
    assert.ok(
      job.stalledCounter >= 1,
      'Recovery must be a BullMQ stalled-job recovery',
    );
    console.log(
      `PASS: two delivery executions, one durable receiver effect, ${mode === 'exhaustion' ? 'failed' : 'completed'} queue job`,
    );
    console.log(
      `PASS: interrupted attempts reconciled with unknown receiver outcome; no unfinished attempts`,
    );
  }
} finally {
  if (holder) {
    await holder.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
    holder.release();
  }
  if (trigger) {
    await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON delivery_attempts`);
    await pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
  }
  await queue.close();
  await pool.end();
  input.close();
  clearTimeout(watchdog);
  console.log(
    `Retained event and attempt history for inspection: ${eventId ?? '(not created)'}`,
  );
}
