import { Module } from '@nestjs/common';
import { DatabaseModule } from '@app/database';
import { EventsQueueModule } from '../queue/events-queue.module.js';
import { OutboxRepository } from './outbox.repository.js';
import { ScheduleService } from './schedule.service.js';

@Module({
  imports: [DatabaseModule, EventsQueueModule],
  providers: [OutboxRepository, ScheduleService],
})
export class ScheduleModule {}
