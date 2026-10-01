import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  compactCompletions,
  recordCompletions,
  recordAcceptance,
} from './observation-state.mjs';

test('extended runs require isolation and respect its offered-event budget before SSH starts', () => {
  const run = (environment) => () =>
    execFileSync(
      process.execPath,
      ['scripts/benchmark-vps.mjs', 'relay-steady'],
      {
        env: {
          ...process.env,
          VPS_SSH_TARGET: 'test@example.invalid',
          BENCH_SECONDS: '600',
          ...environment,
        },
        stdio: 'pipe',
        timeout: 10000,
      },
    );
  assert.throws(
    run({ BENCH_ISOLATE_REDIS: '0' }),
    /Runs longer than 120 seconds require/,
  );
  assert.throws(
    run({ BENCH_ISOLATE_REDIS: '1', BENCH_RATE: '100' }),
    /limited to 50000 offered events/,
  );
});

test('completed IDs are sent once, including later status transitions', () => {
  const seen = new Map();
  assert.deepEqual(
    compactCompletions(seen, [{ id: 'a', status: 'delivered' }]),
    [{ id: 'a', status: 'delivered' }],
  );
  assert.deepEqual(
    compactCompletions(seen, [{ id: 'a', status: 'delivered' }]),
    [],
  );
  assert.deepEqual(compactCompletions(seen, [{ id: 'b', status: 'failed' }]), [
    { id: 'b', status: 'failed' },
  ]);
  assert.deepEqual(
    compactCompletions(seen, [{ id: 'b', status: 'delivered' }]),
    [{ id: 'b', status: 'delivered' }],
  );
});

test('a completion received before HTTP acknowledgment is retained with zero post-ack delay', () => {
  const state = {
    accepted: new Map(),
    earlyCompletions: new Map(),
    preAckCompletions: 0,
  };
  recordCompletions(state, [{ id: 'a', status: 'delivered' }], 100);
  recordAcceptance(state, 'a', { ack: 110, apiMs: 20 });
  assert.equal(state.accepted.get('a').observed, 110);
  assert.equal(state.accepted.get('a').status, 'delivered');
  assert.equal(state.preAckCompletions, 1);
  assert.equal(state.earlyCompletions.size, 0);
});

test('replayed completions preserve the first observation and update status', () => {
  const state = {
    accepted: new Map([['a', { ack: 20 }]]),
    earlyCompletions: new Map(),
  };
  recordCompletions(state, [{ id: 'a', status: 'failed' }], 100);
  recordCompletions(state, [{ id: 'a', status: 'delivered' }], 200);
  assert.equal(state.accepted.get('a').observed, 100);
  assert.equal(state.accepted.get('a').status, 'delivered');
  assert.equal(state.lastCompletion, 100);
});
