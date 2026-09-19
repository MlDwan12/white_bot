import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { envValidationSchema } from './env.validation';

const REQUIRED = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  // Как и ключ шифрования, в .env.example не кладётся: значение-заглушка,
  // пригодное к запуску, рано или поздно уедет в прод как настоящее.
  JWT_SECRET: 'x'.repeat(48),
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
      JWT_SECRET: REQUIRED.JWT_SECRET,
    });

    expect(error).toBeUndefined();
  });

  it('refuses to boot without a signing secret', () => {
    // Сервер с предсказуемым секретом подписи хуже, чем сервер, который не
    // стартовал: пропуск в панель тогда может выписать себе кто угодно.
    const withoutSecret: Record<string, string> = { ...REQUIRED };
    delete withoutSecret.JWT_SECRET;

    expect(envValidationSchema.validate(withoutSecret).error).toBeDefined();
  });

  it('refuses a signing secret short enough to brute-force', () => {
    expect(
      envValidationSchema.validate({ ...REQUIRED, JWT_SECRET: 'короткий' })
        .error,
    ).toBeDefined();
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

  describe('MAX_API_BASE_URL', () => {
    const validate = (value?: string) =>
      envValidationSchema.validate({
        ...REQUIRED,
        ...(value === undefined ? {} : { MAX_API_BASE_URL: value }),
      }) as { error?: Error; value: { MAX_API_BASE_URL: string } };

    it('falls back to the publicly trusted host when unset', () => {
      // The SDK's own default host serves a certificate from a CA that isn't
      // in the default trust store, so every MAX call would die as an opaque
      // `fetch failed`. Our default must win whenever the var isn't set.
      expect(validate().value.MAX_API_BASE_URL).toBe('https://botapi.max.ru');
    });

    it('treats a blank line as unset rather than as a fatal error', () => {
      // dotenv turns `MAX_API_BASE_URL=` into '', and a Joi default does not
      // apply to ''. Blanking the line is the natural way to say "use the
      // default", so it must not crash the boot.
      const { error, value } = validate('');

      expect(error).toBeUndefined();
      expect(value.MAX_API_BASE_URL).toBe('https://botapi.max.ru');
    });

    it('rejects a base URL carrying a path', () => {
      // `new URL('messages', 'https://proxy/max')` resolves to
      // `https://proxy/messages` — the prefix vanishes and every call 404s
      // with no hint why. Better to refuse to boot.
      expect(validate('https://proxy.example/max').error).toBeDefined();
      expect(validate('https://proxy.example/').error).toBeUndefined();
    });

    it('rejects a non-https host', () => {
      expect(validate('http://botapi.max.ru').error).toBeDefined();
    });
  });
});
