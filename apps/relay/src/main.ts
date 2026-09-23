import { NestFactory } from '@nestjs/core';
import { RelayModule } from './relay.module.js';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { EVENTS_QUEUE } from '@app/queue';
import {
  createLogger,
  PinoNestLogger,
} from '../../../libs/observability/src/logger.js';
import { relayMetrics } from '../../../libs/observability/src/metrics.js';
import { collectDefaultMetrics } from 'prom-client';

async function bootstrap() {
  collectDefaultMetrics({ register: relayMetrics.registry });
  const app = await NestFactory.createApplicationContext(RelayModule, {
    logger: new PinoNestLogger(createLogger('relay')),
  });
  app.enableShutdownHooks();
  const queue = app.get<Queue>(getQueueToken(EVENTS_QUEUE));
  relayMetrics.collectQueue(() =>
    queue.getJobCounts('waiting', 'active', 'delayed'),
  );
}
await bootstrap();
