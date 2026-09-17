import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),
  DATABASE_URL: Joi.string().uri().required(),
  REDIS_URL: Joi.string().uri().required(),
  // Must be the exact base64 encoding of 32 raw bytes — the AES-256-GCM key
  // length is fixed by the algorithm, so a wrong key must fail fast at
  // startup rather than break encryption/decryption at the first group
  // connection. A regex check first matters because Buffer.from(str,
  // 'base64') never throws: it silently ignores characters outside the
  // base64 alphabet (e.g. a stray space/newline from a copy-paste) instead
  // of rejecting them, so decode-then-check-length alone could let a
  // corrupted key through if the corruption happened not to change length.
  TOKEN_ENCRYPTION_KEY: Joi.string()
    .required()
    .pattern(/^[A-Za-z0-9+/]{43}=$/)
    .custom((value: string, helpers) => {
      if (Buffer.from(value, 'base64').length !== 32) {
        return helpers.error('any.invalid');
      }
      return value;
    }, 'base64-encoded 32-byte AES-256 key'),
  // Optional: only needed for the VK personal-uploader OAuth flow (photo/doc
  // wall attachments), not for the app to boot — a community-only setup
  // shouldn't be forced to configure a VK app it doesn't use yet. No
  // redirect_uri setting here: VK's Mini App console (the only app type
  // currently offered) exposes no way to register a custom one, and a
  // custom redirect_uri is rejected outright ("check application redirect
  // uri in the settings page") — only the universal oauth.vk.com/blank.html
  // works, so it's hardcoded (see VkUploaderTokenService), not configurable.
  VK_APP_ID: Joi.string().optional(),
  VK_APP_CLIENT_SECRET: Joi.string().optional(),
});
