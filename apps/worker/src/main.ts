import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { EVENTS_QUEUE } from './queue/queue.constants.js';
import {
  createLogger,
  PinoNestLogger,
} from '../../../libs/observability/src/logger.js';
import { workerMetrics } from '../../../libs/observability/src/metrics.js';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: new PinoNestLogger(createLogger('worker')),
  });
  app.enableShutdownHooks();
  const queue = app.get<Queue>(getQueueToken(EVENTS_QUEUE));
  workerMetrics.collectQueue(() =>
    queue.getJobCounts('waiting', 'active', 'delayed'),
  );
}
await bootstrap();
