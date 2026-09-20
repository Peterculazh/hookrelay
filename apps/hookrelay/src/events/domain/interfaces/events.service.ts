import type { Event, EventWithAttempts } from './events.repository.ts';

export const EVENTS_SERVICE = Symbol('EVENTS_SERVICE');

export type SaveEventInput = {
  type: string;
  payload: unknown;
};

export interface EventsService {
  saveEvent(input: SaveEventInput): Promise<Event>;
  getEvent(id: string): Promise<EventWithAttempts>;
}
