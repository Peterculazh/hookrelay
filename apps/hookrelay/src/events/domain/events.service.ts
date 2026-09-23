import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createLogger } from '../../../../../libs/observability/src/logger.js';
import { UnitOfWork } from '@app/database';
import { randomUUID } from 'node:crypto';
import { OutboxService } from '../../outbox/domain/outbox.service.ts';
import {
  EVENTS_REPOSITORY,
  type EventsRepository,
} from './interfaces/events.repository.ts';
import type {
  EventsService,
  SaveEventInput,
} from './interfaces/events.service.ts';
import { WEBHOOK_TARGET_URL } from '../../config/config.ts';

@Injectable()
export class EventsServiceImpl implements EventsService {
  private readonly logger = createLogger('api');
  private targetUrl: string;

  constructor(
    @Inject(EVENTS_REPOSITORY)
    private readonly eventsRepository: EventsRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly outboxService: OutboxService,
  ) {
    this.targetUrl = WEBHOOK_TARGET_URL;
  }

  async saveEvent(body: SaveEventInput) {
    const started = performance.now();
    const id = randomUUID();

    const event = await this.unitOfWork.run(async (transaction) => {
      const event = await this.eventsRepository.save(
        {
          id,
          payload: body.payload,
          type: body.type,
          targetUrl: this.targetUrl,
          status: 'pending',
        },
        transaction,
      );

      await this.outboxService.enqueue(event.id, transaction);

      return event;
    });

    this.logger.info({
      action: 'event.accepted',
      eventId: event.id,
      jobId: event.id,
      attemptId: null,
      httpStatus: 202,
      durationMs: performance.now() - started,
      eventType: event.type,
    });

    return event;
  }

  async getEvent(id: string) {
    const event = await this.eventsRepository.findById(id);

    if (!event) {
      throw new NotFoundException(`Event ${id} not found`);
    }

    return event;
  }
}
