import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { CurrentAdmin } from '../auth/current-admin.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { ContestsService } from '../contests/contests.service';
import type { AdminUser, Prisma } from '../generated/prisma/client';
import { PostModerationService } from '../posts/post-moderation.service';
import { PostsService } from '../posts/posts.service';
import { PrismaService } from '../prisma/prisma.service';
import { hiddenVkIds, parseLocal, showVk, withoutVk } from './vk-scope';
import {
  ContestConditionsDto,
  CreateContestWithPostDto,
  ManualParticipantsDto,
  ParticipantsQueryDto,
  PrizeLabelsDto,
  PublicationDto,
  WinnerDto,
} from './contests-api.dto';
import type {
  ContestDetails,
  ContestSummary,
  FunnelStats,
  ParticipantsPage,
  Wire,
} from '@white-bot/shared';

const PAGE_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Конкурсы для панели (`apps/web`).
 *
 * VK у роли admin скрыт целиком: его каналы в ответы не попадают (`vk-scope`).
 */
@Controller('api/contests')
@UseGuards(AdminAuthGuard, CsrfGuard)
@RequirePermissions('contests_manage')
export class ContestsApiController {
  constructor(
    private readonly contests: ContestsService,
    private readonly posts: PostsService,
    private readonly moderation: PostModerationService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ContestsApiController.name);
  }

  @Get()
  list(@CurrentAdmin() admin: AdminUser): Promise<Wire<ContestSummary[]>> {
    return this.contests.listContests(undefined, showVk(admin));
  }

  /**
   * Создание конкурса вместе с публикацией. Все проверки, которые может
   * провалить `createContest`, повторены **до** создания поста: иначе отказ
   * оставил бы черновик-сироту без конкурса (как в старой панели).
   */
  @Post()
  async create(
    @Body() dto: CreateContestWithPostDto,
    @CurrentAdmin() admin: AdminUser,
  ) {
    const startsAt = parseLocal(
      dto.startsAt,
      this.config.getOrThrow<string>('DEFAULT_TIMEZONE'),
    );
    const endsAt = parseLocal(
      dto.endsAt,
      this.config.getOrThrow<string>('DEFAULT_TIMEZONE'),
    );
    if (startsAt && endsAt && startsAt >= endsAt) {
      throw validation('Дата розыгрыша должна быть позже публикации');
    }
    if (endsAt && endsAt.getTime() <= Date.now()) {
      throw validation('Дата розыгрыша не может быть в прошлом');
    }
    if (endsAt && dto.prizes.length === 0) {
      throw validation('Для розыгрыша по дате нужно хотя бы одно место');
    }
    const groupIds = await withoutVk(this.prisma, admin, dto.groupIds);
    const requiredGroupIds = await this.contests.assertRequirableGroups(
      await withoutVk(this.prisma, admin, dto.requiredGroupIds),
    );
    await this.contests.assertPublishChannels(groupIds);

    const text = dto.text.trim();
    const post = await this.posts.createPost({
      text,
      groupIds,
      attachmentIds: dto.attachmentIds,
    });
    const contest = await this.contests.createContest({
      title: dto.title.trim(),
      description: text,
      postId: post.id,
      joinButtonLabel: dto.joinButtonLabel?.trim() || undefined,
      resultsButtonLabel: dto.resultsButtonLabel?.trim() || undefined,
      notifyWinners: dto.notifyWinners,
      publishResultsInPost: dto.publishResultsInPost,
      startsAt,
      endsAt,
      placesCount: dto.prizes.length,
      requiredGroupIds,
    });
    if (dto.prizes.length > 0) {
      await this.contests.setPrizes(contest.id, prizeInputs(dto.prizes));
    }
    return { id: contest.id };
  }

  @Get(':id')
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUser,
  ): Promise<Wire<ContestDetails>> {
    const contest = await this.contests.getContest(id);
    const vk = showVk(admin);
    const since = new Date(Date.now() - DAY_MS);
    const actorIds = [
      ...new Set(contest.drawLogs.map((l) => l.actorId).filter(isString)),
    ];
    const actors = await this.prisma.adminUser.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, email: true },
    });
    const actorEmail = new Map(actors.map((a) => [a.id, a.email]));
    // Имена — только тех, кого упоминает журнал перевыборов.
    const loggedIds = contest.drawLogs.flatMap((log) => {
      const snapshot = log.resultSnapshot as Record<string, unknown>;
      return [snapshot.previousParticipantId, snapshot.participantId].filter(
        (v): v is string => typeof v === 'string',
      );
    });
    const [participantsCount, participantsLastDay, logged] = await Promise.all([
      this.prisma.contestParticipant.count({ where: { contestId: id } }),
      this.prisma.contestParticipant.count({
        where: { contestId: id, joinedAt: { gte: since } },
      }),
      this.prisma.contestParticipant.findMany({
        where: { id: { in: [...new Set(loggedIds)] } },
        select: {
          id: true,
          displayName: true,
          platformUser: { select: { username: true } },
        },
      }),
    ]);
    const participantName = new Map(
      logged.map((p) => [p.id, participantLabel(p)]),
    );

    return {
      id: contest.id,
      title: contest.title,
      status: contest.status,
      createdAt: contest.createdAt,
      startsAt: contest.startsAt,
      endsAt: contest.endsAt,
      joinButtonLabel: contest.joinButtonLabel,
      resultsButtonLabel: contest.resultsButtonLabel,
      notifyWinners: contest.notifyWinners,
      publishResultsInPost: contest.publishResultsInPost,
      participantsCount,
      participantsLastDay,
      post: contest.post && {
        id: contest.post.id,
        status: contest.post.status,
        text: contest.post.text,
        attachments: contest.post.attachments.map((a) => ({
          id: a.mediaAsset.id,
          filename: a.mediaAsset.filename,
          kind: a.mediaAsset.kind,
        })),
        deliveries: contest.post.deliveries
          .filter((d) => vk || d.group.platform !== 'vk')
          .map((d) => ({
            groupId: d.group.id,
            title: d.group.title,
            platform: d.group.platform,
            status: d.status,
            error: d.error,
          })),
      },
      requiredGroups: contest.requiredGroups
        .map((r) => r.group)
        .filter((g) => vk || g.platform !== 'vk')
        .map((g) => ({ id: g.id, title: g.title, status: g.status })),
      prizes: contest.prizes.map((prize) => ({
        id: prize.id,
        place: prize.place,
        label: prize.label,
        isForced: prize.isForced,
        notifyStatus: prize.notifyStatus,
        notifyError: prize.notifyError,
        winner: prize.winnerParticipant && {
          id: prize.winnerParticipant.id,
          name: participantLabel(prize.winnerParticipant),
          source: prize.winnerParticipant.source,
        },
      })),
      // Подписи мест правятся списком, который нумерует их подряд с первого.
      // Места «вразбежку» или с переносом в подписи (заведены через API) так
      // не воспроизвести — сохранение без единой правки переписало бы их.
      prizesEditable: contest.prizes.every(
        (prize, index) =>
          prize.place === index + 1 && !prize.label.includes('\n'),
      ),
      drawLogs: contest.drawLogs.map((log) => {
        const snapshot = log.resultSnapshot as Record<string, unknown>;
        return {
          id: log.id,
          kind: log.kind,
          drawnAt: log.drawnAt,
          actor: log.actorId ? (actorEmail.get(log.actorId) ?? null) : null,
          note: log.note,
          seed: log.seed,
          poolSize: arrayLength(snapshot.participantIds),
          disqualified: arrayLength(snapshot.disqualifiedParticipantIds),
          place: typeof snapshot.place === 'number' ? snapshot.place : null,
          previous:
            typeof snapshot.previousParticipantId === 'string'
              ? (participantName.get(snapshot.previousParticipantId) ?? null)
              : null,
          next:
            typeof snapshot.participantId === 'string'
              ? (participantName.get(snapshot.participantId) ?? null)
              : null,
        };
      }),
    };
  }

  /** Участники страницами по 50, с поиском по имени и нику. */
  @Get(':id/participants')
  async participants(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ParticipantsQueryDto,
    @CurrentAdmin() admin: AdminUser,
  ): Promise<Wire<ParticipantsPage>> {
    const where = participantsWhere(id, query.q);
    const [total, rows] = await Promise.all([
      this.prisma.contestParticipant.count({ where }),
      this.prisma.contestParticipant.findMany({
        where,
        orderBy: { joinedAt: 'desc' },
        skip: query.offset ?? 0,
        take: PAGE_SIZE,
        include: {
          group: { select: { title: true, platform: true } },
          platformUser: { select: { username: true } },
        },
      }),
    ]);
    const vk = showVk(admin);
    return {
      total,
      pageSize: PAGE_SIZE,
      items: rows.map((p) => ({
        id: p.id,
        name: participantLabel(p),
        group:
          p.group && (vk || p.group.platform !== 'vk') ? p.group.title : null,
        joinedAt: p.joinedAt,
        source: p.source,
      })),
    };
  }

  /** Выгрузка всех участников для Excel: `;` и BOM — так он открывает кириллицу. */
  @Get(':id/participants.csv')
  async participantsCsv(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUser,
    @Res() res: Response,
  ): Promise<void> {
    await this.contests.getContest(id); // 404, если конкурса нет
    const participants = await this.prisma.contestParticipant.findMany({
      where: { contestId: id },
      orderBy: { joinedAt: 'asc' },
      include: {
        group: { select: { title: true } },
        platformUser: { select: { username: true } },
      },
    });
    const vk = showVk(admin);
    const zone = this.config.getOrThrow<string>('DEFAULT_TIMEZONE');
    const when = new Intl.DateTimeFormat('ru-RU', {
      timeZone: zone,
      dateStyle: 'short',
      timeStyle: 'short',
    });
    const lines = [
      [
        'Имя',
        'Ник',
        'Платформа',
        'Id на платформе',
        'Откуда',
        'Когда',
        'Способ',
      ],
      ...participants
        .filter((p) => vk || p.platform !== 'vk')
        .map((p) => [
          p.displayName,
          p.platformUser?.username ?? '',
          p.platform,
          p.externalUserId ?? '',
          p.group?.title ?? '',
          when.format(p.joinedAt),
          p.source === 'manual' ? 'вручную' : 'кнопка',
        ]),
    ];
    const body = lines
      .map((cells) => cells.map(csvCell).join(';'))
      .join('\r\n');
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="participants-${id}.csv"`,
    });
    res.send(`\uFEFF${body}`);
  }

  /** Воронка участия — статистика разработчика. */
  @Get(':id/funnel')
  @RequirePermissions('contests_manage', 'audit_viewAll')
  funnel(@Param('id', ParseUUIDPipe) id: string): Promise<Wire<FunnelStats>> {
    return this.contests.funnelStats(id);
  }

  @Post(':id/conditions')
  async conditions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ContestConditionsDto,
    @CurrentAdmin() admin: AdminUser,
  ) {
    await this.contests.editContest(id, {
      title: dto.title.trim(),
      joinButtonLabel: dto.joinButtonLabel?.trim() || undefined,
      resultsButtonLabel: dto.resultsButtonLabel?.trim() || undefined,
      notifyWinners: dto.notifyWinners,
      publishResultsInPost: dto.publishResultsInPost,
      startsAt: parseLocal(
        dto.startsAt,
        this.config.getOrThrow<string>('DEFAULT_TIMEZONE'),
      ),
      endsAt: parseLocal(
        dto.endsAt,
        this.config.getOrThrow<string>('DEFAULT_TIMEZONE'),
      ),
      requiredGroupIds: await this.keepHiddenRequired(
        id,
        admin,
        dto.requiredGroupIds,
      ),
    });
    return { ok: true };
  }

  /**
   * Открыть приём и отправить анонс. Отказ отправки не откатывает открытие:
   * участие и публикация независимы, сверка повторит отправку сама.
   */
  @Post(':id/open')
  async open(@Param('id', ParseUUIDPipe) id: string) {
    const contest = await this.contests.openContest(id);
    if (!contest.postId) {
      return { ok: true };
    }
    try {
      await this.posts.schedulePostIfDraft(contest.postId);
    } catch (err: unknown) {
      this.logger.warn(
        { err, contestId: id, postId: contest.postId },
        'Приём открыт, но анонс-пост отправить не удалось',
      );
      throw new AppException(
        ErrorCode.REQUEST_ERROR,
        `Приём открыт, но публикация не ушла: ${
          err instanceof AppException ? err.message : 'ошибка отправки'
        }. Повторная попытка — автоматически в течение минуты.`,
      );
    }
    return { ok: true };
  }

  /**
   * Текст и картинка, а до отправки — и каналы. Черновик правится как
   * черновик, опубликованное — правкой сообщений во всех каналах.
   */
  @Post(':id/publication')
  async publication(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublicationDto,
    @CurrentAdmin() admin: AdminUser,
  ) {
    const text = dto.text.trim();
    if (!text) {
      throw validation('Текст конкурса обязателен — его увидят подписчики');
    }
    const post = await this.contests.contestPost(id);
    if (!post) {
      throw validation('У этого конкурса нет публикации');
    }
    let outcome: { succeeded: number; failed: unknown[] } | null = null;
    if (post.status === 'draft') {
      const current = post.deliveries.map((d) => d.groupId);
      // Скрытые от админа VK-каналы он снять не мог — оставляем как были.
      const groupIds =
        dto.groupIds === undefined
          ? current
          : [
              ...(await withoutVk(this.prisma, admin, dto.groupIds)),
              ...(await hiddenVkIds(this.prisma, admin, current)),
            ];
      await this.contests.assertPublishChannels(groupIds, current);
      await this.posts.editDraft(post.id, {
        text,
        groupIds,
        attachmentIds: dto.attachmentIds,
      });
    } else {
      outcome = await this.moderation.editPublished(post.id, {
        text,
        // У конкурса один текст: переопределение для MAX имело бы приоритет,
        // и правка отрапортовала бы успех, оставив в каналах старое.
        vkTextOverride: null,
        maxTextOverride: null,
        attachmentIds: dto.attachmentIds,
      });
    }
    // `description` — копия текста для списка конкурсов.
    await this.prisma.contest.update({
      where: { id },
      data: { description: text },
    });
    return { outcome };
  }

  /** «Отправить оставшимся» — сбойные каналы публикации. */
  @Post(':id/publication/resume')
  async resume(@Param('id', ParseUUIDPipe) id: string) {
    const post = await this.contests.contestPost(id);
    if (!post) {
      throw validation('У этого конкурса нет публикации');
    }
    await this.posts.resumePost(post.id);
    return { ok: true };
  }

  /**
   * Удаление — только до розыгрыша. Неснятое сообщение удаление не
   * останавливает: такие каналы возвращаются списком — убрать руками.
   */
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    const { messages, uncertain } = await this.contests.deleteContest(id);
    const failed = await this.moderation.deleteMessages(messages);
    return {
      leftBehind: [
        ...uncertain.map((title) => `«${title}» — исход отправки неизвестен`),
        ...failed.map((f) => `«${f.groupTitle}» — ${f.error}`),
      ],
    };
  }

  @Post(':id/prizes')
  async prizes(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PrizeLabelsDto,
  ) {
    const current = await this.prisma.contestPrize.findMany({
      where: { contestId: id },
      orderBy: { place: 'asc' },
      select: { place: true, label: true },
    });
    if (
      !current.every(
        (prize, index) =>
          prize.place === index + 1 && !prize.label.includes('\n'),
      )
    ) {
      throw new AppException(
        ErrorCode.REQUEST_ERROR,
        'Места этого конкурса заведены не по порядку — здесь их не править',
      );
    }
    if (dto.prizes.length === 0) {
      throw validation('Впишите хотя бы одно место');
    }
    await this.contests.setPrizes(id, prizeInputs(dto.prizes));
    return { ok: true };
  }

  @Post(':id/participants')
  async addParticipants(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ManualParticipantsDto,
    @CurrentAdmin() admin: AdminUser,
  ) {
    return this.contests.addParticipantsFromText(
      id,
      dto.text,
      showVk(admin) ? dto.platform : 'max',
    );
  }

  @Post(':id/draw')
  async draw(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUser,
  ) {
    await this.contests.draw(id, admin.id);
    return { ok: true };
  }

  /** «Подкрутка» до розыгрыша: место закрепляется за участником. */
  @Post(':id/prizes/:prizeId/force-winner')
  async forceWinner(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('prizeId', ParseUUIDPipe) prizeId: string,
    @Body() dto: WinnerDto,
  ) {
    await this.assertPrizeOf(id, prizeId);
    await this.contests.forceWinner(prizeId, dto.participantId);
    return { ok: true };
  }

  /** Замена победителя после розыгрыша — отдельной записью в журнале. */
  @Post(':id/prizes/:prizeId/override-winner')
  async overrideWinner(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('prizeId', ParseUUIDPipe) prizeId: string,
    @Body() dto: WinnerDto,
    @CurrentAdmin() admin: AdminUser,
  ) {
    await this.assertPrizeOf(id, prizeId);
    await this.contests.overrideWinner(
      prizeId,
      dto.participantId,
      dto.note?.trim() || undefined,
      admin.id,
    );
    return { ok: true };
  }

  /** Админ сам связался с победителем — бот не смог или не пробовал. */
  @Post(':id/prizes/:prizeId/notified')
  async markNotified(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('prizeId', ParseUUIDPipe) prizeId: string,
  ) {
    await this.contests.markWinnerNotified(id, prizeId);
    return { ok: true };
  }

  /**
   * Приз из адреса обязан принадлежать конкурсу из адреса: сервис проверяет
   * только пару «приз ↔ участник», и подделанный запрос сменил бы победителя
   * в чужом конкурсе.
   */
  private async assertPrizeOf(contestId: string, prizeId: string) {
    const prize = await this.prisma.contestPrize.findUnique({
      where: { id: prizeId },
      select: { contestId: true },
    });
    if (prize?.contestId !== contestId) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Призовое место не найдено');
    }
  }

  /** Условия на скрытые от admin VK-группы его правка не снимает. */
  private async keepHiddenRequired(
    contestId: string,
    admin: AdminUser,
    ids: string[],
  ) {
    if (showVk(admin)) {
      return ids;
    }
    const hidden = await this.prisma.contestRequiredGroup.findMany({
      where: { contestId, group: { platform: 'vk' } },
      select: { groupId: true },
    });
    return [
      ...(await withoutVk(this.prisma, admin, ids)),
      ...hidden.map((h) => h.groupId),
    ];
  }
}

function validation(message: string): AppException {
  return new AppException(ErrorCode.VALIDATION_ERROR, message);
}

function prizeInputs(labels: string[]) {
  return labels.map((label, index) => ({
    place: index + 1,
    label: label.trim(),
  }));
}

function participantsWhere(
  contestId: string,
  q: string | undefined,
): Prisma.ContestParticipantWhereInput {
  const search = q?.trim();
  if (!search) {
    return { contestId };
  }
  return {
    contestId,
    OR: [
      { displayName: { contains: search, mode: 'insensitive' } },
      {
        platformUser: {
          username: { contains: search.replace(/^@/, ''), mode: 'insensitive' },
        },
      },
    ],
  };
}

function participantLabel(p: {
  displayName: string;
  platformUser?: { username: string | null } | null;
}): string {
  const username = p.platformUser?.username;
  return username ? `${p.displayName} @${username}` : p.displayName;
}

function arrayLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function isString(value: string | null): value is string {
  return value !== null;
}

/** Ячейка CSV: кавычки, и формулы Excel не исполняются (`=`, `+`, `-`, `@`). */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
