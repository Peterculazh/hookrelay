import { Module } from '@nestjs/common';
import { DatabaseModule } from '@app/database';
import { EventsQueueModule } from '../queue/events-queue.module.js';
import { EventDeliveryRepository } from './event-delivery.repository.js';
import { EventsProcessor } from './events.processor.js';

@Module({
  imports: [DatabaseModule, EventsQueueModule],
  providers: [EventDeliveryRepository, EventsProcessor],
})
export class JobsModule {}
