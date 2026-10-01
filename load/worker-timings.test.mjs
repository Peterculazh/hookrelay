import test from 'node:test';
import assert from 'node:assert/strict';
import { workerTimings } from './worker-timings.mjs';
const metric = (count, sum, labels = 'outcome="completed",service="worker"') =>
  `hookrelay_delivery_processing_duration_seconds_count{${labels}} ${count}\nhookrelay_delivery_processing_duration_seconds_sum{${labels}} ${sum}\nhookrelay_delivery_processing_duration_seconds_bucket{le="0.025",${labels}} ${count}\nhookrelay_delivery_processing_duration_seconds_bucket{le="+Inf",${labels}} ${count}`;
test('uses per-Pod counter deltas and zero baseline for a newly created worker', () => {
  const summary = workerTimings(
    [{ name: 'worker/a', text: metric(10, 0.2) }],
    [
      { name: 'worker/a', text: metric(15, 0.3) },
      { name: 'worker/b', text: metric(5, 0.1) },
    ],
  );
  assert.equal(summary.available, true);
  assert.equal(summary.processing.count, 10);
  assert.ok(Math.abs(summary.processing.meanMs - 20) < 0.00001);
  assert.equal(summary.processing.p95UpperBoundMs, 25);
});
test('keeps error metrics distinct and reports missing instrumentation', () => {
  const summary = workerTimings(
    [],
    [
      {
        name: 'worker/a',
        text: metric(2, 0.08, 'outcome="error",service="worker"'),
      },
    ],
  );
  assert.equal(summary.processing.count, 0);
  assert.equal(summary.processingErrors.count, 2);
  assert.equal(
    workerTimings([], [{ name: 'worker/old', text: '' }]).available,
    false,
  );
});
