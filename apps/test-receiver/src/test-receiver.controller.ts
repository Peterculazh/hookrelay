import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SignatureGuard } from './signature.guard.js';
import { TestReceiverService } from './test-receiver.service.js';

@Controller()
export class TestReceiverController {
  constructor(private readonly testReceiverService: TestReceiverService) {}

  @Get()
  getHello(): string {
    return this.testReceiverService.getHello();
  }

  @Post('webhooks')
  @UseGuards(SignatureGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async receiveWebhook(@Body() event: unknown): Promise<void> {
    await this.testReceiverService.receiveWebhook(event);
  }
}
