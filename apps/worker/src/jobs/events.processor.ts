import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import {
  EVENTS_QUEUE,
  PUBLISH_EVENT_JOB,
  type PublishEventJobData,
} from '../queue/queue.constants.js';
import { EventDeliveryRepository } from './event-delivery.repository.js';

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
    let response: Response;

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
      await this.eventDeliveryRepository.markFailed(
        attemptId,
        event.id,
        {
          httpStatus: null,
          errorCode: isTimeoutError(error) ? TIMEOUT : NETWORK_ERROR,
          errorMessage: errorMessage(error),
        },
        new Date(),
        eventStatusAfterFailure(job),
      );

      throw error;
    }

    await response.body?.cancel().catch(() => undefined);

    if (!response.ok) {
      const status = `${response.status} ${response.statusText}`.trim();
      const error = new Error(
        `Webhook for event ${event.id} responded with ${status}`,
      );

      await this.eventDeliveryRepository.markFailed(
        attemptId,
        event.id,
        {
          httpStatus: response.status,
          errorCode: HTTP_ERROR,
          errorMessage: error.message,
        },
        new Date(),
        eventStatusAfterFailure(job),
      );

      throw error;
    }

    await this.eventDeliveryRepository.markSucceededAndDelivered(
      attemptId,
      event.id,
      response.status,
      new Date(),
    );
  }
}
