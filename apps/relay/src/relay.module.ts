import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ScheduleModule as NestScheduleModule } from '@nestjs/schedule';
import { loadRedisConnection } from '@app/queue';
import { ScheduleModule } from './schedule/schedule.module.js';
import { MetricsModule } from '../../../libs/observability/src/metrics-server.js';
import { relayMetrics } from '../../../libs/observability/src/metrics.js';

@Module({
  imports: [
    MetricsModule.forRoot({
      metrics: relayMetrics,
      service: 'relay',
      port: 9466,
    }),
    BullModule.forRoot({ connection: loadRedisConnection() }),
    NestScheduleModule.forRoot(),
    ScheduleModule,
  ],
})
export class RelayModule {}
