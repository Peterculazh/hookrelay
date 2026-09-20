import { jsonb, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { pgTable } from '../table.ts';

export const events = pgTable('events', {
  id: uuid('id').primaryKey(),
  type: varchar('type', { length: 255 }).notNull(),
  payload: jsonb('payload').notNull(),
  targetUrl: varchar('target_url', { length: 255 }).notNull(),
  status: varchar('status', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  deliveredAt: timestamp('delivered_at'),
});
