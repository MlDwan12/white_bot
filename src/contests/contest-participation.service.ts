import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { Contest, Platform, Post, Prisma } from '../generated/prisma/client';
import { PostSender, type ContestButton } from '../posts/post-sender';
import {
  PlatformUsersService,
  type PlatformUserProfile,
} from '../platform-users/platform-users.service';
import {
  announcementText,
  contestJoinPayload,
  joinButtonText,
  notSubscribedText,
  subscriptionKeyboard,
  winnerCongratulation,
  type ContestKeyboardButton,
} from './contest-button';
import { buildDedupKey } from './contest-participants';
import {
  ContestSubscriptions,
  type MissingChannel,
} from './contest-subscriptions';

export type JoinStatus =
  | 'joined'
  | 'already_joined'
  | 'not_open'
  | 'drawn'
  | 'unknown_contest'
  | 'consent_required'
  | 'not_subscribed'
  | 'subscription_check_failed';

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
  /** Вид после розыгрыша (итоги, «Узнать результаты»). */
  drawn: boolean;
}

export interface JoinOutcome {
  status: JoinStatus;
  /** Личное сообщение участнику — доставляется в лс, если бот может ему писать. */
  message: string;
  /** Пусто, если у конкурса нет анонс-поста: перерисовывать нечего. */
  refresh?: AnnouncementRefresh;
  /**
   * Есть — человеку нужна клавиатура «Подписаться … / Проверить подписку».
   * Непустой при `not_subscribed`; пустой при `subscription_check_failed`:
   * каналов назвать нечем, но кнопка повторной проверки нужна, иначе ответ
   * на её же нажатие стёр бы её вместе с сообщением.
   */
  missingChannels?: MissingChannel[];
}

