import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';

const TOLERANCE_SECONDS = 300;
const SIGNATURE_PATTERN = /^v1=([0-9a-f]{64})$/;

// Receiver-owned verification: deliberately shares no code with HookRelay.
@Injectable()
export class SignatureGuard implements CanActivate {
  // Unsigned deliveries are accepted until the receiver is given a secret.
  private readonly secret = process.env.WEBHOOK_SIGNING_SECRET || undefined;

  canActivate(context: ExecutionContext): boolean {
    if (!this.secret) return true;

    const request = context
      .switchToHttp()
      .getRequest<RawBodyRequest<Request>>();
    const timestamp = request.header('x-hookrelay-timestamp') ?? '';
    const signature = SIGNATURE_PATTERN.exec(
      request.header('x-hookrelay-signature') ?? '',
    )?.[1];
    if (!signature || !/^\d+$/.test(timestamp) || !request.rawBody) {
      throw new UnauthorizedException('Missing or malformed signature');
    }
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) {
      throw new UnauthorizedException('Signature timestamp is out of range');
    }

    const expected = createHmac('sha256', this.secret)
      .update(`${timestamp}.`)
      .update(request.rawBody)
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
      throw new UnauthorizedException('Signature mismatch');
    }

    return true;
  }
}
