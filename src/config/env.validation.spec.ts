import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { envValidationSchema } from './env.validation';

const REQUIRED = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
};

describe('envValidationSchema', () => {
  it('accepts the committed .env.example as-is', () => {
    // The file tells the reader to leave the optional vars empty, and dotenv
    // turns `MAX_BOT_TOKEN=` into ''. Joi's string type rejects '' by
    // default, so without `.allow('')` copying .env.example to .env would
    // stop the app from booting — the opposite of what the file promises.
    const example = dotenv.parse(
      fs.readFileSync(path.join(__dirname, '../../.env.example')),
    );
    const { error } = envValidationSchema.validate({
      ...example,
      TOKEN_ENCRYPTION_KEY: REQUIRED.TOKEN_ENCRYPTION_KEY,
    });

    expect(error).toBeUndefined();
  });

  it('treats an empty MAX_BOT_TOKEN as "MAX disabled", not as a fatal error', () => {
    const result = envValidationSchema.validate({
      ...REQUIRED,
      MAX_BOT_TOKEN: '',
    }) as { error?: Error; value: Record<string, unknown> };

    expect(result.error).toBeUndefined();
    // Falsy either way, which is what the bot provider keys off to return null.
    expect(result.value.MAX_BOT_TOKEN).toBeFalsy();
  });

  it('still rejects a malformed encryption key', () => {
    const { error } = envValidationSchema.validate({
      ...REQUIRED,
      TOKEN_ENCRYPTION_KEY: 'too-short',
    });

    expect(error).toBeDefined();
  });
});
