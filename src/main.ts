import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Without this, SIGTERM (docker stop / pod eviction) never triggers
  // OnModuleDestroy, so PrismaService never disconnects and leaks
  // connections against Postgres's connection limit on every restart.
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);
  // Joi's schema already guarantees PORT has a default (env.validation.ts) —
  // getOrThrow keeps that the single source of truth instead of a second,
  // possibly-diverging fallback here.
  const port = configService.getOrThrow<number>('PORT');
  await app.listen(port);
}
void bootstrap();
