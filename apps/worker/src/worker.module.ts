import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { JobsModule } from './jobs/jobs.module.js';
import { loadRedisConnection } from '@app/queue';
import { MetricsModule } from '../../../libs/observability/src/metrics-server.js';
import { workerMetrics } from '../../../libs/observability/src/metrics.js';

@Module({
  imports: [
    MetricsModule.forRoot({
      metrics: workerMetrics,
      service: 'worker',
      port: 9465,
    }),
    BullModule.forRoot({ connection: loadRedisConnection() }),
    JobsModule,
  ],
})
export class WorkerModule {}
