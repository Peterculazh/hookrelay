import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';
import {
  createLogger,
  PinoNestLogger,
} from '../../../libs/observability/src/logger.js';
import { workerMetrics } from '../../../libs/observability/src/metrics.js';
import { collectDefaultMetrics } from 'prom-client';

async function bootstrap() {
  collectDefaultMetrics({ register: workerMetrics.registry });
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: new PinoNestLogger(createLogger('worker')),
  });
  app.enableShutdownHooks();
}
await bootstrap();
