import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService, schema } from '@app/database';
import { EVENTS_QUEUE, type PublishEventJobData } from '@app/queue';
import type { Queue } from 'bullmq';
import { and, eq, exists, gt, or } from 'drizzle-orm';
import { createLogger } from '../../../../libs/observability/src/logger.js';

const BATCH_SIZE = 100;

@Injectable()
export class ReconciliationService implements OnModuleDestroy {
  private readonly logger = createLogger('relay');
  private cursor?: string;
  private stopping = false;
  private activeBatch?: Promise<void>;

  constructor(
    private readonly database: DatabaseService,
    @InjectQueue(EVENTS_QUEUE)
    private readonly queue: Queue<PublishEventJobData>,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.activeBatch?.catch(() => undefined);
  }

  @Cron(CronExpression.EVERY_10_SECONDS, {
    name: 'reconcile-delivery-outcomes',
    waitForCompletion: true,
  })
  async handleCron(): Promise<void> {
    if (this.stopping || this.activeBatch) return;
    this.activeBatch = this.reconcileBatch();
    try {
      await this.activeBatch;
    } finally {
      this.activeBatch = undefined;
    }
  }

  private async reconcileBatch(): Promise<void> {
    const unfinished = this.database.db
      .select({ id: schema.deliveryAttempts.id })
      .from(schema.deliveryAttempts)
      .where(
        and(
          eq(schema.deliveryAttempts.eventId, schema.events.id),
          eq(schema.deliveryAttempts.status, 'in_progress'),
        ),
      );
    const candidates = await this.database.db
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(
        and(
          or(eq(schema.events.status, 'pending'), exists(unfinished)),
          this.cursor ? gt(schema.events.id, this.cursor) : undefined,
        ),
      )
      .orderBy(schema.events.id)
      .limit(BATCH_SIZE);

    for (const event of candidates) {
      const job = await this.queue.getJob(event.id);
      const state = await job?.getState();
      // Retained terminal jobs are authoritative. Age alone cannot distinguish
      // a slow active execution from a dead worker. Never retry jobs here.
      if (state !== 'failed' && state !== 'completed') continue;
      const interruptedAttemptIds = await this.database.transaction(
        async (transaction) => {
          const attempts = await transaction
            .update(schema.deliveryAttempts)
            .set({
              status: 'failed',
              finishedAt: new Date(),
              httpStatus: null,
              errorCode: 'INTERRUPTED',
              errorMessage: `Execution did not persist its outcome; reconciled after queue job ${state}. Receiver outcome is unknown.`,
            })
            .where(
              and(
                eq(schema.deliveryAttempts.eventId, event.id),
                eq(schema.deliveryAttempts.status, 'in_progress'),
              ),
            )
            .returning({ id: schema.deliveryAttempts.id });
          if (state === 'failed') {
            await transaction
              .update(schema.events)
              .set({ status: 'failed' })
              .where(
                and(
                  eq(schema.events.id, event.id),
                  eq(schema.events.status, 'pending'),
                ),
              );
          }
          return attempts.map((attempt) => attempt.id);
        },
      );
      this.logger.info({
        action: 'delivery.reconciled',
        eventId: event.id,
        jobId: event.id,
        queueState: state,
        interruptedAttemptIds,
      });
    }
    // Keyset pagination prevents a permanent pending backlog starving later IDs.
    this.cursor =
      candidates.length === BATCH_SIZE ? candidates.at(-1)?.id : undefined;
  }
}
