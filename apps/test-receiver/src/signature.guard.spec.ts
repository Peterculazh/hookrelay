import { createHmac } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignatureGuard } from './signature.guard.js';

const secret = 'receiver-test-signing-secret-0123456789';
const body = '{"id":"event-1"}';
const now = new Date('2026-09-12T10:00:00.000Z');
const timestamp = String(now.getTime() / 1000);
const stale = String(Number(timestamp) - 301);

function sign(time = timestamp, payload = body, key = secret) {
  const digest = createHmac('sha256', key)
    .update(`${time}.${payload}`)
    .digest('hex');
  return `v1=${digest}`;
}

function request(headers: Record<string, string>, rawBody?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        rawBody: rawBody === undefined ? undefined : Buffer.from(rawBody),
        header: (name: string) => headers[name],
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('SignatureGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubEnv('WEBHOOK_SIGNING_SECRET', secret);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('accepts a valid signature over the raw body', () => {
    expect(
      new SignatureGuard().canActivate(
        request(
          {
            'x-hookrelay-signature': sign(),
            'x-hookrelay-timestamp': timestamp,
          },
          body,
        ),
      ),
    ).toBe(true);
  });

  it('accepts unsigned requests when no secret is configured', () => {
    vi.stubEnv('WEBHOOK_SIGNING_SECRET', '');
    expect(new SignatureGuard().canActivate(request({}, body))).toBe(true);
  });

  it.each([
    ['no signature headers', {}, 'Missing or malformed signature'],
    [
      'a malformed signature',
      { 'x-hookrelay-signature': 'v1=abc', 'x-hookrelay-timestamp': timestamp },
      'Missing or malformed signature',
    ],
    [
      'a signature made with another secret',
      {
        'x-hookrelay-signature': sign(timestamp, body, 'another-secret'),
        'x-hookrelay-timestamp': timestamp,
      },
      'Signature mismatch',
    ],
    [
      'a signature for a different body',
      {
        'x-hookrelay-signature': sign(timestamp, '{"id":"event-2"}'),
        'x-hookrelay-timestamp': timestamp,
      },
      'Signature mismatch',
    ],
    [
      'a correctly signed but stale timestamp',
      {
        'x-hookrelay-signature': sign(stale),
        'x-hookrelay-timestamp': stale,
      },
      'Signature timestamp is out of range',
    ],
  ])('rejects %s', (_name, headers, message) => {
    expect(() =>
      new SignatureGuard().canActivate(request(headers, body)),
    ).toThrow(message);
  });

  // Signatures computed outside the project for secret, 1789207200 and body:
  //   printf '%s' '1789207200.{"id":"event-1"}' | openssl dgst -sha256 -hmac <secret>
  //   printf '%s' '{"id":"event-1"}' | openssl dgst -sha256 -hmac <secret>
  describe('known answers', () => {
    const withTimestamp =
      '01a1b7c15189c07eaa6133e93db4e6d37206a1ca5a4376da18d0b4f58eab9931';
    const bodyOnly =
      '8b52b2906dfbd831b60609550cfbf033125c80f09c9cd1d73018366e4599c4c8';
    const send = (signature: string) =>
      new SignatureGuard().canActivate(
        request(
          {
            'x-hookrelay-signature': `v1=${signature}`,
            'x-hookrelay-timestamp': '1789207200',
          },
          body,
        ),
      );

    it('accepts the HMAC of "<timestamp>.<body>"', () => {
      expect(send(withTimestamp)).toBe(true);
    });

    it('rejects an HMAC of the body alone', () => {
      expect(() => send(bodyOnly)).toThrow('Signature mismatch');
    });
  });
});
