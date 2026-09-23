import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { Request, Response, NextFunction } from 'express';

const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15];
const methods = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

export class Metrics {
  readonly registry = new Registry();
  readonly attempts: Counter<'outcome'>;
  readonly webhookDuration: Histogram<'outcome'>;
  readonly requests: Counter<'method' | 'route' | 'status'>;
  readonly requestDuration: Histogram<'method' | 'route' | 'status'>;

  constructor(service: string) {
    this.registry.setDefaultLabels({ service });
    const registers = [this.registry];
    this.requests = new Counter({
      name: 'hookrelay_api_requests_total',
      help: 'Completed API requests',
      labelNames: ['method', 'route', 'status'],
      registers,
    });
    this.requestDuration = new Histogram({
      name: 'hookrelay_api_request_duration_seconds',
      help: 'API request duration in seconds',
      labelNames: ['method', 'route', 'status'],
      buckets,
      registers,
    });
    this.attempts = new Counter({
      name: 'hookrelay_delivery_attempts_total',
      help: 'Webhook attempts by receiver outcome, recorded before database finalization',
      labelNames: ['outcome'],
      registers,
    });
    this.webhookDuration = new Histogram({
      name: 'hookrelay_webhook_request_duration_seconds',
      help: 'Time to receiver response headers or request failure in seconds',
      labelNames: ['outcome'],
      buckets,
      registers,
    });
    if (service === 'worker') {
      for (const outcome of ['succeeded', 'failed']) {
        this.attempts.inc({ outcome }, 0);
        this.webhookDuration.zero({ outcome });
      }
    }
  }

  observeDelivery(outcome: 'succeeded' | 'failed', seconds: number) {
    this.attempts.inc({ outcome });
    this.webhookDuration.observe({ outcome }, seconds);
  }

  collectOutbox(count: () => Promise<number>) {
    new Gauge({
      name: 'hookrelay_outbox_unpublished',
      help: 'Committed outbox records awaiting publication',
      registers: [this.registry],
      async collect() {
        this.set(await count());
      },
    });
  }

  collectQueue(count: () => Promise<Record<string, number>>) {
    new Gauge({
      name: 'hookrelay_queue_jobs',
      help: 'Current events queue jobs by state',
      labelNames: ['state'],
      registers: [this.registry],
      async collect() {
        const counts = await count();
        for (const state of ['waiting', 'active', 'delayed'])
          this.set({ state }, counts[state] ?? 0);
      },
    });
  }

  readonly middleware = (req: Request, res: Response, next: NextFunction) => {
    const started = performance.now();
    res.once('finish', () => {
      const labels = {
        method: methods.has(req.method) ? req.method : 'OTHER',
        route:
          typeof req.route?.path === 'string' ? req.route.path : 'unmatched',
        status: String(res.statusCode),
      };
      this.requests.inc(labels);
      this.requestDuration.observe(
        labels,
        (performance.now() - started) / 1000,
      );
    });
    next();
  };
}

export const apiMetrics = new Metrics('api');
export const workerMetrics = new Metrics('worker');
