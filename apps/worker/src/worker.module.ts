import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ScheduleModule as NestScheduleModule } from '@nestjs/schedule';
import { JobsModule } from './jobs/jobs.module.js';
import { loadRedisConnection } from './queue/queue.config.js';
import { ScheduleModule } from './schedule/schedule.module.js';
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
    NestScheduleModule.forRoot(),
    JobsModule,
    ScheduleModule,
  ],
})
export class WorkerModule {}
