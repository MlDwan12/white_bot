import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { MaxApiClient } from '../max/max-api.client';
import { MaxApiError } from '../max/max-api.error';

/** Сколько помним ссылку на канал-условие. */
const LINK_TTL_MS = 10 * 60 * 1000;

/** Канал из условия «подписаться», как его видит проверка. */
export interface RequiredChannel {
  groupId: string;
  externalId: string;
  title: string;
}

/** Канал, на который человек ещё не подписан, — со ссылкой для кнопки. */
export interface MissingChannel {
  title: string;
  /** Null, если MAX её не отдал: тогда в сообщении остаётся только название. */
  link: string | null;
}

/**
 * Условие «подписаться на каналы» — проверка через MAX.
 *
 * Сбой MAX при проверке (сеть, 5xx) пробрасывается: пропустить человека без
 * проверки значило бы сделать условие необязательным ровно тогда, когда MAX
 * тормозит. Исключение — канал, в котором бота больше нет (403/404): его
 * подписчиков проверить нечем в принципе, и держать из-за этого закрытым весь
 * конкурс хуже, чем снять одно условие. Такой канал пропускается с
 * предупреждением в логе; обычно к этому моменту группа и сама уже помечена
 * `bot_removed` и в условия не попадает.
 */
@Injectable()
export class ContestSubscriptions {
  private readonly links = new Map<
    string,
    { link: string | null; at: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly api: MaxApiClient,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ContestSubscriptions.name);
  }

  /**
   * Каналы-условия конкурса. Только активные MAX-группы: отключённую или
   * покинутую ботом группу проверить нельзя, и она молча выпадает из
   * условий, а не закрывает приём.
   */
  async requiredChannels(contestId: string): Promise<RequiredChannel[]> {
    const rows = await this.prisma.contestRequiredGroup.findMany({
      where: { contestId, group: { platform: 'max', status: 'active' } },
      select: {
        group: { select: { id: true, externalId: true, title: true } },
      },
      orderBy: { group: { title: 'asc' } },
    });
    return rows.map(({ group }) => ({
      groupId: group.id,
      externalId: group.externalId,
      title: group.title,
    }));
  }

  /** На какие из каналов-условий человек не подписан. Пусто — условие выполнено. */
  async missingFor(
    contestId: string,
    externalUserId: string,
  ): Promise<MissingChannel[]> {
    const channels = await this.requiredChannels(contestId);
    // Параллельно: проверка стоит до ответа на нажатие кнопки, и клиент MAX
    // всё это время крутит «загрузку». Каналов в условии единицы — лимиту
    // MAX такая пачка не страшна.
    const results = await Promise.all(
      channels.map(async (channel): Promise<MissingChannel | null> => {
        const members = await this.membersOf(channel, [externalUserId]);
        if (!members || members.has(externalUserId)) {
          return null;
        }
        return { title: channel.title, link: await this.linkOf(channel) };
      }),
    );
    return results.filter((m): m is MissingChannel => m !== null);
  }

  /**
   * Для розыгрыша: кто из `externalUserIds` не подписан хотя бы на один из
   * `channels`. Каналы передаются снаружи, чтобы все проходы одного
   * розыгрыша сверялись с одним и тем же списком условий.
   */
  async unsubscribedAmong(
    channels: RequiredChannel[],
    externalUserIds: string[],
    /** Сюда — `groupId` каналов, которые проверить не удалось (бота нет). */
    skipped?: Set<string>,
  ): Promise<Set<string>> {
    const unsubscribed = new Set<string>();
    if (externalUserIds.length === 0) {
      return unsubscribed;
    }
    // Каналы параллельно, как и в `missingFor`: розыгрыш ждёт этого внутри
    // транзакции с конечным сроком, и последовательные запросы по каналам
    // складывались бы в него.
    const perChannel = await Promise.all(
      channels.map(async (channel) => ({
        channel,
        members: await this.membersOf(channel, externalUserIds),
      })),
    );
    for (const { channel, members } of perChannel) {
      if (!members) {
        skipped?.add(channel.groupId);
        continue;
      }
      for (const id of externalUserIds) {
        if (!members.has(id)) {
          unsubscribed.add(id);
        }
      }
    }
    return unsubscribed;
  }

  /** Null — бота в канале нет, проверить нечем (см. комментарий к классу). */
  private async membersOf(
    channel: RequiredChannel,
    externalUserIds: string[],
  ): Promise<Set<string> | null> {
    try {
      return await this.api.chatMemberIds(
        Number(channel.externalId),
        externalUserIds.map(Number),
      );
    } catch (err: unknown) {
      if (
        err instanceof MaxApiError &&
        (err.status === 403 || err.status === 404)
      ) {
        this.logger.warn(
          { err, groupId: channel.groupId },
          'Бот не может проверить подписку на канал-условие — условие пропущено',
        );
        return null;
      }
      throw err;
    }
  }

  /** Ссылка нужна только для кнопки «Подписаться» — её отсутствие не отказ. */
  private async linkOf(channel: RequiredChannel): Promise<string | null> {
    // Ссылка канала почти не меняется, а спрашивается на каждое нажатие
    // неподписанного: при потоке нажатий это лишние запросы к лимиту MAX.
    // ponytail: кэш в памяти процесса, без вытеснения — каналов-условий
    // единицы; при нескольких инстансах у каждого свой.
    const hit = this.links.get(channel.groupId);
    if (hit && Date.now() - hit.at < LINK_TTL_MS) {
      return hit.link;
    }
    try {
      const link = (await this.api.getChat(Number(channel.externalId))).link;
      this.links.set(channel.groupId, { link, at: Date.now() });
      return link;
    } catch (err: unknown) {
      this.logger.warn(
        { err, groupId: channel.groupId },
        'Не удалось получить ссылку на канал-условие',
      );
      return null;
    }
  }
}
