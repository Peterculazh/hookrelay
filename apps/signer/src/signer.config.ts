import { z } from 'zod';
import { SIGNER_DEFAULT_PORT } from '@app/grpc';

export function loadSignerConfig(environment = process.env) {
  return z
    .object({
      // HMAC-SHA256 keys shorter than the digest weaken the signature.
      secret: z.string().min(32),
      keyId: z.string().min(1).max(64).default('v1'),
      url: z.string().min(1).default(`0.0.0.0:${SIGNER_DEFAULT_PORT}`),
    })
    .parse({
      secret: environment.SIGNING_SECRET,
      keyId: environment.SIGNING_KEY_ID,
      url: environment.SIGNER_GRPC_URL,
    });
}
