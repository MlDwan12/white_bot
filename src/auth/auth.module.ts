import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AdminAuthGuard } from './admin-auth.guard';
import { CsrfGuard } from './csrf.guard';
import { CsrfInterceptor } from './csrf.interceptor';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';

@Module({
  imports: [
    PrismaModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // getOrThrow, а не get с запасным значением: сервер с предсказуемым
        // секретом подписи хуже, чем сервер, который не стартовал.
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    SessionService,
    AdminAuthGuard,
    CsrfGuard,
    CsrfInterceptor,
  ],
  exports: [
    AuthService,
    AdminAuthGuard,
    CsrfGuard,
    PasswordService,
    SessionService,
  ],
})
export class AuthModule {}
