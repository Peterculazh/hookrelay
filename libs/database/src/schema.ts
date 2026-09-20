import { defineRelations } from 'drizzle-orm';
import { events } from './schemas/events.ts';
import { outbox } from './schemas/outbox.ts';
import { deliveryAttempts } from './schemas/delivery_attempts.ts';
export { pgTable } from './table.ts';

/**
 * Use this instead of pgTable when declaring models. In Drizzle 1.x casing is
 * selected while a table is declared, rather than in the driver config.
 */
/** Add every table/view exported by this folder to this object. */
export const schema = {
  events,
  outbox,
  deliveryAttempts,
};

/**
 * Drizzle 1.x relational configuration. Add the relation callback as the
 * second argument once the first related tables are introduced.
 */
export const relations = defineRelations(schema);
