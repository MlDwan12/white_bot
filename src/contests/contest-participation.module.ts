import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ContestParticipationService } from './contest-participation.service';

/**
 * Намеренно не зависит от MaxModule: его импортирует сам MaxModule, чтобы
 * обработчик нажатия кнопки мог зарегистрировать участника. Админская
 * половина конкурсов (ContestsModule) зовёт MAX и импортирует его обычным
 * образом — так граф модулей остаётся ацикличным.
 */
@Module({
  imports: [PrismaModule],
  providers: [ContestParticipationService],
  exports: [ContestParticipationService],
})
export class ContestParticipationModule {}
