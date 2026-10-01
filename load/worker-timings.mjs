function histogram(text, name, wanted) {
  const result = { count: 0, sum: 0, buckets: new Map() };
  for (const line of text.split('\n')) {
    const match = line.match(/^([^ {]+)(?:\{([^}]+)\})?\s+([\d.eE+-]+)$/);
    if (!match || !match[1].startsWith(name + '_')) continue;
    const labels = Object.fromEntries(
      [...(match[2] ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    if (!Object.entries(wanted).every(([key, value]) => labels[key] === value))
      continue;
    const value = Number(match[3]);
    if (match[1] === name + '_count') result.count += value;
    if (match[1] === name + '_sum') result.sum += value;
    if (match[1] === name + '_bucket') {
      const bound = labels.le === '+Inf' ? Infinity : Number(labels.le);
      result.buckets.set(bound, (result.buckets.get(bound) ?? 0) + value);
    }
  }
  return result;
}

export function workerTimings(baseline, final) {
  const before = new Map((baseline ?? []).map((m) => [m.name, m.text ?? '']));
  const workers = (final ?? []).filter(
    (m) => m.name.startsWith('worker/') && !m.error,
  );
  const available =
    workers.length > 0 &&
    workers.every((m) =>
      m.text.includes('hookrelay_delivery_processing_duration_seconds_count'),
    );
  const summarize = (name, labels) => {
    let count = 0;
    let sum = 0;
    const buckets = new Map();
    for (const worker of workers) {
      const initial = histogram(before.get(worker.name) ?? '', name, labels);
      const last = histogram(worker.text, name, labels);
      count += last.count - initial.count;
      sum += last.sum - initial.sum;
      for (const [bound, total] of last.buckets) {
        buckets.set(
          bound,
          (buckets.get(bound) ?? 0) + total - (initial.buckets.get(bound) ?? 0),
        );
      }
    }
    const p95Bound = [...buckets]
      .sort(([a], [b]) => a - b)
      .find(([, total]) => count > 0 && total >= count * 0.95)?.[0];
    return {
      count,
      totalSeconds: sum,
      meanMs: count > 0 ? (sum / count) * 1000 : null,
      p95UpperBoundMs: Number.isFinite(p95Bound) ? p95Bound * 1000 : null,
    };
  };
  return {
    available,
    attemptStart: summarize('hookrelay_delivery_database_duration_seconds', {
      phase: 'attempt_start',
      outcome: 'completed',
    }),
    attemptStartErrors: summarize(
      'hookrelay_delivery_database_duration_seconds',
      { phase: 'attempt_start', outcome: 'error' },
    ),
    finalize: summarize('hookrelay_delivery_database_duration_seconds', {
      phase: 'finalize',
      outcome: 'completed',
    }),
    finalizeErrors: summarize('hookrelay_delivery_database_duration_seconds', {
      phase: 'finalize',
      outcome: 'error',
    }),
    webhook: summarize('hookrelay_webhook_request_duration_seconds', {
      outcome: 'succeeded',
    }),
    webhookErrors: summarize('hookrelay_webhook_request_duration_seconds', {
      outcome: 'failed',
    }),
    processing: summarize('hookrelay_delivery_processing_duration_seconds', {
      outcome: 'completed',
    }),
    processingErrors: summarize(
      'hookrelay_delivery_processing_duration_seconds',
      { outcome: 'error' },
    ),
  };
}
