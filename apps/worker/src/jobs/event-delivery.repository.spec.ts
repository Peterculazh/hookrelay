import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../../libs/database/src/database.service.js';
import { schema } from '../../../../libs/database/src/schema.js';
import { EventDeliveryRepository } from './event-delivery.repository.js';

const eventId = 'e9c5697d-d4c2-4445-893b-65e27f836dda';
const attemptId = '83afeffc-87f2-43d1-aea1-c5555cd193e4';
const startedAt = new Date('2026-09-12T10:00:00.000Z');
const finishedAt = new Date('2026-09-12T10:00:01.000Z');

function createInsertChain(result: unknown[]) {
  const returning = vi.fn().mockResolvedValue(result);
  const values = vi.fn().mockReturnValue({ returning });

  return {
    builder: { values },
    returning,
    values,
  };
}

function createUpdateChain(result: unknown[]) {
  const returning = vi.fn().mockResolvedValue(result);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });

  return {
    builder: { set },
    returning,
    set,
    where,
  };
}

function createDatabaseMock() {
  return {
    db: {
      insert: vi.fn(),
      update: vi.fn(),
    },
    transaction: vi.fn(),
  };
}

describe('EventDeliveryRepository', () => {
  it('creates an in-progress attempt with empty result fields', async () => {
    const database = createDatabaseMock();
    const insert = createInsertChain([{ id: attemptId }]);
    database.db.insert.mockReturnValue(insert.builder);
    const repository = new EventDeliveryRepository(
      database as unknown as DatabaseService,
    );

    await expect(repository.startAttempt(eventId, startedAt)).resolves.toBe(
      attemptId,
    );

    expect(database.db.insert).toHaveBeenCalledWith(schema.deliveryAttempts);
    expect(insert.values).toHaveBeenCalledWith({
      eventId,
      status: 'in_progress',
      startedAt,
      finishedAt: null,
      httpStatus: null,
      errorCode: null,
      errorMessage: null,
    });
  });

  it('atomically succeeds the attempt and marks the event delivered', async () => {
    const database = createDatabaseMock();
    const attemptUpdate = createUpdateChain([{ id: attemptId }]);
    const eventUpdate = createUpdateChain([{ id: eventId }]);
    const transaction = {
      update: vi
        .fn()
        .mockReturnValueOnce(attemptUpdate.builder)
        .mockReturnValueOnce(eventUpdate.builder),
    };
    database.transaction.mockImplementation(async (operation) =>
      operation(transaction),
    );
    const repository = new EventDeliveryRepository(
      database as unknown as DatabaseService,
    );

    await repository.markSucceededAndDelivered(
      attemptId,
      eventId,
      204,
      finishedAt,
    );

    expect(database.transaction).toHaveBeenCalledOnce();
    expect(transaction.update).toHaveBeenNthCalledWith(
      1,
      schema.deliveryAttempts,
    );
    expect(attemptUpdate.set).toHaveBeenCalledWith({
      status: 'succeeded',
      finishedAt,
      httpStatus: 204,
      errorCode: null,
      errorMessage: null,
    });
    expect(transaction.update).toHaveBeenNthCalledWith(2, schema.events);
    expect(eventUpdate.set).toHaveBeenCalledWith({
      deliveredAt: finishedAt,
      status: 'delivered',
    });
  });

  it('atomically fails an HTTP attempt and marks the event failed', async () => {
    const database = createDatabaseMock();
    const attemptUpdate = createUpdateChain([{ id: attemptId }]);
    const eventUpdate = createUpdateChain([{ id: eventId }]);
    const transaction = {
      update: vi
        .fn()
        .mockReturnValueOnce(attemptUpdate.builder)
        .mockReturnValueOnce(eventUpdate.builder),
    };
    database.transaction.mockImplementation(async (operation) =>
      operation(transaction),
    );
    const repository = new EventDeliveryRepository(
      database as unknown as DatabaseService,
    );

    await repository.markFailed(
      attemptId,
      eventId,
      {
        httpStatus: 500,
        errorCode: 'HTTP_ERROR',
        errorMessage: 'Internal Server Error',
      },
      finishedAt,
      'failed',
    );

    expect(database.transaction).toHaveBeenCalledOnce();
    expect(transaction.update).toHaveBeenNthCalledWith(
      1,
      schema.deliveryAttempts,
    );
    expect(attemptUpdate.set).toHaveBeenCalledWith({
      status: 'failed',
      finishedAt,
      httpStatus: 500,
      errorCode: 'HTTP_ERROR',
      errorMessage: 'Internal Server Error',
    });
    expect(transaction.update).toHaveBeenNthCalledWith(2, schema.events);
    expect(eventUpdate.set).toHaveBeenCalledWith({ status: 'failed' });
  });

  it('keeps the event pending when a timed-out attempt will retry', async () => {
    const database = createDatabaseMock();
    const attemptUpdate = createUpdateChain([{ id: attemptId }]);
    const eventUpdate = createUpdateChain([{ id: eventId }]);
    const transaction = {
      update: vi
        .fn()
        .mockReturnValueOnce(attemptUpdate.builder)
        .mockReturnValueOnce(eventUpdate.builder),
    };
    database.transaction.mockImplementation(async (operation) =>
      operation(transaction),
    );
    const repository = new EventDeliveryRepository(
      database as unknown as DatabaseService,
    );

    await repository.markFailed(
      attemptId,
      eventId,
      {
        httpStatus: null,
        errorCode: 'TIMEOUT',
        errorMessage: 'Request timed out',
      },
      finishedAt,
      'pending',
    );

    expect(attemptUpdate.set).toHaveBeenCalledWith({
      status: 'failed',
      finishedAt,
      httpStatus: null,
      errorCode: 'TIMEOUT',
      errorMessage: 'Request timed out',
    });
    expect(eventUpdate.set).toHaveBeenCalledWith({ status: 'pending' });
  });
});
