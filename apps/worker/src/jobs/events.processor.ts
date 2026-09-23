import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import {
  EVENTS_QUEUE,
  PUBLISH_EVENT_JOB,
  type PublishEventJobData,
} from '../queue/queue.constants.js';
import { EventDeliveryRepository } from './event-delivery.repository.js';
import { createLogger } from '../../../../libs/observability/src/logger.js';
import { workerMetrics } from '../../../../libs/observability/src/metrics.js';

const WEBHOOK_TIMEOUT_MS = 10_000;
const HTTP_ERROR = 'HTTP_ERROR';
const TIMEOUT = 'TIMEOUT';
const NETWORK_ERROR = 'NETWORK_ERROR';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === 'TimeoutError' || error.name === 'AbortError';
}

function eventStatusAfterFailure(
  job: Job<PublishEventJobData, void, string>,
): 'pending' | 'failed' {
  const totalAttempts = Math.max(job.opts.attempts ?? 1, 1);

  return job.attemptsMade + 1 < totalAttempts ? 'pending' : 'failed';
}

@Processor(EVENTS_QUEUE)
export class EventsProcessor extends WorkerHost {
  private readonly logger = createLogger('worker');

  @OnWorkerEvent('failed')
  onFailed(job: Job<PublishEventJobData> | undefined, err: Error) {
    this.logger.error({
      action: 'job.failed',
      eventId: job?.data?.event?.id ?? null,
      jobId: job?.id ?? null,
      attemptId: null,
      attemptNumber: job?.attemptsMade,
      errorCode: 'JOB_FAILED',
      err,
    });
  }

  @OnWorkerEvent('error')
  onError(err: Error) {
    this.logger.error({
      action: 'worker.error',
      errorCode: 'WORKER_ERROR',
      err,
    });
  }

  constructor(
    private readonly eventDeliveryRepository: EventDeliveryRepository,
  ) {
    super();
  }

  override async process(
    job: Job<PublishEventJobData, void, string>,
  ): Promise<void> {
    if (job.name !== PUBLISH_EVENT_JOB) {
      throw new UnrecoverableError(`Unsupported events job: ${job.name}`);
    }

    const queuedEvent = job.data?.event;
    if (!queuedEvent) {
      throw new UnrecoverableError(
        `Event data is missing from job ${job.id ?? 'unknown'}`,
      );
    }

    const { targetUrl, ...event } = queuedEvent;
    const attemptId = await this.eventDeliveryRepository.startAttempt(
      event.id,
      new Date(),
    );

    this.logger.info({
      action: 'delivery.started',
      eventId: event.id,
      jobId: job.id,
      attemptId,
      attemptNumber: job.attemptsMade + 1,
    });

    let response: Response;
    const started = performance.now();
    try {
      response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
    } catch (error) {
      const durationMs = performance.now() - started;
      workerMetrics.observeDelivery('failed', durationMs / 1000);
      const eventStatus = eventStatusAfterFailure(job);
      const errorCode = isTimeoutError(error) ? TIMEOUT : NETWORK_ERROR;

      await this.eventDeliveryRepository.markFailed(
        attemptId,
        event.id,
        {
          httpStatus: null,
          errorCode: errorCode,
          errorMessage: errorMessage(error),
        },
        new Date(),
        eventStatus,
      );

      const failureLog = {
        action: 'delivery.failed',
        eventId: event.id,
        jobId: job.id,
        attemptId,
        attemptNumber: job.attemptsMade + 1,
        httpStatus: null,
        errorCode,
        eventStatus,
        durationMs,
      };

      if (eventStatus === 'failed') {
        this.logger.error(failureLog);
      } else {
        this.logger.warn(failureLog);
      }

      throw error;
    }

    const durationMs = performance.now() - started;
    workerMetrics.observeDelivery(
      response.ok ? 'succeeded' : 'failed',
      durationMs / 1000,
    );
    await response.body?.cancel().catch(() => undefined);

    if (!response.ok) {
      const status = `${response.status} ${response.statusText}`.trim();
      const error = new Error(
        `Webhook for event ${event.id} responded with ${status}`,
      );

      const eventStatus = eventStatusAfterFailure(job);
      const errorCode = HTTP_ERROR;

      await this.eventDeliveryRepository.markFailed(
        attemptId,
        event.id,
        {
          httpStatus: response.status,
          errorCode: errorCode,
          errorMessage: error.message,
        },
        new Date(),
        eventStatus,
      );

      const failureLog = {
        action: 'delivery.failed',
        eventId: event.id,
        jobId: job.id,
        attemptId,
        attemptNumber: job.attemptsMade + 1,
        httpStatus: response.status,
        errorCode,
        eventStatus,
        durationMs,
      };

      if (eventStatus === 'failed') {
        this.logger.error(failureLog);
      } else {
        this.logger.warn(failureLog);
      }

      throw error;
    }

    await this.eventDeliveryRepository.markSucceededAndDelivered(
      attemptId,
      event.id,
      response.status,
      new Date(),
    );

    this.logger.info({
      action: 'delivery.succeeded',
      eventId: event.id,
      jobId: job.id,
      attemptId,
      attemptNumber: job.attemptsMade + 1,
      httpStatus: response.status,
      durationMs,
    });
  }
}
