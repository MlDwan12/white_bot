import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminNotifier } from './admin-notifier';
import { MaxAdminResolver } from './max-admin.resolver';
import { MaxApiClient } from './max-api.client';
import { MAX_BOT, maxBotProvider } from './max-bot.provider';

/**
 * Нижний этаж MAX: сам бот, клиент API и доступ к админам — без
 * обработчиков апдейтов. Вынесено из `MaxModule`, потому что тот
 * импортирует группы и участие в конкурсах, а им самим нужен MAX (написать
 * админам о подключённом VK-сообществе, проверить подписку участника). Через
 * `MaxModule` это замкнуло бы граф модулей в кольцо; этот модуль ни от чего
 * доменного не зависит, и импортировать его может кто угодно.
 */
@Module({
  imports: [PrismaModule],
  providers: [maxBotProvider, MaxApiClient, MaxAdminResolver, AdminNotifier],
  exports: [MAX_BOT, MaxApiClient, MaxAdminResolver, AdminNotifier],
})
export class MaxCoreModule {}
