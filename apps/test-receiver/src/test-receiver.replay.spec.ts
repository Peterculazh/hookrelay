import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService, schema } from '@app/database';
import { SignatureGuard } from './signature.guard.js';
import { TestReceiverController } from './test-receiver.controller.js';
import { TestReceiverService } from './test-receiver.service.js';

const secret = 'receiver-replay-signing-secret-0123456789';
const now = new Date('2026-09-12T10:00:00.000Z');
const timestamp = String(now.getTime() / 1000);
const body = JSON.stringify({
  id: 'e9c5697d-d4c2-4445-893b-65e27f836dda',
  type: 'order.created',
  payload: { orderId: 'order-1' },
});
const signature = `v1=${createHmac('sha256', secret)
  .update(`${timestamp}.${body}`)
  .digest('hex')}`;

// Stands in for Postgres: the event id key arbitrates duplicates, as the unique index does.
function createDatabase() {
  const received = new Set<string>();
  const effects: { eventId: string }[] = [];
  const transaction = {
    insert: (table: unknown) => ({
      values: (row: { eventId: string }) => {
        if (table !== schema.receivedEvents) {
          effects.push(row);
          return Promise.resolve();
        }
        return {
          onConflictDoNothing: () => ({
            returning: () => {
              if (received.has(row.eventId)) return Promise.resolve([]);
              received.add(row.eventId);
              return Promise.resolve([{ eventId: row.eventId }]);
            },
          }),
        };
      },
    }),
  };
  return {
    effects,
    service: {
      transaction: (callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
    } as unknown as DatabaseService,
  };
}

// The real guard, controller and service behind a real HTTP server with raw bodies.
describe('in-window replay', () => {
  let app: INestApplication;
  let effects: { eventId: string }[];

  // The same captured request every time: identical bytes, timestamp and signature.
  const resend = () =>
    request(app.getHttpServer())
      .post('/webhooks')
      .set('content-type', 'application/json')
      .set('x-hookrelay-timestamp', timestamp)
      .set('x-hookrelay-signature', signature)
      .send(body);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    vi.stubEnv('WEBHOOK_SIGNING_SECRET', secret);
    const database = createDatabase();
    effects = database.effects;
    const moduleRef = await Test.createTestingModule({
      controllers: [TestReceiverController],
      providers: [
        TestReceiverService,
        SignatureGuard,
        { provide: DatabaseService, useValue: database.service },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('acknowledges the same signed request twice but processes it once', async () => {
    expect((await resend()).status).toBe(204);
    expect((await resend()).status).toBe(204);

    expect(effects).toHaveLength(1);
  });

  it('still remembers the event id at 300 s and rejects the resend at 301 s', async () => {
    expect((await resend()).status).toBe(204);

    vi.setSystemTime(now.getTime() + 300_000);
    expect((await resend()).status).toBe(204);
    expect(effects).toHaveLength(1);

    vi.setSystemTime(now.getTime() + 301_000);
    const rejected = await resend();
    expect(rejected.status).toBe(401);
    expect(rejected.body.message).toBe('Signature timestamp is out of range');
    expect(effects).toHaveLength(1);
  });
});
