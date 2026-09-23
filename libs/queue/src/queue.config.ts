import type { RedisOptions } from 'bullmq';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';

const redisEnvironmentSchema = z.object({
  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().max(65_535).default(6_379),
  REDIS_DB: z.coerce.number().int().nonnegative().default(0),
  REDIS_PASSWORD: z.string().min(1).optional(),
});

function loadLocalEnvironment(): void {
  try {
    loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

export function loadRedisConnection(): RedisOptions {
  loadLocalEnvironment();

  const environment = redisEnvironmentSchema.parse(process.env);

  return {
    host: environment.REDIS_HOST,
    port: environment.REDIS_PORT,
    db: environment.REDIS_DB,
    password: environment.REDIS_PASSWORD,
    enableOfflineQueue: false,
  };
}
