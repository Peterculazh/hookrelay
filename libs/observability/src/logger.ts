import type { LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger } from 'pino';

export function createLogger(service: string, destination?: DestinationStream) {
  const options = {
    base: { service },
    level: process.env.LOG_LEVEL ?? 'info',
    redact: ['payload', 'targetUrl', 'headers', 'password'],
  };
  return destination ? pino(options, destination) : pino(options);
}

/** Keep Nest lifecycle/errors and application fields in the same JSON stream. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  private write(
    level: 'info' | 'error' | 'warn' | 'debug' | 'trace' | 'fatal',
    message: unknown,
    args: unknown[],
  ) {
    const context = args.at(-1);
    const fields =
      message instanceof Error
        ? { err: message }
        : typeof message === 'object' && message !== null
          ? message
          : {};
    this.logger[level](
      { ...fields, ...(typeof context === 'string' ? { context } : {}) },
      typeof message === 'string' ? message : undefined,
    );
  }

  log(message: unknown, ...args: unknown[]) {
    this.write('info', message, args);
  }
  error(message: unknown, ...args: unknown[]) {
    this.write('error', message, args);
  }
  warn(message: unknown, ...args: unknown[]) {
    this.write('warn', message, args);
  }
  debug(message: unknown, ...args: unknown[]) {
    this.write('debug', message, args);
  }
  verbose(message: unknown, ...args: unknown[]) {
    this.write('trace', message, args);
  }
  fatal(message: unknown, ...args: unknown[]) {
    this.write('fatal', message, args);
  }
}
