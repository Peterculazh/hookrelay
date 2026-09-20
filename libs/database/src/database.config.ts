import type { FactoryProvider } from '@nestjs/common';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';

export const DATABASE_CONFIG = Symbol('DATABASE_CONFIG');

const databaseEnvironmentSchema = z.object({
  NODE_ENV: z.string().default('development'),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().max(65_535),
  DB_NAME: z.string().min(1),
  DB_SSL: z.enum(['true', 'false']).default('false'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_IDLE_TIMEOUT: z.coerce.number().int().nonnegative().default(10_000),
  DB_CONNECTION_TIMEOUT: z.coerce.number().int().positive().default(5_000),
});

export interface DatabaseConfig {
  readonly user: string;
  readonly password: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly ssl: boolean;
  readonly poolMax: number;
  readonly idleTimeoutMillis: number;
  readonly connectionTimeoutMillis: number;
  readonly logQueries: boolean;
}

function loadLocalEnvironment(): void {
  try {
    // Existing process variables take precedence over values from .env.
    loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

export function loadDatabaseConfig(): DatabaseConfig {
  loadLocalEnvironment();

  const environment = databaseEnvironmentSchema.parse(process.env);

  return Object.freeze({
    user: environment.DB_USER,
    password: environment.DB_PASSWORD,
    host: environment.DB_HOST,
    port: environment.DB_PORT,
    database: environment.DB_NAME,
    ssl: environment.DB_SSL === 'true',
    poolMax: environment.DB_POOL_MAX,
    idleTimeoutMillis: environment.DB_IDLE_TIMEOUT,
    connectionTimeoutMillis: environment.DB_CONNECTION_TIMEOUT,
    logQueries: environment.NODE_ENV === 'development',
  });
}

export const databaseConfigProvider: FactoryProvider<DatabaseConfig> = {
  provide: DATABASE_CONFIG,
  useFactory: loadDatabaseConfig,
};
