import { join } from 'node:path';
import { Transport, type GrpcOptions } from '@nestjs/microservices';
import type { Observable } from 'rxjs';

export const SIGNER_PACKAGE = 'signer';
export const SIGNER_SERVICE = 'SignerService';
export const SIGNER_DEFAULT_PORT = 5_051;

/** Mirrors proto/signer.proto as decoded with the loader options below. */
export interface SignRequest {
  readonly eventId: string;
  readonly timestamp: number;
  readonly body: Uint8Array;
}

export interface SignResponse {
  readonly signature: string;
  readonly keyId: string;
}

export interface SignerClient {
  sign(request: SignRequest): Observable<SignResponse>;
}

// Applications are bundled, so the .proto files are read from the working
// directory (the repository root locally, /app in the image) at startup.
function protoPath(file: string): string {
  return join(
    process.env.GRPC_PROTO_DIR ?? join(process.cwd(), 'libs/grpc/proto'),
    file,
  );
}

/** Shared by the signer server and its clients so both decode identically. */
export function signerGrpcOptions(url: string): GrpcOptions {
  return {
    transport: Transport.GRPC,
    options: {
      url,
      package: SIGNER_PACKAGE,
      protoPath: protoPath('signer.proto'),
      loader: { longs: Number },
    },
  };
}
