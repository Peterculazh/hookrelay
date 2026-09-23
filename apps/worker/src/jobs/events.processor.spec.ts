import type { Job } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PUBLISH_EVENT_JOB,
  type PublishEventJobData,
} from '@app/queue';
import type { EventDeliveryRepository } from './event-delivery.repository.js';
import { EventsProcessor } from './events.processor.js';
import { workerMetrics } from '../../../../libs/observability/src/metrics.js';

const now = new Date('2026-09-12T10:00:00.000Z');
const attemptId = '83afeffc-87f2-43d1-aea1-c5555cd193e4';

const jobData: PublishEventJobData = {
  event: {
    id: 'e9c5697d-d4c2-4445-893b-65e27f836dda',
    type: 'order.created',
    payload: {
      orderId: 'order-1',
      amount: 125,
      currency: 'USD',
    },
    targetUrl: 'https://example.com/webhooks',
    createdAt: '2026-09-11T12:00:00.000Z',
  },
};

interface JobOverrides {
  readonly name?: string;
  readonly attemptsMade?: number;
  readonly attempts?: number;
}

function createJob({
  name = PUBLISH_EVENT_JOB,
  attemptsMade = 0,
  attempts = 3,
}: JobOverrides = {}) {
  return {
    id: jobData.event.id,
    name,
    data: jobData,
    attemptsMade,
    opts: { attempts },
  } as Job<PublishEventJobData, void, string>;
}

describe('EventsProcessor', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let eventDeliveryRepository: {
    startAttempt: ReturnType<typeof vi.fn>;
    markSucceededAndDelivered: ReturnType<typeof vi.fn>;
    markFailed: ReturnType<typeof vi.fn>;
  };
  let processor: EventsProcessor;

  beforeEach(() => {
    workerMetrics.registry.resetMetrics();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    eventDeliveryRepository = {
      startAttempt: vi.fn().mockResolvedValue(attemptId),
      markSucceededAndDelivered: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
    };
    processor = new EventsProcessor(
      eventDeliveryRepository as unknown as EventDeliveryRepository,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts the queued event snapshot to its target URL', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(processor.process(createJob())).resolves.toBeUndefined();

    expect(eventDeliveryRepository.startAttempt).toHaveBeenCalledWith(
      jobData.event.id,
      now,
    );
    expect(fetchMock).toHaveBeenCalledWith(jobData.event.targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: jobData.event.id,
        type: jobData.event.type,
        payload: jobData.event.payload,
        createdAt: jobData.event.createdAt,
      }),
      signal: expect.any(AbortSignal),
    });
    expect(
      eventDeliveryRepository.startAttempt.mock.invocationCallOrder[0],
    ).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
    expect(
      eventDeliveryRepository.markSucceededAndDelivered,
    ).toHaveBeenCalledWith(attemptId, jobData.event.id, 204, now);
    expect(eventDeliveryRepository.markFailed).not.toHaveBeenCalled();
  });

  it('keeps the event pending when BullMQ will retry an HTTP failure', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    );

    await expect(processor.process(createJob())).rejects.toThrow(
      'responded with 500 Internal Server Error',
    );

    expect(eventDeliveryRepository.markFailed).toHaveBeenCalledWith(
      attemptId,
      jobData.event.id,
      {
        httpStatus: 500,
        errorCode: 'HTTP_ERROR',
        errorMessage: `Webhook for event ${jobData.event.id} responded with 500 Internal Server Error`,
      },
      now,
      'pending',
    );
    expect(
      eventDeliveryRepository.markSucceededAndDelivered,
    ).not.toHaveBeenCalled();
  });

  it('records and propagates network errors so BullMQ can retry the job', async () => {
    const error = new TypeError('fetch failed');
    fetchMock.mockRejectedValueOnce(error);

    await expect(processor.process(createJob())).rejects.toBe(error);

    expect(eventDeliveryRepository.markFailed).toHaveBeenCalledWith(
      attemptId,
      jobData.event.id,
      {
        httpStatus: null,
        errorCode: 'NETWORK_ERROR',
        errorMessage: 'fetch failed',
      },
      now,
      'pending',
    );
  });

  it('marks the event failed when a timeout exhausts BullMQ retries', async () => {
    const error = new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError',
    );
    fetchMock.mockRejectedValueOnce(error);

    await expect(
      processor.process(createJob({ attemptsMade: 2, attempts: 3 })),
    ).rejects.toBe(error);

    expect(eventDeliveryRepository.markFailed).toHaveBeenCalledWith(
      attemptId,
      jobData.event.id,
      {
        httpStatus: null,
        errorCode: 'TIMEOUT',
        errorMessage: 'The operation was aborted due to timeout',
      },
      now,
      'failed',
    );
    expect(
      eventDeliveryRepository.markSucceededAndDelivered,
    ).not.toHaveBeenCalled();
  });

  it('does not send the webhook when starting its attempt fails', async () => {
    const error = new Error('Database unavailable');
    eventDeliveryRepository.startAttempt.mockRejectedValueOnce(error);

    await expect(processor.process(createJob())).rejects.toBe(error);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(eventDeliveryRepository.markFailed).not.toHaveBeenCalled();
  });

  it('rejects unsupported job names without making a request', async () => {
    await expect(
      processor.process(createJob({ name: 'delete-event' })),
    ).rejects.toThrow('Unsupported events job: delete-event');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(eventDeliveryRepository.startAttempt).not.toHaveBeenCalled();
  });

  it.each([
    ['succeeded', 204, undefined],
    ['failed', 503, undefined],
    ['failed', undefined, new TypeError('fetch failed')],
    ['failed', undefined, new DOMException('timeout', 'TimeoutError')],
  ] as const)(
    'counts a %s receiver outcome once (status %s)',
    async (outcome, status, error) => {
      vi.spyOn(performance, 'now')
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(350);
      if (error) fetchMock.mockRejectedValueOnce(error);
      else fetchMock.mockResolvedValueOnce(new Response(null, { status }));
      await processor.process(createJob()).catch(() => undefined);
      const counter = await workerMetrics.attempts.get();
      expect(counter.values).toEqual([
        expect.objectContaining({ labels: { outcome }, value: 1 }),
      ]);
      const histogram = await workerMetrics.webhookDuration.get();
      expect(histogram.values).toContainEqual(
        expect.objectContaining({
          metricName: 'hookrelay_webhook_request_duration_seconds_sum',
          labels: { outcome },
          value: 0.25,
        }),
      );
    },
  );

  it('retains the receiver outcome metric when database finalization fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    eventDeliveryRepository.markSucceededAndDelivered.mockRejectedValueOnce(
      new Error('DB down'),
    );
    await expect(processor.process(createJob())).rejects.toThrow('DB down');
    expect((await workerMetrics.attempts.get()).values).toEqual([
      expect.objectContaining({ labels: { outcome: 'succeeded' }, value: 1 }),
    ]);
  });

  it('rejects legacy jobs that do not contain an event snapshot', async () => {
    const job = {
      id: jobData.event.id,
      name: PUBLISH_EVENT_JOB,
      data: { eventId: jobData.event.id },
    } as unknown as Job<PublishEventJobData, void, string>;

    await expect(processor.process(job)).rejects.toThrow(
      `Event data is missing from job ${jobData.event.id}`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(eventDeliveryRepository.startAttempt).not.toHaveBeenCalled();
  });
});
