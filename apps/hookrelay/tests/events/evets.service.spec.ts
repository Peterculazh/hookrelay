import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TransactionContext,
  UnitOfWork,
} from '../../../../libs/database/src/index.ts';
import { EventsServiceImpl } from '../../src/events/domain/events.service.ts';
import {
  EVENTS_REPOSITORY,
  type Event,
  type EventsRepository,
  type EventWithAttempts,
} from '../../src/events/domain/interfaces/events.repository.ts';
import { OutboxService } from '../../src/outbox/domain/outbox.service.ts';
import type {
  EventsService,
  SaveEventInput,
} from '../../src/events/domain/interfaces/events.service.ts';

class TestTransactionContext extends TransactionContext {}

describe('EventsService', () => {
  let service: EventsService;
  const transaction = new TestTransactionContext();
  const eventsRepository = {
    save: vi.fn(),
    findById: vi.fn(),
  } satisfies EventsRepository;
  const unitOfWork = {
    async run<T>(
      operation: (transaction: TransactionContext) => Promise<T>,
    ): Promise<T> {
      return operation(transaction);
    },
  } satisfies UnitOfWork;

  const runSpy = vi.spyOn(unitOfWork, 'run');
  const outboxService = {
    enqueue: vi.fn(),
  } satisfies Pick<OutboxService, 'enqueue'>;

  beforeEach(async () => {
    eventsRepository.save.mockReset();
    eventsRepository.findById.mockReset();
    runSpy.mockClear();
    outboxService.enqueue.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsServiceImpl,
        {
          provide: EVENTS_REPOSITORY,
          useValue: eventsRepository,
        },
        {
          provide: UnitOfWork,
          useValue: unitOfWork,
        },
        {
          provide: OutboxService,
          useValue: outboxService,
        },
      ],
    }).compile();

    service = module.get<EventsServiceImpl>(EventsServiceImpl);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('saves the event inside the unit of work transaction', async () => {
    const body: SaveEventInput = {
      type: 'order.created',
      payload: {
        orderId: 'order-id',
        amount: 100,
        currency: 'USD',
      },
    };
    const savedEvent: Event = {
      id: 'event-id',
      type: body.type,
      payload: body.payload,
      targetUrl: 'string',
      status: 'pending',
      createdAt: new Date(),
      deliveredAt: null,
    };
    eventsRepository.save.mockResolvedValueOnce(savedEvent);

    await expect(service.saveEvent(body)).resolves.toBe(savedEvent);

    expect(runSpy).toHaveBeenCalledOnce();
    expect(eventsRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: savedEvent.type,
        payload: savedEvent.payload,
        status: 'pending',
        targetUrl: 'string',
      }),
      transaction,
    );
    expect(outboxService.enqueue).toHaveBeenCalledWith(
      savedEvent.id,
      transaction,
    );
  });

  it('propagates an outbox failure through the unit of work', async () => {
    const body: SaveEventInput = {
      type: 'order.created',
      payload: {
        orderId: 'order-id',
        amount: 100,
        currency: 'USD',
      },
    };
    const savedEvent: Event = {
      id: 'event-id',
      type: body.type,
      payload: body.payload,
      targetUrl: 'string',
      status: 'pending',
      createdAt: new Date(),
      deliveredAt: null,
    };
    const error = new Error('Failed to persist outbox entry');
    eventsRepository.save.mockResolvedValueOnce(savedEvent);
    outboxService.enqueue.mockRejectedValueOnce(error);

    await expect(service.saveEvent(body)).rejects.toBe(error);

    expect(eventsRepository.save).toHaveBeenCalledOnce();
    expect(outboxService.enqueue).toHaveBeenCalledWith(
      savedEvent.id,
      transaction,
    );
  });

  it('returns an event with its delivery attempts', async () => {
    const event: EventWithAttempts = {
      id: 'e9c5697d-d4c2-4445-893b-65e27f836dda',
      type: 'order.created',
      payload: { orderId: 'order-id' },
      targetUrl: 'https://example.com/webhooks',
      status: 'failed',
      createdAt: new Date('2026-09-12T10:00:00.000Z'),
      deliveredAt: null,
      attempts: [],
    };
    eventsRepository.findById.mockResolvedValueOnce(event);

    await expect(service.getEvent(event.id)).resolves.toBe(event);

    expect(eventsRepository.findById).toHaveBeenCalledWith(event.id);
  });

  it('throws a not-found error when an event does not exist', async () => {
    const eventId = 'e9c5697d-d4c2-4445-893b-65e27f836dda';
    eventsRepository.findById.mockResolvedValueOnce(null);

    await expect(service.getEvent(eventId)).rejects.toEqual(
      new NotFoundException(`Event ${eventId} not found`),
    );
  });
});
