import { randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { TokenEncryptionService } from './token-encryption.service';

function buildService(): TokenEncryptionService {
  const key = randomBytes(32).toString('base64');
  const config = { getOrThrow: () => key } as unknown as ConfigService;
  return new TokenEncryptionService(config);
}

describe('TokenEncryptionService', () => {
  it('round-trips plaintext through encrypt/decrypt', () => {
    const service = buildService();
    const plaintext = 'vk1.a.super-secret-community-token';

    const encrypted = service.encrypt(plaintext);

    expect(encrypted).not.toContain(plaintext);
    expect(service.decrypt(encrypted)).toBe(plaintext);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const service = buildService();
    const plaintext = 'same-token';

    expect(service.encrypt(plaintext)).not.toBe(service.encrypt(plaintext));
  });

  it('rejects a tampered payload instead of returning corrupted plaintext', () => {
    const service = buildService();
    const encrypted = service.encrypt('vk1.a.super-secret-community-token');
    const [iv, authTag, ciphertext] = encrypted.split('.');
    const tampered = [iv, authTag, ciphertext.slice(0, -2) + 'AA'].join('.');

    expect(() => service.decrypt(tampered)).toThrow();
  });

  it('cannot decrypt with the wrong key', () => {
    const service = buildService();
    const other = buildService();
    const encrypted = service.encrypt('vk1.a.super-secret-community-token');

    expect(() => other.decrypt(encrypted)).toThrow();
  });
});
