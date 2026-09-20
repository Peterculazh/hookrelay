import { Injectable } from '@nestjs/common';
import {
  DatabaseService,
  schema,
  type TransactionContext,
} from '@app/database';
import { asc, eq } from 'drizzle-orm';
import type {
  Event,
  EventsRepository,
  EventWithAttempts,
  NewEvent,
} from './interfaces/events.repository.ts';

@Injectable()
export class EventsRepositoryImpl implements EventsRepository {
  constructor(private readonly database: DatabaseService) {}

  async save(event: NewEvent, tx: TransactionContext): Promise<Event> {
    const [savedEvent] = await this.database
      .getExecutor(tx)
      .insert(schema.events)
      .values(event)
      .returning();

    if (!savedEvent) {
      throw new Error('Failed to persist event');
    }

    return savedEvent;
  }

  async findById(id: string): Promise<EventWithAttempts | null> {
    const rows = await this.database.db
      .select({
        event: {
          id: schema.events.id,
          type: schema.events.type,
          payload: schema.events.payload,
          targetUrl: schema.events.targetUrl,
          status: schema.events.status,
          createdAt: schema.events.createdAt,
          deliveredAt: schema.events.deliveredAt,
        },
        attempt: {
          id: schema.deliveryAttempts.id,
          eventId: schema.deliveryAttempts.eventId,
          status: schema.deliveryAttempts.status,
          startedAt: schema.deliveryAttempts.startedAt,
          finishedAt: schema.deliveryAttempts.finishedAt,
          httpStatus: schema.deliveryAttempts.httpStatus,
          errorCode: schema.deliveryAttempts.errorCode,
          errorMessage: schema.deliveryAttempts.errorMessage,
        },
      })
      .from(schema.events)
      .leftJoin(
        schema.deliveryAttempts,
        eq(schema.deliveryAttempts.eventId, schema.events.id),
      )
      .where(eq(schema.events.id, id))
      .orderBy(
        asc(schema.deliveryAttempts.startedAt),
        asc(schema.deliveryAttempts.id),
      );

    const firstRow = rows[0];
    if (!firstRow) {
      return null;
    }

    return {
      ...firstRow.event,
      attempts: rows.flatMap(({ attempt }) => (attempt ? [attempt] : [])),
    };
  }
}
