import { NestFactory } from '@nestjs/core';
import { TestReceiverModule } from './test-receiver.module.js';

async function bootstrap() {
  const app = await NestFactory.create(TestReceiverModule);
  app.enableShutdownHooks();
  await app.listen(process.env.TEST_RECEIVER_PORT ?? 3001);
}
await bootstrap();
