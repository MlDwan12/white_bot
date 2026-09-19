import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { Contest, Platform, Post, Prisma } from '../generated/prisma/client';
import { PostSender } from '../posts/post-sender';
import {
  announcementText,
  contestJoinPayload,
  joinButtonText,
} from './contest-button';
import { buildDedupKey } from './contest-participants';

export type JoinStatus =
  'joined' | 'already_joined' | 'not_open' | 'drawn' | 'unknown_contest';

/**
 * Чем перерисовать анонс после нажатия. Ответ на колбэк в MAX всегда
 * заменяет сообщение целиком, поэтому «не трогать пост» технически означает
 * «вернуть его ровно таким же» — с тем же текстом и тем же набором кнопок,
 * разве что со свежим счётчиком участников.
 */
export interface AnnouncementRefresh {
  text: string;
  buttonText: string;
  payload: string;
}

export interface JoinOutcome {
  status: JoinStatus;
  /** Личное сообщение участнику — доставляется в лс, если бот может ему писать. */
  message: string;
  /** Пусто, если у конкурса нет анонс-поста: перерисовывать нечего. */
  refresh?: AnnouncementRefresh;
}

/** Профиль, как его отдала платформа в момент нажатия. */
export interface PlatformUserProfile {
  externalUserId: string;
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  isBot?: boolean;
  /** Полный ответ платформы — хранится как есть, про запас. */
  raw?: unknown;
}

export interface JoinRequest {
  contestId: string;
  platform: Platform;
  user: PlatformUserProfile;
  /** Внешний id группы, в которой нажата кнопка. */
  groupExternalId: string;
}

/**
 * Участие в конкурсе со стороны платформы: человек нажал кнопку под
 * анонс-постом.
 *
 * Отделено от `ContestsService` не ради красоты, а ради графа модулей:
 * обработчики MAX-бота живут в `MaxModule`, а админские операции конкурса
 * сами зовут MAX (лс победителю, подмена кнопки). Будь это один сервис,
 * модули замкнулись бы друг на друга.
 */
@Injectable()
export class ContestParticipationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ContestParticipationService.name);
  }

  async join(request: JoinRequest): Promise<JoinOutcome> {
    const contest = await this.prisma.contest.findUnique({
      where: { id: request.contestId },
      include: { post: true },
    });

    if (!contest) {
      // Кнопка живёт в опубликованном посте и переживает удаление конкурса.
      return {
        status: 'unknown_contest',
        message: 'Конкурс не найден — возможно, он был удалён.',
      };
    }

    if (contest.status === 'drawn') {
      return {
        status: 'drawn',
        message: await this.resultsMessage(contest.id),
        refresh: await this.buildRefresh(
          contest,
          contest.resultsButtonLabel,
          false,
        ),
      };
    }

    if (contest.status !== 'open') {
      return {
        status: 'not_open',
        message: 'Приём участников ещё не открыт.',
        refresh: await this.buildRefresh(
          contest,
          contest.joinButtonLabel,
          true,
        ),
      };
    }

    const group = await this.prisma.group.findUnique({
      where: {
        platform_externalId: {
          platform: request.platform,
          externalId: request.groupExternalId,
        },
      },
      select: { id: true },
    });

    const dedupKey = buildDedupKey({
      platform: request.platform,
      externalUserId: request.user.externalUserId,
      externalUserIdKind: 'id',
      displayName: request.user.displayName,
    });

    // Профиль заводится до записи в конкурс и обновляется при каждом
    // нажатии: человек мог сменить имя или username с прошлого раза.
    const platformUser = await this.upsertPlatformUser(
      request.platform,
      request.user,
    );

    let status: JoinStatus;
    let message: string;
    try {
      await this.prisma.contestParticipant.create({
        data: {
          contestId: contest.id,
          displayName: request.user.displayName,
          platform: request.platform,
          externalUserId: request.user.externalUserId,
          groupId: group?.id ?? null,
          platformUserId: platformUser.id,
          source: 'button',
          dedupKey,
        },
      });
      status = 'joined';
      message = 'Вы участвуете в конкурсе!';
    } catch (err: unknown) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      // Не ошибка, а обычный повторный клик — в том числе из другой группы
      // того же конкурса: пул общий, значит это один участник.
      status = 'already_joined';
      message = 'Вы уже участвуете в этом конкурсе.';
    }

    return {
      status,
      message,
      refresh: await this.buildRefresh(contest, contest.joinButtonLabel, true),
    };
  }

  /**
   * Профиль человека, участвовавшего хотя бы раз. Живёт отдельно от записи в
   * конкурсе: конкурс можно удалить, а знание о человеке остаётся.
   */
  private async upsertPlatformUser(
    platform: Platform,
    user: PlatformUserProfile,
  ): Promise<{ id: string }> {
    const profile = {
      displayName: user.displayName,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      username: user.username ?? null,
      isBot: user.isBot ?? false,
      // Prisma не принимает голый `null` в Json-колонку — для «ничего нет»
      // у неё отдельное значение. Без этого любой вызов без сырого профиля
      // падал бы уже в рантайме.
      profile: (user.raw ?? Prisma.DbNull) as Prisma.InputJsonValue,
    };

    return this.prisma.platformUser.upsert({
      where: {
        platform_externalUserId: {
          platform,
          externalUserId: user.externalUserId,
        },
      },
      create: {
        platform,
        externalUserId: user.externalUserId,
        ...profile,
      },
      update: { ...profile, lastSeenAt: new Date() },
      select: { id: true },
    });
  }

  /**
   * Собирает пост заново — тем же текстом и с той же кнопкой, только счётчик
   * участников свежий. Именно это и значит «нажатие не портит анонс».
   */
  private async buildRefresh(
    contest: Contest & { post: Post | null },
    label: string,
    withCount: boolean,
  ): Promise<AnnouncementRefresh | undefined> {
    if (!contest.post) {
      return undefined;
    }
    const count = withCount
      ? await this.prisma.contestParticipant.count({
          where: { contestId: contest.id },
        })
      : 0;
    // Победители дописываются в сам пост, потому что это единственный канал,
    // который видят все подписчики: лс от бота доходит не всем.
    const winners =
      contest.status === 'drawn' && contest.publishResultsInPost
        ? await this.winnersList(contest.id)
        : null;
    return {
      text: announcementText(
        PostSender.resolveText(contest.post, 'max'),
        winners,
      ),
      buttonText: joinButtonText(label, count),
      payload: contestJoinPayload(contest.id),
    };
  }

  /**
   * Текст для кнопки после розыгрыша. Тот же текст отдаётся и тому, кто жмёт
   * ещё не подменённую кнопку «Участвовать», — подмена может не пройти, и
   * тогда это единственный способ узнать результат.
   */
  async resultsMessage(contestId: string): Promise<string> {
    const winners = await this.winnersList(contestId);
    return winners ? `Конкурс завершён.\n\n${winners}` : 'Конкурс завершён.';
  }

  /** Только места и победители, без заголовка — чтобы не дублировать его. */
  async winnersList(contestId: string): Promise<string> {
    const prizes = await this.prisma.contestPrize.findMany({
      where: { contestId },
      orderBy: { place: 'asc' },
      include: { winnerParticipant: { select: { displayName: true } } },
    });

    return prizes
      .map(
        (prize) =>
          `${prize.place}. ${prize.label} — ${prize.winnerParticipant?.displayName ?? '—'}`,
      )
      .join('\n');
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}
