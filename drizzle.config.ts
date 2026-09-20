import { defineConfig } from 'drizzle-kit';
import { loadDatabaseConfig } from './libs/database/src/database.config.ts';

const database = loadDatabaseConfig();

export default defineConfig({
  dialect: 'postgresql',
  schema: './libs/database/src/schemas/*.ts',
  out: './libs/database/src/migrations',
  dbCredentials: {
    user: database.user,
    password: database.password,
    host: database.host,
    port: database.port,
    database: database.database,
    ssl: database.ssl,
  },
});
