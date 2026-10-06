import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { SignRequest, SignResponse } from '@app/grpc';
import { loadSignerConfig } from './signer.config.js';

@Injectable()
export class SignerService {
  private readonly configuration = loadSignerConfig();

  sign({ timestamp, body }: SignRequest): SignResponse {
    const signature = createHmac('sha256', this.configuration.secret)
      .update(`${timestamp}.`)
      .update(body)
      .digest('hex');

    return { signature, keyId: this.configuration.keyId };
  }
}
