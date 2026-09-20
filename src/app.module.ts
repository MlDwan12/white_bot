import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { envValidationSchema } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { GroupsModule } from './groups/groups.module';
import { VkModule } from './vk/vk.module';
import { MaxModule } from './max/max.module';
import { QueueModule } from './queue/queue.module';
import { PostsModule } from './posts/posts.module';
import { MediaModule } from './media/media.module';
import { ContestsModule } from './contests/contests.module';
import { AuthModule } from './auth/auth.module';
import { PanelModule } from './panel/panel.module';
import { HealthController } from './health/health.controller';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { buildPinoConfig } from './logger/pino-logger.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: buildPinoConfig,
    }),
    PrismaModule,
    VkModule,
    GroupsModule,
    QueueModule,
    MaxModule,
    MediaModule,
    PostsModule,
    ContestsModule,
    AuthModule,
    PanelModule,
    // Ограничитель нужен прежде всего форме входа: argon2 намеренно
    // медленный, и без него вход — это и перебор паролей, и нагрузка.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
  ],
  controllers: [AppController, HealthController],
  providers: [
    // Без гварда декоратор @Throttle на форме входа не делает ничего —
    // модуль сам по себе ничего не ограничивает. Глобальный потолок заодно
    // прикрывает остальные эндпоинты.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    AppService,
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
