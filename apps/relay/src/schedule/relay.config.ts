import { z } from 'zod';

export function loadRelayConfig(environment = process.env) {
  return z
    .object({
      batchSize: z.coerce.number().int().min(1).max(1000).default(100),
      publishEverySeconds: z.coerce
        .number()
        .int()
        .min(1)
        .max(60)
        .refine(
          (seconds) => 60 % seconds === 0,
          'Interval must divide 60 evenly',
        )
        .default(10),
    })
    .parse({
      batchSize: environment.RELAY_BATCH_SIZE,
      publishEverySeconds: environment.RELAY_PUBLISH_INTERVAL_SECONDS,
    });
}

export function relayCronExpression(seconds: number): string {
  return seconds === 60 ? '0 * * * * *' : `*/${seconds} * * * * *`;
}
