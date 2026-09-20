import { Module } from '@nestjs/common';
import { TestReceiverController } from './test-receiver.controller.js';
import { TestReceiverService } from './test-receiver.service.js';

@Module({
  imports: [],
  controllers: [TestReceiverController],
  providers: [TestReceiverService],
})
export class TestReceiverModule {}
