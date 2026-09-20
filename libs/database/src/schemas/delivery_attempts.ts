import {
  index,
  integer,
  pgEnum,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { pgTable } from '../table.ts';

import { events } from './events.ts';

export const deliveryAttemptStatus = pgEnum('delivery_attempt_status', [
  'in_progress',
  'succeeded',
  'failed',
]);

export const deliveryAttempts = pgTable(
  'delivery_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, {
        onDelete: 'cascade',
      }),

    status: deliveryAttemptStatus('status').notNull().default('in_progress'),

    startedAt: timestamp('started_at', {
      withTimezone: true,
      mode: 'date',
    })
      .notNull()
      .defaultNow(),

    finishedAt: timestamp('finished_at', {
      withTimezone: true,
      mode: 'date',
    }),

    httpStatus: integer('http_status'),

    errorCode: varchar('error_code', {
      length: 50,
    }),

    errorMessage: text('error_message'),
  },
  (table) => [index('delivery_attempts_event_id_idx').on(table.eventId)],
);
