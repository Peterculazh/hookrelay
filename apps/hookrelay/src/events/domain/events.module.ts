import { Module } from '@nestjs/common';
import { EventsServiceImpl } from './events.service.ts';
import { DatabaseModule } from '@app/database';
import { EventsController } from '../api/events.controller.ts';
import { EventsRepositoryImpl } from './events.repository.ts';
import { EVENTS_REPOSITORY } from './interfaces/events.repository.ts';
import { OutboxModule } from '../../outbox/domain/outbox.module.ts';
import { EVENTS_SERVICE } from './interfaces/events.service.ts';

@Module({
  imports: [DatabaseModule, OutboxModule],
  providers: [
    {
      provide: EVENTS_SERVICE,
      useClass: EventsServiceImpl,
    },
    {
      provide: EVENTS_REPOSITORY,
      useClass: EventsRepositoryImpl,
    },
  ],
  controllers: [EventsController],
  exports: [EVENTS_SERVICE],
})
export class EventsModule {}
