import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { PrismaService } from '../prisma/prisma.service';
import {
  Contest,
  ContestStatus,
  Platform,
  Prisma,
} from '../generated/prisma/client';
import { ContestNotifier } from './contest-notifier';
import {
  ContestDrawError,
  drawWinners,
  generateSeed,
  type DrawAssignment,
} from './contest-draw';
import { buildDedupKey, parseParticipantLines } from './contest-participants';

export interface CreateContestInput {
  title: string;
  description?: string;
  /** Анонс-пост с кнопкой участия. Без него остаётся только ручной список. */
  postId?: string;
  joinButtonLabel?: string;
  resultsButtonLabel?: string;
  notifyWinners?: boolean;
  publishResultsInPost?: boolean;
  /** Открыть приём участников автоматически в этот момент. */
  startsAt?: Date;
  /** Провести розыгрыш автоматически в этот момент. */
  endsAt?: Date;
  /**
   * Сколько призовых мест завести сразу же, с местами `1..N` и подписями
   * «Место N» — правятся потом как обычно через `setPrizes`. Без этого
   * поля создание конкурса и раскладка мест были бы двумя раздельными
   * действиями там, где админу нужно одно.
   */
  placesCount?: number;
}

export interface ContestSummary {
  id: string;
  title: string;
  description: string;
  status: ContestStatus;
  createdAt: Date;
  startsAt: Date | null;
  endsAt: Date | null;
  participantsCount: number;
  placesCount: number;
  /** Анонс-пост, если он есть: по нему список показывает, к чему конкурс. */
  postId: string | null;
  postText: string | null;
}

export interface PrizeInput {
  place: number;
  label: string;
}

export interface AddParticipantsResult {
  added: number;
  /** Номера строк, которые оказались дублями уже добавленных участников. */
  duplicateLines: number[];
}

