import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { type TransactionContext, UnitOfWork } from '@app/database';
import type { Queue } from 'bullmq';
import {
  EVENTS_QUEUE,
  PUBLISH_EVENT_JOB,
  type PublishEventJobData,
} from '../queue/queue.constants.js';
import {
  OutboxRepository,
  type UnpublishedOutboxEntry,
} from './outbox.repository.js';

const OUTBOX_BATCH_SIZE = 100;

@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);

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
      this.logger.error(
        `Failed to enqueue event ${event.id}`,
        error instanceof Error ? error.stack : String(error),
      );
      return;
    }

    await this.outboxRepository.markPublished(entry.id, transaction);
  }
}
