import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { createLogger } from '../../../../libs/observability/src/logger.js';
import { Cron, CronExpression } from '@nestjs/schedule';
import { type TransactionContext, UnitOfWork } from '@app/database';
import type { Queue } from 'bullmq';
import {
  EVENTS_QUEUE,
  PUBLISH_EVENT_JOB,
  type PublishEventJobData,
} from '@app/queue';
import {
  OutboxRepository,
  type UnpublishedOutboxEntry,
} from './outbox.repository.js';

const OUTBOX_BATCH_SIZE = 100;

@Injectable()
export class ScheduleService {
  private readonly logger = createLogger('relay');

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly outboxRepository: OutboxRepository,
    @InjectQueue(EVENTS_QUEUE)
    private readonly eventsQueue: Queue<PublishEventJobData>,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS, {
    name: 'publish-outbox-events',
    waitForCompletion: true,
  })
  async handleCron(): Promise<void> {
    await this.unitOfWork.run(async (transaction) => {
      const entries = await this.outboxRepository.findUnpublishedForUpdate(
        transaction,
        OUTBOX_BATCH_SIZE,
      );

      for (const entry of entries) {
        await this.publishEntry(entry, transaction);
      }
    });
  }

  private async publishEntry(
    entry: UnpublishedOutboxEntry,
    transaction: TransactionContext,
  ): Promise<void> {
    const started = performance.now();
    const event = {
      ...entry.event,
      createdAt: entry.event.createdAt.toISOString(),
    };

    try {
      await this.eventsQueue.add(
        PUBLISH_EVENT_JOB,
        { event },
        {
          jobId: event.id,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5_000,
          },
          removeOnComplete: false,
          removeOnFail: false,
        },
      );
    } catch (error) {
      this.logger.error({
        action: 'job.publish_failed',
        eventId: event.id,
        jobId: event.id,
        attemptId: null,
        errorCode: 'QUEUE_PUBLISH_ERROR',
        err: error,
        durationMs: performance.now() - started,
      });
      return;
    }

    this.logger.info({
      action: 'job.published',
      eventId: event.id,
      jobId: event.id,
      attemptId: null,
      durationMs: performance.now() - started,
    });
    try {
      await this.outboxRepository.markPublished(entry.id, transaction);
    } catch (err) {
      this.logger.error({
        action: 'outbox.mark_failed',
        eventId: event.id,
        jobId: event.id,
        attemptId: null,
        errorCode: 'OUTBOX_UPDATE_ERROR',
        err,
      });
      throw err;
    }
  }
}
