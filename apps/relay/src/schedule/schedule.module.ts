import { Module } from '@nestjs/common';
import { DatabaseModule } from '@app/database';
import { EventsQueueModule } from '@app/queue';
import { OutboxRepository } from './outbox.repository.js';
import { ScheduleService } from './schedule.service.js';
import { ReconciliationService } from './reconciliation.service.js';

@Module({
  imports: [DatabaseModule, EventsQueueModule],
  providers: [OutboxRepository, ScheduleService, ReconciliationService],
})
export class ScheduleModule {}
