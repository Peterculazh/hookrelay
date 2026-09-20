import { snakeCase } from 'drizzle-orm/pg-core';

/** Table factory shared by schema declarations without importing the schema barrel. */
export const pgTable = snakeCase.table;
