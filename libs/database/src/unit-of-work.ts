import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service.ts';
import {
  TransactionContext,
  createTransactionContext,
} from './transaction-context.ts';

/** Application-facing abstraction for running an atomic unit of work. */
export abstract class UnitOfWork {
  abstract run<T>(
    operation: (transaction: TransactionContext) => Promise<T>,
  ): Promise<T>;
}

@Injectable()
export class DrizzleUnitOfWork extends UnitOfWork {
  constructor(private readonly database: DatabaseService) {
    super();
  }

  run<T>(
    operation: (transaction: TransactionContext) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction((transaction) =>
      operation(createTransactionContext(transaction)),
    );
  }
}
