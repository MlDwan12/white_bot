import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { requestContextMiddleware } from './request-context';

/**
 * Глобальный: журнал пишут почти все модули (посты, конкурсы, каналы,
 * админы, вход), и импорт в каждый — шум. Без зависимости от AuthModule:
 * вход сам пишет в журнал, и импорт в обратную сторону замкнул бы кольцо.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestContextMiddleware).forRoutes('*');
  }
}

/** Чтение и очистка журнала — отдельно, ему нужен guard входа. */
@Module({
  imports: [AuthModule],
  controllers: [AuditController],
})
export class AuditApiModule {}
