import { Inject, Injectable } from '@nestjs/common';
import {
  DRIZZLE_DB,
  type DrizzleDatabase,
  type DrizzleTransaction,
} from './database.provider.ts';
import {
  type TransactionContext,
  unwrapTransactionContext,
} from './transaction-context.ts';

@Injectable()
export class DatabaseService {
  constructor(@Inject(DRIZZLE_DB) public readonly db: DrizzleDatabase) {}

  /** Resolve the normal database or the connection bound to a unit of work. */
  getExecutor(
    context?: TransactionContext,
  ): DrizzleDatabase | DrizzleTransaction {
    return context ? unwrapTransactionContext(context) : this.db;
  }

  transaction<T>(
    callback: (transaction: DrizzleTransaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(callback);
  }
}
