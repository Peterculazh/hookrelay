import { Module } from '@nestjs/common';
import { DatabaseModule } from '@app/database';
import { TestReceiverController } from './test-receiver.controller.js';
import { TestReceiverService } from './test-receiver.service.js';
import { SignatureGuard } from './signature.guard.js';

@Module({
  imports: [DatabaseModule],
  controllers: [TestReceiverController],
  providers: [TestReceiverService, SignatureGuard],
})
export class TestReceiverModule {}
