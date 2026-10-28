import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;

/**
 * Encrypts group access tokens at rest with AES-256-GCM. The master key lives
 * only in `TOKEN_ENCRYPTION_KEY` (env/secret manager), never in the database —
 * a stolen DB dump alone can't decrypt tokens.
 */
@Injectable()
export class TokenEncryptionService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    this.key = Buffer.from(
      config.getOrThrow<string>('TOKEN_ENCRYPTION_KEY'),
      'base64',
    );
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return [
      iv.toString('base64'),
      authTag.toString('base64'),
      ciphertext.toString('base64'),
    ].join('.');
  }

  decrypt(payload: string): string {
    const parts = payload.split('.');
    if (parts.length !== 3) {
      throw new Error('Malformed encrypted token payload');
    }
    const [ivB64, authTagB64, ciphertextB64] = parts;
    const decipher = createDecipheriv(
      ALGORITHM,
      this.key,
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  }
}
