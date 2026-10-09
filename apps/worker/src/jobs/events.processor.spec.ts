import { createHmac } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import type { Job, Worker } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUBLISH_EVENT_JOB, type PublishEventJobData } from '@app/queue';
import type { EventDeliveryRepository } from './event-delivery.repository.js';
import { EventsProcessor } from './events.processor.js';
import { SignatureGuard } from '../../../test-receiver/src/signature.guard.js';
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
    vi.unstubAllEnvs();
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

  it('adds the signer headers for the exact body it sends', async () => {
    const signatureHeaders = {
      'x-hookrelay-signature': 'v1=abc',
      'x-hookrelay-timestamp': '1789207200',
      'x-hookrelay-key-id': 'key-7',
    };
    const sign = vi.fn().mockResolvedValue(signatureHeaders);
    processor = new EventsProcessor(
      eventDeliveryRepository as unknown as EventDeliveryRepository,
      { sign },
    );
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await processor.process(createJob());

    const [, request] = fetchMock.mock.calls[0];
    expect(sign).toHaveBeenCalledWith(jobData.event.id, request.body);
    expect(request.headers).toEqual({
      'content-type': 'application/json',
      ...signatureHeaders,
    });
  });

  it('records a signer failure and retries without contacting the receiver', async () => {
    const error = new Error('14 UNAVAILABLE: No connection established');
    processor = new EventsProcessor(
      eventDeliveryRepository as unknown as EventDeliveryRepository,
      { sign: vi.fn().mockRejectedValue(error) },
    );

    await expect(processor.process(createJob())).rejects.toBe(error);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(eventDeliveryRepository.markFailed).toHaveBeenCalledWith(
      attemptId,
      jobData.event.id,
      {
        httpStatus: null,
        errorCode: 'SIGNER_ERROR',
        errorMessage: error.message,
      },
      now,
      'pending',
    );
    expect((await workerMetrics.attempts.get()).values).toEqual([]);
  });

  it('re-signs each retry with a fresh timestamp the receiver still accepts', async () => {
    const secret = 'worker-retry-signing-secret-0123456789';
    vi.stubEnv('WEBHOOK_SIGNING_SECRET', secret);
    // Signs like the signer service does, stamping the time of the call.
    const sign = vi.fn((_eventId: string, body: string) => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const digest = createHmac('sha256', secret)
        .update(`${timestamp}.${body}`)
        .digest('hex');
      return Promise.resolve({
        'x-hookrelay-signature': `v1=${digest}`,
        'x-hookrelay-timestamp': timestamp,
        'x-hookrelay-key-id': 'key-7',
      });
    });
    processor = new EventsProcessor(
      eventDeliveryRepository as unknown as EventDeliveryRepository,
      { sign },
    );
    // The receiver's own verification, run against what the worker put on the wire.
    const receiverAccepts = (sent: {
      headers: Record<string, string>;
      body: string;
    }) =>
      new SignatureGuard().canActivate({
        switchToHttp: () => ({
          getRequest: () => ({
            rawBody: Buffer.from(sent.body),
            header: (name: string) => sent.headers[name],
          }),
        }),
      } as unknown as ExecutionContext);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(processor.process(createJob())).rejects.toThrow(
      'responded with 500',
    );
    // The backoff outlasts the receiver's 300 s tolerance for the first signature.
    const retryAt = now.getTime() + 301_000;
    vi.setSystemTime(retryAt);
    await processor.process(createJob({ attemptsMade: 1 }));

    const [[, first], [, retry]] = fetchMock.mock.calls;
    expect(sign).toHaveBeenCalledTimes(2);
    expect(first.headers['x-hookrelay-timestamp']).toBe(
      String(now.getTime() / 1000),
    );
    expect(retry.headers['x-hookrelay-timestamp']).toBe(
      String(retryAt / 1000),
    );
    expect(receiverAccepts(retry)).toBe(true);
    expect(() => receiverAccepts(first)).toThrow(
      'Signature timestamp is out of range',
    );
  });

  it('waits for BullMQ to drain before completing module destruction', async () => {
    let release!: () => void;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    Object.defineProperty(processor, 'worker', {
      value: { close } as unknown as Worker,
    });
    let drained = false;
    const shutdown = processor.onModuleDestroy().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(close).toHaveBeenCalledWith();
    expect(drained).toBe(false);
    release();
    await shutdown;
    expect(drained).toBe(true);
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
      let elapsed = 100;
      vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
      fetchMock.mockImplementationOnce(() => {
        elapsed = 350;
        return error
          ? Promise.reject(error)
          : Promise.resolve(new Response(null, { status }));
      });
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
    expect((await workerMetrics.databaseDuration.get()).values).toContainEqual(
      expect.objectContaining({
        metricName: 'hookrelay_delivery_database_duration_seconds_count',
        labels: { phase: 'finalize', outcome: 'error' },
        value: 1,
      }),
    );
    expect(
      (await workerMetrics.processingDuration.get()).values,
    ).toContainEqual(
      expect.objectContaining({
        metricName: 'hookrelay_delivery_processing_duration_seconds_count',
        labels: { outcome: 'error' },
        value: 1,
      }),
    );
  });

  it('measures database phases and total processing separately from HTTP time', async () => {
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    eventDeliveryRepository.startAttempt.mockImplementationOnce(async () => {
      elapsed += 11;
      return attemptId;
    });
    fetchMock.mockImplementationOnce(async () => {
      elapsed += 17;
      return new Response(null, { status: 204 });
    });
    eventDeliveryRepository.markSucceededAndDelivered.mockImplementationOnce(
      async () => {
        elapsed += 23;
      },
    );
    await processor.process(createJob());
    const database = (await workerMetrics.databaseDuration.get()).values;
    for (const [phase, seconds] of [
      ['attempt_start', 0.011],
      ['finalize', 0.023],
    ]) {
      expect(database).toContainEqual(
        expect.objectContaining({
          metricName: 'hookrelay_delivery_database_duration_seconds_sum',
          labels: { phase, outcome: 'completed' },
          value: seconds,
        }),
      );
    }
    expect((await workerMetrics.webhookDuration.get()).values).toContainEqual(
      expect.objectContaining({
        metricName: 'hookrelay_webhook_request_duration_seconds_sum',
        labels: { outcome: 'succeeded' },
        value: 0.017,
      }),
    );
    expect(
      (await workerMetrics.processingDuration.get()).values,
    ).toContainEqual(
      expect.objectContaining({
        metricName: 'hookrelay_delivery_processing_duration_seconds_sum',
        labels: { outcome: 'completed' },
        value: 0.051,
      }),
    );
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
