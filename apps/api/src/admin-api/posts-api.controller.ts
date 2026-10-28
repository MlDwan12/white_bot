import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { CurrentAdmin } from '../auth/current-admin.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { DirectMessageDispatchService } from '../direct-messages/direct-message-dispatch.service';
import type { DirectMessageRecipientSelector } from '../direct-messages/direct-message-recipients.service';
import type { AdminUser } from '../generated/prisma/client';
import { PlatformUsersService } from '../platform-users/platform-users.service';
import { PostModerationService } from '../posts/post-moderation.service';
import { PostsService } from '../posts/posts.service';
import { PrismaService } from '../prisma/prisma.service';
import { showVk, withoutVk, parseLocal } from './vk-scope';
import {
  CreatePostDto,
  DeletePublishedDto,
  DirectMessageTargetDto,
  DraftPostDto,
  EditPublishedDto,
  NewDirectMessageDto,
} from './posts-api.dto';
import type {
  ModerationOutcome,
  PlatformUser,
  PostDetails,
  PostSummary,
  Wire,
} from '@white-bot/shared';

/**
 * Посты для React-панели — та же обвязка, что в `PanelController`, ответы
 * JSON. VK у роли admin скрыт целиком: его каналы не показываются, выбрать
 * их нельзя, а VK-текст его правки не трогают.
 */
@Controller('api')
@UseGuards(AdminAuthGuard, CsrfGuard)
@RequirePermissions('posts_manage')
export class PostsApiController {
  constructor(
    private readonly posts: PostsService,
    private readonly moderation: PostModerationService,
    private readonly directMessages: DirectMessageDispatchService,
    private readonly platformUsers: PlatformUsersService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Get('posts')
  list(@CurrentAdmin() admin: AdminUser): Promise<Wire<PostSummary[]>> {
    return this.posts.listCampaigns(undefined, showVk(admin));
  }

  /**
   * Создание и, если просили, отправка. Отказ отправки не откатывает
   * создание: пост остаётся черновиком (повторное «Отправить» в форме
   * создало бы второй такой же), причина уходит в ответ.
   */
  @Post('posts')
  async create(@Body() dto: CreatePostDto, @CurrentAdmin() admin: AdminUser) {
    const post = await this.posts.createPost({
      ...this.texts(dto, admin),
      groupIds: await withoutVk(this.prisma, admin, dto.groupIds),
      attachmentIds: dto.attachmentIds,
      scheduledAt: parseLocal(
        dto.scheduledAt,
        this.config.getOrThrow<string>('DEFAULT_TIMEZONE'),
      ),
      autoDeleteAfterMinutes: dto.autoDeleteAfterMinutes ?? null,
    });
    if (!dto.send) {
      return { id: post.id, sendError: null };
    }
    try {
      await this.posts.schedulePost(post.id);
      return { id: post.id, sendError: null };
    } catch (err: unknown) {
      if (!(err instanceof AppException)) throw err;
      return { id: post.id, sendError: sendError(err) };
    }
  }

  @Get('posts/:id')
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUser,
  ): Promise<Wire<PostDetails | { contestId: string }>> {
    // Носитель конкурса — не отдельный пост: всё про него в карточке конкурса.
    const contest = await this.prisma.contest.findUnique({
      where: { postId: id },
      select: { id: true },
    });
    if (contest) {
      return { contestId: contest.id };
    }
    const post = await this.posts.getPostWithDeliveries(id);
    const vk = showVk(admin);
    const dm = await this.prisma.directMessageDelivery.groupBy({
      by: ['status'],
      where: { postId: id },
      _count: { _all: true },
    });
    return {
      contestId: null,
      id: post.id,
      status: post.status,
      text: post.text,
      vkTextOverride: vk ? post.vkTextOverride : null,
      maxTextOverride: post.maxTextOverride,
      createdAt: post.createdAt,
      scheduledAt: post.scheduledAt,
      autoDeleteAfterMinutes: post.autoDeleteAfterMinutes,
      stopRequested: post.stopRequested,
      attachments: post.attachments.map((a) => a.mediaAsset),
      deliveries: post.deliveries
        .filter((d) => vk || d.group.platform !== 'vk')
        .map((d) => ({
          groupId: d.group.id,
          title: d.group.title,
          platform: d.group.platform,
          status: d.status,
          error: d.error,
          sentAt: d.sentAt,
          deletedAt: d.deletedAt,
          autoDeleteDueAt: d.autoDeleteDueAt,
          // Править и снимать можно только то, что реально вышло и не снято.
          published:
            d.status === 'sent' && !d.deletedAt && !!d.externalMessageId,
        })),
      directMessages: Object.fromEntries(
        dm.map((row) => [row.status, row._count._all]),
      ),
    };
  }

