import type { FactoryProvider } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { DATABASE_CONFIG, type DatabaseConfig } from './database.config.ts';
import { relations } from './schema.ts';

export const PG_POOL = Symbol('PG_POOL');
export const DRIZZLE_DB = Symbol('DRIZZLE_DB');

export const pgPoolProvider: FactoryProvider<Pool> = {
  provide: PG_POOL,
  inject: [DATABASE_CONFIG],
  useFactory: (config: DatabaseConfig) =>
    new Pool({
      user: config.user,
      password: config.password,
      host: config.host,
      port: config.port,
      database: config.database,
      ssl: config.ssl,
      max: config.poolMax,
      idleTimeoutMillis: config.idleTimeoutMillis,
      connectionTimeoutMillis: config.connectionTimeoutMillis,
      application_name: 'hookrelay',
    }),
};

function createDatabase(client: Pool, config: DatabaseConfig) {
  return drizzle({
    client,
    relations,
    logger: config.logQueries,
  });
}

export type DrizzleDatabase = ReturnType<typeof createDatabase>;
export type DrizzleTransaction = Parameters<
  Parameters<DrizzleDatabase['transaction']>[0]
>[0];

export const drizzleDbProvider: FactoryProvider<DrizzleDatabase> = {
  provide: DRIZZLE_DB,
  inject: [PG_POOL, DATABASE_CONFIG],
  useFactory: createDatabase,
};
