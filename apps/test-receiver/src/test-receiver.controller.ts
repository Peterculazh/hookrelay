import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { TestReceiverService } from './test-receiver.service.js';

@Controller()
export class TestReceiverController {
  constructor(private readonly testReceiverService: TestReceiverService) {}

  @Get()
  getHello(): string {
    return this.testReceiverService.getHello();
  }

  @Post('webhooks')
  @HttpCode(HttpStatus.NO_CONTENT)
  receiveWebhook(@Body() event: unknown): void {
    this.testReceiverService.receiveWebhook(event);
  }
}
