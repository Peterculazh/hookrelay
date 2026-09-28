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
  it('does not change the event when a superseded execution tries to finalize', async () => {
    const database = createDatabaseMock();
    const staleAttempt = createUpdateChain([]);
    const update = vi.fn().mockReturnValue(staleAttempt.builder);
    database.transaction.mockImplementation(async (operation) =>
      operation({ update }),
    );
    const repository = new EventDeliveryRepository(
      database as unknown as DatabaseService,
    );

    await expect(
      repository.markSucceededAndDelivered(attemptId, eventId, 204, finishedAt),
    ).rejects.toThrow('was not marked succeeded');
    expect(update).toHaveBeenCalledOnce();
    update.mockClear();
    await expect(
      repository.markFailed(
        attemptId,
        eventId,
        {
          httpStatus: null,
          errorCode: 'NETWORK_ERROR',
          errorMessage: 'late failure',
        },
        finishedAt,
        'failed',
      ),
    ).rejects.toThrow('was not marked failed');
    expect(update).toHaveBeenCalledOnce();
  });

  it('propagates an insertion failure through the reconciliation transaction', async () => {
    const database = createDatabaseMock();
    const interrupted = createUpdateChain([]);
    database.db.update.mockReturnValue(interrupted.builder);
    const insert = createInsertChain([]);
    insert.returning.mockRejectedValueOnce(new Error('insert failed'));
    database.db.insert.mockReturnValue(insert.builder);
    database.transaction.mockImplementation(async (operation) =>
      operation(database.db),
    );
    const repository = new EventDeliveryRepository(
      database as unknown as DatabaseService,
    );
    await expect(repository.startAttempt(eventId, startedAt)).rejects.toThrow(
      'insert failed',
    );
    expect(database.transaction).toHaveBeenCalledOnce();
  });
  it('creates an in-progress attempt with empty result fields', async () => {
    const database = createDatabaseMock();
    const insert = createInsertChain([{ id: attemptId }]);
    database.db.insert.mockReturnValue(insert.builder);
    const interrupted = createUpdateChain([]);
    database.db.update.mockReturnValue(interrupted.builder);
    database.transaction.mockImplementation(async (operation) =>
      operation(database.db),
    );
    const repository = new EventDeliveryRepository(
      database as unknown as DatabaseService,
    );

    await expect(repository.startAttempt(eventId, startedAt)).resolves.toBe(
      attemptId,
    );

    expect(database.db.insert).toHaveBeenCalledWith(schema.deliveryAttempts);
    expect(database.transaction).toHaveBeenCalledOnce();
    expect(interrupted.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'INTERRUPTED',
        httpStatus: null,
        finishedAt: startedAt,
      }),
    );
    expect(database.db.update.mock.invocationCallOrder[0]).toBeLessThan(
      database.db.insert.mock.invocationCallOrder[0],
    );
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
