import { createServer } from 'node:net';
import type { ExecutionContext, INestMicroservice } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signerGrpcOptions } from '@app/grpc';
import { SignatureGuard } from '../../test-receiver/src/signature.guard.js';
import { GrpcWebhookSigner } from '../../worker/src/jobs/webhook-signer.js';
import { SignerController } from './signer.controller.js';
import { SignerService } from './signer.service.js';

const secret = 'grpc-test-signing-secret-0123456789';
const body = JSON.stringify({ id: 'event-1', type: 'order.created' });

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function webhookRequest(headers: Record<string, string>, rawBody = body) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        rawBody: Buffer.from(rawBody),
        header: (name: string) => headers[name],
      }),
    }),
  } as unknown as ExecutionContext;
}

// Exercises the real proto, server, and client over a loopback socket.
describe('signer over gRPC', () => {
  let app: INestMicroservice;
  let client: GrpcWebhookSigner;

  beforeAll(async () => {
    vi.stubEnv('SIGNING_SECRET', secret);
    vi.stubEnv('SIGNING_KEY_ID', 'key-7');
    const url = `127.0.0.1:${await freePort()}`;
    const moduleRef = await Test.createTestingModule({
      controllers: [SignerController],
      providers: [SignerService],
    }).compile();
    app = moduleRef.createNestMicroservice(signerGrpcOptions(url));
    await app.listen();
    client = new GrpcWebhookSigner(url);
  });

  afterAll(async () => {
    client?.onApplicationShutdown();
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('returns headers that the receiver accepts for the signed body only', async () => {
    const headers = await client.sign('event-1', body);

    expect(headers).toEqual({
      'x-hookrelay-signature': expect.stringMatching(/^v1=[0-9a-f]{64}$/),
      'x-hookrelay-timestamp': expect.stringMatching(/^\d+$/),
      'x-hookrelay-key-id': 'key-7',
    });

    vi.stubEnv('WEBHOOK_SIGNING_SECRET', secret);
    const guard = new SignatureGuard();
    expect(guard.canActivate(webhookRequest(headers))).toBe(true);
    expect(() =>
      guard.canActivate(webhookRequest(headers, `${body} `)),
    ).toThrow('Signature mismatch');

    vi.stubEnv('WEBHOOK_SIGNING_SECRET', 'a-different-receiver-secret-012345');
    expect(() =>
      new SignatureGuard().canActivate(webhookRequest(headers)),
    ).toThrow('Signature mismatch');
  });

  it('does not let a captured signature be replayed under a fresh timestamp', async () => {
    const captured = await client.sign('event-1', body);
    vi.stubEnv('WEBHOOK_SIGNING_SECRET', secret);
    const guard = new SignatureGuard();
    expect(guard.canActivate(webhookRequest(captured))).toBe(true);

    // Still inside the tolerance, so only the HMAC can catch the swap.
    const fresh = String(Number(captured['x-hookrelay-timestamp']) + 60);
    expect(() =>
      guard.canActivate(
        webhookRequest({ ...captured, 'x-hookrelay-timestamp': fresh }),
      ),
    ).toThrow('Signature mismatch');
  });

  it('surfaces a rejected request as an error', async () => {
    await expect(client.sign('event-1', '')).rejects.toThrow(
      'timestamp and body are required',
    );
  });
});
