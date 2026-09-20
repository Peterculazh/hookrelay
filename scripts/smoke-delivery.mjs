import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const baseUrl = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3200';
const requestTimeoutMs = 3_000;
const pollIntervalMs = 1_000;
let eventId;
let lastEventResponse;

// Bound each request by both its own timeout and the current polling deadline.
function request(path, deadline, options = {}) {
  const remainingMs = Math.ceil(deadline - performance.now());
  assert.ok(remainingMs > 0, `Deadline exceeded for ${path}`);
  return fetch(new URL(path, baseUrl), {
    ...options,
    signal: AbortSignal.timeout(Math.min(requestTimeoutMs, remainingMs)),
  });
}

async function pause(deadline) {
  await sleep(
    Math.max(0, Math.min(pollIntervalMs, deadline - performance.now())),
  );
}

async function waitForApi() {
  const deadline = performance.now() + 30_000;
  let lastError;

  while (performance.now() < deadline) {
    try {
      const response = await request('/', deadline);
      await response.text();
      assert.equal(response.status, 200, 'API readiness check must return 200');
      return;
    } catch (error) {
      // Connection failures are expected while Nest is starting.
      lastError = error;
    }
    await pause(deadline);
  }

  throw new Error('API did not become ready within 30 seconds', {
    cause: lastError,
  });
}

async function createEvent() {
  // Submit once: retrying a POST could create a second event.
  const response = await request(
    '/v1/events',
    performance.now() + requestTimeoutMs,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'order.created',
        payload: {
          orderId: `ci-smoke-${randomUUID()}`,
          amount: 100,
          currency: 'USD',
        },
      }),
    },
  );
  lastEventResponse = await response.text();
  assert.equal(response.status, 202, 'Creating an event must return 202');
  const event = JSON.parse(lastEventResponse);
  assert.ok(
    typeof event.id === 'string' && event.id.trim(),
    'Expected an event id',
  );
  eventId = event.id;
  console.log(`Created event ${eventId}; waiting for delivery`);
}

async function waitForDelivery() {
  // The outbox relay runs every 10 seconds; allow time for processing and retries.
  const deadline = performance.now() + 60_000;

  while (performance.now() < deadline) {
    const response = await request(
      `/v1/events/${encodeURIComponent(eventId)}`,
      deadline,
    );
    lastEventResponse = await response.text();
    assert.equal(response.status, 200, 'Reading the event must return 200');
    const event = JSON.parse(lastEventResponse);
    assert.equal(event.id, eventId, 'API returned a different event');

    if (event.status === 'delivered') {
      assert.ok(Array.isArray(event.attempts), 'Expected an attempt history');
      assert.ok(
        event.attempts.some(
          (attempt) =>
            attempt.eventId === eventId &&
            attempt.status === 'succeeded' &&
            attempt.httpStatus === 204,
        ),
        'Expected a successful webhook attempt with HTTP 204',
      );
      console.log(
        `Smoke test passed: event ${eventId} delivered with HTTP 204`,
      );
      return;
    }

    assert.notEqual(
      event.status,
      'failed',
      'Event exhausted its delivery attempts',
    );
    assert.equal(event.status, 'pending', 'Unexpected event status');
    await pause(deadline);
  }

  throw new Error('Event was not delivered within 60 seconds');
}

try {
  await waitForApi();
  await createEvent();
  await waitForDelivery();
} catch (error) {
  console.error('Delivery smoke test failed:', error);
  console.error('Event id:', eventId ?? '(not created)');
  console.error('Last event response:', lastEventResponse ?? '(none)');
  process.exitCode = 1;
}
