import type { OnApplicationShutdown } from '@nestjs/common';
import { ClientGrpcProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import {
  SIGNER_SERVICE,
  signerGrpcOptions,
  type SignerClient,
} from '@app/grpc';

export const WEBHOOK_SIGNER = Symbol('WEBHOOK_SIGNER');

const SIGNER_TIMEOUT_MS = 2_000;

export type SignatureHeaders = Record<
  'x-hookrelay-signature' | 'x-hookrelay-timestamp' | 'x-hookrelay-key-id',
  string
>;

export interface WebhookSigner {
  sign(eventId: string, body: string): Promise<SignatureHeaders>;
}

export class GrpcWebhookSigner implements WebhookSigner, OnApplicationShutdown {
  private readonly client: ClientGrpcProxy;
  private readonly signer: SignerClient;

  constructor(url: string) {
    this.client = new ClientGrpcProxy(signerGrpcOptions(url).options);
    this.signer = this.client.getService<SignerClient>(SIGNER_SERVICE);
  }

  async sign(eventId: string, body: string): Promise<SignatureHeaders> {
    const timestamp = Math.floor(Date.now() / 1000);
    const { signature, keyId } = await firstValueFrom(
      this.signer
        .sign({ eventId, timestamp, body: Buffer.from(body) })
        .pipe(timeout(SIGNER_TIMEOUT_MS)),
    );

    return {
      'x-hookrelay-signature': `v1=${signature}`,
      'x-hookrelay-timestamp': String(timestamp),
      'x-hookrelay-key-id': keyId,
    };
  }

  // Runs after the processor has drained in the module-destroy phase.
  onApplicationShutdown(): void {
    this.client.close();
  }
}
