import { Module } from '@nestjs/common';
import { databaseConfigProvider } from './database.config.ts';
import {
  DRIZZLE_DB,
  drizzleDbProvider,
  pgPoolProvider,
} from './database.provider.ts';
import { DatabaseService } from './database.service.ts';
import { DrizzleUnitOfWork, UnitOfWork } from './unit-of-work.ts';

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
  ],
  exports: [DRIZZLE_DB, DatabaseService, UnitOfWork],
})
export class DatabaseModule {}
