import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../../libs/database/src/database.service.js';
import { schema } from '../../../../libs/database/src/schema.js';
import { EventsRepositoryImpl } from '../../src/events/domain/events.repository.ts';

const event = {
  id: 'e9c5697d-d4c2-4445-893b-65e27f836dda',
  type: 'order.created',
  payload: { orderId: 'order-id' },
  targetUrl: 'https://example.com/webhooks',
  status: 'failed',
  createdAt: new Date('2026-09-12T10:00:00.000Z'),
  deliveredAt: null,
};

const firstAttempt = {
  id: '1f1f96aa-ec3d-4fd2-ab58-f706aeaa5ee3',
  eventId: event.id,
  status: 'failed' as const,
  startedAt: new Date('2026-09-12T10:00:01.000Z'),
  finishedAt: new Date('2026-09-12T10:00:11.000Z'),
  httpStatus: 500,
  errorCode: 'HTTP_ERROR',
  errorMessage: 'Internal Server Error',
};

const secondAttempt = {
  id: '83afeffc-87f2-43d1-aea1-c5555cd193e4',
  eventId: event.id,
  status: 'failed' as const,
  startedAt: new Date('2026-09-12T10:01:00.000Z'),
  finishedAt: new Date('2026-09-12T10:01:10.000Z'),
  httpStatus: null,
  errorCode: 'TIMEOUT',
  errorMessage: 'Request timed out',
};

function createHarness(rows: unknown[]) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ orderBy });
  const leftJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ leftJoin });
  const select = vi.fn().mockReturnValue({ from });
  const database = {
    db: { select },
  };
  const repository = new EventsRepositoryImpl(
    database as unknown as DatabaseService,
  );

  return { from, leftJoin, orderBy, repository, select, where };
}

describe('EventsRepositoryImpl.findById', () => {
  it('returns the event and its delivery attempts in query order', async () => {
    const { from, leftJoin, orderBy, repository, select, where } =
      createHarness([
        { event, attempt: firstAttempt },
        { event, attempt: secondAttempt },
      ]);

    await expect(repository.findById(event.id)).resolves.toStrictEqual({
      ...event,
      attempts: [firstAttempt, secondAttempt],
    });

    expect(select).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledWith(schema.events);
    expect(leftJoin).toHaveBeenCalledWith(
      schema.deliveryAttempts,
      expect.anything(),
    );
    expect(where).toHaveBeenCalledOnce();
    expect(orderBy).toHaveBeenCalledWith(expect.anything(), expect.anything());
  });

  it('returns an empty history when the event has no attempts', async () => {
    const { repository } = createHarness([{ event, attempt: null }]);

    await expect(repository.findById(event.id)).resolves.toStrictEqual({
      ...event,
      attempts: [],
    });
  });

  it('returns null when the event does not exist', async () => {
    const { repository } = createHarness([]);

    await expect(repository.findById(event.id)).resolves.toBeNull();
  });
});
