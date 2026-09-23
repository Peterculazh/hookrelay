import { createServer, type Server } from 'node:http';
import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import type { Metrics } from './metrics.js';
import { createLogger } from './logger.js';

const OPTIONS = Symbol('METRICS_OPTIONS');
interface Options {
  metrics: Metrics;
  service: string;
  port: number;
}

@Injectable()
class MetricsServer
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private server?: Server;
  constructor(@Inject(OPTIONS) private readonly options: Options) {}

  async onApplicationBootstrap() {
    const logger = createLogger(this.options.service);
    this.server = createServer(async (req, res) => {
      if (req.method !== 'GET' || req.url !== '/metrics') {
        res.writeHead(404).end();
        return;
      }
      try {
        const body = await this.options.metrics.registry.metrics();
        res
          .writeHead(200, {
            'Content-Type': this.options.metrics.registry.contentType,
          })
          .end(body);
      } catch (err) {
        logger.error({ action: 'metrics.collection_failed', err });
        res.writeHead(503).end('Metrics unavailable\n');
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(
        Number(process.env.METRICS_PORT ?? this.options.port),
        process.env.METRICS_HOST ?? '0.0.0.0',
        resolve,
      );
    });
  }

  async beforeApplicationShutdown() {
    await new Promise<void>((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((error) => (error ? reject(error) : resolve()));
      this.server.closeAllConnections();
    });
  }
}

@Module({})
export class MetricsModule {
  static forRoot(options: Options): DynamicModule {
    return {
      module: MetricsModule,
      providers: [{ provide: OPTIONS, useValue: options }, MetricsServer],
    };
  }
}
