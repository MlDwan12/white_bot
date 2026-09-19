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
  // `.allow('')` matters: dotenv turns a bare `VK_APP_ID=` line (exactly what
  // .env.example ships) into an empty string, which Joi's string type rejects
  // by default — copying .env.example to .env would then refuse to boot
  // instead of simply running without the optional integration.
  VK_APP_ID: Joi.string().allow('').optional(),
  VK_APP_CLIENT_SECRET: Joi.string().allow('').optional(),
  // Optional for the same reason as VK_APP_ID: the app must boot without it
  // (local runs, CI, e2e) — a missing token disables MAX long polling with a
  // startup warning instead of crashing the whole process. Unlike VK, this
  // is a single bot token for every MAX chat/channel, so it lives in env
  // rather than per-Group: in MAX the bot is one identity and the chats are
  // its targets.
  MAX_BOT_TOKEN: Joi.string().allow('').optional(),
  // MAX serves the same bot API from two hosts. The SDK defaults to
  // `platform-api2.max.ru`, whose certificate is issued by the Russian
  // Trusted CA — absent from the default trust store, so every call dies as
  // an opaque `fetch failed`. `botapi.max.ru` serves the same API behind a
  // publicly trusted certificate and is what we use. It stays configurable
  // because a host that does trust that CA (a Russian VPS in production) may
  // prefer the other one, and that is an environment fact, not a design
  // decision.
  MAX_API_BASE_URL: Joi.string()
    // dotenv turns a bare `MAX_API_BASE_URL=` line into '', and a Joi default
    // does not apply to ''. Without `.empty('')` blanking the line — the
    // natural way to say "use the default" — would crash the boot instead.
    .empty('')
    .uri({ scheme: ['https'] })
    // The SDK builds request URLs as `new URL(method, baseUrl)`, which
    // resolves against the base's *parent* path: a base of
    // `https://proxy/max` silently becomes `https://proxy/messages`. Rather
    // than let a path-prefixed proxy fail as unexplained 404s at runtime, we
    // reject it at boot.
    .custom((value: string, helpers) => {
      const { pathname } = new URL(value);
      return pathname === '/' ? value : helpers.error('any.invalid');
    }, 'root path only')
    .message(
      'MAX_API_BASE_URL must be a host root without a path (e.g. https://botapi.max.ru)',
    )
    .default('https://botapi.max.ru'),
  // Where uploaded attachment files live. A default keeps local runs and CI
  // working without extra configuration; in Docker this path is a volume, so
  // files survive container rebuilds (see PLAN.md, шаг 11).
  MEDIA_STORAGE_PATH: Joi.string().default('./storage/media'),
  // Default timezone for a recurring template's cron expression. Stored on
  // the template itself at creation, so changing this later doesn't silently
  // move the firing time of templates that already exist.
  //
  // Validated rather than accepted as any string: a typo like "Europe/Moskva"
  // would otherwise boot fine and surface much later as a 400 blaming the cron
  // expression, which is the one thing that isn't wrong.
  DEFAULT_TIMEZONE: Joi.string()
    .default('Europe/Moscow')
    .custom((value: string, helpers) => {
      // Checked by asking the runtime to *use* the zone rather than by
      // matching it against `Intl.supportedValuesOf('timeZone')`: that list
      // holds only canonical names for this particular ICU build, so it
      // rejects `UTC` outright and accepts exactly one of
      // `Europe/Kiev`/`Europe/Kyiv` depending on the build. The same .env
      // would then boot on one host and not on another.
      try {
        new Intl.DateTimeFormat(undefined, { timeZone: value });
        return value;
      } catch {
        return helpers.error('any.invalid');
      }
    }, 'IANA timezone'),
});