@Injectable()
export class ContestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: ContestNotifier,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ContestsService.name);
  }

  async createContest(
    input: CreateContestInput,
    now: Date = new Date(),
  ): Promise<Contest> {
    if (input.postId) {
      const post = await this.prisma.post.findUnique({
        where: { id: input.postId },
        select: { id: true, contest: { select: { id: true } } },
      });
      if (!post) {
        throw new AppException(ErrorCode.NOT_FOUND, 'Анонс-пост не найден');
      }
      if (post.contest) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'У этого поста уже есть конкурс',
        );
      }
    }
    if (input.startsAt && input.endsAt && input.startsAt >= input.endsAt) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Дата завершения должна быть позже даты начала',
      );
    }
    // Прошедшее время завершения означало бы, что сверка попытается
    // разыграть конкурс на первом же проходе — до того, как админ вообще
    // успел бы что-то с ним сделать. `startsAt` в прошлом отдельно не
    // проверяется: это осмысленный способ открыть приём сразу же, а не
    // ошибка.
    if (input.endsAt && input.endsAt.getTime() <= now.getTime()) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Дата завершения не может быть в прошлом',
      );
    }
    if (input.placesCount !== undefined && input.placesCount < 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Количество мест не может быть отрицательным',
      );
    }
    // Без этого авто-розыгрыш по `endsAt` молча и бесконечно повторял бы
    // попытку каждую минуту — `draw()` отказывает без призовых мест, а
    // никакого способа завести их автоматически после создания нет.
    // `placesCount` — единственный способ задать места прямо при создании,
    // поэтому именно он и требуется здесь, а не факт их наличия в базе.
    if (input.endsAt && !input.placesCount) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Для авто-розыгрыша по дате нужно хотя бы одно призовое место — укажите «Мест»',
      );
    }

    // Id генерируется здесь, а не Postgres'ом, чтобы места можно было
    // создать в одной транзакции с самим конкурсом: раньше это были два
    // отдельных запроса, и сбой второго (например, обрыв соединения между
    // ними) оставлял бы висеть ровно то, что вся эта проверка выше должна
    // была не допустить — конкурс с `endsAt`, но без единого места.
    const contestId = randomUUID();
    const queries: Prisma.PrismaPromise<unknown>[] = [
      this.prisma.contest.create({
        data: {
          id: contestId,
          title: input.title,
          description: input.description ?? '',
          postId: input.postId ?? null,
          joinButtonLabel: input.joinButtonLabel,
          resultsButtonLabel: input.resultsButtonLabel,
          notifyWinners: input.notifyWinners,
          publishResultsInPost: input.publishResultsInPost,
          startsAt: input.startsAt ?? null,
          endsAt: input.endsAt ?? null,
        },
      }),
    ];
    if (input.placesCount) {
      queries.push(
        this.prisma.contestPrize.createMany({
          data: Array.from({ length: input.placesCount }, (_, i) => ({
            contestId,
            place: i + 1,
            label: `Место ${i + 1}`,
          })),
        }),
      );
    }
    const [contest] = (await this.prisma.$transaction(queries)) as [Contest];

    return contest;
  }

  /**
   * Правка уже существующего конкурса — заголовок, описание, подписи кнопок,
   * флаги уведомлений и даты. Работает до розыгрыша включительно (черновик
   * и уже открытый приём), а не только до публикации: `endsAt` живого
   * конкурса — это как раз то время, которое иногда нужно подвинуть, пока
   * приём ещё идёт. После `drawn` — нет, розыгрыш уже состоялся, и что-либо
   * менять в его условиях задним числом означало бы переписывать историю.
   *
   * `description` здесь — тот же панельный текст, что и при создании
   * (публичный текст живёт в самом анонс-посте и правится отдельно, через
   * его карточку): форма специально не синхронизирует их обратно, иначе
   * правка одного поля молча переписывала бы то, что админ мог заранее
   * набрать в другом.
   *
   * `postId` не входит в список правимых полей: привязка анонса — решение
   * времени создания, смена поста задним числом — отдельная, не запрошенная
   * возможность.
   */
  async editContest(
    contestId: string,
    input: {
      title: string;
      description?: string;
      joinButtonLabel?: string;
      resultsButtonLabel?: string;
      notifyWinners?: boolean;
      publishResultsInPost?: boolean;
      startsAt?: Date;
      endsAt?: Date;
    },
    now: Date = new Date(),
  ): Promise<Contest> {
    const contest = await this.requireContest(contestId);
    if (contest.status === 'drawn') {
      throw new AppException(
        ErrorCode.CONTEST_ALREADY_DRAWN,
        'Розыгрыш уже проведён — условия конкурса больше не редактируются',
      );
    }
    if (input.startsAt && input.endsAt && input.startsAt >= input.endsAt) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Дата завершения должна быть позже даты начала',
      );
    }
    // Только если дата реально меняется: форма всегда присылает текущее
    // значение конкурса, даже когда админ правит не его, а что-то другое
    // (например, заголовок). Конкурс, который сверка не смогла разыграть
    // (мало участников — открытый вопрос ждёт человека) сам собой уезжает
    // датой в прошлое — без этой оговорки его вообще нельзя было бы
    // сохранить, пока не подвинута и сама дата.
    const endsAtChanged =
      (input.endsAt?.getTime() ?? null) !== (contest.endsAt?.getTime() ?? null);
    if (
      endsAtChanged &&
      input.endsAt &&
      input.endsAt.getTime() <= now.getTime()
    ) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Дата завершения не может быть в прошлом',
      );
    }
    await this.assertPrizesForAutoDraw(contestId, input.endsAt);

    return this.prisma.contest.update({
      where: { id: contestId },
      data: {
        title: input.title,
        description: input.description ?? '',
        joinButtonLabel: input.joinButtonLabel,
        resultsButtonLabel: input.resultsButtonLabel,
        notifyWinners: input.notifyWinners,
        publishResultsInPost: input.publishResultsInPost,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
      },
    });
  }

  /**
   * «Открыть приём участников» — отдельное действие, а не следствие публикации
   * анонса: `postId` необязателен, и связывать одно с другим значило бы
   * запретить конкурс без поста.
   */
  async openContest(contestId: string): Promise<Contest> {
    const contest = await this.requireContest(contestId);
    if (contest.status === 'drawn') {
      throw new AppException(
        ErrorCode.CONTEST_ALREADY_DRAWN,
        'Розыгрыш уже проведён',
      );
    }
    // Повторная защита той же дыры, что и в `createContest`/`editContest`:
    // места можно снести до нуля через `setPrizes` уже после того, как
    // `endsAt` назначен. Открытие — последний момент, где это ещё можно
    // поймать до того, как приём вообще начнётся.
    await this.assertPrizesForAutoDraw(contestId, contest.endsAt);
    return this.prisma.contest.update({
      where: { id: contestId },
      data: { status: 'open' },
    });
  }

  /**
   * Общая проверка для `editContest`/`openContest`/`setPrizes`: конкурс с
   * назначенным `endsAt` не может остаться без единого призового места —
   * `draw()` откажет, а сверка будет молча и бесконечно повторять попытку
   * раз в минуту. `createContest` проверяет тот же факт иначе (по
   * `input.placesCount`, не по базе): на момент проверки там ещё нет
   * строки конкурса, которую можно было бы посчитать.
   */
  private async assertPrizesForAutoDraw(
    contestId: string,
    endsAt: Date | null | undefined,
  ): Promise<void> {
    if (!endsAt) {
      return;
    }
    const prizeCount = await this.prisma.contestPrize.count({
      where: { contestId },
    });
    if (prizeCount === 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'У конкурса с датой завершения должно быть хотя бы одно призовое место',
      );
    }
  }

  /**
   * Часть общей сверки `PostReconcilerService` — своего таймера и лока у
   * конкурсов нет осознанно (см. комментарий там же: один планировщик,
   * один лок, одно место отказа). Открывает `draft`-конкурсы, чьё время
   * настало; провал одного не должен останавливать остальные.
   */
  async openDueContests(
    now: Date,
  ): Promise<{ opened: Array<{ id: string; postId: string | null }> }> {
    const due = await this.prisma.contest.findMany({
      where: { status: 'draft', startsAt: { lte: now } },
      select: { id: true, postId: true },
    });
    const opened: Array<{ id: string; postId: string | null }> = [];
    for (const contest of due) {
      try {
        await this.openContest(contest.id);
        opened.push({ id: contest.id, postId: contest.postId });
      } catch (err: unknown) {
        this.logger.error(
          { err, contestId: contest.id },
          'Не удалось автоматически открыть приём участников',
        );
      }
    }
    return { opened };
  }

  /**
   * Открытые конкурсы, чей анонс-пост всё ещё черновик — не только только
   * что открытые в этом же проходе, а любые: если отправка при открытии
   * упала (сетевой сбой VK/MAX), `openDueContests` эту связку больше
   * никогда не увидит — она спрашивает только `status: 'draft'` у самого
   * конкурса, а он уже `open`. Без отдельного прохода пост так и остался
   * бы черновиком навсегда, без единой попытки повторить и без следа для
   * админа, кроме одной строки в логе на момент отказа.
   */
  async openContestsWithUnsentAnnouncement(): Promise<
    Array<{ id: string; postId: string }>
  > {
    const stuck = await this.prisma.contest.findMany({
      where: { status: 'open', post: { status: 'draft' } },
      select: { id: true, postId: true },
    });
    return stuck
      .filter(
        (contest): contest is { id: string; postId: string } =>
          contest.postId != null,
      )
      .map((contest) => ({ id: contest.id, postId: contest.postId }));
  }

  /**
   * Тот же приём, что у `openDueContests`. Конкурс без участников на
   * момент `endsAt` не считается сбоем сверки — `draw` откажет ожидаемой
   * `CONTEST_INSUFFICIENT_PARTICIPANTS`, конкурс остаётся `open`, и
   * следующий проход пробует снова: добавят участника вручную — разыграется
   * сам, а нет — так и останется ждать, не застряв ни в каком неверном
   * статусе.
   */
  async drawDueContests(now: Date): Promise<{ drawn: number }> {
    const due = await this.prisma.contest.findMany({
      where: { status: 'open', endsAt: { lte: now } },
      select: { id: true },
    });
    let drawn = 0;
    for (const contest of due) {
      try {
        await this.draw(contest.id);
        drawn++;
      } catch (err: unknown) {
        this.logger.warn(
          { err, contestId: contest.id },
          'Не удалось автоматически провести розыгрыш',
        );
      }
    }
    return { drawn };
  }

  async setPrizes(contestId: string, prizes: PrizeInput[]): Promise<void> {
    const contest = await this.requireContest(contestId);
    if (contest.status === 'drawn') {
      throw new AppException(
        ErrorCode.CONTEST_ALREADY_DRAWN,
        'Призовые места нельзя менять после розыгрыша',
      );
    }

    const places = prizes.map((p) => p.place);
    if (new Set(places).size !== places.length) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Призовые места повторяются',
      );
    }
    // Последнее звено той же цепочки, что и в `createContest`/`editContest`/
    // `openContest`: панель не даёт отправить пустой список, но сервис сам
    // по себе это не проверял — вызов API в обход панели мог обнулить места
    // у уже открытого конкурса с `endsAt`, и сверка молча повторяла бы
    // розыгрыш каждую минуту без единого места для победителя.
    if (prizes.length === 0 && contest.endsAt) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'У конкурса с датой завершения должно быть хотя бы одно призовое место',
      );
    }

    await this.prisma.$transaction([
      this.prisma.contestPrize.deleteMany({ where: { contestId } }),
      this.prisma.contestPrize.createMany({
        data: prizes.map((prize) => ({
          contestId,
          place: prize.place,
          label: prize.label,
        })),
      }),
    ]);
  }

  /**
   * Запасной путь ввода: админ вставляет список строками. Дубли не роняют всю
   * пачку — они возвращаются отдельным списком, чтобы было видно, что именно
   * не добавилось.
   */
  async addParticipantsFromText(
    contestId: string,
    text: string,
    fallbackPlatform: Platform = 'max',
  ): Promise<AddParticipantsResult> {
    const contest = await this.requireContest(contestId);
    if (contest.status === 'drawn') {
      throw new AppException(
        ErrorCode.CONTEST_ALREADY_DRAWN,
        'Новых участников после розыгрыша добавлять поздно',
      );
    }

    const parsed = parseParticipantLines(text, fallbackPlatform);
    const duplicateLines: number[] = [];
    let added = 0;

    for (const entry of parsed) {
      try {
        await this.prisma.contestParticipant.create({
          data: {
            contestId,
            displayName: entry.displayName,
            platform: entry.platform,
            externalUserId: entry.externalUserId,
            source: 'manual',
            dedupKey: buildDedupKey(entry),
          },
        });
        added += 1;
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          duplicateLines.push(entry.lineNumber);
          continue;
        }
        throw err;
      }
    }

    return { added, duplicateLines };
  }

  /** «Подкрутка»: место закрепляется за конкретным участником до розыгрыша. */
  async forceWinner(prizeId: string, participantId: string): Promise<void> {
    const prize = await this.requirePrizeWithParticipant(
      prizeId,
      participantId,
    );
    const contest = await this.requireContest(prize.contestId);
    if (contest.status === 'drawn') {
      // После розыгрыша менять победителя можно только через
      // `overrideWinner` — он пишет в журнал старое и новое значение.
      // Иначе «подкрутка» стала бы способом тихо переписать итог.
      throw new AppException(
        ErrorCode.CONTEST_ALREADY_DRAWN,
        'Розыгрыш уже проведён — замена победителя только через правку места',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // На победителе висит unique: если участник уже закреплён за другим
      // местом, прямое обновление упёрлось бы в constraint и вернуло 500.
      await tx.contestPrize.updateMany({
        where: {
          contestId: prize.contestId,
          winnerParticipantId: participantId,
        },
        data: { winnerParticipantId: null, isForced: false },
      });
      await tx.contestPrize.update({
        where: { id: prizeId },
        data: { winnerParticipantId: participantId, isForced: true },
      });
    });
  }

  /**
   * Один розыгрыш на все места разом. Сид пишется в журнал, поэтому результат
   * можно пересчитать и доказать, что он не подкручен.
   */
  async draw(contestId: string, actorId?: string): Promise<DrawAssignment[]> {
    const contest = await this.requireContest(contestId);
    if (contest.status === 'drawn') {
      throw new AppException(
        ErrorCode.CONTEST_ALREADY_DRAWN,
        'Розыгрыш уже проведён — доступны только точечные правки мест',
      );
    }

    const seed = generateSeed();

    const assignments = await this.prisma.$transaction(async (tx) => {
      // Приём закрывается первым же действием транзакции. Читать пул раньше
      // значило бы оставить окно, в котором успевший нажать кнопку попадает
      // в таблицу участников, но не в разыгранный пул — и журнал розыгрыша
      // перестал бы сходиться с тем, что видно в базе.
      const closed = await tx.contest.updateMany({
        where: { id: contestId, status: { not: 'drawn' } },
        data: { status: 'drawn' },
      });
      if (closed.count === 0) {
        // Кто-то успел провести розыгрыш параллельно.
        throw new AppException(
          ErrorCode.CONTEST_ALREADY_DRAWN,
          'Розыгрыш уже проведён — доступны только точечные правки мест',
        );
      }

      const [participants, prizes] = await Promise.all([
        tx.contestParticipant.findMany({
          where: { contestId },
          select: { id: true },
        }),
        tx.contestPrize.findMany({
          where: { contestId },
          select: {
            id: true,
            place: true,
            winnerParticipantId: true,
            isForced: true,
          },
        }),
      ]);

      let drawn: DrawAssignment[];
      try {
        drawn = drawWinners({
          participantIds: participants.map((p) => p.id),
          prizes: prizes.map((prize) => ({
            id: prize.id,
            place: prize.place,
            forcedWinnerParticipantId: prize.isForced
              ? prize.winnerParticipantId
              : null,
          })),
          seed,
        });
      } catch (err: unknown) {
        // Бросок откатывает и закрытие приёма: конкурс остаётся открытым,
        // а не застревает в `drawn` без победителей.
        throw toAppException(err);
      }

      // Победители снимаются со всех мест до расстановки новых: на
      // `winnerParticipantId` висит unique, и обновление «по одному» упёрлось
      // бы в него на любой перестановке.
      await tx.contestPrize.updateMany({
        where: { contestId },
        data: { winnerParticipantId: null },
      });

      for (const assignment of drawn) {
        await tx.contestPrize.update({
          where: { id: assignment.prizeId },
          data: {
            winnerParticipantId: assignment.participantId,
            isForced: assignment.isForced,
          },
        });
      }

      await tx.contestDrawLog.create({
        data: {
          contestId,
          kind: 'draw',
          seed,
          actorId: actorId ?? null,
          resultSnapshot: {
            // Пул целиком — без него сид бесполезен: пересчёт требует ровно
            // того же входа, что был на момент розыгрыша.
            participantIds: participants.map((p) => p.id).sort(),
            assignments: drawn.map((a) => ({
              prizeId: a.prizeId,
              place: a.place,
              participantId: a.participantId,
              isForced: a.isForced,
            })),
          },
        },
      });

      return drawn;
    });

    // Розыгрыш уже зафиксирован. Провал уведомлений (в том числе сбой базы
    // внутри них) не должен превращаться в 500: админ повторил бы запрос и
    // получил «уже проведён», а кнопки так и остались бы неподменёнными.
    await this.safeAnnounce(contestId, 'draw');

    return assignments;
  }

  /**
   * Ручная замена победителя уже после розыгрыша. Пишется отдельной записью
   * журнала со старым и новым значением, а не молчаливой перезаписью.
   */
  async overrideWinner(
    prizeId: string,
    participantId: string,
    note?: string,
    actorId?: string,
  ): Promise<void> {
    const prize = await this.requirePrizeWithParticipant(
      prizeId,
      participantId,
    );

    await this.prisma.$transaction(async (tx) => {
      // Участник может уже занимать другое место: unique на победителе не
      // даст ему занять два, поэтому старое место сначала освобождается.
      await tx.contestPrize.updateMany({
        where: {
          contestId: prize.contestId,
          winnerParticipantId: participantId,
        },
        // Освобождаемое место обнуляется целиком: иначе оно осталось бы без
        // победителя, но со статусом «уведомлён» и отметкой времени от
        // человека, который там больше не стоит.
        data: {
          winnerParticipantId: null,
          isForced: false,
          notifyStatus: 'pending',
          notifyError: null,
          notifyAttemptedAt: null,
        },
      });

      await tx.contestPrize.update({
        where: { id: prizeId },
        data: {
          winnerParticipantId: participantId,
          isForced: true,
          // Победитель сменился — прежний статус уведомления к нему больше
          // не относится.
          notifyStatus: 'pending',
          notifyError: null,
          notifyAttemptedAt: null,
        },
      });

      await tx.contestDrawLog.create({
        data: {
          contestId: prize.contestId,
          kind: 'override',
          actorId: actorId ?? null,
          note: note ?? null,
          resultSnapshot: {
            prizeId,
            place: prize.place,
            previousParticipantId: prize.winnerParticipantId,
            participantId,
          },
        },
      });
    });

    // Итог изменился: пост всё ещё показывает прежнего победителя, а новый
    // ещё не уведомлён. Без переобъявления правка места была бы видна только
    // в базе.
    await this.safeAnnounce(prize.contestId, 'override');
  }

  /**
   * Объявление итогов, которое не может уронить вызвавшую операцию. Сама
   * операция (розыгрыш, правка места) уже зафиксирована в базе, а рассылка —
   * следствие; превращать её сбой в ошибку запроса нельзя.
   */
  private async safeAnnounce(
    contestId: string,
    reason: 'draw' | 'override',
  ): Promise<void> {
    try {
      await this.notifier.announceResults(contestId, reason);
    } catch (err: unknown) {
      this.logger.error(
        { err, contestId, reason },
        'Итоги конкурса зафиксированы, но объявить их не удалось',
      );
    }
  }

  async getContest(contestId: string) {
    const contest = await this.prisma.contest.findUnique({
      where: { id: contestId },
      include: {
        prizes: {
          orderBy: { place: 'asc' },
          include: { winnerParticipant: true },
        },
        participants: {
          orderBy: { joinedAt: 'asc' },
          include: {
            group: { select: { id: true, title: true } },
            platformUser: true,
          },
        },
        drawLogs: { orderBy: { drawnAt: 'desc' } },
      },
    });
    if (!contest) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Конкурс не найден');
    }
    return contest;
  }

  /**
   * Сводка для списка конкурсов в панели. Считать участников и места здесь,
   * а не отдельными запросами на строку: десяток конкурсов иначе даёт
   * два десятка обращений к базе ради двух чисел.
   */
  async listContests(limit = 50): Promise<ContestSummary[]> {
    const contests = await this.prisma.contest.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        _count: { select: { participants: true, prizes: true } },
        post: { select: { id: true, text: true } },
      },
    });

    return contests.map((contest) => ({
      id: contest.id,
      title: contest.title,
      description: contest.description,
      status: contest.status,
      createdAt: contest.createdAt,
      startsAt: contest.startsAt,
      endsAt: contest.endsAt,
      participantsCount: contest._count.participants,
      placesCount: contest._count.prizes,
      postId: contest.post?.id ?? null,
      postText: contest.post?.text ?? null,
    }));
  }

  /** Приз существует и участник относится к тому же конкурсу. */
  private async requirePrizeWithParticipant(
    prizeId: string,
    participantId: string,
  ): Promise<{
    id: string;
    contestId: string;
    place: number;
    winnerParticipantId: string | null;
  }> {
    const prize = await this.prisma.contestPrize.findUnique({
      where: { id: prizeId },
      select: {
        id: true,
        contestId: true,
        place: true,
        winnerParticipantId: true,
      },
    });
    if (!prize) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Призовое место не найдено');
    }

    const participant = await this.prisma.contestParticipant.findUnique({
      where: { id: participantId },
      select: { contestId: true },
    });
    if (!participant || participant.contestId !== prize.contestId) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Участник не относится к этому конкурсу',
      );
    }
    return prize;
  }

  private async requireContest(contestId: string): Promise<Contest> {
    const contest = await this.prisma.contest.findUnique({
      where: { id: contestId },
    });
    if (!contest) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Конкурс не найден');
    }
    return contest;
  }
}

function toAppException(err: unknown): unknown {
  if (!(err instanceof ContestDrawError)) {
    return err;
  }
  const code =
    err.code === 'NOT_ENOUGH_PARTICIPANTS'
      ? ErrorCode.CONTEST_INSUFFICIENT_PARTICIPANTS
      : ErrorCode.VALIDATION_ERROR;
  return new AppException(code, err.message);
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}
