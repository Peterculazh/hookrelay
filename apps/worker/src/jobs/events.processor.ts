import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, type OnModuleDestroy } from '@nestjs/common';
import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import {
  EVENTS_QUEUE,
  PUBLISH_EVENT_JOB,
  type PublishEventJobData,
} from '@app/queue';
import { EventDeliveryRepository } from './event-delivery.repository.js';
import { createLogger } from '../../../../libs/observability/src/logger.js';
import {
  workerMetrics,
  type DeliveryDatabasePhase,
  type DeliveryOperationOutcome,
} from '../../../../libs/observability/src/metrics.js';
import { loadWorkerConcurrency } from './worker.config.js';
import { WEBHOOK_SIGNER, type WebhookSigner } from './webhook-signer.js';

const WEBHOOK_TIMEOUT_MS = 10_000;
const HTTP_ERROR = 'HTTP_ERROR';
const TIMEOUT = 'TIMEOUT';
const NETWORK_ERROR = 'NETWORK_ERROR';
const SIGNER_ERROR = 'SIGNER_ERROR';

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

@Processor(EVENTS_QUEUE, { concurrency: loadWorkerConcurrency() })
export class EventsProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = createLogger('worker');

  async onModuleDestroy(): Promise<void> {
    this.logger.info({ action: 'worker.draining' });
    // Drain before the application-shutdown phase closes Redis and PostgreSQL.
    // close() stops taking jobs and waits for active processors and finalization.
    await this.worker.close();
    this.logger.info({ action: 'worker.drained' });
  }

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
    @Inject(WEBHOOK_SIGNER)
    private readonly webhookSigner: WebhookSigner | null = null,
  ) {
    super();
    this.logger.info({
      action: 'worker.configured',
      signing: this.webhookSigner !== null,
    });
  }

  override async process(
    job: Job<PublishEventJobData, void, string>,
  ): Promise<void> {
    const started = performance.now();
    let outcome: DeliveryOperationOutcome = 'error';
    try {
      await this.deliver(job);
      outcome = 'completed';
    } finally {
      workerMetrics.observeProcessing(
        outcome,
        (performance.now() - started) / 1000,
      );
    }
  }

  private async measureDatabase<T>(
    phase: DeliveryDatabasePhase,
    operation: () => Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    let outcome: DeliveryOperationOutcome = 'error';
    try {
      const result = await operation();
      outcome = 'completed';
      return result;
    } finally {
      workerMetrics.observeDatabase(
        phase,
        outcome,
        (performance.now() - started) / 1000,
      );
    }
  }

  private async deliver(
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
    const attemptId = await this.measureDatabase('attempt_start', () =>
      this.eventDeliveryRepository.startAttempt(event.id, new Date()),
    );

    this.logger.info({
      action: 'delivery.started',
      eventId: event.id,
      jobId: job.id,
      attemptId,
      attemptNumber: job.attemptsMade + 1,
    });

    const body = JSON.stringify(event);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.webhookSigner) {
      try {
        Object.assign(headers, await this.webhookSigner.sign(event.id, body));
      } catch (error) {
        // The receiver was never contacted, so no receiver outcome is counted.
        const eventStatus = eventStatusAfterFailure(job);

        await this.measureDatabase('finalize', () =>
          this.eventDeliveryRepository.markFailed(
            attemptId,
            event.id,
            {
              httpStatus: null,
              errorCode: SIGNER_ERROR,
              errorMessage: errorMessage(error),
            },
            new Date(),
            eventStatus,
          ),
        );

        const failureLog = {
          action: 'delivery.failed',
          eventId: event.id,
          jobId: job.id,
          attemptId,
          attemptNumber: job.attemptsMade + 1,
          httpStatus: null,
          errorCode: SIGNER_ERROR,
          eventStatus,
        };

        if (eventStatus === 'failed') {
          this.logger.error(failureLog);
        } else {
          this.logger.warn(failureLog);
        }

        throw error;
      }
    }

    let response: Response;
    const started = performance.now();
    try {
      response = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
    } catch (error) {
      const durationMs = performance.now() - started;
      workerMetrics.observeDelivery('failed', durationMs / 1000);
      const eventStatus = eventStatusAfterFailure(job);
      const errorCode = isTimeoutError(error) ? TIMEOUT : NETWORK_ERROR;

      await this.measureDatabase('finalize', () =>
        this.eventDeliveryRepository.markFailed(
          attemptId,
          event.id,
          {
            httpStatus: null,
            errorCode: errorCode,
            errorMessage: errorMessage(error),
          },
          new Date(),
          eventStatus,
        ),
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

      await this.measureDatabase('finalize', () =>
        this.eventDeliveryRepository.markFailed(
          attemptId,
          event.id,
          {
            httpStatus: response.status,
            errorCode: errorCode,
            errorMessage: error.message,
          },
          new Date(),
          eventStatus,
        ),
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

    await this.measureDatabase('finalize', () =>
      this.eventDeliveryRepository.markSucceededAndDelivered(
        attemptId,
        event.id,
        response.status,
        new Date(),
      ),
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