export interface StartedFromLink {
  /** Что ответить в открытом диалоге. */
  text: string;
  /** Места победителя, которые после успешной отправки помечаются уведомлёнными. */
  prizeIdsToMark: string[];
  /** Участие записано впервые: у постов надо обновить счётчик на кнопке. */
  joined: boolean;
  /** Клавиатура к ответу — ссылки на каналы и «Проверить подписку». */
  buttons?: ContestKeyboardButton[][];
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
    private readonly subscriptions: ContestSubscriptions,
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
        refresh: await this.announcementView(contest),
      };
    }

    // Срок прошёл, а розыгрыш ещё не состоялся (сверка не успела или не
    // хватает подписанных на места и конкурс ждёт админа): опоздавший не
    // должен попасть в конкурс после объявленного окончания.
    if (
      contest.status === 'open' &&
      contest.endsAt &&
      contest.endsAt.getTime() <= Date.now()
    ) {
      return {
        status: 'not_open',
        message: 'Приём участников завершён — скоро будут итоги.',
        refresh: await this.announcementView(contest),
      };
    }

    if (contest.status !== 'open') {
      return {
        status: 'not_open',
        message: 'Приём участников ещё не открыт.',
        refresh: await this.announcementView(contest),
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

    // Условие «подписаться на каналы» — после согласия (без него профиль
    // человека не трогаем) и до записи. Проверяется и у уже участвующего:
    // отписавшийся всё равно выбыл бы при розыгрыше, и лучше сказать ему об
    // этом сейчас, чем промолчать «вы уже участвуете». Только MAX: участие
    // идёт через MAX-бота, и подписку можно проверить лишь там.
    if (request.platform === 'max') {
      let missing: MissingChannel[];
      try {
        missing = await this.subscriptions.missingFor(
          contest.id,
          request.user.externalUserId,
        );
      } catch (err: unknown) {
        this.logger.warn(
          { err, contestId: contest.id },
          'Не удалось проверить подписку участника на каналы-условия',
        );
        return {
          status: 'subscription_check_failed',
          message:
            'Не получилось проверить подписку на каналы. Попробуйте ещё раз через минуту.',
          missingChannels: [],
          refresh: await this.announcementView(contest),
        };
      }
      if (missing.length > 0) {
        return {
          status: 'not_subscribed',
          message: notSubscribedText(missing),
          missingChannels: missing,
          refresh: await this.announcementView(contest),
        };
      }
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
      // Запись — под блокировкой строки конкурса. Розыгрыш закрывает приём
      // первым действием своей транзакции, но при условии подписки держит её
      // открытой, пока ходит в MAX (секунды), и всё это время чужая
      // транзакция ещё видит `open`. Без блокировки успевший нажать попал бы
      // в таблицу участников мимо разыгранного пула. `FOR SHARE`
      // несовместим с любым UPDATE строки конкурса: короткую правку
      // (сохранение формы, открытие приёма) переждём, а розыгрыш, который
      // держит строку секундами, упрётся в `lock_timeout` — отказ, а не
      // ожидание до минуты. После розыгрыша видно уже `drawn`.
      const joined = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(JOIN_LOCK_TIMEOUT_SQL);
        const [row] = await tx.$queryRaw<{ status: string }[]>`
          SELECT status FROM "Contest" WHERE id = ${contest.id} FOR SHARE`;
        if (!row) {
          return 'gone' as const;
        }
        if (row.status !== 'open') {
          return 'closed' as const;
        }
        await tx.contestParticipant.create({
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
        return 'joined' as const;
      });
      if (joined === 'gone') {
        // Конкурс удалили, пока человек нажимал.
        return {
          status: 'unknown_contest',
          message: 'Конкурс не найден — возможно, он был удалён.',
        };
      }
      if (joined === 'closed') {
        return this.closedDuringJoin(contest.id);
      }
      status = 'joined';
      message = 'Вы участвуете в конкурсе!';
    } catch (err: unknown) {
      if (isLockNotAvailable(err)) {
        return this.closedDuringJoin(contest.id);
      }
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
      refresh: await this.announcementView(contest),
    };
  }

  /**
   * Приём закрылся между первой проверкой статуса и записью — идёт или уже
   * прошёл розыгрыш. Пост при этом не трогаем: итоги в него впишет
   * уведомитель, а перерисовка счётчиком затёрла бы их.
   */
  private async closedDuringJoin(contestId: string): Promise<JoinOutcome> {
    // У конкурса с условием подписки человек мог прийти кнопкой «Проверить
    // подписку»: ответ заменяет то сообщение, и без клавиатуры нажимать ещё
    // раз, как просит текст, было бы нечего (тот же приём, что у
    // `subscription_check_failed`). Без условия такой кнопки не было и нет.
    const hasCondition =
      (await this.subscriptions.requiredChannels(contestId)).length > 0;
    return {
      status: 'not_open',
      message:
        // Строку конкурса держит не только розыгрыш, но и удаление или
        // правка конкурса — текст не утверждает, что именно.
        'Приём участников сейчас недоступен — конкурс подводит итоги или меняется. Нажмите ещё раз через минуту.',
      ...(hasCondition ? { missingChannels: [] } : {}),
    };
  }

  /**
   * Как анонс должен выглядеть **сейчас** — единственное место, где это
   * решается. До розыгрыша: исходный текст и «Участвовать (N)»; после:
   * итоги в тексте (если включено) и «Узнать результаты». Его зовут все, кто
   * перерисовывает пост: отправка, правка, ответ на нажатие, счётчик,
   * подмена после розыгрыша. Раньше каждый собирал своё, и правка текста
   * после розыгрыша возвращала кнопку «Участвовать» и стирала победителей.
   */
  async announcementView(
    contest: Contest & { post: Post | null },
  ): Promise<AnnouncementRefresh | undefined> {
    if (!contest.post) {
      return undefined;
    }
    const drawn = contest.status === 'drawn';
    // После розыгрыша счётчик не показывается: кнопка ведёт к итогам.
    const count = drawn
      ? 0
      : await this.prisma.contestParticipant.count({
          where: { contestId: contest.id },
        });
    // Победители дописываются в сам пост, потому что это единственный канал,
    // который видят все подписчики: лс от бота доходит не всем.
    const winners =
      drawn && contest.publishResultsInPost
        ? await this.winnersList(contest.id)
        : null;
    return {
      text: announcementText(
        PostSender.resolveText(contest.post, 'max'),
        winners,
      ),
      buttonText: joinButtonText(
        drawn ? contest.resultsButtonLabel : contest.joinButtonLabel,
        count,
      ),
      payload: contestJoinPayload(contest.id),
      drawn,
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
              select: { platform: true, externalUserId: true, source: true },
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
              // Ручная строка с цифровым ником — не этот человек, даже если
              // цифры совпали с его id.
              prize.winnerParticipant?.source === 'button' &&
              prize.winnerParticipant.platform === 'max' &&
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

    return {
      text: outcome.message,
      prizeIdsToMark: [],
      joined: false,
      buttons: outcome.missingChannels
        ? subscriptionKeyboard(outcome.missingChannels, contestId)
        : undefined,
    };
  }

  /**
   * Кнопка и текст для отправки или правки поста-носителя конкурса — или
   * `null`, если у поста конкурса нет.
   */
  async contestButton(
    post: Post & { contest: Contest | null },
  ): Promise<ContestButton | null> {
    if (!post.contest) {
      return null;
    }
    const view = await this.announcementView({ ...post.contest, post });
    return view
      ? { contestId: post.contest.id, label: view.buttonText, text: view.text }
      : null;
  }

  /**
   * Что перерисовать у анонса **сейчас**: актуальный вид и сообщения во всех
   * MAX-группах. Считается заново при каждом вызове, а не берётся из ответа
   * `join`: правки от разных участников и подмена после розыгрыша идут
   * вперемешку, и устаревший вид перезаписал бы более новый.
   */
  async announcementRefresh(
    contestId: string,
  ): Promise<(AnnouncementRefresh & { messageIds: string[] }) | null> {
    const contest = await this.prisma.contest.findUnique({
      where: { id: contestId },
      include: { post: true },
    });
    const view = contest ? await this.announcementView(contest) : undefined;
    if (!contest?.post || !view) {
      return null;
    }
    return {
      ...view,
      messageIds: await this.sentMaxMessageIds(contest.post.id),
    };
  }

  /** Только статус — на каждое нажатие, поэтому без сборки всего вида. */
  async isDrawn(contestId: string): Promise<boolean> {
    const contest = await this.prisma.contest.findUnique({
      where: { id: contestId },
      select: { status: true },
    });
    return contest?.status === 'drawn';
  }

  /** Сообщения анонса во всех MAX-группах, куда он вышел. */
  private async sentMaxMessageIds(
    postId: string | undefined,
  ): Promise<string[]> {
    if (!postId) {
      return [];
    }
    const deliveries = await this.prisma.postDelivery.findMany({
      // Удалённые из канала не правим: MAX ответит ошибкой на каждую правку.
      where: {
        postId,
        status: 'sent',
        deletedAt: null,
        group: { platform: 'max' },
      },
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

/**
 * Сколько ждать занятую строку конкурса: правки конкурса длятся
 * миллисекунды, розыгрыш с проверкой подписки — секунды. Литерал, а не
 * параметр: `SET` не принимает плейсхолдеры.
 */
const JOIN_LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '2s'";

/**
 * `55P03` — строка занята дольше `lock_timeout` (идёт розыгрыш). С адаптером
 * драйвера Prisma отдаёт его не своим кодом, а как P2010 с исходным кодом
 * Postgres внутри (проверено живьём на dev-базе, 23.09.2026).
 */
function isLockNotAvailable(err: unknown): boolean {
  if (
    !(err instanceof Prisma.PrismaClientKnownRequestError) ||
    err.code !== 'P2010'
  ) {
    return false;
  }
  const cause = (
    err.meta as
      { driverAdapterError?: { cause?: { code?: unknown } } } | undefined
  )?.driverAdapterError?.cause;
  return cause?.code === '55P03';
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}
