import {
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Pool } from 'pg';
import {
  DATABASE_CONFIG,
  databaseConfigProvider,
  type DatabaseConfig,
} from './database.config.ts';
import {
  DRIZZLE_DB,
  PG_POOL,
  drizzleDbProvider,
  pgPoolProvider,
} from './database.provider.ts';
import { DatabaseService } from './database.service.ts';
import { DrizzleUnitOfWork, UnitOfWork } from './unit-of-work.ts';

@Injectable()
class DatabaseLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseLifecycle.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(DATABASE_CONFIG) private readonly config: DatabaseConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.pool.query('select 1');
      this.logger.log(
        `Connected to PostgreSQL ${this.config.host}:${this.config.port}/${this.config.database}`,
      );
    } catch (error) {
      await this.pool.end();

      throw new Error(
        `Unable to connect to PostgreSQL ${this.config.host}:${this.config.port}/${this.config.database}`,
        { cause: error },
      );
    }
  }

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
