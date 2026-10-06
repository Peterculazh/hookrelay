import { status } from '@grpc/grpc-js';
import { Controller } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { SIGNER_SERVICE, type SignRequest, type SignResponse } from '@app/grpc';
import { SignerService } from './signer.service.js';

@Controller()
export class SignerController {
  constructor(private readonly signerService: SignerService) {}

  @GrpcMethod(SIGNER_SERVICE, 'Sign')
  sign(request: SignRequest): SignResponse {
    // proto3 defaults stand in for omitted fields; never sign those.
    if (!(request.timestamp > 0) || request.body.length === 0) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'timestamp and body are required',
      });
    }

    return this.signerService.sign(request);
  }
}
