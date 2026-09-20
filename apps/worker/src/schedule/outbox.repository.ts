import { Injectable } from '@nestjs/common';
import {
  DatabaseService,
  schema,
  type TransactionContext,
} from '@app/database';
import { and, asc, eq, isNull } from 'drizzle-orm';

export interface UnpublishedOutboxEntry {
  readonly id: string;
  readonly event: {
    readonly id: string;
    readonly type: string;
    readonly payload: unknown;
    readonly targetUrl: string;
    readonly createdAt: Date;
  };
}

@Injectable()
export class OutboxRepository {
  constructor(private readonly database: DatabaseService) {}

  async findUnpublishedForUpdate(
    transaction: TransactionContext,
    limit: number,
  ): Promise<UnpublishedOutboxEntry[]> {
    const entries = await this.database
      .getExecutor(transaction)
      .select({
        id: schema.outbox.id,
        event: {
          id: schema.events.id,
          type: schema.events.type,
          payload: schema.events.payload,
          targetUrl: schema.events.targetUrl,
          createdAt: schema.events.createdAt,
        },
      })
      .from(schema.outbox)
      .innerJoin(schema.events, eq(schema.events.id, schema.outbox.eventId))
      .where(isNull(schema.outbox.publishedAt))
      .orderBy(asc(schema.outbox.createdAt))
      .limit(limit)
      .for('update', { of: schema.outbox, skipLocked: true });

    return entries;
  }

  async markPublished(
    outboxId: string,
    transaction: TransactionContext,
  ): Promise<void> {
    const [updatedEntry] = await this.database
      .getExecutor(transaction)
      .update(schema.outbox)
      .set({ publishedAt: new Date() })
      .where(
        and(eq(schema.outbox.id, outboxId), isNull(schema.outbox.publishedAt)),
      )
      .returning({ id: schema.outbox.id });

    if (!updatedEntry) {
      throw new Error(`Outbox entry ${outboxId} was not marked as published`);
    }
  }
}
