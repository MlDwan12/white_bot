import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { Contest, Platform, Post, Prisma } from '../generated/prisma/client';
import { PostSender } from '../posts/post-sender';
import {
  PlatformUsersService,
  type PlatformUserProfile,
} from '../platform-users/platform-users.service';
import {
  announcementText,
  contestJoinPayload,
  joinButtonText,
  winnerCongratulation,
} from './contest-button';
import { buildDedupKey } from './contest-participants';

export type JoinStatus =
  | 'joined'
  | 'already_joined'
  | 'not_open'
  | 'drawn'
  | 'unknown_contest'
  | 'consent_required';

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

export interface StartedFromLink {
  /** Что ответить в открытом диалоге. */
  text: string;
  /** Места победителя, которые после успешной отправки помечаются уведомлёнными. */
  prizeIdsToMark: string[];
  /** Участие записано впервые: у постов надо обновить счётчик на кнопке. */
  joined: boolean;
}

export interface JoinRequest {
  contestId: string;
  platform: Platform;
  user: PlatformUserProfile;
  /**
   * Внешний id группы, в которой нажата кнопка. Со ссылки на бота его нет:
   * человек приходит в диалог, а не из канала. Тогда группа берётся, только
   * если анонс вышел ровно в одну MAX-группу, иначе остаётся пустой — это
   * справочное поле, а не часть ключа дедупликации.
   */
  groupExternalId?: string | null;
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
    private readonly platformUsers: PlatformUsersService,
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

    // Единая точка: `join` — единственное место, которое действительно
    // сохраняет профиль и записывает участие, и все три пути к нему (старт
    // бота по ссылке, кнопка прямо под постом в канале, мини-приложение)
    // обязаны пройти эту проверку — а не только тот, что явно показывает
    // экран согласия. Без неё кнопка в канале записывала бы участие и
    // профиль, минуя согласие целиком. Проверяется до похода за группой:
    // без согласия эта группа всё равно не понадобится.
    if (
      !(await this.platformUsers.hasConsented(
        request.platform,
        request.user.externalUserId,
      ))
    ) {
      return {
        status: 'consent_required',
        message:
          'Чтобы участвовать, сначала откройте диалог с ботом («Начать») и подтвердите согласие на обработку персональных данных.',
      };
    }

    const group = request.groupExternalId
      ? await this.prisma.group.findUnique({
          where: {
            platform_externalId: {
              platform: request.platform,
              externalId: request.groupExternalId,
            },
          },
          select: { id: true },
        })
      : await this.soleDeliveryGroup(contest.post?.id, request.platform);

    const dedupKey = buildDedupKey({
      platform: request.platform,
      externalUserId: request.user.externalUserId,
      externalUserIdKind: 'id',
      displayName: request.user.displayName,
    });

