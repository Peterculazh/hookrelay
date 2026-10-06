import { NestFactory } from '@nestjs/core';
import { TestReceiverModule } from './test-receiver.module.js';

async function bootstrap() {
  const app = await NestFactory.create(TestReceiverModule, {
    // The signature covers the exact request bytes, not the parsed JSON.
    rawBody: true,
  });
  app.enableShutdownHooks();
  await app.listen(process.env.TEST_RECEIVER_PORT ?? 3001);
}
await bootstrap();
