import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const accepted = new Counter('events_accepted');
const apiDuration = new Trend('api_acceptance_ms', true);

export const options = {
  scenarios: {
    ingress: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 5),
      timeUnit: '1s',
      duration: __ENV.DURATION || '20s',
      preAllocatedVUs: 10,
      maxVUs: 100,
      gracefulStop: '10s',
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(95)', 'p(99)'],
  systemTags: ['status', 'method', 'name', 'scenario', 'expected_response'],
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    dropped_iterations: ['count==0'],
    api_acceptance_ms: [`p(95)<${__ENV.API_P95_MS || 500}`],
  },
};

export default function () {
  const response = http.post(
    `${__ENV.BENCH_URL}/v1/events`,
    JSON.stringify({
      type: __ENV.EVENT_TYPE,
      payload: {
        benchmark: true,
        padding: 'x'.repeat(Number(__ENV.PAYLOAD_BYTES || 256)),
        receiver: {
          delayMs: Number(__ENV.DELAY_MS || 0),
          failAttempts: Number(__ENV.FAIL_ATTEMPTS || 0),
        },
      },
    }),
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: '5s',
      tags: { name: 'POST /v1/events' },
    },
  );
  let valid = false;
  try {
    valid = response.status === 202 && typeof response.json('id') === 'string';
  } catch (_) {
    /* check records malformed responses */
  }
  check(response, { 'event committed and accepted': () => valid });
  if (valid) {
    accepted.add(1);
    apiDuration.add(Number(response.headers['X-Benchmark-Api-Duration-Ms']));
  }
}

export function handleSummary(data) {
  const metric = (name, key) =>
    data.metrics[name] ? data.metrics[name].values[key] : 0;
  return {
    [__ENV.SUMMARY_PATH]: JSON.stringify(data, null, 2),
    stdout: `k6: accepted=${metric('events_accepted', 'count')}, dropped=${metric('dropped_iterations', 'count')}, API p95=${metric('api_acceptance_ms', 'p(95)')}ms\n`,
  };
}
