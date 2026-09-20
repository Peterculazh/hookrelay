import { timestamp, uuid } from 'drizzle-orm/pg-core';
import { pgTable } from '../table.ts';

export const outbox = pgTable('outbox', {
  id: uuid().primaryKey(),
  eventId: uuid().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  publishedAt: timestamp('published_at'),
});
