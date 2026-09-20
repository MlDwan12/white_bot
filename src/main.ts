import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Токены входа живут в куках, а их без разбора не прочесть.
  app.use(cookieParser());

  // Панель — серверный рендер: страницы собираются здесь, а не в браузере,
  // поэтому она работает без обязательного JS и без отдельной сборки
  // фронтенда. Шаблоны лежат в `src/panel/views` и копируются в `dist`
  // вместе с кодом (см. `nest-cli.json`).
  app.setBaseViewsDir(join(__dirname, 'panel', 'views'));
  app.setViewEngine('ejs');

  // CSS и JS темы раздаём со своего сервера, а не с внешнего CDN: панель
  // поедет на российский хостинг, где зарубежный CDN может быть медленным
  // или недоступным, и каждый админ ходил бы за ним сам.
  app.useStaticAssets(
    join(__dirname, '..', 'node_modules', '@tabler', 'core', 'dist'),
    {
      prefix: '/panel/assets',
      // Файлы версионированы вместе с пакетом; менять их могут только
      // обновлением зависимости.
      maxAge: '7d',
      immutable: true,
    },
  );
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
