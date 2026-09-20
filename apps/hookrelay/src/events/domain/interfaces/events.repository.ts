import type { TransactionContext } from '@app/database';

export const EVENTS_REPOSITORY = Symbol('EVENTS_REPOSITORY');

export type NewEvent = {
  id: string;
  type: string;
  payload: unknown;
  targetUrl: string;
  status: string;
};

export type Event = NewEvent & {
  createdAt: Date;
  deliveredAt: Date | null;
};

export type DeliveryAttempt = {
  id: string;
  eventId: string;
  status: 'in_progress' | 'succeeded' | 'failed';
  startedAt: Date;
  finishedAt: Date | null;
  httpStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type EventWithAttempts = Event & {
  attempts: DeliveryAttempt[];
};

export interface EventsRepository {
  save(event: NewEvent, tx: TransactionContext): Promise<Event>;
  findById(id: string): Promise<EventWithAttempts | null>;
}
