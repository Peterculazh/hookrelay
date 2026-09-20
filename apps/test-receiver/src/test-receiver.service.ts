import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class TestReceiverService {
  private readonly logger = new Logger(TestReceiverService.name);

  getHello(): string {
    return 'Hello World!';
  }

  receiveWebhook(event: unknown): void {
    this.logger.log(`Received webhook: ${JSON.stringify(event)}`);
  }
}