  @Post('posts/:id/draft')
  async editDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DraftPostDto,
    @CurrentAdmin() admin: AdminUser,
  ) {
    const post = await this.posts.getPostWithDeliveries(id);
    const hidden = showVk(admin)
      ? []
      : post.deliveries
          .filter((d) => d.group.platform === 'vk')
          .map((d) => d.group.id);
    await this.posts.editDraft(id, {
      ...this.texts(dto, admin, post.vkTextOverride),
      // Скрытые от admin VK-каналы он снять не мог — остаются как были.
      groupIds: [
        ...(await withoutVk(this.prisma, admin, dto.groupIds)),
        ...hidden,
      ],
      attachmentIds: dto.attachmentIds,
      scheduledAt: parseLocal(
        dto.scheduledAt,
        this.config.getOrThrow<string>('DEFAULT_TIMEZONE'),
      ),
      autoDeleteAfterMinutes: dto.autoDeleteAfterMinutes ?? null,
    });
    return { ok: true };
  }

  @Post('posts/:id/published')
  async editPublished(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditPublishedDto,
    @CurrentAdmin() admin: AdminUser,
  ) {
    const outcome = await this.moderation.editPublished(id, {
      text: dto.text,
      // У admin VK-текст не виден — и не трогается (undefined = как было).
      vkTextOverride: showVk(admin)
        ? dto.vkTextOverride?.trim() || null
        : undefined,
      maxTextOverride: dto.maxTextOverride?.trim() || null,
      // Абсолютный срок снимается тоже: он приоритетнее относительного, и без
      // этого очищенное поле не отменяло бы удаление, назначенное через API.
      autoDeleteAfterMinutes: dto.autoDeleteAfterMinutes ?? null,
      autoDeleteAt: null,
      attachmentIds: dto.attachmentIds,
    });
    return { outcome };
  }

  @Post('posts/:id/delete-published')
  async deletePublished(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeletePublishedDto,
    @CurrentAdmin() admin: AdminUser,
  ): Promise<Wire<{ outcome: ModerationOutcome }>> {
    const groupIds = await withoutVk(this.prisma, admin, dto.groupIds);
    if (groupIds.length === 0) {
      // Пустой список сервис понял бы как «удалить отовсюду».
      throw new AppException(ErrorCode.VALIDATION_ERROR, 'Каналы не выбраны');
    }
    return { outcome: await this.moderation.deletePublished(id, groupIds) };
  }

  @Post('posts/:id/send')
  async send(@Param('id', ParseUUIDPipe) id: string) {
    await this.posts.schedulePost(id);
    return { ok: true };
  }

  @Post('posts/:id/stop')
  async stop(@Param('id', ParseUUIDPipe) id: string) {
    await this.posts.stopPost(id);
    return { ok: true };
  }

  @Post('posts/:id/resume')
  async resume(@Param('id', ParseUUIDPipe) id: string) {
    await this.posts.resumePost(id);
    return { ok: true };
  }

  @Post('posts/:id/direct-messages')
  sendDirect(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DirectMessageTargetDto,
  ) {
    return this.directMessages.sendNow(id, selector(dto));
  }

  /**
   * «Написать в личку»: пост только для личных сообщений создаётся и
   * отправляется одним запросом. Отказ рассылки не теряет созданное.
   */
  @Post('direct-messages')
  async newDirect(@Body() dto: NewDirectMessageDto) {
    const target = selector(dto);
    const post = await this.posts.createDirectMessageDraft({
      text: dto.text,
      attachmentIds: dto.attachmentIds,
    });
    return {
      id: post.id,
      ...(await this.directMessages.sendNow(post.id, target)),
    };
  }

  /** Поиск получателя личного сообщения — только MAX: VK личку не шлёт. */
  @Get('platform-users')
  searchUsers(
    @Query('q') q: string | undefined,
  ): Promise<Wire<PlatformUser[]>> {
    return this.platformUsers.search('max', (q ?? '').slice(0, 100));
  }

  private texts(
    dto: { text: string; vkTextOverride?: string; maxTextOverride?: string },
    admin: AdminUser,
    keepVk?: string | null,
  ) {
    return {
      text: dto.text,
      vkTextOverride: showVk(admin)
        ? dto.vkTextOverride?.trim() || undefined
        : (keepVk ?? undefined),
      maxTextOverride: dto.maxTextOverride?.trim() || undefined,
    };
  }
}

function selector(dto: DirectMessageTargetDto): DirectMessageRecipientSelector {
  if (dto.mode === 'user') {
    return { mode: 'user', platformUserId: dto.platformUserId! };
  }
  if (dto.mode === 'group') {
    return { mode: 'group', groupId: dto.groupId! };
  }
  return { mode: 'all' };
}

/** Причина отказа отправки и подсказка, если дело в токене VK. */
function sendError(err: AppException) {
  return {
    message: err.message,
    vkTokenExpired: err.code === ErrorCode.VK_UPLOADER_TOKEN_EXPIRED,
  };
}
