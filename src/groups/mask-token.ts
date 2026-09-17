/**
 * Masks a plaintext token for display (e.g. "vk1a****3f9c"). Never used to
 * store anything — call only at the moment the plaintext is briefly in hand
 * (submission time), so the mask can be persisted without ever decrypting
 * the stored token again just to show it.
 */
export function maskToken(token: string): string {
  if (token.length <= 8) {
    return '****';
  }
  return `${token.slice(0, 4)}****${token.slice(-4)}`;
}
