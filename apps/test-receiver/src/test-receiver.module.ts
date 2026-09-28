import { Module } from '@nestjs/common';
import { DatabaseModule } from '@app/database';
import { TestReceiverController } from './test-receiver.controller.js';
import { TestReceiverService } from './test-receiver.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [TestReceiverController],
  providers: [TestReceiverService],
})
export class TestReceiverModule {}
