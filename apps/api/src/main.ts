import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import type { Request, Response } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Токены входа живут в куках, а их без разбора не прочесть.
  app.use(cookieParser());

  // Панель на React (`web/`): собирается отдельно (`yarn --cwd web
  // build`) и отдаётся отсюда же, с того же источника, — куки входа и CSRF
  // работают без CORS. Пути внутри неё разбирает сам браузерный
  // роутер, поэтому на любой адрес под `/app` отдаётся `index.html`.
  const webDist = join(__dirname, '..', '..', 'web', 'dist');
  app.useStaticAssets(join(webDist, 'assets'), {
    prefix: '/app/assets',
    // В имени файла хэш содержимого: новая сборка — новые имена.
    maxAge: '1y',
    immutable: true,
  });
  // Нет файла — 404, а не index.html под видом скрипта.
  app.use('/app/assets', (_req: Request, res: Response) => {
    res.status(404).end();
  });
  app.use('/app', (_req: Request, res: Response) => {
    // Сам index.html не кэшируется: иначе после выкладки браузер держал бы
    // ссылки на файлы прошлой сборки.
    res.set('Cache-Control', 'no-cache');
    res.sendFile(join(webDist, 'index.html'), (err) => {
      if (err && !res.headersSent) {
        res.status(404).send('Панель не собрана');
      }
    });
  });

  // Without this, SIGTERM (docker stop / pod eviction) never triggers
  // OnModuleDestroy, so PrismaService never disconnects and leaks
  // connections against Postgres's connection limit on every restart.
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);

  const trustProxyHops = configService.get<number>('TRUST_PROXY_HOPS', 0);
  if (trustProxyHops > 0) {
    // Без этого за прокси `req.ip` одинаков у всех, и ограничитель попыток
    // входа блокирует всех админов сразу после пяти чужих ошибок.
    app.set('trust proxy', trustProxyHops);
  }

  // Мини-приложение отдаётся с другого хоста (GitHub Pages), чем API, а
  // заголовок Authorization делает запрос «сложным» — браузер сначала шлёт
  // preflight OPTIONS. Без CORS Nest отвечает на него 404, и до эндпоинтов
  // не доходит ни один запрос. Список источников задаётся явно: открывать
  // API всему интернету ради одной страницы незачем.
  const origins = configService
    .get<string>('MINIAPP_ORIGINS', '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length > 0) {
    app.enableCors({
      origin: origins,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'X-CSRF-Token'],
      // Куки не разделяются между источниками: мини-апп представляется
      // подписью запуска в заголовке, а панель по плану отдаётся тем же
      // сервером, то есть со своего источника, и CORS ей не нужен вовсе.
      // Если панель когда-нибудь переедет на отдельный домен, одного
      // `credentials: true` не хватит — куки `SameSite=strict` туда всё
      // равно не поедут, и схему придётся пересматривать целиком.
      credentials: false,
      maxAge: 600,
    });
  }
  // Joi's schema already guarantees PORT has a default (env.validation.ts) —
  // getOrThrow keeps that the single source of truth instead of a second,
  // possibly-diverging fallback here.
  const port = configService.getOrThrow<number>('PORT');
  await app.listen(port);
}
void bootstrap();
