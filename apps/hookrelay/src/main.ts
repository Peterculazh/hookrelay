import { NestFactory } from '@nestjs/core';
import { VersioningType } from '@nestjs/common';
import { DatabaseService, schema } from '@app/database';
import { count, isNull } from 'drizzle-orm';
import {
  createLogger,
  PinoNestLogger,
} from '../../../libs/observability/src/logger.js';
import { apiMetrics } from '../../../libs/observability/src/metrics.js';
import { AppModule, ObserveInstrument } from './app.module.js';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
    logger: new PinoNestLogger(createLogger('api')),
  });
  app.enableShutdownHooks();
  app.enableVersioning({ type: VersioningType.URI });
  app.use(apiMetrics.middleware);
  const database = app.get(DatabaseService);
  apiMetrics.collectOutbox(async () => {
    const [result] = await database.db
      .select({ count: count() })
      .from(schema.outbox)
      .where(isNull(schema.outbox.publishedAt));
    return result.count;
  });

  const config = new DocumentBuilder()
    .setDescription('Hook-relay API')
    .setVersion('1.0')
    .build();
  const documentFactory = () => SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, documentFactory);

  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
