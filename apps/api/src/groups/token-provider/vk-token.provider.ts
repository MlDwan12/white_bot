import { Injectable } from '@nestjs/common';

export const VK_TOKEN_PROVIDER = Symbol('VK_TOKEN_PROVIDER');

/**
 * Resolves the plaintext VK community token GroupsService will encrypt and
 * store. Kept as its own seam so a future OAuth flow (multi-tenant install)
 * plugs in as another implementation without touching GroupsService.
 */
export interface VkTokenProvider {
  resolveToken(input: { pastedToken: string }): string;
}

/** Current (and only) provider: the admin pastes a community token directly. */
@Injectable()
export class ManualVkTokenProvider implements VkTokenProvider {
  resolveToken(input: { pastedToken: string }): string {
    return input.pastedToken;
  }
}
