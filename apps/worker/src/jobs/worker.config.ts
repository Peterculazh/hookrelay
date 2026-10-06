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

// Webhooks are signed only when a signer address is configured.
export function loadSignerUrl(environment = process.env): string | undefined {
  return z.string().min(1).optional().parse(environment.SIGNER_URL);
}
