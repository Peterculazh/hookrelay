export const EVENTS_QUEUE = 'events';
export const PUBLISH_EVENT_JOB = 'publish-event';

export interface QueuedEvent {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly targetUrl: string;
  readonly createdAt: string;
}

export interface PublishEventJobData {
  readonly event: QueuedEvent;
}
