import { Logger } from '@nestjs/common';
import type { TransactionContext, UnitOfWork } from '@app/database';
import type { Queue } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUBLISH_EVENT_JOB, type PublishEventJobData } from '@app/queue';
import type {
  OutboxRepository,
  UnpublishedOutboxEntry,
} from './outbox.repository.js';
import { ScheduleService } from './schedule.service.js';

const firstEntry: UnpublishedOutboxEntry = {
  id: '4a597799-4675-43cb-9ed9-260fa49540f1',
  event: {
    id: 'e9c5697d-d4c2-4445-893b-65e27f836dda',
    type: 'order.created',
    payload: { orderId: 'order-1' },
    targetUrl: 'https://example.com/webhooks',
    createdAt: new Date('2026-09-11T12:00:00.000Z'),
  },
};

const secondEntry: UnpublishedOutboxEntry = {
  id: '1f1f96aa-ec3d-4fd2-ab58-f706aeaa5ee3',
  event: {
    id: '006d5ce1-a86e-4f0a-bbc9-4cf90a408c80',
    type: 'order.updated',
    payload: { orderId: 'order-2' },
    targetUrl: 'https://example.com/webhooks',
    createdAt: new Date('2026-09-11T12:01:00.000Z'),
  },
};

const firstJobData: PublishEventJobData = {
  event: {
    ...firstEntry.event,
    createdAt: firstEntry.event.createdAt.toISOString(),
  },
};

function createHarness(entries: UnpublishedOutboxEntry[]) {
  const transaction = {} as TransactionContext;
  const outboxRepository = {
    findUnpublishedForUpdate: vi.fn().mockResolvedValue(entries),
    markPublished: vi.fn().mockResolvedValue(undefined),
  };
  const eventsQueue = {
    add: vi.fn().mockResolvedValue(undefined),
  };
  const unitOfWork = {
    run: vi.fn(
      async (
        operation: (transaction: TransactionContext) => Promise<unknown>,
      ) => operation(transaction),
    ),
  };
  const service = new ScheduleService(
    unitOfWork as unknown as UnitOfWork,
    outboxRepository as unknown as OutboxRepository,
    eventsQueue as unknown as Queue<PublishEventJobData>,
  );

  return {
    eventsQueue,
    outboxRepository,
    service,
    transaction,
    unitOfWork,
  };
}

describe('ScheduleService', () => {
  it('drains an active publication before shutdown and rejects new batches', async () => {
    const { service, eventsQueue, outboxRepository } = createHarness([
      firstEntry,
    ]);
    let release!: () => void;
    eventsQueue.add.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const batch = service.handleCron();
    await vi.waitFor(() => expect(eventsQueue.add).toHaveBeenCalledOnce());
    let drained = false;
    const shutdown = service.onModuleDestroy().then(() => {
      drained = true;
    });
    await service.handleCron();
    expect(drained).toBe(false);
    expect(outboxRepository.markPublished).not.toHaveBeenCalled();
    release();
    await Promise.all([batch, shutdown]);
    expect(drained).toBe(true);
    expect(outboxRepository.markPublished).toHaveBeenCalledOnce();
    await service.handleCron();
    expect(eventsQueue.add).toHaveBeenCalledOnce();
  });
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('uses the configured bounded batch size', async () => {
    vi.stubEnv('RELAY_BATCH_SIZE', '250');
    const { service, outboxRepository, transaction } = createHarness([]);
    await service.handleCron();
    expect(outboxRepository.findUnpublishedForUpdate).toHaveBeenCalledWith(
      transaction,
      250,
    );
  });

  it('does not overlap publication while a queue operation is in flight', async () => {
    const { service, eventsQueue, unitOfWork } = createHarness([firstEntry]);
    let release!: () => void;
    eventsQueue.add.mockReturnValueOnce(
      new Promise<void>((done) => {
        release = done;
      }),
    );
    const batch = service.handleCron();
    await vi.waitFor(() => expect(eventsQueue.add).toHaveBeenCalledOnce());
    await service.handleCron();
    expect(unitOfWork.run).toHaveBeenCalledOnce();
    release();
    await batch;
    await service.handleCron();
    expect(unitOfWork.run).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the outbox has no unpublished events', async () => {
    const { eventsQueue, outboxRepository, service } = createHarness([]);

    await service.handleCron();

    expect(eventsQueue.add).not.toHaveBeenCalled();
    expect(outboxRepository.markPublished).not.toHaveBeenCalled();
  });

  it('adds a job with the event id before marking the outbox entry published', async () => {
    const { eventsQueue, outboxRepository, service, transaction } =
      createHarness([firstEntry]);

    await service.handleCron();

    expect(outboxRepository.findUnpublishedForUpdate).toHaveBeenCalledWith(
      transaction,
      100,
    );
    expect(eventsQueue.add).toHaveBeenCalledWith(
      PUBLISH_EVENT_JOB,
      firstJobData,
      {
        jobId: firstEntry.event.id,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5_000,
        },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
    expect(outboxRepository.markPublished).toHaveBeenCalledWith(
      firstEntry.id,
      transaction,
    );
    expect(eventsQueue.add.mock.invocationCallOrder[0]).toBeLessThan(
      outboxRepository.markPublished.mock.invocationCallOrder[0],
    );
  });

  it('leaves an entry unpublished when adding its job fails', async () => {
    const { eventsQueue, outboxRepository, service } = createHarness([
      firstEntry,
    ]);
    eventsQueue.add.mockRejectedValueOnce(new Error('Redis unavailable'));

    await expect(service.handleCron()).resolves.toBeUndefined();

    expect(outboxRepository.markPublished).not.toHaveBeenCalled();
  });

  it('continues publishing later entries after one queue failure', async () => {
    const { eventsQueue, outboxRepository, service, transaction } =
      createHarness([firstEntry, secondEntry]);
    eventsQueue.add.mockRejectedValueOnce(new Error('Redis unavailable'));

    await service.handleCron();

    expect(eventsQueue.add).toHaveBeenCalledTimes(2);
    expect(outboxRepository.markPublished).toHaveBeenCalledOnce();
    expect(outboxRepository.markPublished).toHaveBeenCalledWith(
      secondEntry.id,
      transaction,
    );
  });

  it('reuses the same job id when marking the entry fails and the batch retries', async () => {
    const { eventsQueue, outboxRepository, service } = createHarness([
      firstEntry,
    ]);
    outboxRepository.markPublished
      .mockRejectedValueOnce(new Error('Database unavailable'))
      .mockResolvedValueOnce(undefined);

    await expect(service.handleCron()).rejects.toThrow('Database unavailable');
    await expect(service.handleCron()).resolves.toBeUndefined();

    expect(eventsQueue.add).toHaveBeenCalledTimes(2);
    expect(eventsQueue.add).toHaveBeenNthCalledWith(
      1,
      PUBLISH_EVENT_JOB,
      firstJobData,
      expect.objectContaining({ jobId: firstEntry.event.id }),
    );
    expect(eventsQueue.add).toHaveBeenNthCalledWith(
      2,
      PUBLISH_EVENT_JOB,
      firstJobData,
      expect.objectContaining({ jobId: firstEntry.event.id }),
    );
  });
});
