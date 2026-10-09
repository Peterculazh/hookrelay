import { Module } from '@nestjs/common';
import { SignerController } from './signer.controller.js';
import { SignerService } from './signer.service.js';
import { MetricsModule } from '../../../libs/observability/src/metrics-server.js';
import { signerMetrics } from '../../../libs/observability/src/metrics.js';

@Module({
  imports: [
    MetricsModule.forRoot({
      metrics: signerMetrics,
      service: 'signer',
      port: 9467,
    }),
  ],
  controllers: [SignerController],
  providers: [SignerService],
})
export class SignerModule {}
