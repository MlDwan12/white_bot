import { Injectable } from '@nestjs/common';
import {
  isForeignKeyViolation,
  isLockNotAvailable,
  isUniqueViolation,
} from '../common/prisma-errors';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import {
  Contest,
  ContestFunnelStage,
  ContestStatus,
  Platform,
  Post,
} from '../generated/prisma/client';
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
import { assertNotFinished, isFinished } from './contest-status';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { AuditService } from '../audit/audit.service';
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
  /** `null` — кнопки нет вовсе (конкурс отменён): клавиатура снимается. */
  buttonText: string | null;
  payload: string;
  /** Итог подведён — разыгран (итоги, «Узнать результаты») или отменён. */
  finished: boolean;
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
  /**
   * Вид анонса для перерисовки не нужен — старт бота по ссылке отвечает
   * текстом в лс и перерисовывает пост сам. Без флага каждый старт собирал
   * вид (с подсчётом участников) впустую.
   */
  withoutRefresh?: boolean;
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
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ContestParticipationService.name);
  }

  /**
   * Продление по кнопке из предупреждения «участников нет». Здесь, а не в
   * `ContestsService`: кнопку обрабатывает MAX-бот, а сервис конкурсов сам
   * зависит от модуля MAX. Новый срок — от прежнего, а если тот уже прошёл
   * (кнопку нажали поздно, но конкурс ещё не отменён), — от сейчас.
   * Отметка предупреждения сбрасывается: продлённый и снова пустой
   * конкурс предупредит ещё раз.
   */
  async extendContest(
    contestId: string,
    days: 1 | 3,
    adminId: string,
  ): Promise<{ title: string; endsAt: Date }> {
    const updated = await this.prisma.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<
          { status: ContestStatus; endsAt: Date | null }[]
        >`SELECT status, "endsAt" FROM "Contest" WHERE id = ${contestId} FOR NO KEY UPDATE`;
        if (!row) {
          throw new AppException(ErrorCode.NOT_FOUND, 'Конкурс не найден');
        }
        assertNotFinished(row.status, 'Розыгрыш уже проведён');
        if (row.status !== 'open') {
          throw new AppException(
            ErrorCode.VALIDATION_ERROR,
            'Конкурс ещё не открыт — продлевать нечего',
          );
        }
        const now = Date.now();
        const from = Math.max(row.endsAt?.getTime() ?? now, now);
        return tx.contest.update({
          where: { id: contestId },
          data: {
            endsAt: new Date(from + days * 24 * 60 * 60 * 1000),
            endWarningSentAt: null,
          },
          select: { title: true, endsAt: true },
        });
      },
      // Блокировку может держать идущий розыгрыш — до минуты; ожидание идёт
      // в счёт `timeout`, стандартных 5 с мало.
      { timeout: EXTEND_TX_TIMEOUT_MS },
    );
    await this.audit.record({
      actor: { adminId },
      action: 'contest.extend',
      entityType: 'contest',
      entityId: contestId,
      summary: `Продлил конкурс «${updated.title}» на ${days === 1 ? 'сутки' : '3 дня'}`,
      details: { endsAt: updated.endsAt!.toISOString() },
    });
    return { title: updated.title, endsAt: updated.endsAt! };
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
    const view = () =>
      request.withoutRefresh
        ? Promise.resolve(undefined)
        : this.announcementView(contest);

    if (contest.status === 'drawn') {
      return {
        status: 'drawn',
        message: await this.resultsMessage(contest.id),
        refresh: await view(),
      };
    }

    if (contest.status === 'cancelled') {
      return {
        status: 'not_open',
        message: CANCELLED_MESSAGE,
        refresh: await view(),
      };
    }

    // Срок прошёл, а розыгрыш ещё не состоялся (сверка не успела или не
    // хватает подписанных на места и конкурс ждёт админа): опоздавший не
    // должен попасть в конкурс после объявленного окончания.
    if (contest.status === 'open' && !isAcceptingEntries(contest)) {
      return {
        status: 'not_open',
        message: 'Приём участников завершён — скоро будут итоги.',
        refresh: await view(),
      };
    }

    if (contest.status !== 'open') {
      return {
        status: 'not_open',
        message: 'Приём участников ещё не открыт.',
        refresh: await view(),
      };
    }

    // Воронка — только у открытого конкурса: нажавший «Узнать результаты»
    // после розыгрыша участвовать не начинал. События с id человека — только
    // после согласия (152-ФЗ); до него — анонимный счётчик у экрана согласия
    // (`noteAnonymousStart`).
    const funnel = (stage: ContestFunnelStage) =>
      this.recordFunnel(
        contest.id,
        request.platform,
        request.user.externalUserId,
        stage,
      );

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
    // Этап воронки «согласие есть» — и у давшего его только что, и у
    // согласившегося раньше: оба прошли экран согласия.
    funnel('consented');

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
          refresh: await view(),
        };
      }
      if (missing.length > 0) {
        funnel('not_subscribed');
        return {
          status: 'not_subscribed',
          message: notSubscribedText(missing),
          missingChannels: missing,
          refresh: await view(),
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

    funnel(status === 'joined' ? 'joined' : 'already_joined');
    return {
      status,
      message,
      refresh: await view(),
    };
  }

  /**
   * Событие воронки участия — для статистики разработчика (уникальные люди
   * на каждом этапе). Best-effort и не ждётся: сбой не мешает участию.
   * Только для давших согласие: до него id человека не храним.
   */
  private recordFunnel(
    contestId: string,
    platform: Platform,
    externalUserId: string,
    stage: ContestFunnelStage,
  ): void {
    // Уже записанное этим процессом в базу не шлём: при потоке повторных
    // нажатий каждое давало бы две пустые вставки на горячем пути.
    const key = `${contestId}:${platform}:${externalUserId}:${stage}`;
    if (this.recordedFunnel.has(key)) {
      return;
    }
    // ponytail: сброс целиком при переполнении — после него повторы снова
    // дойдут до unique в базе, это лишь лишние вставки, а не дубли.
    if (this.recordedFunnel.size >= FUNNEL_MEMO_LIMIT) {
      this.recordedFunnel.clear();
    }
    this.recordedFunnel.add(key);
    // Не ждём: это статистика, а ответ на нажатие и так ждёт MAX. Ошибки
    // ловятся здесь же — необработанного промиса не остаётся.
    // Один раз на человека и этап: повторное нажатие упирается в unique и
    // молча пропускается — таблица не растёт от кликов.
    void this.prisma.contestFunnelEvent
      .createMany({
        data: [{ contestId, platform, externalUserId, stage }],
        skipDuplicates: true,
      })
      .catch((err: unknown) => {
        // Не записалось — пусть следующее нажатие попробует снова.
        this.recordedFunnel.delete(key);
        // Конкурса уже нет (кнопка под постом переживает удаление) — штатно.
        if (isForeignKeyViolation(err)) {
          return;
        }
        this.logger.warn(
          { err, contestId, stage },
          'Не удалось записать событие воронки конкурса',
        );
      });
  }

  /** События воронки, уже записанные этим процессом, — см. `recordFunnel`. */
  private readonly recordedFunnel = new Set<string>();

  /**
   * Старт бота по ссылке конкурса **до согласия** — только +1 к счётчику
   * конкурса, без id человека (152-ФЗ: до согласия о нём ничего не храним).
   * Иначе отказавшиеся от согласия выпали бы из статистики. Считается только
   * здесь, у экрана согласия: нажатие кнопки без согласия ведёт сюда же по
   * ссылке, и счёт и там дал бы двойной учёт. Только у открытого конкурса
   * (см. комментарий в `join`). Не ждётся, как и воронка.
   */
  noteAnonymousStart(contestId: string): void {
    // Одним запросом: вставка только у конкурса, который принимает
    // участников, — то же правило, что `isAcceptingEntries` (держать в
    // согласии). Удалённый или закрытый конкурс — просто 0 строк, без гонки
    // между проверкой и записью.
    void this.prisma.$executeRaw`
      INSERT INTO "ContestAnonymousStarts" ("contestId", count)
      SELECT id, 1 FROM "Contest"
      WHERE id = ${contestId} AND status = 'open'
        AND ("endsAt" IS NULL OR "endsAt" > now())
      ON CONFLICT ("contestId")
      DO UPDATE SET count = "ContestAnonymousStarts".count + 1`.catch(
      (err: unknown) => {
        // Конкурс удалили прямо между выборкой и вставкой — штатно.
        if (isForeignKeyViolation(err)) {
          return;
        }
        this.logger.warn(
          { err, contestId },
          'Не удалось записать начало участия',
        );
      },
    );
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
    const cancelled = contest.status === 'cancelled';
    // После розыгрыша счётчик не показывается: кнопка ведёт к итогам.
    const count =
      drawn || cancelled
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
    const postText = PostSender.resolveText(contest.post, 'max');
    if (cancelled) {
      // Кнопку снимаем: участвовать нельзя, итогов нет.
      return {
        text: `${postText}\n\n${CANCELLED_MESSAGE}`,
        buttonText: null,
        payload: contestJoinPayload(contest.id),
        finished: true,
      };
    }
    return {
      text: announcementText(postText, winners),
      buttonText: joinButtonText(
        drawn ? contest.resultsButtonLabel : contest.joinButtonLabel,
        count,
      ),
      payload: contestJoinPayload(contest.id),
      finished: drawn,
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

    if (contest.status === 'cancelled') {
      return { text: CANCELLED_MESSAGE, prizeIdsToMark: [], joined: false };
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
      withoutRefresh: true,
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

  /**
   * Подведён ли итог (разыгран или отменён). Только статус — на каждое
   * нажатие, поэтому без сборки всего вида.
   */
  async isFinished(contestId: string): Promise<boolean> {
    const contest = await this.prisma.contest.findUnique({
      where: { id: contestId },
      select: { status: true },
    });
    return contest ? isFinished(contest.status) : false;
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

/** Одна формулировка отмены — для поста, ответа на кнопку и лс. */
const CANCELLED_MESSAGE =
  'Конкурс отменён — к сроку не набралось ни одного участника.';

/**
 * Сколько ждать занятую строку конкурса: правки конкурса длятся
 * миллисекунды, розыгрыш с проверкой подписки — секунды. Литерал, а не
 * параметр: `SET` не принимает плейсхолдеры.
 */
const JOIN_LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '2s'";

/** Сколько событий воронки помнить — см. `recordFunnel`. */
const FUNNEL_MEMO_LIMIT = 10_000;

/** Ждать строку конкурса при продлении — розыгрыш держит её до минуты. */
const EXTEND_TX_TIMEOUT_MS = 90_000;

/**
 * Принимает ли конкурс участников прямо сейчас: открыт и срок не прошёл
 * (после `endsAt` приём закрыт, даже если розыгрыш ещё не состоялся). Одно
 * место правила для `join`; его SQL-копия — в `noteAnonymousStart`.
 */
function isAcceptingEntries(contest: {
  status: string;
  endsAt: Date | null;
}): boolean {
  return (
    contest.status === 'open' &&
    !(contest.endsAt && contest.endsAt.getTime() <= Date.now())
  );
}
