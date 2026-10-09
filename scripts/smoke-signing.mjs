import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

// Execute from the host against an already migrated Compose stack that runs
// the signer. The receiver stays internal, so direct checks run inside it.
const baseUrl = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3200';
const composeArgs = [
  'compose',
  '-f',
  process.env.SIGNING_COMPOSE_FILE ?? 'docker-compose.yml',
];
if (process.env.SIGNING_COMPOSE_PROJECT)
  composeArgs.push('-p', process.env.SIGNING_COMPOSE_PROJECT);
const compose = (args, environment = {}) =>
  execFileSync('docker', [...composeArgs, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ...environment },
  });
const recreateReceiver = (environment) =>
  compose(
    ['up', '--detach', '--no-build', '--no-deps', '--wait', 'test-receiver'],
    environment,
  );

async function receiverRejectsForgeries(id) {
  const { default: assert } = await import('node:assert/strict');
  const { createHmac } = await import('node:crypto');
  const secret = process.env.WEBHOOK_SIGNING_SECRET;
  assert.ok(secret, 'The receiver must be configured with a signing secret');
  const body = JSON.stringify({ id, type: 'signing.test', payload: {} });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = (key, time = timestamp) =>
    `v1=${createHmac('sha256', key).update(`${time}.${body}`).digest('hex')}`;
  async function send(headers) {
    const response = await fetch('http://127.0.0.1:3001/webhooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      signal: AbortSignal.timeout(5000),
    });
    await response.text();
    return response.status;
  }
  const stale = String(Number(timestamp) - 3600);
  assert.equal(await send({}), 401, 'unsigned');
  assert.equal(
    await send({
      'x-hookrelay-signature': sign(`${secret}-forged`),
      'x-hookrelay-timestamp': timestamp,
    }),
    401,
    'wrong secret',
  );
  assert.equal(
    await send({
      'x-hookrelay-signature': sign(secret, stale),
      'x-hookrelay-timestamp': stale,
    }),
    401,
    'stale timestamp',
  );
  console.log(
    'PASS: receiver rejects unsigned, forged, and stale webhooks with 401',
  );
}

function execInReceiver(check, ...args) {
  const source = `await (${check.toString()})(...${JSON.stringify(args)});`;
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
    { input: source, encoding: 'utf8', timeout: 60_000 },
  );
  process.stdout.write(output);
}

async function createEvent() {
  // Submit once: retrying a POST could create a second event.
  const response = await fetch(new URL('/v1/events', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'order.created',
      payload: {
        orderId: `signing-smoke-${randomUUID()}`,
        amount: 100,
        currency: 'USD',
      },
    }),
    signal: AbortSignal.timeout(3_000),
  });
  const text = await response.text();
  assert.equal(response.status, 202, 'Creating an event must return 202');
  return JSON.parse(text).id;
}

// Poll until the event satisfies the predicate; the relay runs every 10 seconds.
async function waitForEvent(id, description, predicate) {
  const deadline = performance.now() + 60_000;
  let event;
  while (performance.now() < deadline) {
    const response = await fetch(new URL(`/v1/events/${id}`, baseUrl), {
      signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200, 'Reading the event must return 200');
    event = await response.json();
    if (predicate(event)) return event;
    await sleep(1_000);
  }
  throw new Error(
    `Event ${id} did not reach "${description}": ${JSON.stringify(event)}`,
  );
}

try {
  execInReceiver(receiverRejectsForgeries, randomUUID());

  // The receiver accepts nothing unsigned, so delivery proves the worker
  // obtained a valid signature from the signer service.
  const delivered = await createEvent();
  await waitForEvent(
    delivered,
    'delivered',
    (event) =>
      event.status === 'delivered' &&
      event.attempts.some((attempt) => attempt.httpStatus === 204),
  );
  console.log(`PASS: signed event ${delivered} delivered with HTTP 204`);

  try {
    recreateReceiver({
      RECEIVER_SIGNING_SECRET: 'mismatched-receiver-secret-0123456789abcdef',
    });
    const rejected = await createEvent();
    await waitForEvent(rejected, 'rejected attempt', (event) =>
      event.attempts.some(
        (attempt) =>
          attempt.status === 'failed' &&
          attempt.httpStatus === 401 &&
          attempt.errorCode === 'HTTP_ERROR',
      ),
    );
    console.log(
      `PASS: event ${rejected} is rejected with HTTP 401 when the secrets differ`,
    );
  } finally {
    recreateReceiver({});
  }
} catch (error) {
  console.error('Signing smoke test failed:', error);
  process.exitCode = 1;
}
