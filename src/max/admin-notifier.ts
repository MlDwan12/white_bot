import { Injectable } from '@nestjs/common';
import type { Button } from '@maxhub/max-bot-api/types';
import { PinoLogger } from 'nestjs-pino';
import { MaxAdminResolver } from './max-admin.resolver';
import { MaxApiClient } from './max-api.client';

/**
 * Служебные сообщения всем админам, привязавшим MAX, — вместо следов в
 * самих группах, которые видят все подписчики.
 *
 * Best-effort: MAX не доставит первое сообщение тому, кто сам не открывал
 * диалог с ботом, так что провал для отдельного админа ожидаем и не должен
 * ронять действие, о котором уведомляем.
 */
@Injectable()
export class AdminNotifier {
  constructor(
    private readonly admins: MaxAdminResolver,
    private readonly api: MaxApiClient,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AdminNotifier.name);
  }

  /** Сколько админов сообщение получили. */
  async notifyAll(text: string, buttons?: Button[][]): Promise<number> {
    if (!this.api.configured) {
      return 0;
    }
    let admins: Awaited<ReturnType<MaxAdminResolver['listNotifiableAdmins']>>;
    try {
      admins = await this.admins.listNotifiableAdmins();
    } catch (err: unknown) {
      this.logger.warn(
        { err },
        'Не удалось получить список админов для уведомления',
      );
      return 0;
    }
    if (admins.length === 0) {
      this.logger.warn(
        { text },
        'Нет администраторов с привязанным maxUserId — уведомление некому отправить',
      );
      return 0;
    }

    let delivered = 0;
    for (const admin of admins) {
      try {
        await this.api.sendMessageToUser(Number(admin.maxUserId), text, {
          buttons,
        });
        delivered += 1;
      } catch (err: unknown) {
        this.logger.warn(
          { err, adminId: admin.id },
          'Не удалось отправить уведомление администратору',
        );
      }
    }
    return delivered;
  }
}
