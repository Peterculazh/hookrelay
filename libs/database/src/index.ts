/** Shared NestJS and Drizzle database infrastructure. */

export { DatabaseModule } from './database.module.ts';
export type { DatabaseConfig } from './database.config.ts';
export {
  DRIZZLE_DB,
  type DrizzleDatabase,
  type DrizzleTransaction,
} from './database.provider.ts';
export { DatabaseService } from './database.service.ts';
export { pgTable, relations, schema } from './schema.ts';
export { TransactionContext } from './transaction-context.ts';
export { UnitOfWork } from './unit-of-work.ts';
