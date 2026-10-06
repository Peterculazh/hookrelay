import { Module } from '@nestjs/common';
import { DatabaseModule } from '@app/database';
import { EventsQueueModule } from '@app/queue';
import { EventDeliveryRepository } from './event-delivery.repository.js';
import { EventsProcessor } from './events.processor.js';
import { GrpcWebhookSigner, WEBHOOK_SIGNER } from './webhook-signer.js';
import { loadSignerUrl } from './worker.config.js';

@Module({
  imports: [DatabaseModule, EventsQueueModule],
  providers: [
    EventDeliveryRepository,
    EventsProcessor,
    {
      provide: WEBHOOK_SIGNER,
      useFactory: () => {
        const url = loadSignerUrl();
        return url ? new GrpcWebhookSigner(url) : null;
      },
    },
  ],
})
export class JobsModule {}
