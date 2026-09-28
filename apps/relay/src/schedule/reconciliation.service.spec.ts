import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '@app/database';
import type { Queue } from 'bullmq';
import type { PublishEventJobData } from '@app/queue';
import { ReconciliationService } from './reconciliation.service.js';

function harness(states: Array<string | undefined>) {
  const candidates = states.map((_, index) => ({ id: `event-${index}` }));
  const limit = vi.fn().mockResolvedValue(candidates);
  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi
        .fn()
        .mockReturnValue({ orderBy: vi.fn().mockReturnValue({ limit }) }),
    }),
  });
  const returning = vi.fn().mockResolvedValue([{ id: 'interrupted' }]);
  const set = vi
    .fn()
    .mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) });
  const update = vi.fn().mockReturnValue({ set });
  const transaction = vi.fn(async (operation) => operation({ update }));
  const getJob = vi.fn(async (id: string) => {
    const state = states[Number(id.split('-')[1])];
    return state ? { getState: vi.fn().mockResolvedValue(state) } : undefined;
  });
  const service = new ReconciliationService(
    { db: { select }, transaction } as unknown as DatabaseService,
    { getJob } as unknown as Queue<PublishEventJobData>,
  );
  return { service, getJob, transaction, update, set, limit };
}

describe('ReconciliationService', () => {
  it('leaves missing, waiting, delayed, and active jobs untouched', async () => {
    const { service, transaction } = harness([
      undefined,
      'waiting',
      'delayed',
      'active',
    ]);
    await service.handleCron();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('closes unknown attempts and marks a terminal failed event in one transaction', async () => {
    const { service, transaction, set } = harness(['failed']);
    await service.handleCron();
    expect(transaction).toHaveBeenCalledOnce();
    expect(set).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        status: 'failed',
        errorCode: 'INTERRUPTED',
        httpStatus: null,
      }),
    );
    expect(set).toHaveBeenNthCalledWith(2, { status: 'failed' });
  });

  it('cleans historical unfinished attempts without changing a completed event', async () => {
    const { service, set } = harness(['completed']);
    await service.handleCron();
    expect(set).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'INTERRUPTED' }),
    );
  });

  it('does not change database outcomes when Redis is unavailable', async () => {
    const { service, getJob, transaction } = harness(['failed']);
    getJob.mockRejectedValueOnce(new Error('Redis unavailable'));
    await expect(service.handleCron()).rejects.toThrow('Redis unavailable');
    expect(transaction).not.toHaveBeenCalled();
    await service.handleCron();
    expect(transaction).toHaveBeenCalledOnce();
  });

  it('stops scheduling and waits for the current reconciliation on shutdown', async () => {
    const { service, limit } = harness([]);
    let release!: (value: Array<{ id: string }>) => void;
    limit.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const batch = service.handleCron();
    let drained = false;
    const shutdown = service.onModuleDestroy().then(() => {
      drained = true;
    });
    await service.handleCron();
    expect(drained).toBe(false);
    release([]);
    await Promise.all([batch, shutdown]);
    expect(drained).toBe(true);
    await service.handleCron();
    expect(limit).toHaveBeenCalledOnce();
  });
});
