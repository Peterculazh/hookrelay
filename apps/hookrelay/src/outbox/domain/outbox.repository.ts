import { Injectable } from '@nestjs/common';
import {
  DatabaseService,
  schema,
  type TransactionContext,
} from '@app/database';
import type {
  NewOutboxEntry,
  OutboxEntry,
  OutboxRepository,
} from './interfaces/outbox.repository.ts';

@Injectable()
export class OutboxRepositoryImpl implements OutboxRepository {
  constructor(private readonly database: DatabaseService) {}

  async save(
    entry: NewOutboxEntry,
    tx: TransactionContext,
  ): Promise<OutboxEntry> {
    const [savedEntry] = await this.database
      .getExecutor(tx)
      .insert(schema.outbox)
      .values(entry)
      .returning();

    if (!savedEntry) {
      throw new Error('Failed to persist outbox entry');
    }

    return savedEntry;
  }
}
