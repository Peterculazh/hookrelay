import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EVENTS_QUEUE } from './queue.constants.js';

@Module({
  imports: [
    BullModule.registerQueue({
      name: EVENTS_QUEUE,
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 1_000,
          jitter: 0.2,
        },
        removeOnComplete: false,
        removeOnFail: false,
      },
    }),
  ],
  exports: [BullModule],
})
export class EventsQueueModule {}
