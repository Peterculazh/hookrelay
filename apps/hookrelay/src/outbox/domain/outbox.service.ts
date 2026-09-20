import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { TransactionContext } from '@app/database';
import {
  OUTBOX_REPOSITORY,
  type OutboxEntry,
  type OutboxRepository,
} from './interfaces/outbox.repository.ts';

@Injectable()
export class OutboxService {
  constructor(
    @Inject(OUTBOX_REPOSITORY)
    private readonly outboxRepository: OutboxRepository,
  ) {}

  enqueue(eventId: string, tx: TransactionContext): Promise<OutboxEntry> {
    return this.outboxRepository.save(
      {
        id: randomUUID(),
        eventId,
      },
      tx,
    );
  }
}
