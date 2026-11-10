export interface ProviderIdentity {
  providerId: string;
}

export interface ProviderIdentityPort {
  resolve(request: unknown): Promise<ProviderIdentity | null>;
}

export const PROVIDER_IDENTITY_PORT = Symbol('PROVIDER_IDENTITY_PORT');

export class NoopProviderIdentity implements ProviderIdentityPort {
  async resolve(): Promise<ProviderIdentity | null> {
    return null;
  }
}
