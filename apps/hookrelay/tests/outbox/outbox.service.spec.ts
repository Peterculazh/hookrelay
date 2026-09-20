import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionContext } from '../../../../libs/database/src/index.ts';
import {
  OUTBOX_REPOSITORY,
  type OutboxEntry,
  type OutboxRepository,
} from '../../src/outbox/domain/interfaces/outbox.repository.ts';
import { OutboxService } from '../../src/outbox/domain/outbox.service.ts';

class TestTransactionContext extends TransactionContext {}

describe('OutboxService', () => {
  let service: OutboxService;
  const transaction = new TestTransactionContext();
  const outboxRepository = {
    save: vi.fn(),
  } satisfies OutboxRepository;

  beforeEach(async () => {
    outboxRepository.save.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxService,
        {
          provide: OUTBOX_REPOSITORY,
          useValue: outboxRepository,
        },
      ],
    }).compile();

    service = module.get<OutboxService>(OutboxService);
  });

  it('enqueues an event using the supplied transaction', async () => {
    const savedEntry: OutboxEntry = {
      id: 'outbox-id',
      eventId: 'event-id',
      createdAt: new Date(),
      publishedAt: null,
    };
    outboxRepository.save.mockResolvedValueOnce(savedEntry);

    await expect(
      service.enqueue(savedEntry.eventId, transaction),
    ).resolves.toBe(savedEntry);

    expect(outboxRepository.save).toHaveBeenCalledWith(
      {
        id: expect.any(String),
        eventId: savedEntry.eventId,
      },
      transaction,
    );
  });
});
