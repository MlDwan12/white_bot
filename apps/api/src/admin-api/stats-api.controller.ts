import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PrismaService } from '../prisma/prisma.service';
import type { StatsReport, Wire } from '@white-bot/shared';

class StatsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsIn([7, 30, 365])
  days?: 7 | 30 | 365;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * «Статистика» разработчика: сводка за период одним запросом страницы.
 * Счётчики — в базе группировками, а не выгрузкой строк: доставок за год
 * тысячи, и в память их тянуть незачем.
 */
@Controller('api/stats')
@UseGuards(AdminAuthGuard)
@RequirePermissions('audit_viewAll')
export class StatsApiController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async stats(@Query() query: StatsQuery): Promise<Wire<StatsReport>> {
    const days = query.days ?? 30;
    const since = new Date(Date.now() - days * DAY_MS);
    // Посты-носители конкурсов и повторяющиеся шаблоны — не «посты»:
    // считаем то, что админ отправлял сам (вхождения шаблонов — тоже).
    const postFilter = { createdAt: { gte: since }, contest: { is: null } };

    const [
      deliveries,
      firstTry,
      sentPosts,
      contestsDrawn,
      contestsOpen,
      participants,
      unique,
      weekly,
      byChannel,
      byChannelParticipants,
      byAdmin,
      admins,
    ] = await Promise.all([
      this.prisma.postDelivery.groupBy({
        by: ['status'],
        where: { post: postFilter },
        _count: { _all: true },
      }),
      this.prisma.postDelivery.count({
        where: { post: postFilter, status: 'sent', attemptsMade: { lte: 1 } },
      }),
      this.prisma.postDelivery.findMany({
        where: { post: postFilter, status: 'sent' },
        distinct: ['postId'],
        select: { postId: true },
      }),
      this.prisma.contestDrawLog.findMany({
        where: { kind: 'draw', drawnAt: { gte: since } },
        distinct: ['contestId'],
        select: { contestId: true },
      }),
      this.prisma.contest.count({ where: { status: 'open' } }),
      this.prisma.contestParticipant.count({
        where: { joinedAt: { gte: since } },
      }),
      // Один человек в разных конкурсах — один ключ `<платформа>:<id>`.
      this.prisma.contestParticipant.findMany({
        where: { joinedAt: { gte: since } },
        distinct: ['dedupKey'],
        select: { dedupKey: true },
      }),
      this.prisma.$queryRaw<{ week: Date; count: number }[]>`
        SELECT date_trunc('week', "joinedAt") AS week, count(*)::int AS count
        FROM "ContestParticipant"
        WHERE "joinedAt" >= ${since}
        GROUP BY 1 ORDER BY 1`,
      this.prisma.postDelivery.groupBy({
        by: ['groupId', 'status'],
        where: { post: postFilter },
        _count: { _all: true },
      }),
      this.prisma.contestParticipant.groupBy({
        by: ['groupId'],
        where: { joinedAt: { gte: since }, groupId: { not: null } },
        _count: { _all: true },
      }),
      // Посты конкурсов не считаются: их `post.send` пишет открытие конкурса,
      // и без этого счётчик постов у админа расходился бы с «Постов
      // отправлено», где они тоже исключены.
      this.prisma.$queryRaw<
        { actorId: string; action: string; count: number }[]
      >`
        SELECT a."actorId", a.action, count(*)::int AS count
        FROM "AuditLog" a
        WHERE a.at >= ${since}
          AND a."actorId" IS NOT NULL
          AND a.action IN ('post.send', 'contest.create')
          AND NOT (a.action = 'post.send' AND EXISTS (
            SELECT 1 FROM "Contest" c WHERE c."postId" = a."entityId"))
        GROUP BY 1, 2`,
      this.prisma.adminUser.findMany({
        select: { id: true, email: true, lastSeenAt: true, disabledAt: true },
        orderBy: { email: 'asc' },
      }),
    ]);

    const count = (
      rows: { status: string; _count: { _all: number } }[],
      s: string,
    ) => rows.find((r) => r.status === s)?._count._all ?? 0;
    const attempted =
      count(deliveries, 'sent') +
      count(deliveries, 'failed') +
      count(deliveries, 'unknown');

    const groupIds = [
      ...new Set([
        ...byChannel.map((r) => r.groupId),
        ...byChannelParticipants.map((r) => r.groupId!),
      ]),
    ];
    const groups = await this.prisma.group.findMany({
      where: { id: { in: groupIds } },
      select: { id: true, title: true, platform: true },
    });

    return {
      days,
      posts: {
        sent: sentPosts.length,
        channels: new Set(
          byChannel.filter((r) => r.status === 'sent').map((r) => r.groupId),
        ).size,
      },
      deliveries: {
        attempted,
        failed: count(deliveries, 'failed') + count(deliveries, 'unknown'),
        firstTry,
      },
      contests: { drawn: contestsDrawn.length, open: contestsOpen },
      participants: { total: participants, unique: unique.length },
      weekly: weekly.map((w) => ({ week: w.week, count: w.count })),
      channels: groups
        .map((g) => {
          const rows = byChannel.filter((r) => r.groupId === g.id);
          const sent = count(rows, 'sent');
          const tried = sent + count(rows, 'failed') + count(rows, 'unknown');
          return {
            id: g.id,
            title: g.title,
            platform: g.platform,
            delivered: tried > 0 ? sent / tried : null,
            participants:
              byChannelParticipants.find((r) => r.groupId === g.id)?._count
                ._all ?? 0,
          };
        })
        .sort((a, b) => b.participants - a.participants),
      admins: admins
        .filter((a) => !a.disabledAt)
        .map((a) => {
          const of = (action: string) =>
            byAdmin.find((r) => r.actorId === a.id && r.action === action)
              ?.count ?? 0;
          return {
            id: a.id,
            email: a.email,
            posts: of('post.send'),
            contests: of('contest.create'),
            lastSeenAt: a.lastSeenAt,
          };
        }),
    };
  }
}
