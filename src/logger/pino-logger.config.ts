import { randomUUID } from 'node:crypto';
import { IncomingMessage } from 'node:http';
import { ConfigService } from '@nestjs/config';
import { Params } from 'nestjs-pino';
import { sanitizeUrl } from './sanitize-url';

export function buildPinoConfig(config: ConfigService): Params {
  const isProd = config.get<string>('NODE_ENV') === 'production';

  return {
    pinoHttp: {
      level: isProd ? 'info' : 'debug',
      transport: isProd
        ? undefined
        : { target: 'pino-pretty', options: { singleLine: true } },
      genReqId: (req: IncomingMessage) => {
        const header = req.headers['x-request-id'];
        return typeof header === 'string' && header.length > 0
          ? header
          : randomUUID();
      },
      // Deliberately minimal: we do not log full headers/query objects by
      // default, only what's useful for tracing a request. `url` is
      // sanitized separately because pino's `redact` option only reaches
      // parsed fields, not this raw string (e.g. VK's `access_token` query
      // param would otherwise leak here even with `redact` configured).
      serializers: {
        req: (req: IncomingMessage & { id?: string }) => ({
          id: req.id,
          method: req.method,
          url: sanitizeUrl(req.url ?? ''),
        }),
        // Ответ по умолчанию логируется вместе со всеми заголовками, а в
        // заголовке `set-cookie` уходит выданный токен входа — целиком, в
        // открытом виде, на каждый успешный вход и каждое обновление
        // сессии. Любой, кто видит логи, получал бы рабочий пропуск в
        // панель. Оставляем только статус: остальное для трассировки не
        // нужно.
        res: (res: { statusCode?: number }) => ({
          statusCode: res.statusCode,
        }),
      },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          '*.accessToken',
          '*.accessTokenEncrypted',
          '*.password',
          '*.passwordHash',
        ],
        censor: '[REDACTED]',
      },
    },
  };
}
