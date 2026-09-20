import {
  HttpStatus,
  NotFoundException,
  type INestApplication,
  VersioningType,
} from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventsController } from '../../src/events/api/events.controller.ts';
import type {
  Event,
  EventWithAttempts,
} from '../../src/events/domain/interfaces/events.repository.ts';
import {
  EVENTS_SERVICE,
  type EventsService,
} from '../../src/events/domain/interfaces/events.service.ts';
import type { Server } from 'node:http';

describe('EventsController', () => {
  let app: INestApplication<Server>;
  let controller: EventsController;
  const eventsService = {
    saveEvent: vi.fn(),
    getEvent: vi.fn(),
  } satisfies EventsService;

  beforeEach(async () => {
    eventsService.saveEvent.mockReset();
    eventsService.getEvent.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EventsController],
      providers: [
        {
          provide: EVENTS_SERVICE,
          useValue: eventsService,
        },
      ],
    }).compile();

    controller = module.get<EventsController>(EventsController);
    app = module.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI });
    await app.init();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('accepts an event for asynchronous processing', async () => {
    const body = {
      type: 'order.created',
      payload: {
        orderId: 'order-id',
        amount: 100,
        currency: 'USD',
      },
    };
    const savedEvent: Event = {
      id: 'event-id',
      ...body,
      targetUrl: 'string',
      status: 'pending',
      createdAt: new Date(),
      deliveredAt: null,
    };
    eventsService.saveEvent.mockResolvedValueOnce(savedEvent);

    const response = await request(app.getHttpServer())
      .post('/v1/events')
      .send(body)
      .expect(HttpStatus.ACCEPTED);

    expect(response.body).toMatchObject({
      id: savedEvent.id,
      type: savedEvent.type,
      status: savedEvent.status,
    });
    expect(eventsService.saveEvent).toHaveBeenCalledWith(body);
  });

  it('returns an event with its ordered delivery attempt history', async () => {
    const eventId = 'e9c5697d-d4c2-4445-893b-65e27f836dda';
    const event: EventWithAttempts = {
      id: eventId,
      type: 'order.created',
      payload: {
        orderId: 'order-id',
        amount: 100,
        currency: 'USD',
      },
      targetUrl: 'https://example.com/webhooks',
      status: 'failed',
      createdAt: new Date('2026-09-12T10:00:00.000Z'),
      deliveredAt: null,
      attempts: [
        {
          id: '1f1f96aa-ec3d-4fd2-ab58-f706aeaa5ee3',
          eventId,
          status: 'failed',
          startedAt: new Date('2026-09-12T10:00:01.000Z'),
          finishedAt: new Date('2026-09-12T10:00:11.000Z'),
          httpStatus: 500,
          errorCode: 'HTTP_ERROR',
          errorMessage: 'Internal Server Error',
        },
        {
          id: '83afeffc-87f2-43d1-aea1-c5555cd193e4',
          eventId,
          status: 'failed',
          startedAt: new Date('2026-09-12T10:01:00.000Z'),
          finishedAt: new Date('2026-09-12T10:01:10.000Z'),
          httpStatus: null,
          errorCode: 'TIMEOUT',
          errorMessage: 'Request timed out',
        },
      ],
    };
    eventsService.getEvent.mockResolvedValueOnce(event);

    const response = await request(app.getHttpServer())
      .get(`/v1/events/${eventId}`)
      .expect(HttpStatus.OK);

    expect(response.body).toStrictEqual({
      ...event,
      createdAt: event.createdAt.toISOString(),
      deliveredAt: null,
      attempts: event.attempts.map((attempt) => ({
        ...attempt,
        startedAt: attempt.startedAt.toISOString(),
        finishedAt: attempt.finishedAt?.toISOString() ?? null,
      })),
    });
    expect(eventsService.getEvent).toHaveBeenCalledWith(eventId);
  });

  it('returns 404 when an event does not exist', async () => {
    const eventId = 'e9c5697d-d4c2-4445-893b-65e27f836dda';
    eventsService.getEvent.mockRejectedValueOnce(
      new NotFoundException(`Event ${eventId} not found`),
    );

    const response = await request(app.getHttpServer())
      .get(`/v1/events/${eventId}`)
      .expect(HttpStatus.NOT_FOUND);

    expect(response.body).toMatchObject({
      statusCode: HttpStatus.NOT_FOUND,
      message: `Event ${eventId} not found`,
    });
    expect(eventsService.getEvent).toHaveBeenCalledWith(eventId);
  });

  it('rejects an invalid event id before calling the service', async () => {
    await request(app.getHttpServer())
      .get('/v1/events/not-a-uuid')
      .expect(HttpStatus.BAD_REQUEST);

    expect(eventsService.getEvent).not.toHaveBeenCalled();
  });

  afterEach(async () => {
    await app.close();
  });
});
