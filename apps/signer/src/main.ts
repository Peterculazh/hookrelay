import { NestFactory } from '@nestjs/core';
import type { GrpcOptions } from '@nestjs/microservices';
import { signerGrpcOptions } from '@app/grpc';
import { SignerModule } from './signer.module.js';
import { loadSignerConfig } from './signer.config.js';
import {
  createLogger,
  PinoNestLogger,
} from '../../../libs/observability/src/logger.js';
import { signerMetrics } from '../../../libs/observability/src/metrics.js';
import { collectDefaultMetrics } from 'prom-client';

async function bootstrap() {
  collectDefaultMetrics({ register: signerMetrics.registry });
  const app = await NestFactory.createMicroservice<GrpcOptions>(SignerModule, {
    ...signerGrpcOptions(loadSignerConfig().url),
    logger: new PinoNestLogger(createLogger('signer')),
  });
  app.enableShutdownHooks();
  await app.listen();
}
await bootstrap();
