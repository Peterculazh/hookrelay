import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Metrics } from './metrics.js';
import { createLogger, PinoNestLogger } from './logger.js';

afterEach(() => vi.restoreAllMocks());

describe('observability', () => {
  it('keeps log fields at the top level and redacts payloads', () => {
    const lines: string[] = [];
    const logger = new PinoNestLogger(
      createLogger('api', {
        write: (line) => {
          lines.push(line);
        },
      }),
    );
    logger.log(
      {
        action: 'event.accepted',
        eventId: 'event-1',
        payload: { secret: true },
      },
      'EventsService',
    );
    expect(JSON.parse(lines[0])).toMatchObject({
      service: 'api',
      action: 'event.accepted',
      eventId: 'event-1',
      context: 'EventsService',
      payload: '[Redacted]',
    });
  });

  it('uses route templates and bounded fallbacks, with monotonic durations', async () => {
    const metrics = new Metrics('api');
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(350)
      .mockReturnValueOnce(400)
      .mockReturnValueOnce(500);
    for (const req of [
      {
        method: 'GET',
        url: '/v1/events/private-id?secret=1',
        route: { path: '/v1/events/:id' },
      },
      { method: 'CUSTOM-private-id', url: '/private-id' },
    ]) {
      const res = Object.assign(new EventEmitter(), { statusCode: 404 });
      metrics.middleware(
        req as Request,
        res as unknown as Response,
        () => undefined,
      );
      res.emit('finish');
    }
    const output = await metrics.registry.metrics();
    expect(output).toContain('route="/v1/events/:id"');
    expect(output).toContain('method="OTHER",route="unmatched"');
    expect(output).not.toContain('private-id');
    expect(output).not.toContain('secret');
    expect(output).toMatch(
      /hookrelay_api_request_duration_seconds_sum\{[^\n]+\} 0.25/,
    );
  });

  it('refreshes backlog on each scrape and fails rather than reporting a false zero', async () => {
    const metrics = new Metrics('api');
    const count = vi
      .fn()
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error('DB down'));
    metrics.collectOutbox(count);
    expect(await metrics.registry.metrics()).toContain(
      'hookrelay_outbox_unpublished{service="api"} 4',
    );
    expect(await metrics.registry.metrics()).toContain(
      'hookrelay_outbox_unpublished{service="api"} 0',
    );
    await expect(metrics.registry.metrics()).rejects.toThrow('DB down');
  });
});
