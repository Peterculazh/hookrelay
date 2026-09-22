import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { EventsModule } from './events/domain/events.module.ts';
import { DatabaseModule } from '@app/database';
import { AppController } from './app.controller.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    // Distributed tracing, auto-correlated logs, request/job metrics, error
    // telemetry, alarms, and more — out of the box. Sign up at https://observe.nestjs.com
    // ObserveModule.forRoot({
    //   appKey: 'YOUR_APP_KEY',
    //   appSecret: 'YOUR_APP_SECRET',
    //   serviceId: 'hookrelay',
    // }),
    DatabaseModule,
    EventsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
