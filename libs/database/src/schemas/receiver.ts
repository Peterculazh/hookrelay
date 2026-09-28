import { jsonb, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { pgTable } from '../table.ts';

// Receiver-owned data: deliberately no reference to HookRelay's events table.
export const receivedEvents = pgTable('received_events', {
  eventId: uuid('event_id').primaryKey(),
  receivedAt: timestamp('received_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Inserting this durable row is the simulated customer business effect.
export const receiverEffects = pgTable('receiver_effects', {
  id: uuid('id').defaultRandom().primaryKey(),
  eventId: uuid('event_id')
    .notNull()
    .unique()
    .references(() => receivedEvents.eventId),
  type: varchar('type', { length: 255 }).notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});
