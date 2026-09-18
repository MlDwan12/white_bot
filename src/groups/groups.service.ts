import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { TokenEncryptionService } from '../common/crypto/token-encryption.service';
import { PrismaService } from '../prisma/prisma.service';
import { Group, GroupKind, Prisma } from '../generated/prisma/client';
import { VkApiClient } from '../vk/vk-api.client';
import { CreateVkGroupDto } from './dto/create-vk-group.dto';
import { maskToken } from './mask-token';
import { VK_TOKEN_PROVIDER } from './token-provider/vk-token.provider';
import type { VkTokenProvider } from './token-provider/vk-token.provider';

/** True for Prisma's unique-constraint violation (P2002) — see https://pris.ly/d/client-error-reference. */
function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

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
    private readonly logger: PinoLogger,
    @Inject(VK_TOKEN_PROVIDER)
    private readonly vkTokenProvider: VkTokenProvider,
  ) {
    this.logger.setContext(GroupsService.name);
  }

  async createVkGroup(
    dto: CreateVkGroupDto,
  ): Promise<PublicGroup & { testMessageSent: boolean }> {
    const pastedToken = this.vkTokenProvider.resolveToken({
      pastedToken: dto.token,
    });

    const info = await this.resolveVkGroupInfoOrThrow(pastedToken);
    const testMessageSent = await this.tryPostVkTestMessage(
      pastedToken,
      info.externalId,
    );

    const accessTokenEncrypted = this.tokenEncryption.encrypt(pastedToken);
    const tokenMask = maskToken(pastedToken);

    const group = await this.upsertVkGroupByExternalId(
      info.externalId,
      { title: info.title, accessTokenEncrypted, tokenMask },
      dto.tags,
    );

    return { ...this.toPublicGroup(group), testMessageSent };
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
      if (!isUniqueConstraintViolation(err)) {
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
    await this.findByIdOrThrow(id);
    const group = await this.prisma.group.update({
      where: { id },
      data: { tags },
    });
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
    const group = await this.prisma.group.update({
      where: { id },
      data: { status: 'removed' },
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

    try {
      const group = existing
        ? await this.prisma.group.update({
            where: { id: existing.id },
            data: {
              title: input.title,
              kind: input.kind,
              status: this.maxDraftStatus(existing),
            },
          })
        : await this.prisma.group.create({
            data: {
              platform: 'max',
              kind: input.kind,
              externalId: input.externalId,
              title: input.title,
              status: 'pending_confirmation',
              tags: [],
            },
          });
      return this.toPublicGroup(group);
    } catch (err: unknown) {
      // See upsertVkGroupByExternalId: the same double-webhook-delivery race
      // applies here (a chat re-add event retried while the first is
      // in-flight), converging by updating the row that now exists.
      if (!isUniqueConstraintViolation(err)) {
        throw err;
      }
      const nowExisting = await this.prisma.group.findUniqueOrThrow({
        where,
      });
      const group = await this.prisma.group.update({
        where: { id: nowExisting.id },
        data: {
          title: input.title,
          kind: input.kind,
          status: this.maxDraftStatus(nowExisting),
        },
      });
      return this.toPublicGroup(group);
    }
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
    const { count } = await this.prisma.group.updateMany({
      where: {
        platform: 'max',
        externalId,
        status: { notIn: ['removed', 'pending_confirmation'] },
      },
      data: { status: 'bot_removed' },
    });
    return count > 0;
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

    const group = await this.prisma.group.update({
      where: { id },
      data: { status: 'active', tags: tags ?? existing.tags },
    });
    return this.toPublicGroup(group);
  }

  async rejectMaxGroup(id: string): Promise<void> {
    const existing = await this.findByIdOrThrow(id);
    this.assertPendingMax(existing);
    // A rejected draft never had a real connection or delivery history, so
    // there's nothing worth a soft-delete audit trail for — unlike an
    // active group being deactivated.
    await this.prisma.group.delete({ where: { id } });
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

  /** Best-effort: a failed test post shouldn't block connecting a group whose token already checked out via groups.getById. */
  private async tryPostVkTestMessage(
    pastedToken: string,
    externalId: string,
  ): Promise<boolean> {
    try {
      await this.vkApiClient.postTestMessage(pastedToken, externalId);
      return true;
    } catch (err: unknown) {
      this.logger.warn(
        { err, externalId },
        'Тестовое сообщение при подключении VK-группы не отправлено',
      );
      return false;
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
