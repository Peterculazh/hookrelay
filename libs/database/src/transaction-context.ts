import type { DrizzleTransaction } from './database.provider.ts';

const transactionContextBrand = Symbol('TransactionContext');

/**
 * An opaque handle that application services can pass between repositories.
 * It intentionally exposes no database-specific API.
 */
export abstract class TransactionContext {
  private readonly [transactionContextBrand] = true;
}

class DrizzleTransactionContext extends TransactionContext {
  constructor(readonly transaction: DrizzleTransaction) {
    super();
  }
}

export function createTransactionContext(
  transaction: DrizzleTransaction,
): TransactionContext {
  return new DrizzleTransactionContext(transaction);
}

export function unwrapTransactionContext(
  context: TransactionContext,
): DrizzleTransaction {
  if (!(context instanceof DrizzleTransactionContext)) {
    throw new TypeError('Unsupported transaction context');
  }

  return context.transaction;
}
