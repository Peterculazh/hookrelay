import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

// This acceptance test intentionally changes replicas and replaces Pods.
// Pin the local learning cluster rather than using kubectl's current context.
const run = promisify(execFile);
const args = ['--context', 'docker-desktop', '--namespace', 'hookrelay'];
async function kubectl(...command) {
  const { stdout } = await run('kubectl', [...args, ...command], {
    encoding: 'utf8',
    timeout: 200_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}
async function resource(...command) {
  return JSON.parse(await kubectl('get', ...command, '-o', 'json'));
}
async function until(description, check, timeout = 180_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await check()) {
      console.log(`PASS: ${description}`);
      return;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out: ${description}`);
}
function ready(pod) {
  return (
    !pod.metadata.deletionTimestamp &&
    pod.status.conditions?.some(
      (condition) => condition.type === 'Ready' && condition.status === 'True',
    )
  );
}
async function pods(app) {
  return (await resource('pods', '-l', `app=${app}`)).items;
}
async function scale(count) {
  await kubectl('scale', 'deployment/worker', `--replicas=${count}`);
  await until(`${count} worker Pods ready`, async () => {
    const current = await pods('worker');
    return current.length === count && current.every(ready);
  });
}
async function replacePod(pod, app, expectedCount) {
  await kubectl('delete', 'pod', pod.metadata.name, '--wait=false');
  await until(`${app} Pod replaced and ready`, async () => {
    const current = await pods(app);
    return (
      current.length === expectedCount &&
      current.every(ready) &&
      current.every((item) => item.metadata.uid !== pod.metadata.uid)
    );
  });
}

// Run from the relay's internal network; credentials stay inside the Pod.
async function probe(operation, input) {
  const source = `
    import { Pool } from 'pg';
    import { Queue } from 'bullmq';
    const input = JSON.parse(process.argv[1]);
    const pool = new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
      user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
      ssl: process.env.DB_SSL === 'true', connectionTimeoutMillis: 5000, query_timeout: 5000 });
    const queue = new Queue('events', { connection: { host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT), db: Number(process.env.REDIS_DB ?? 0),
      maxRetriesPerRequest: 1, connectTimeout: 5000 } });
    try {
      const result = await (async () => { ${operation} })();
      console.log(JSON.stringify(result));
    } finally { await queue.close(); await pool.end(); }
  `;
  return JSON.parse(
    await kubectl(
      'exec',
      'deployment/relay',
      '--',
      'node',
      '--input-type=module',
      '-e',
      source,
      JSON.stringify(input),
    ),
  );
}
async function submit(count) {
  return probe(
    `
    return Promise.all(Array.from({ length: input }, async (_, index) => {
      const response = await fetch('http://hookrelay:3000/v1/events', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'kubernetes.acceptance', payload: { index } }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.status !== 202) throw new Error('Event rejected: ' + response.status);
      return (await response.json()).id;
    }));
  `,
    count,
  );
}
async function batchState(ids) {
  return probe(
    `
    const events = (await pool.query('SELECT id, status FROM events WHERE id = ANY($1::uuid[])', [input])).rows;
    const attempts = (await pool.query('SELECT event_id, status FROM delivery_attempts WHERE event_id = ANY($1::uuid[])', [input])).rows;
    const effects = (await pool.query('SELECT event_id FROM receiver_effects WHERE event_id = ANY($1::uuid[])', [input])).rows;
    const states = await Promise.all(input.map(async (id) => (await queue.getJob(id))?.getState() ?? 'missing'));
    return { events, attempts, effects, states };
  `,
    ids,
  );
}
async function delivered(ids) {
  let state;
  await until(
    `${ids.length} events delivered with completed queue jobs`,
    async () => {
      state = await batchState(ids);
      return (
        state.events.length === ids.length &&
        state.events.every((event) => event.status === 'delivered') &&
        state.states.every((status) => status === 'completed')
      );
    },
    90_000,
  );
  assert.equal(state.attempts.length, ids.length);
  assert.ok(state.attempts.every((attempt) => attempt.status === 'succeeded'));
  assert.equal(state.effects.length, ids.length);
  assert.equal(
    new Set(state.effects.map((effect) => effect.event_id)).size,
    ids.length,
  );
  console.log(
    'PASS: one successful attempt and one durable receiver effect per event',
  );
}

const originalReplicas = (await resource('deployment', 'worker')).spec.replicas;
const relay = await resource('deployment', 'relay');
assert.equal(relay.spec.replicas, 1, 'Keep exactly one relay');
assert.equal(
  relay.spec.strategy.type,
  'Recreate',
  'Relay rollouts must not overlap',
);
assert.equal((await pods('relay')).filter(ready).length, 1);
assert.equal(
  await probe('return queue.isPaused();', null),
  false,
  'Test requires an unpaused queue',
);
let pausedByTest = false;
try {
  await scale(0);
  const ids = await submit(24);
  await until(
    'outbox publishes 24 waiting jobs while workers are stopped',
    async () => {
      const state = await batchState(ids);
      return (
        state.states.every((status) => status === 'waiting') &&
        state.attempts.length === 0
      );
    },
    45_000,
  );
  const redis = (await pods('redis'))[0];
  await replacePod(redis, 'redis', 1);
  assert.ok(
    (await batchState(ids)).states.every((status) => status === 'waiting'),
  );
  console.log('PASS: queued jobs survived Redis Pod replacement');

  // Start both consumers before releasing the backlog so a faster-starting
  // Pod cannot drain all jobs before the second consumer even exists.
  pausedByTest = true;
  await probe('await queue.pause(); return true;', null);
  await scale(2);
  await probe('await queue.resume(); return true;', null);
  pausedByTest = false;
  await delivered(ids);
  for (const pod of await pods('worker')) {
    const logs = await kubectl('logs', pod.metadata.name, '--tail=500');
    const processed = logs.split('\n').filter((line) => {
      try {
        const entry = JSON.parse(line);
        return (
          entry.action === 'delivery.succeeded' && ids.includes(entry.eventId)
        );
      } catch {
        return false;
      }
    }).length;
    assert.ok(
      processed > 0,
      `${pod.metadata.name} must process at least one test event`,
    );
    console.log(
      `PASS: ${pod.metadata.name} completed ${processed} test deliveries`,
    );
  }

  await replacePod((await pods('worker'))[0], 'worker', 2);
  await delivered(await submit(12));
  assert.equal((await resource('deployment', 'relay')).spec.replicas, 1);
  console.log(
    'Kubernetes acceptance passed: persistence, independent worker scaling, and Pod replacement',
  );
} catch (error) {
  console.error(await kubectl('get', 'pods,pvc,jobs'));
  throw error;
} finally {
  try {
    if (pausedByTest) await probe('await queue.resume(); return true;', null);
  } finally {
    await scale(originalReplicas);
    console.log(`Restored worker replicas to ${originalReplicas}`);
  }
}
