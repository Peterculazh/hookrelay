import {
  Controller,
  Get,
  HttpCode,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DatabaseService } from '@app/database';

const READINESS_TIMEOUT_MS = 1_000;

@Controller()
export class AppController {
  constructor(
    private readonly database: DatabaseService,
  ) {}

  @Get('/health/live')
  @HttpCode(200)
  healthLive(): void {
    return;
  }

  @Get('/health/ready')
  @HttpCode(200)
  async healthReady(): Promise<void> {
    try {
      await this.database.checkConnection(READINESS_TIMEOUT_MS);
    } catch {
      throw new ServiceUnavailableException();
    }
  }
}
