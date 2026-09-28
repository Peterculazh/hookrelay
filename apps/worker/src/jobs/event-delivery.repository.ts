import { Injectable } from '@nestjs/common';
import { DatabaseService, schema } from '@app/database';
import { and, eq } from 'drizzle-orm';

export type DeliveryErrorCode = 'HTTP_ERROR' | 'TIMEOUT' | 'NETWORK_ERROR';
export type EventStatusAfterFailure = 'pending' | 'failed';

export interface FailedDeliveryAttempt {
  readonly httpStatus: number | null;
  readonly errorCode: DeliveryErrorCode;
  readonly errorMessage: string;
}

@Injectable()
export class EventDeliveryRepository {
  constructor(private readonly database: DatabaseService) {}

  async startAttempt(eventId: string, startedAt: Date): Promise<string> {
    return this.database.transaction(async (transaction) => {
      // BullMQ has assigned this execution the job lock. Earlier unfinished
      // executions have an unknown receiver outcome, not a confirmed HTTP failure.
      await transaction
        .update(schema.deliveryAttempts)
        .set({
          status: 'failed',
          finishedAt: startedAt,
          httpStatus: null,
          errorCode: 'INTERRUPTED',
          errorMessage:
            'Previous execution did not persist its outcome; reconciled when a new execution started. Receiver outcome is unknown.',
        })
        .where(
          and(
            eq(schema.deliveryAttempts.eventId, eventId),
            eq(schema.deliveryAttempts.status, 'in_progress'),
          ),
        );
      const [attempt] = await transaction
        .insert(schema.deliveryAttempts)
        .values({
          eventId,
          status: 'in_progress',
          startedAt,
          finishedAt: null,
          httpStatus: null,
          errorCode: null,
          errorMessage: null,
        })
        .returning({ id: schema.deliveryAttempts.id });

      if (!attempt) {
        throw new Error(
          `Failed to start a delivery attempt for event ${eventId}`,
        );
      }

      return attempt.id;
    });
  }

  async markSucceededAndDelivered(
    attemptId: string,
    eventId: string,
    httpStatus: number,
    finishedAt: Date,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [updatedAttempt] = await transaction
        .update(schema.deliveryAttempts)
        .set({
          status: 'succeeded',
          finishedAt,
          httpStatus,
          errorCode: null,
          errorMessage: null,
        })
        .where(
          and(
            eq(schema.deliveryAttempts.id, attemptId),
            eq(schema.deliveryAttempts.status, 'in_progress'),
          ),
        )
        .returning({ id: schema.deliveryAttempts.id });

      if (!updatedAttempt) {
        throw new Error(
          `Delivery attempt ${attemptId} was not marked succeeded`,
        );
      }

      const [updatedEvent] = await transaction
        .update(schema.events)
        .set({ deliveredAt: finishedAt, status: 'delivered' })
        .where(eq(schema.events.id, eventId))
        .returning({ id: schema.events.id });

      if (!updatedEvent) {
        throw new Error(`Event ${eventId} was not marked delivered`);
      }
    });
  }

  async markFailed(
    attemptId: string,
    eventId: string,
    failure: FailedDeliveryAttempt,
    finishedAt: Date,
    eventStatus: EventStatusAfterFailure,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [updatedAttempt] = await transaction
        .update(schema.deliveryAttempts)
        .set({
          status: 'failed',
          finishedAt,
          httpStatus: failure.httpStatus,
          errorCode: failure.errorCode,
          errorMessage: failure.errorMessage,
        })
        .where(
          and(
            eq(schema.deliveryAttempts.id, attemptId),
            eq(schema.deliveryAttempts.status, 'in_progress'),
          ),
        )
        .returning({ id: schema.deliveryAttempts.id });

      if (!updatedAttempt) {
        throw new Error(`Delivery attempt ${attemptId} was not marked failed`);
      }

      const [updatedEvent] = await transaction
        .update(schema.events)
        .set({ status: eventStatus })
        .where(eq(schema.events.id, eventId))
        .returning({ id: schema.events.id });

      if (!updatedEvent) {
        throw new Error(`Event ${eventId} status was not updated`);
      }
    });
  }
}
