import { CanActivate, Inject, Injectable } from '@nestjs/common';
import { PROVIDER_IDENTITY_PORT, type ProviderIdentityPort } from './provider-identity';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(PROVIDER_IDENTITY_PORT) private readonly identity: ProviderIdentityPort,
  ) {
    void this.identity;
  }

  canActivate(): boolean {
    return true;
  }
}
