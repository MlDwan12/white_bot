import { Inject, Injectable } from '@nestjs/common';
import {
  isForeignKeyViolation,
  isUniqueViolation,
} from '../common/prisma-errors';
import { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { TokenEncryptionService } from '../common/crypto/token-encryption.service';
import { AuditService, changed } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { Group, GroupKind } from '../generated/prisma/client';
import { VkApiClient } from '../vk/vk-api.client';
import { AdminNotifier } from '../max/admin-notifier';
import { CreateVkGroupDto } from './dto/create-vk-group.dto';
import { maskToken } from './mask-token';
import { VK_TOKEN_PROVIDER } from './token-provider/vk-token.provider';
import type { VkTokenProvider } from './token-provider/vk-token.provider';

export interface PublicGroup {
  id: string;
  platform: Group['platform'];
  kind: Group['kind'];
  externalId: string;
  title: string;
  tokenMask: string | null;
  tags: string[];
  status: Group['status'];
  createdAt: Date;
}

@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vkApiClient: VkApiClient,
    private readonly tokenEncryption: TokenEncryptionService,
    private readonly notifier: AdminNotifier,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
    @Inject(VK_TOKEN_PROVIDER)
    private readonly vkTokenProvider: VkTokenProvider,
  ) {
    this.logger.setContext(GroupsService.name);
  }

  async createVkGroup(dto: CreateVkGroupDto): Promise<PublicGroup> {
    const pastedToken = this.vkTokenProvider.resolveToken({
      pastedToken: dto.token,
    });

    const info = await this.resolveVkGroupInfoOrThrow(pastedToken);
    // Эта же форма обновляет токен у уже подключённого сообщества — тогда
    // «подключено» было бы неправдой.
    const previous = await this.prisma.group.findUnique({
      where: {
        platform_externalId: { platform: 'vk', externalId: info.externalId },
      },
      select: { status: true },
    });

    const accessTokenEncrypted = this.tokenEncryption.encrypt(pastedToken);
    const tokenMask = maskToken(pastedToken);

    const group = await this.upsertVkGroupByExternalId(
      info.externalId,
      { title: info.title, accessTokenEncrypted, tokenMask },
      dto.tags,
    );

    // Та же форма обновляет токен уже подключённого (в том числе слетевший —
    // `token_invalid`) — это не подключение. Заново подключённое после
    // отключения (`removed`) — подключение.
    const tokenUpdate = previous != null && previous.status !== 'removed';

    // Подтверждение — только админам, в лс: тестовый пост на стене
    // сообщества увидели бы все подписчики. Не ждём: рассылка идёт по
    // админам по очереди, и тормозящий MAX задерживал бы ответ панели, а
    // `notifyAll` сам не бросает.
    void this.notifier.notifyAll(
      tokenUpdate
        ? `Токен VK-сообщества «${group.title}» обновлён.`
        : `VK-сообщество «${group.title}» подключено.`,
    );

    await this.audit.record({
      action: tokenUpdate ? 'group.token' : 'group.connect_vk',
      entityType: 'group',
      entityId: group.id,
      summary: tokenUpdate
        ? `Заменил токен VK-сообщества «${group.title}»`
        : `Подключил VK-сообщество «${group.title}»`,
    });
    return this.toPublicGroup(group);
  }

  /**
   * Find-then-create/update has a race window between the lookup and the
   * write: two concurrent requests for the same externalId (double-clicked
   * "Connect", a retried webhook) can both see no existing row and both call
   * `create`, so the loser hits the (platform, externalId) unique constraint.
   * On that specific conflict we converge by updating the row the winner
   * just inserted, instead of surfacing a raw 500.
   */
  private async upsertVkGroupByExternalId(
    externalId: string,
    data: { title: string; accessTokenEncrypted: string; tokenMask: string },
    tags?: string[],
  ): Promise<Group> {
    const where = {
      platform_externalId: { platform: 'vk' as const, externalId },
    };
    const existing = await this.prisma.group.findUnique({ where });

    try {
      return existing
        ? await this.prisma.group.update({
            where: { id: existing.id },
            data: { ...data, status: 'active', tags: tags ?? existing.tags },
          })
        : await this.prisma.group.create({
            data: {
              ...data,
              platform: 'vk',
              kind: 'community',
              externalId,
              status: 'active',
              tags: tags ?? [],
            },
          });
    } catch (err: unknown) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      const nowExisting = await this.prisma.group.findUniqueOrThrow({
        where,
      });
      return this.prisma.group.update({
        where: { id: nowExisting.id },
        data: { ...data, status: 'active', tags: tags ?? nowExisting.tags },
      });
    }
  }

  async replaceVkToken(id: string, newToken: string): Promise<PublicGroup> {
    const existing = await this.findByIdOrThrow(id);
    if (existing.platform !== 'vk') {
      throw new AppException(
        ErrorCode.REQUEST_ERROR,
        'Замена токена доступна только для VK-групп',
      );
    }

    const pastedToken = this.vkTokenProvider.resolveToken({
      pastedToken: newToken,
    });
    const info = await this.resolveVkGroupInfoOrThrow(pastedToken);

    if (info.externalId !== existing.externalId) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Новый токен принадлежит другому сообществу VK',
      );
    }

    const group = await this.prisma.group.update({
      where: { id },
      data: {
        title: info.title,
        accessTokenEncrypted: this.tokenEncryption.encrypt(pastedToken),
        tokenMask: maskToken(pastedToken),
        status: 'active',
      },
    });
    await this.audit.record({
      action: 'group.token',
      entityType: 'group',
      entityId: group.id,
      summary: `Заменил токен VK-сообщества «${group.title}»`,
    });
    return this.toPublicGroup(group);
  }

  async listGroups(): Promise<PublicGroup[]> {
    const groups = await this.prisma.group.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return groups.map((group) => this.toPublicGroup(group));
  }

  async getGroup(id: string): Promise<PublicGroup> {
    return this.toPublicGroup(await this.findByIdOrThrow(id));
  }

  async updateTags(id: string, tags: string[]): Promise<PublicGroup> {
    const existing = await this.findByIdOrThrow(id);
    // Условием «теги всё ещё те, что прочитаны»: двойной клик иначе дал бы
    // две записи. Не совпало — их успели сменить, и это сохранение уже
    // ничего не меняет (последнее слово — за успевшим).
    const { count } = await this.prisma.group.updateMany({
      where: { id, tags: { equals: existing.tags } },
      data: { tags },
    });
    const group = await this.findByIdOrThrow(id);
    // Сохранение формы без правки — не действие.
    if (count > 0 && changed(existing.tags, tags)) {
      await this.audit.record({
        action: 'group.tags',
        entityType: 'group',
        entityId: group.id,
        summary: `Изменил теги канала «${group.title}»: ${tags.join(', ') || 'без тегов'}`,
        details: { before: existing.tags, after: tags },
      });
    }
    return this.toPublicGroup(group);
  }

  async deactivate(id: string): Promise<PublicGroup> {
    const existing = await this.findByIdOrThrow(id);
    if (existing.status === 'removed') {
      throw new AppException(
        ErrorCode.REQUEST_ERROR,
        'Группа уже деактивирована',
      );
    }
    const { count } = await this.prisma.group.updateMany({
      where: { id, status: { not: 'removed' } },
      data: { status: 'removed' },
    });
    if (count === 0) {
      // Второй клик: первый уже отключил.
      throw new AppException(
        ErrorCode.REQUEST_ERROR,
        'Группа уже деактивирована',
      );
    }
    const group = await this.findByIdOrThrow(id);
    await this.audit.record({
      action: 'group.deactivate',
      entityType: 'group',
      entityId: group.id,
      summary: `Отключил канал «${group.title}»`,
    });
    return this.toPublicGroup(group);
  }

  /**
   * Called from the (future, Step 5) MAX "bot added to chat/channel" webhook
   * handler. Reactivates a previously-known chat by its unique external id
   * instead of duplicating it, without requiring re-confirmation.
   */
  async createOrReactivateMaxDraft(input: {
    externalId: string;
    kind: GroupKind;
    title: string;
  }): Promise<PublicGroup> {
    const where = {
      platform_externalId: {
        platform: 'max' as const,
        externalId: input.externalId,
      },
    };
    const existing = await this.prisma.group.findUnique({ where });

    let group: Group;
    // Сменился ли статус этим событием — по нему решаем, писать ли в журнал:
    // повтор события статус не меняет, а в гонке двух одинаковых событий
    // второе упирается в уже созданную или обновлённую первым строку.
    let statusChanged: boolean;
    try {
      ({ group, statusChanged } = existing
        ? await this.reactivateMaxGroup(existing, input)
        : {
            statusChanged: true,
            group: await this.prisma.group.create({
              data: {
                platform: 'max',
                kind: input.kind,
                externalId: input.externalId,
                title: input.title,
                status: 'pending_confirmation',
                tags: [],
              },
            }),
          });
    } catch (err: unknown) {
      // See upsertVkGroupByExternalId: the same double-webhook-delivery race
      // applies here (a chat re-add event retried while the first is
      // in-flight), converging by updating the row that now exists.
      if (!isUniqueViolation(err)) {
        throw err;
      }
      const nowExisting = await this.prisma.group.findUniqueOrThrow({
        where,
      });
      ({ group, statusChanged } = await this.reactivateMaxGroup(
        nowExisting,
        input,
      ));
    }
    if (statusChanged) {
      await this.audit.record({
        actor: 'bot',
        action: 'group.bot_added',
        entityType: 'group',
        entityId: group.id,
        summary: `Бота добавили в «${group.title}»${group.status === 'pending_confirmation' ? ' — ждёт подтверждения' : ''}`,
      });
    }
    return this.toPublicGroup(group);
  }

  /**
   * Обновление условием «статус всё ещё тот, что прочитан»: если параллельное
   * такое же событие успело раньше, это ничего не меняет (`statusChanged: false`) —
   * и второй записи в журнале не будет.
   */
  private async reactivateMaxGroup(
    existing: Group,
    input: { kind: GroupKind; title: string },
  ): Promise<{ group: Group; statusChanged: boolean }> {
    const status = this.maxDraftStatus(existing);
    const { count } = await this.prisma.group.updateMany({
      where: { id: existing.id, status: existing.status },
      data: { title: input.title, kind: input.kind, status },
    });
    // Статус успели сменить (подтвердили, параллельное событие) — его не
    // трогаем, но название и тип из события всё равно свежее.
    const group =
      count > 0
        ? await this.prisma.group.findUniqueOrThrow({
            where: { id: existing.id },
          })
        : await this.prisma.group.update({
            where: { id: existing.id },
            data: { title: input.title, kind: input.kind },
          });
    return { group, statusChanged: count > 0 && existing.status !== status };
  }

  // A group that was ever actually confirmed (active/token_invalid/
  // bot_removed) skips re-confirmation on reconnect — that's the whole
  // point of matching by externalId. A still-pending draft was never
  // confirmed in the first place, and a `removed` group was explicitly
  // disconnected by an admin, so both require going through confirmation
  // again rather than silently reactivating behind the admin's back.
  private maxDraftStatus(existing: Group): Group['status'] {
    return existing.status === 'pending_confirmation' ||
      existing.status === 'removed'
      ? 'pending_confirmation'
      : 'active';
  }

  /**
   * MAX's `bot_removed` event: the bot can no longer post there, so the group
   * stops being a valid delivery target. Deliberately not a soft-delete —
   * `bot_removed` is recoverable (re-adding the bot reactivates the row via
   * createOrReactivateMaxDraft), while `removed` means an admin disconnected
   * it on purpose and must confirm again.
   *
   * An unknown chat_id is not an error: the bot can be removed from a chat
   * whose draft was already rejected (rejectMaxGroup hard-deletes the row),
   * and a removal event for a group we never tracked is simply nothing to do.
   *
   * A still-`pending_confirmation` draft is deliberately left untouched.
   * `maxDraftStatus` reads `bot_removed` as proof the group was confirmed
   * once, so overwriting a draft here would let this sequence through: bot
   * added → draft created → bot removed before anyone reviews it → bot
   * re-added → group silently becomes `active`. That would make a chat a live
   * broadcast target that no admin ever approved.
   */
  async markMaxGroupBotRemoved(externalId: string): Promise<boolean> {
    // Одним запросом с RETURNING: id и название для журнала приходят
    // только при реальной смене статуса. Уже помеченная не трогается —
    // строка возвращается, лишь если статус сменился, и два одновременных
    // одинаковых события не дадут двух записей «бота удалили».
    const [removed] = await this.prisma.$queryRaw<
      { id: string; title: string }[]
    >`
      UPDATE "Group" SET status = 'bot_removed'
      WHERE platform = 'max' AND "externalId" = ${externalId}
        AND status NOT IN ('removed', 'pending_confirmation', 'bot_removed')
      RETURNING id, title`;
    if (removed) {
      await this.audit.record({
        actor: 'bot',
        action: 'group.bot_removed',
        entityType: 'group',
        entityId: removed.id,
        summary: `Бота удалили из канала «${removed.title}»`,
      });
    }
    return removed !== undefined;
  }

  /** MAX drafts awaiting an admin's confirm/reject decision. */
  async listPendingMaxGroups(): Promise<PublicGroup[]> {
    const groups = await this.prisma.group.findMany({
      where: { platform: 'max', status: 'pending_confirmation' },
      orderBy: { createdAt: 'asc' },
    });
    return groups.map((group) => this.toPublicGroup(group));
  }

  async confirmMaxGroup(id: string, tags?: string[]): Promise<PublicGroup> {
    const existing = await this.findByIdOrThrow(id);
    this.assertPendingMax(existing);

    // Условием: уведомление о новой группе получают все админы, и два
    // почти одновременных «Подтвердить» иначе дали бы две записи в журнале.
    const { count } = await this.prisma.group.updateMany({
      where: { id, status: 'pending_confirmation' },
      data: { status: 'active', tags: tags ?? existing.tags },
    });
    const group = await this.prisma.group.findUniqueOrThrow({ where: { id } });
    // Не мы перевели — второе «Подтвердить» (уже `active`, тихо) или группу
    // успели отклонить: тогда «подключена» было бы неправдой.
    if (count === 0 && group.status !== 'active') {
      throw new AppException(
        ErrorCode.REQUEST_ERROR,
        'Группа уже не ждёт подтверждения',
      );
    }
    if (count > 0) {
      await this.audit.record({
        action: 'group.confirm',
        entityType: 'group',
        entityId: group.id,
        summary: `Подтвердил канал «${group.title}»`,
      });
    }
    return this.toPublicGroup(group);
  }

  async rejectMaxGroup(id: string): Promise<void> {
    const existing = await this.findByIdOrThrow(id);
    this.assertPendingMax(existing);
    // A fresh draft never had a real connection or delivery history, so
    // there's nothing worth a soft-delete audit trail for — unlike an
    // active group being deactivated. A draft can also be a *returning*
    // group (bot re-added after removal) that still carries history —
    // deliveries, a contest's subscription condition — and those rows pin
    // it: the delete then fails on a foreign key, and the rejection falls
    // back to the same soft-delete a deactivation uses.
    // Условием «всё ещё ждёт подтверждения»: второе «Отклонить» (или
    // «Подтвердить» другого админа) иначе падало бы на P2025 — 500 — или
    // писало вторую запись в журнал.
    const pending = { id, status: 'pending_confirmation' as const };
    let count: number;
    try {
      ({ count } = await this.prisma.group.deleteMany({ where: pending }));
    } catch (err: unknown) {
      if (!isForeignKeyViolation(err)) {
        throw err;
      }
      ({ count } = await this.prisma.group.updateMany({
        where: pending,
        data: { status: 'removed' },
      }));
    }
    if (count === 0) {
      throw new AppException(ErrorCode.REQUEST_ERROR, 'Группа уже обработана');
    }
    await this.audit.record({
      action: 'group.reject',
      entityType: 'group',
      entityId: id,
      summary: `Отклонил канал «${existing.title}»`,
    });
  }

  private assertPendingMax(group: Group): void {
    if (group.platform !== 'max' || group.status !== 'pending_confirmation') {
      throw new AppException(
        ErrorCode.REQUEST_ERROR,
        'Группа не ожидает подтверждения',
      );
    }
  }

  private async resolveVkGroupInfoOrThrow(pastedToken: string) {
    try {
      return await this.vkApiClient.resolveGroupInfo(pastedToken);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'неизвестная ошибка';
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        `Не удалось проверить токен VK: ${message}`,
      );
    }
  }

  private async findByIdOrThrow(id: string): Promise<Group> {
    const group = await this.prisma.group.findUnique({ where: { id } });
    if (!group) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Группа не найдена');
    }
    return group;
  }

  private toPublicGroup(group: Group): PublicGroup {
    return {
      id: group.id,
      platform: group.platform,
      kind: group.kind,
      externalId: group.externalId,
      title: group.title,
      tokenMask: group.tokenMask,
      tags: group.tags,
      status: group.status,
      createdAt: group.createdAt,
    };
  }
}
