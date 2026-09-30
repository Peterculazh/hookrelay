import { z } from 'zod';

// Bound parallel HTTP requests and database work per worker process.
export function loadWorkerConcurrency(environment = process.env): number {
  return z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(1)
    .parse(environment.WORKER_CONCURRENCY);
}
