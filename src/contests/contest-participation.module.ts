import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PlatformUsersModule } from '../platform-users/platform-users.module';
import { MaxCoreModule } from '../max/max-core.module';
import { ContestParticipationService } from './contest-participation.service';
import { ContestSubscriptions } from './contest-subscriptions';

/**
 * Намеренно не зависит от MaxModule: его импортирует сам MaxModule, чтобы
 * обработчик нажатия кнопки мог зарегистрировать участника. Проверке
 * подписки MAX всё же нужен — поэтому здесь только `MaxCoreModule` (клиент
 * API без обработчиков), и граф модулей остаётся ацикличным.
 */
@Module({
  imports: [PrismaModule, PlatformUsersModule, MaxCoreModule],
  providers: [ContestParticipationService, ContestSubscriptions],
  exports: [ContestParticipationService, ContestSubscriptions],
})
export class ContestParticipationModule {}
