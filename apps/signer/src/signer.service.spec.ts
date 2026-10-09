import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSignerConfig } from './signer.config.js';
import { SignerController } from './signer.controller.js';
import { SignerService } from './signer.service.js';

const secret = 'unit-test-signing-secret-0123456789';

describe('signer', () => {
  afterEach(() => vi.unstubAllEnvs());

  function createController() {
    vi.stubEnv('SIGNING_SECRET', secret);
    vi.stubEnv('SIGNING_KEY_ID', 'key-7');
    return new SignerController(new SignerService());
  }

  it('signs "<timestamp>.<body>" with HMAC-SHA256 and reports the key id', () => {
    const body = Buffer.from('{"id":"event-1"}');

    expect(
      createController().sign({ eventId: 'event-1', timestamp: 1_800, body }),
    ).toEqual({
      signature: createHmac('sha256', secret)
        .update('1800.{"id":"event-1"}')
        .digest('hex'),
      keyId: 'key-7',
    });
  });

  it.each([
    ['a missing timestamp', { timestamp: 0, body: Buffer.from('{}') }],
    ['an empty body', { timestamp: 1_800, body: Buffer.alloc(0) }],
  ])('refuses to sign %s', (_name, request) => {
    expect(() =>
      createController().sign({ eventId: 'event-1', ...request }),
    ).toThrow('timestamp and body are required');
  });

  it('requires a secret of at least 32 characters', () => {
    expect(() => loadSignerConfig({})).toThrow();
    expect(() => loadSignerConfig({ SIGNING_SECRET: 'short' })).toThrow();
    expect(loadSignerConfig({ SIGNING_SECRET: secret })).toEqual({
      secret,
      keyId: 'v1',
      url: '0.0.0.0:5051',
    });
  });
});
