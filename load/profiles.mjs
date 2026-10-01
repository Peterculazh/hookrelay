export const cases = {
  baseline: { rate: 5, seconds: 10 },
  'slow-serial': { rate: 4, seconds: 10, delayMs: 500 },
  'slow-concurrency': { rate: 4, seconds: 10, delayMs: 500, concurrency: 4 },
  'slow-replicas': { rate: 4, seconds: 10, delayMs: 500, replicas: 2 },
  retry: { rate: 2, seconds: 5, failAttempts: 1, concurrency: 4 },
  failure: {
    rate: 2,
    seconds: 5,
    failAttempts: 3,
    concurrency: 4,
    expected: 'failed',
  },
  timeout: {
    rate: 1,
    seconds: 3,
    delayMs: 11000,
    concurrency: 4,
    expected: 'failed',
  },
  'backlog-serial': { rate: 4, seconds: 10, delayMs: 500, paused: true },
  'backlog-concurrency': {
    rate: 4,
    seconds: 10,
    delayMs: 500,
    paused: true,
    concurrency: 4,
  },
  'relay-pressure': { rate: 20, seconds: 15, concurrency: 4 },
};

export function quantiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) =>
    sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
  return {
    count: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? null,
  };
}
