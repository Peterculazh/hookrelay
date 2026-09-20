import { Module } from '@nestjs/common';
import { DatabaseModule } from '@app/database';
import { OUTBOX_REPOSITORY } from './interfaces/outbox.repository.ts';
import { OutboxRepositoryImpl } from './outbox.repository.ts';
import { OutboxService } from './outbox.service.ts';

@Module({
  imports: [DatabaseModule],
  providers: [
    OutboxService,
    {
      provide: OUTBOX_REPOSITORY,
      useClass: OutboxRepositoryImpl,
    },
  ],
  exports: [OutboxService],
})
export class OutboxModule {}