    // Профиль заводится до записи в конкурс и обновляется при каждом
    // нажатии: человек мог сменить имя или username с прошлого раза.
    const platformUser = await this.platformUsers.upsert(
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
   * Человек перешёл по ссылке с кнопки конкурса и нажал «Начать»: диалог с
   * ботом открыт, и бот может ему писать.
   *
   * До розыгрыша это и есть участие: кнопка под постом — ссылка, а не
   * колбэк, так что регистрирует человека именно этот старт. Ответ зависит
   * от исхода: записан, уже был записан, приём ещё не открыт.
   *
   * После розыгрыша победитель, у которого поздравление не дошло (диалога не
   * было), получает его прямо сейчас — иначе кнопка «Узнать результаты»
   * обещала бы то, чего не делает. Остальным отвечаем списком победителей.
   * Ответ несёт и список мест, которые после успешной отправки надо пометить
   * уведомлёнными.
   *
   * `redraw` заполнен, только если участие записано впервые: в этом случае у
   * постов надо обновить счётчик на кнопке.
   */
  async startedFromLink(
    contestId: string,
    user: PlatformUserProfile,
  ): Promise<StartedFromLink> {
    const contest = await this.prisma.contest.findUnique({
      where: { id: contestId },
      include: {
        post: true,
        prizes: {
          orderBy: { place: 'asc' },
          include: {
            winnerParticipant: {
              select: { platform: true, externalUserId: true },
            },
          },
        },
      },
    });
    if (!contest) {
      return {
        text: 'Этот конкурс не найден — возможно, его уже удалили.',
        prizeIdsToMark: [],
        joined: false,
      };
    }

    if (contest.status === 'drawn') {
      // Поздравление задним числом — только там, где оно не дошло. Место
      // в состоянии `pending` принадлежит уведомителю: розыгрыш только что
      // прошёл, и он вот-вот пришлёт своё. Ответь мы здесь тоже — победитель
      // получил бы два одинаковых поздравления.
      const late = contest.notifyWinners
        ? contest.prizes.filter(
            (prize) =>
              prize.winnerParticipant?.platform === 'max' &&
              prize.winnerParticipant.externalUserId === user.externalUserId &&
              (prize.notifyStatus === 'manual_required' ||
                prize.notifyStatus === 'failed'),
          )
        : [];
      if (late.length > 0) {
        return {
          text: late
            .map((prize) =>
              winnerCongratulation(prize.place, contest.title, prize.label),
            )
            .join('\n'),
          prizeIdsToMark: late.map((prize) => prize.id),
          joined: false,
        };
      }
      // Остальным — список победителей: и тому, кто не выиграл, и победителю,
      // которого уже поздравили (`sent`, `notified_manually` — отметка
      // человека, автоматика её не трогает).
      return {
        text: await this.resultsMessage(contest.id),
        prizeIdsToMark: [],
        joined: false,
      };
    }

    const outcome = await this.join({
      contestId,
      platform: 'max',
      user,
      groupExternalId: null,
    });

    if (outcome.status === 'joined' || outcome.status === 'already_joined') {
      const lead =
        outcome.status === 'joined'
          ? `Вы участвуете в конкурсе «${contest.title}»!`
          : `Вы уже участвуете в конкурсе «${contest.title}».`;
      return {
        text: `${lead} Итоги пришлю сюда.`,
        prizeIdsToMark: [],
        joined: outcome.status === 'joined',
      };
    }

    return { text: outcome.message, prizeIdsToMark: [], joined: false };
  }

  /**
   * Что перерисовать у анонса **сейчас**: свежий счётчик и сообщения во всех
   * MAX-группах. Считается заново при каждом вызове, а не берётся из ответа
   * `join`: правки от разных участников идут вперемешку, и устаревшее число
   * перезаписало бы более новое.
   *
   * После розыгрыша — `null`: пост тогда принадлежит уведомителю (победители,
   * «Узнать результаты»), и запоздалая правка счётчика затёрла бы итоги.
   */
  async announcementRefresh(
    contestId: string,
  ): Promise<(AnnouncementRefresh & { messageIds: string[] }) | null> {
    const contest = await this.prisma.contest.findUnique({
      where: { id: contestId },
      include: { post: true },
    });
    if (!contest?.post || contest.status === 'drawn') {
      return null;
    }
    const refresh = await this.buildRefresh(
      contest,
      contest.joinButtonLabel,
      true,
    );
    if (!refresh) {
      return null;
    }
    return {
      ...refresh,
      messageIds: await this.sentMaxMessageIds(contest.post.id),
    };
  }

  /** Сообщения анонса во всех MAX-группах, куда он вышел. */
  private async sentMaxMessageIds(
    postId: string | undefined,
  ): Promise<string[]> {
    if (!postId) {
      return [];
    }
    const deliveries = await this.prisma.postDelivery.findMany({
      where: { postId, status: 'sent', group: { platform: 'max' } },
      select: { externalMessageId: true },
    });
    return deliveries.flatMap((d) => d.externalMessageId ?? []);
  }

  /** Единственная группа платформы, куда вышел анонс, — иначе `null`. */
  private async soleDeliveryGroup(
    postId: string | undefined,
    platform: Platform,
  ): Promise<{ id: string } | null> {
    if (!postId) {
      return null;
    }
    const deliveries = await this.prisma.postDelivery.findMany({
      where: { postId, status: 'sent', group: { platform } },
      select: { groupId: true },
    });
    return deliveries.length === 1 ? { id: deliveries[0].groupId } : null;
  }

  /** Поздравление доставлено — отмечаем места, как и при обычном розыгрыше. */
  async markWinnersNotified(prizeIds: string[]): Promise<void> {
    if (prizeIds.length === 0) {
      return;
    }
    await this.prisma.contestPrize.updateMany({
      where: { id: { in: prizeIds } },
      data: {
        notifyStatus: 'sent',
        notifyError: null,
        notifyAttemptedAt: new Date(),
      },
    });
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
