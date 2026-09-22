import { Inject, Injectable } from '@nestjs/common';
import type { Pool, QueryConfig } from 'pg';
import {
  DRIZZLE_DB,
  PG_POOL,
  type DrizzleDatabase,
  type DrizzleTransaction,
} from './database.provider.ts';
import {
  type TransactionContext,
  unwrapTransactionContext,
} from './transaction-context.ts';

interface TimeoutQueryConfig extends QueryConfig {
  readonly query_timeout: number;
}

@Injectable()
export class DatabaseService {
  constructor(
    @Inject(DRIZZLE_DB) public readonly db: DrizzleDatabase,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  async checkConnection(timeoutMs: number): Promise<void> {
    const query: TimeoutQueryConfig = {
      text: 'select 1',
      query_timeout: timeoutMs,
    };
    let timeout: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        this.pool.query(query),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(
              new Error(
                `PostgreSQL health check timed out after ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

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
