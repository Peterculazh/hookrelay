import {
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { databaseConfigProvider } from './database.config.ts';
import {
  DRIZZLE_DB,
  PG_POOL,
  drizzleDbProvider,
  pgPoolProvider,
} from './database.provider.ts';
import { DatabaseService } from './database.service.ts';
import { DrizzleUnitOfWork, UnitOfWork } from './unit-of-work.ts';

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Module({
  providers: [
    databaseConfigProvider,
    pgPoolProvider,
    drizzleDbProvider,
    DatabaseService,
    DrizzleUnitOfWork,
    {
      provide: UnitOfWork,
      useExisting: DrizzleUnitOfWork,
    },
    DatabaseLifecycle,
  ],
  exports: [DRIZZLE_DB, DatabaseService, UnitOfWork],
})
export class DatabaseModule {}
