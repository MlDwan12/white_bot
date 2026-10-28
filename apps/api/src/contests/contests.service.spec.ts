import { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { PrismaService } from '../prisma/prisma.service';
import { ContestNotifier } from './contest-notifier';
import { ContestsService } from './contests.service';
import { ContestSubscriptions } from './contest-subscriptions';
import { drawWinners } from './contest-draw';

const CONTEST_ID = '11111111-1111-4111-8111-111111111111';

// `createContest` generates the id itself (so it can seed places in the same
// transaction) — fixed here so tests can still assert on it. `contest-draw.ts`
// also pulls from `node:crypto` (`createHmac`/`randomBytes`), hence
// `requireActual` rather than replacing the whole module.
jest.mock('node:crypto', () => ({
  ...jest.requireActual<typeof import('node:crypto')>('node:crypto'),
  randomUUID: () => CONTEST_ID,
}));

/** Reads one argument of a recorded call as `T` — the mock itself is untyped. */
function callArg<T>(mockFn: jest.Mock, callIndex = 0, argIndex = 0): T {
  return (mockFn.mock.calls as unknown[][])[callIndex][argIndex] as T;
}

function setup(
  contest: Record<string, unknown> | null = { id: CONTEST_ID, status: 'open' },
) {
  const participants = { current: [{ id: 'p1' }, { id: 'p2' }] };

  // Розыгрыш целиком живёт в транзакции: приём закрывается, пул читается и
  // места расставляются одним куском, иначе успевший нажать кнопку попал бы
  // в базу мимо журнала.
  const tx = {
    contest: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue(contest && { ...contest, requiredGroups: [] }),
    },
    // Блокировка строки конкурса в правке.
    $queryRaw: jest
      .fn()
      .mockResolvedValue([{ id: CONTEST_ID, status: 'open' }]),
    contestRequiredGroup: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    contestParticipant: {
      findMany: jest.fn(() => Promise.resolve(participants.current)),
      // Ручное добавление — одной вставкой в транзакции.
      createManyAndReturn: jest.fn().mockResolvedValue([]),
    },
    contestPrize: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'prize-1',
          place: 1,
          winnerParticipantId: null,
          isForced: false,
        },
      ]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue({}),
      // `setPrizes` — замена мест в транзакции.
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    contestDrawLog: { create: jest.fn().mockResolvedValue({}) },
  };

  const prisma = {
    contest: {
      findUnique: jest.fn().mockResolvedValue(contest),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(contest),
      // Открытие — условный переход draft → open.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({ id: CONTEST_ID, status: 'draft' }),
    },
    contestParticipant: {
      findMany: jest.fn().mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]),
      findUnique: jest.fn().mockResolvedValue({ contestId: CONTEST_ID }),
      create: jest.fn().mockResolvedValue({}),
    },
    contestPrize: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'prize-1',
          place: 1,
          winnerParticipantId: null,
          isForced: false,
        },
      ]),
      findUnique: jest.fn().mockResolvedValue({
        id: 'prize-1',
        contestId: CONTEST_ID,
        place: 1,
        winnerParticipantId: 'p1',
      }),
      update: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(1),
    },
    // Пост публикации по умолчанию годный: черновик с одним MAX-каналом.
    post: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'post-1',
        contest: null,
        deliveries: [{ groupId: 'g1' }],
      }),
    },
    group: { count: jest.fn().mockResolvedValue(1) },
    contestRequiredGroup: { findMany: jest.fn().mockResolvedValue([]) },
    // Prisma's real `$transaction` has two overloads: a callback, used by
    // `draw`, and an array of already-built queries, used by `setPrizes`.
    // Both need to work here, or a test that goes through `setPrizes`
    // (e.g. `createContest` with `placesCount`) would call an array as if
    // it were a function.
    $transaction: jest.fn(
      async (
        arg: ((client: typeof tx) => Promise<unknown>) | Promise<unknown>[],
      ) => (typeof arg === 'function' ? arg(tx) : Promise.all(arg)),
    ),
  };

  const notifier = {
    announceResults: jest.fn().mockResolvedValue(undefined),
    announceCancelled: jest.fn().mockResolvedValue(undefined),
    warnEmptyEnding: jest.fn().mockResolvedValue(undefined),
  };
  // По умолчанию у конкурса нет условия подписки — розыгрыш как раньше.
  const subscriptions = {
    requiredChannels: jest.fn().mockResolvedValue([]),
    unsubscribedAmong: jest.fn().mockResolvedValue(new Set()),
  };
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const audit = { record: jest.fn(), purgeExpired: jest.fn() };
  const service = new ContestsService(
    prisma as unknown as PrismaService,
    notifier as unknown as ContestNotifier,
    subscriptions as unknown as ContestSubscriptions,
    audit as never,
    logger as unknown as PinoLogger,
  );
  return {
    service,
    prisma,
    tx,
    notifier,
    subscriptions,
    participants,
    logger,
    audit,
  };
}

describe('ContestsService.draw — условие подписки', () => {
  const CHANNEL = { groupId: 'g-1', externalId: '-100', title: 'Канал' };
  const pool = [
    { id: 'p1', platform: 'max', externalUserId: '1', source: 'button' },
    { id: 'p2', platform: 'max', externalUserId: '2', source: 'button' },
    { id: 'p3', platform: 'max', externalUserId: '3', source: 'button' },
  ];

  type Snapshot = {
    participantIds: string[];
    disqualifiedParticipantIds: string[];
    assignments: { participantId: string }[];
  };

  function drawSetup() {
    const ctx = setup();
    ctx.participants.current = pool;
    ctx.subscriptions.requiredChannels.mockResolvedValue([CHANNEL]);
    return ctx;
  }

  it('drops an unsubscribed winner and redraws with the same seed, logging who dropped out', async () => {
    const { service, tx, subscriptions } = drawSetup();
    // Первый выпавший отписался, все остальные подписаны.
    let first = true;
    subscriptions.unsubscribedAmong.mockImplementation(
      (_channels: unknown, ids: string[]) => {
        const out = new Set(first ? ids : []);
        first = false;
        return Promise.resolve(out);
      },
    );

    const [winner] = await service.draw(CONTEST_ID);

    const logged = callArg<{
      data: { seed: string; resultSnapshot: Snapshot };
    }>(tx.contestDrawLog.create).data;
    const dropped = logged.resultSnapshot.disqualifiedParticipantIds;
    expect(dropped).toHaveLength(1);
    expect(winner.participantId).not.toBe(dropped[0]);
    // Пул в журнале полный, а пересчёт — тот же сид на пуле без выбывших.
    expect(logged.resultSnapshot.participantIds).toEqual(['p1', 'p2', 'p3']);
    const replay = drawWinners({
      participantIds: ['p1', 'p2', 'p3'].filter((id) => !dropped.includes(id)),
      prizes: [{ id: 'prize-1', place: 1 }],
      seed: logged.seed,
    });
    expect(replay[0].participantId).toBe(winner.participantId);
  });

  it('checks only the drawn winners, not the whole pool', async () => {
    const { service, subscriptions } = drawSetup();

    await service.draw(CONTEST_ID);

    expect(subscriptions.unsubscribedAmong).toHaveBeenCalledTimes(1);
    expect(
      callArg<string[]>(subscriptions.unsubscribedAmong, 0, 1),
    ).toHaveLength(1);
  });

  it('fails like a short pool when everyone has unsubscribed, saying why', async () => {
    const { service, subscriptions } = drawSetup();
    subscriptions.unsubscribedAmong.mockImplementation(
      (_channels: unknown, ids: string[]) => Promise.resolve(new Set(ids)),
    );

    const failure = service.draw(CONTEST_ID);
    await expect(failure).rejects.toMatchObject({
      code: ErrorCode.CONTEST_INSUFFICIENT_PARTICIPANTS,
    });
    await expect(failure).rejects.toThrow(/выбыли из-за отписки/);
  });

  it('does not draw at all when MAX cannot answer — the condition must not silently lapse', async () => {
    const { service, tx, subscriptions } = drawSetup();
    subscriptions.unsubscribedAmong.mockRejectedValue(
      new Error('MAX недоступен'),
    );

    await expect(service.draw(CONTEST_ID)).rejects.toThrow('MAX недоступен');
    expect(tx.contestDrawLog.create).not.toHaveBeenCalled();
  });

  it('не спрашивает MAX про ручного участника с ником вместо числового id', async () => {
    const { service, participants, subscriptions } = drawSetup();
    participants.current = [
      { id: 'h1', platform: 'max', externalUserId: 'ivan_petrov' },
    ] as never;

    await service.draw(CONTEST_ID);

    expect(subscriptions.unsubscribedAmong).not.toHaveBeenCalled();
  });

  it('не принимает цифровой ник ручной строки за MAX id', async () => {
    // `Иван @100500` — это ник «100500», а не id: проверка спросила бы MAX
    // о постороннем, и выбранный админом участник выбыл бы.
    const { service, participants, subscriptions } = drawSetup();
    participants.current = [
      { id: 'h1', platform: 'max', externalUserId: '100500', source: 'manual' },
    ] as never;

    await service.draw(CONTEST_ID);

    expect(subscriptions.unsubscribedAmong).not.toHaveBeenCalled();
  });

  it('leaves manually added participants without a MAX id unchecked', async () => {
    const { service, participants, subscriptions } = drawSetup();
    participants.current = [
      { id: 'm1', platform: 'max', externalUserId: null },
    ] as never;

    await service.draw(CONTEST_ID);

    expect(subscriptions.unsubscribedAmong).not.toHaveBeenCalled();
  });
});

describe('ContestsService.draw', () => {
  it('records the seed and the whole pool, not just the winners', async () => {
    const { service, tx } = setup();

    await service.draw(CONTEST_ID);

    const logged = callArg<{
      data: {
        seed: string;
        kind: string;
        resultSnapshot: { participantIds: string[] };
      };
    }>(tx.contestDrawLog.create).data;
    // Without the pool the seed proves nothing: recomputing a draw needs
    // exactly the input it ran on.
    expect(logged.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(logged.kind).toBe('draw');
    expect(logged.resultSnapshot.participantIds).toEqual(['p1', 'p2']);
  });

  it('clears every winner before assigning, so a swap cannot hit the unique index', async () => {
    const { service, tx } = setup();

    await service.draw(CONTEST_ID);

    const clearOrder = tx.contestPrize.updateMany.mock.invocationCallOrder[0];
    const assignOrder = tx.contestPrize.update.mock.invocationCallOrder[0];
    expect(clearOrder).toBeLessThan(assignOrder);
  });

  it('notifies only after the transaction is committed', async () => {
    const { service, prisma, notifier } = setup();

    await service.draw(CONTEST_ID);

    // The draw has happened and is recorded; an undelivered DM must not be
    // able to roll it back.
    expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      notifier.announceResults.mock.invocationCallOrder[0],
    );
  });

  it('closes entries before reading the pool', async () => {
    const { service, tx } = setup();

    await service.draw(CONTEST_ID);

    // Иначе нажавший кнопку в эту секунду попал бы в таблицу участников, но
    // не в разыгранный пул, и журнал разошёлся бы с базой.
    expect(tx.contest.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.contestParticipant.findMany.mock.invocationCallOrder[0],
    );
  });

  it('refuses a draw that another request already completed', async () => {
    const { service, tx } = setup();
    tx.contest.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.draw(CONTEST_ID)).rejects.toMatchObject({
      code: ErrorCode.CONTEST_ALREADY_DRAWN,
    });
  });

  it('does not fail the draw when announcing the result throws', async () => {
    const { service, notifier } = setup();
    notifier.announceResults.mockRejectedValue(new Error('база недоступна'));

    // The draw is committed; turning a failed announcement into a 500 would
    // make the admin retry and get "уже проведён", with the buttons never
    // swapped and nobody notified.
    await expect(service.draw(CONTEST_ID)).resolves.toHaveLength(1);
  });

  it('refuses a second draw', async () => {
    const { service, prisma } = setup({ id: CONTEST_ID, status: 'drawn' });

    await expect(service.draw(CONTEST_ID)).rejects.toMatchObject({
      code: ErrorCode.CONTEST_ALREADY_DRAWN,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('reports too few participants as its own error code', async () => {
    const { service, participants } = setup();
    participants.current = [];

    await expect(service.draw(CONTEST_ID)).rejects.toMatchObject({
      code: ErrorCode.CONTEST_INSUFFICIENT_PARTICIPANTS,
    });
  });

  it('does not notify anyone when the draw was refused', async () => {
    const { service, participants, notifier } = setup();
    participants.current = [];

    await expect(service.draw(CONTEST_ID)).rejects.toThrow(AppException);
    expect(notifier.announceResults).not.toHaveBeenCalled();
  });
});

describe('ContestsService.overrideWinner', () => {
  it('logs the replacement instead of overwriting silently', async () => {
    const { service, tx } = setup({ id: CONTEST_ID, status: 'drawn' });

    await service.overrideWinner('prize-1', 'p2', 'ошиблись');

    const logged = callArg<{
      data: {
        kind: string;
        note: string;
        resultSnapshot: {
          previousParticipantId: string;
          participantId: string;
        };
      };
    }>(tx.contestDrawLog.create).data;
    expect(logged.kind).toBe('override');
    expect(logged.note).toBe('ошиблись');
    expect(logged.resultSnapshot.previousParticipantId).toBe('p1');
    expect(logged.resultSnapshot.participantId).toBe('p2');
  });

  it('frees the place the new winner already held', async () => {
    const { service, tx } = setup({ id: CONTEST_ID, status: 'drawn' });

    await service.overrideWinner('prize-1', 'p2');

    // One participant, one place: without releasing their previous place the
    // unique index on the winner would reject the update.
    const { where } = callArg<{ where: { winnerParticipantId: string } }>(
      tx.contestPrize.updateMany,
    );
    expect(where.winnerParticipantId).toBe('p2');
  });

  it('resets the notification status for the new winner', async () => {
    const { service, tx } = setup({ id: CONTEST_ID, status: 'drawn' });

    await service.overrideWinner('prize-1', 'p2');

    const { data } = callArg<{ data: { notifyStatus: string } }>(
      tx.contestPrize.update,
    );
    // The old "sent" referred to a different person.
    expect(data.notifyStatus).toBe('pending');
  });

  it('re-announces the result so the post stops showing the old winner', async () => {
    const { service, notifier } = setup({ id: CONTEST_ID, status: 'drawn' });

    await service.overrideWinner('prize-1', 'p2');

    expect(notifier.announceResults).toHaveBeenCalledWith(
      CONTEST_ID,
      'override',
    );
  });

  it('frees the previous place completely, not just its winner', async () => {
    const { service, tx } = setup({ id: CONTEST_ID, status: 'drawn' });

    await service.overrideWinner('prize-1', 'p2');

    // Otherwise that place would sit winnerless while still claiming the
    // previous winner had been notified.
    const { data } = callArg<{
      data: { isForced: boolean; notifyStatus: string };
    }>(tx.contestPrize.updateMany);
    expect(data.isForced).toBe(false);
    expect(data.notifyStatus).toBe('pending');
  });

  it('refuses before the draw — that would announce results early', async () => {
    const { service, tx, notifier } = setup({ id: CONTEST_ID, status: 'open' });

    // Правка места запускает объявление итогов: поздравление и «Узнать
    // результаты» ушли бы раньше самого розыгрыша.
    await expect(service.overrideWinner('prize-1', 'p2')).rejects.toMatchObject(
      { code: ErrorCode.VALIDATION_ERROR },
    );
    expect(tx.contestDrawLog.create).not.toHaveBeenCalled();
    expect(notifier.announceResults).not.toHaveBeenCalled();
  });

  it('rejects a participant from another contest', async () => {
    const { service, prisma } = setup({ id: CONTEST_ID, status: 'drawn' });
    prisma.contestParticipant.findUnique.mockResolvedValue({
      contestId: 'other-contest',
    });

    await expect(service.overrideWinner('prize-1', 'p2')).rejects.toMatchObject(
      { code: ErrorCode.VALIDATION_ERROR },
    );
  });
});

describe('ContestsService.addParticipantsFromText', () => {
  it('reports duplicates by line instead of failing the whole paste', async () => {
    const { service, tx } = setup();
    // Вставлены двое: повтор Ивана в списке — дубль.
    tx.contestParticipant.createManyAndReturn.mockImplementation(
      ({ data }: { data: { dedupKey: string }[] }) =>
        Promise.resolve(
          [...new Set(data.map((d) => d.dedupKey))].map((dedupKey) => ({
            dedupKey,
          })),
        ),
    );

    const result = await service.addParticipantsFromText(
      CONTEST_ID,
      'Иван @ivan\nИван @ivan\nМария @maria',
    );

    expect(result).toEqual({ added: 2, duplicateLines: [2] });
    // Одна вставка на весь список, дубли её не обрывают.
    expect(tx.contestParticipant.createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(
      (
        tx.contestParticipant.createManyAndReturn.mock.calls as unknown[][]
      )[0][0],
    ).toMatchObject({ skipDuplicates: true });
  });

  it('уже участвующий — дубль, без записи в журнал', async () => {
    const { service, tx, audit } = setup();
    tx.contestParticipant.createManyAndReturn.mockResolvedValue([]);

    const result = await service.addParticipantsFromText(
      CONTEST_ID,
      'Иван @ivan',
    );

    expect(result).toEqual({ added: 0, duplicateLines: [1] });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('розыгрыш завершился, пока ждали блокировку, — никого не добавляем', async () => {
    const { service, tx, audit } = setup();
    tx.$queryRaw.mockResolvedValue([{ status: 'drawn' }]);

    await expect(
      service.addParticipantsFromText(CONTEST_ID, 'Иван @ivan'),
    ).rejects.toMatchObject({ code: ErrorCode.CONTEST_ALREADY_DRAWN });

    expect(tx.contestParticipant.createManyAndReturn).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses to add anyone once the draw has happened', async () => {
    const { service } = setup({ id: CONTEST_ID, status: 'drawn' });

    await expect(
      service.addParticipantsFromText(CONTEST_ID, 'Иван @ivan'),
    ).rejects.toMatchObject({ code: ErrorCode.CONTEST_ALREADY_DRAWN });
  });
});

describe('ContestsService.setPrizes', () => {
  it('закрепление места: розыгрыш завершился, пока ждали блокировку, — отказ без правки места', async () => {
    const { service, tx } = setup({ id: CONTEST_ID, status: 'open' });
    tx.$queryRaw.mockResolvedValue([{ status: 'drawn' }]);

    await expect(service.forceWinner('prize-1', 'p1')).rejects.toMatchObject({
      code: ErrorCode.CONTEST_ALREADY_DRAWN,
    });
    expect(tx.contestPrize.update).not.toHaveBeenCalled();
  });

  it('розыгрыш завершился, пока ждали блокировку, — отказ, победители не стёрты', async () => {
    const { service, tx } = setup({ id: CONTEST_ID, status: 'open' });
    tx.$queryRaw.mockResolvedValue([{ status: 'drawn' }]);

    await expect(
      service.setPrizes(CONTEST_ID, [{ place: 1, label: 'Первый' }]),
    ).rejects.toMatchObject({ code: ErrorCode.CONTEST_ALREADY_DRAWN });
    expect(tx.contestPrize.deleteMany).not.toHaveBeenCalled();
  });

  it('те же места — без записи в журнал, другие — с «было → стало»', async () => {
    const { service, tx, audit } = setup();
    tx.contestPrize.findMany.mockResolvedValue([{ place: 1, label: 'Первый' }]);

    await service.setPrizes(CONTEST_ID, [{ place: 1, label: 'Первый' }]);
    expect(audit.record).not.toHaveBeenCalled();

    await service.setPrizes(CONTEST_ID, [{ place: 1, label: 'Главный' }]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        details: {
          before: [{ place: 1, label: 'Первый' }],
          after: [{ place: 1, label: 'Главный' }],
        },
      }),
    );
  });

  it('rejects repeated places', async () => {
    const { service } = setup();

    await expect(
      service.setPrizes(CONTEST_ID, [
        { place: 1, label: 'Первый' },
        { place: 1, label: 'Тоже первый' },
      ]),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it('refuses to wipe every place on a contest with a scheduled end date', async () => {
    const { service, prisma } = setup({
      id: CONTEST_ID,
      status: 'open',
      endsAt: new Date('2099-01-01T00:00:00Z'),
    });

    // The panel already blocks an empty list client-side, but the service
    // is also reachable directly (API) — same hole as create/edit/open if
    // left unchecked here.
    await expect(service.setPrizes(CONTEST_ID, [])).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('allows clearing places on a contest with no scheduled end date', async () => {
    const { service, prisma } = setup({ id: CONTEST_ID, status: 'open' });

    await service.setPrizes(CONTEST_ID, []);

    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

describe('ContestsService.deleteContest', () => {
  const group = (id: string) => ({ id, title: `Канал ${id}` });

  function deleteSetup(
    row: { status: string; postId: string | null } | null,
    postStatus = 'sent',
    deliveries: unknown[] = [
      {
        status: 'sent',
        deletedAt: null,
        externalMessageId: 'mid.1',
        group: group('g1'),
      },
      {
        status: 'unknown',
        deletedAt: null,
        externalMessageId: null,
        group: group('g2'),
      },
      {
        status: 'failed',
        deletedAt: null,
        externalMessageId: null,
        group: group('g3'),
      },
    ],
  ) {
    const ctx = setup();
    const order: string[] = [];
    const del = (name: string) =>
      jest.fn(() => {
        order.push(name);
        return Promise.resolve({ count: 1 });
      });
    const dtx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce(row ? [row] : [])
        .mockResolvedValueOnce([{ status: postStatus }]),
      postDelivery: {
        findMany: jest.fn().mockResolvedValue(deliveries),
        deleteMany: del('delivery'),
      },
      contestPrize: { deleteMany: del('prize') },
      contestParticipant: { deleteMany: del('participant') },
      contestRequiredGroup: { deleteMany: del('requiredGroup') },
      contestDrawLog: { deleteMany: del('drawLog') },
      contest: { delete: del('contest') },
      postAttachment: { deleteMany: del('attachment') },
      directMessageDelivery: { deleteMany: del('dm') },
      post: { updateMany: del('clones'), delete: del('post') },
    };
    ctx.prisma.$transaction.mockImplementation(((fn: (c: unknown) => unknown) =>
      Promise.resolve(fn(dtx))) as never);
    return { ...ctx, order };
  }

  it('отменённый конкурс удалить можно — розыгрыша не было', async () => {
    const { service, order } = deleteSetup({
      status: 'cancelled',
      postId: 'post-1',
    });

    await service.deleteContest(CONTEST_ID);

    expect(order).toContain('contest');
  });

  it('стирает строки и отдаёт, какие сообщения снять, — сам в MAX не ходит', async () => {
    // Снятие — после коммита: откат после снятия оставил бы открытый
    // конкурс без анонсов. Места — раньше участников (место ссылается на
    // победителя), конкурс — раньше поста (конкурс ссылается на пост).
    const { service, order } = deleteSetup({
      status: 'open',
      postId: 'post-1',
    });

    const result = await service.deleteContest(CONTEST_ID);

    expect(result.messages).toEqual([
      { group: group('g1'), externalMessageId: 'mid.1' },
    ]);
    // «Неизвестно» — могло опубликоваться без id: снять нечем, назвать надо.
    expect(result.uncertain).toEqual(['Канал g2']);
    expect(order).toEqual([
      'prize',
      'participant',
      'requiredGroup',
      'drawLog',
      'contest',
      'attachment',
      'delivery',
      'dm',
      'clones',
      'post',
    ]);
  });

  it('ждёт блокировку дольше стандартных 5 с — её может держать розыгрыш', async () => {
    const { service, prisma } = deleteSetup({
      status: 'open',
      postId: 'post-1',
    });

    await service.deleteContest(CONTEST_ID);

    const options = callArg<{ timeout: number }>(prisma.$transaction, 0, 1);
    expect(options.timeout).toBeGreaterThan(60_000);
  });

  it('разыгранный не трогает', async () => {
    const { service, order } = deleteSetup({
      status: 'drawn',
      postId: 'post-1',
    });

    await expect(service.deleteContest(CONTEST_ID)).rejects.toMatchObject({
      code: ErrorCode.CONTEST_ALREADY_DRAWN,
    });
    expect(order).toEqual([]);
  });

  it('не удаляет, пока публикация отправляется — сообщение вышло бы сиротой', async () => {
    const { service, order } = deleteSetup(
      { status: 'open', postId: 'post-1' },
      'sending',
    );

    await expect(service.deleteContest(CONTEST_ID)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
    expect(order).toEqual([]);
  });

  it('несуществующий — NOT_FOUND', async () => {
    const { service } = deleteSetup(null);

    await expect(service.deleteContest(CONTEST_ID)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });
});

describe('ContestsService.createContest', () => {
  it('rejects an end date at or before the start date', async () => {
    const { service, prisma } = setup();

    await expect(
      service.createContest({
        title: 'Конкурс',
        postId: 'post-1',
        startsAt: new Date('2026-01-02T00:00:00Z'),
        endsAt: new Date('2026-01-01T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(prisma.contest.create).not.toHaveBeenCalled();
  });

  it('rejects a negative number of places', async () => {
    const { service, prisma } = setup();

    await expect(
      service.createContest({
        title: 'Конкурс',
        postId: 'post-1',
        placesCount: -1,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(prisma.contest.create).not.toHaveBeenCalled();
  });

  it('lays out places 1..N when placesCount is given', async () => {
    const { service, prisma } = setup();

    await service.createContest({
      title: 'Конкурс',
      postId: 'post-1',
      placesCount: 3,
    });

    // A freshly created contest is always `draft`, so setPrizes cannot hit
    // "already drawn" here — going through the real method (not a shortcut)
    // still matters: it's what keeps the unique-place check applied to the
    // places this option generates.
    const created = callArg<{
      data: { place: number; label: string }[];
    }>(prisma.contestPrize.createMany);
    expect(created.data).toEqual([
      { contestId: CONTEST_ID, place: 1, label: 'Место 1' },
      { contestId: CONTEST_ID, place: 2, label: 'Место 2' },
      { contestId: CONTEST_ID, place: 3, label: 'Место 3' },
    ]);
  });

  it('does not touch prizes when placesCount is omitted', async () => {
    const { service, prisma } = setup();

    await service.createContest({ title: 'Конкурс', postId: 'post-1' });

    expect(prisma.contestPrize.createMany).not.toHaveBeenCalled();
  });

  it('rejects a contest whose publication has no channels', async () => {
    const { service, prisma } = setup();
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-1',
      contest: null,
      deliveries: [],
    });

    // Конкурс всегда публикуется: без каналов участвовать было бы негде.
    await expect(
      service.createContest({ title: 'Конкурс', postId: 'post-1' }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(prisma.contest.create).not.toHaveBeenCalled();
  });

  it('rejects publishing into a channel that is not an active MAX group', async () => {
    const { service, prisma } = setup();
    // У поста на стене VK нет кнопок — такой конкурс был бы без участия.
    prisma.group.count.mockResolvedValue(0);

    await expect(
      service.createContest({ title: 'Конкурс', postId: 'post-1' }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(prisma.group.count).toHaveBeenCalledWith({
      where: { id: { in: ['g1'] }, platform: 'max', status: 'active' },
    });
    expect(prisma.contest.create).not.toHaveBeenCalled();
  });

  it('не снимает канал черновика, ставший неактивным, при правке текста', async () => {
    const { service, prisma } = setup();
    prisma.group.count.mockResolvedValue(0);

    // Уже стоящий в черновике — проходит; новый неактивный — отказ.
    await expect(
      service.assertPublishChannels(['g1'], ['g1']),
    ).resolves.toBeUndefined();
    await expect(
      service.assertPublishChannels(['g1', 'g2'], ['g1']),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it('rejects an announcement post that already belongs to another contest', async () => {
    const { service, prisma } = setup();
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-1',
      contest: { id: 'other-contest' },
    });

    await expect(
      service.createContest({ title: 'Конкурс', postId: 'post-1' }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(prisma.contest.create).not.toHaveBeenCalled();
  });

  it('rejects an end date already in the past', async () => {
    const { service, prisma } = setup();
    const now = new Date('2026-06-15T12:00:00Z');

    // Otherwise the reconciler would try to draw it on the very next sweep —
    // before the admin has had any chance to do anything with it.
    await expect(
      service.createContest(
        {
          title: 'Конкурс',
          postId: 'post-1',
          endsAt: new Date('2026-06-15T11:59:59Z'),
          placesCount: 1,
        },
        now,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(prisma.contest.create).not.toHaveBeenCalled();
  });

  it('accepts an end date exactly equal to now as already past', async () => {
    const { service, prisma } = setup();
    const now = new Date('2026-06-15T12:00:00Z');

    await expect(
      service.createContest(
        { title: 'Конкурс', postId: 'post-1', endsAt: now, placesCount: 1 },
        now,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(prisma.contest.create).not.toHaveBeenCalled();
  });

  it('does not reject a start date in the past — that just opens entry right away', async () => {
    const { service, prisma } = setup();
    prisma.contest.create.mockResolvedValue({ id: CONTEST_ID });

    await expect(
      service.createContest(
        {
          title: 'Конкурс',
          postId: 'post-1',
          startsAt: new Date('2020-01-01T00:00:00Z'),
        },
        new Date('2026-06-15T12:00:00Z'),
      ),
    ).resolves.toBeDefined();
  });

  it('rejects auto-draw scheduling with no prize places', async () => {
    const { service, prisma } = setup();

    // Without this, the reconciler would retry the draw forever, once a
    // minute, and refuse every single time — silently, in the server log
    // only, with no way for an admin to notice short of reading it.
    await expect(
      service.createContest({
        title: 'Конкурс',
        postId: 'post-1',
        endsAt: new Date('2099-01-01T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(prisma.contest.create).not.toHaveBeenCalled();
  });

  it('accepts auto-draw scheduling once placesCount seeds at least one place', async () => {
    const { service, prisma } = setup();
    prisma.contest.create.mockResolvedValue({ id: CONTEST_ID });

    await expect(
      service.createContest({
        title: 'Конкурс',
        postId: 'post-1',
        endsAt: new Date('2099-01-01T00:00:00Z'),
        placesCount: 1,
      }),
    ).resolves.toBeDefined();
    expect(prisma.contest.create).toHaveBeenCalled();
  });
});

describe('ContestsService.openContest', () => {
  it('refuses to open when a scheduled end date has no prize places', async () => {
    const { service, prisma } = setup({
      id: CONTEST_ID,
      status: 'draft',
      endsAt: new Date('2099-01-01T00:00:00Z'),
    });
    prisma.contestPrize.count.mockResolvedValue(0);

    // The same hole as at creation, reachable a different way: prizes seeded
    // at creation can still be wiped to zero afterwards via setPrizes.
    await expect(service.openContest(CONTEST_ID)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
    expect(prisma.contest.updateMany).not.toHaveBeenCalled();
  });

  it('opens normally once there is at least one prize place', async () => {
    const { service, prisma } = setup({
      id: CONTEST_ID,
      status: 'draft',
      endsAt: new Date('2099-01-01T00:00:00Z'),
    });
    prisma.contestPrize.count.mockResolvedValue(1);

    await service.openContest(CONTEST_ID);

    expect(prisma.contest.updateMany).toHaveBeenCalledWith({
      where: { id: CONTEST_ID, status: 'draft' },
      data: { status: 'open' },
    });
  });

  it('не откатывает розыгрыш, завершившийся между проверкой и открытием', async () => {
    // Проверка статуса — вне транзакции: безусловный update вернул бы
    // разыгранный конкурс в приём участников мимо разыгранного пула.
    const { service, prisma } = setup({ id: CONTEST_ID, status: 'open' });
    prisma.contest.updateMany.mockResolvedValue({ count: 0 });
    prisma.contest.findUnique
      .mockResolvedValueOnce({ id: CONTEST_ID, status: 'open' })
      .mockResolvedValueOnce({ id: CONTEST_ID, status: 'drawn' });

    await expect(service.openContest(CONTEST_ID)).rejects.toMatchObject({
      code: ErrorCode.CONTEST_ALREADY_DRAWN,
    });
  });

  it('повторное «Открыть» уже открытого — без изменений и без записи в журнал', async () => {
    const { service, prisma, audit } = setup({
      id: CONTEST_ID,
      status: 'open',
    });
    prisma.contest.updateMany.mockResolvedValue({ count: 0 });

    await service.openContest(CONTEST_ID);

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('does not require prizes for a contest with no scheduled end date', async () => {
    const { service, prisma } = setup({ id: CONTEST_ID, status: 'draft' });

    await service.openContest(CONTEST_ID);

    expect(prisma.contestPrize.count).not.toHaveBeenCalled();
    expect(prisma.contest.updateMany).toHaveBeenCalled();
  });
});

describe('ContestsService.openDueContests', () => {
  it('opens every draft contest whose start time has passed, keeping their postId', async () => {
    const { service, prisma } = setup();
    prisma.contest.findMany.mockResolvedValue([
      { id: 'c1', postId: 'post-1' },
      { id: 'c2', postId: null },
    ]);

    const now = new Date('2026-01-01T00:00:00Z');
    const { opened } = await service.openDueContests(now);

    expect(prisma.contest.findMany).toHaveBeenCalledWith({
      where: { status: 'draft', startsAt: { lte: now } },
      select: { id: true, postId: true },
    });
    expect(opened).toEqual([
      { id: 'c1', postId: 'post-1' },
      { id: 'c2', postId: null },
    ]);
    expect(prisma.contest.updateMany).toHaveBeenCalledTimes(2);
  });

  it('opens the rest of the batch when one contest fails to open', async () => {
    const { service, prisma, logger } = setup();
    prisma.contest.findMany.mockResolvedValue([
      { id: 'c1', postId: null },
      { id: 'c2', postId: null },
    ]);
    prisma.contest.updateMany
      .mockRejectedValueOnce(new Error('база недоступна'))
      .mockResolvedValueOnce({ count: 1 });

    const { opened } = await service.openDueContests(new Date());

    // One failure must not cost the rest of the sweep the same run.
    expect(opened).toEqual([{ id: 'c2', postId: null }]);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('ContestsService.drawDueContests', () => {
  it('draws every open contest whose end time has passed', async () => {
    const { service, prisma } = setup();
    prisma.contest.findMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);

    const now = new Date('2026-01-01T00:00:00Z');
    const { drawn } = await service.drawDueContests(now);

    expect(prisma.contest.findMany).toHaveBeenCalledWith({
      where: { status: 'open', endsAt: { lte: now } },
      select: { id: true },
    });
    expect(drawn).toBe(2);
  });

  it('ни одного участника к сроку — конкурс отменяется, а не ждёт вечно', async () => {
    const { service, prisma, participants, notifier, audit } = setup();
    prisma.contest.findMany.mockResolvedValue([{ id: CONTEST_ID }]);
    participants.current = [];

    const result = await service.drawDueContests(new Date());

    expect(result).toEqual({ drawn: 0, cancelled: 1 });
    // Условием «всё ещё открыт»: ручной розыгрыш мог успеть.
    const now = (prisma.contest.findMany.mock.calls as unknown[][])[0][0] as {
      where: { endsAt: { lte: Date } };
    };
    expect(prisma.contest.updateMany).toHaveBeenCalledWith({
      // Пустой, просроченный (продление не перечёркивается) и открытый.
      where: {
        id: CONTEST_ID,
        status: 'open',
        endsAt: { lte: now.where.endsAt.lte },
        participants: { none: {} },
      },
      data: { status: 'cancelled' },
    });
    expect(notifier.announceCancelled).toHaveBeenCalledWith(CONTEST_ID);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'system', action: 'contest.cancel' }),
    );
  });

  it('участники есть, но все отписались — не отмена: ждёт админа, без «ни одного»', async () => {
    const { service, prisma, notifier, logger } = setup();
    prisma.contest.findMany.mockResolvedValue([{ id: CONTEST_ID }]);
    // Розыгрыш отказал (пул пуст после проверки подписки), а условие
    // «участников нет» в базе не сошлось — строк 0.
    jest
      .spyOn(service, 'draw')
      .mockRejectedValue(
        new AppException(ErrorCode.CONTEST_INSUFFICIENT_PARTICIPANTS, 'нет'),
      );
    prisma.contest.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.drawDueContests(new Date());

    expect(result).toEqual({ drawn: 0, cancelled: 0 });
    expect(notifier.announceCancelled).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('отмену успел перебить ручной розыгрыш — ни объявления, ни записи', async () => {
    const { service, prisma, participants, notifier, audit } = setup();
    prisma.contest.findMany.mockResolvedValue([{ id: CONTEST_ID }]);
    participants.current = [];
    prisma.contest.updateMany.mockResolvedValue({ count: 0 });

    await service.drawDueContests(new Date());

    expect(notifier.announceCancelled).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('пока идёт прошлый проход, новый ничего не делает', async () => {
    const { service, prisma } = setup();
    let release!: () => void;
    prisma.contest.findMany.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve([]))),
    );

    const first = service.drawDueContests(new Date());
    await expect(service.drawDueContests(new Date())).resolves.toEqual({
      drawn: 0,
      cancelled: 0,
    });
    release();
    await first;

    expect(prisma.contest.findMany).toHaveBeenCalledTimes(1);
  });

  it('keeps drawing the rest of the batch when one contest fails outright', async () => {
    const { service, prisma, logger } = setup();
    prisma.contest.findMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
    // requireContest() is the first thing draw() awaits, so failing it here
    // stands in for any unexpected error during that contest's draw.
    prisma.contest.findUnique
      .mockRejectedValueOnce(new Error('база недоступна'))
      .mockResolvedValue({ id: 'c2', status: 'open' });

    const { drawn } = await service.drawDueContests(new Date());

    expect(drawn).toBe(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('ContestsService.warnEmptyEndingContests', () => {
  it('предупреждает о пустом конкурсе за 10 минут — один раз, условием', async () => {
    const { service, prisma, notifier } = setup();
    const now = new Date('2026-10-27T10:00:00Z');
    prisma.contest.findMany.mockResolvedValue([
      { id: CONTEST_ID, title: 'Пустой', endsAt: new Date() },
    ]);

    await expect(service.warnEmptyEndingContests(now)).resolves.toBe(1);

    const { where } = (
      prisma.contest.findMany.mock.calls as unknown[][]
    )[0][0] as {
      where: Record<string, unknown>;
    };
    // Только без участников: меньше, чем мест, — не повод.
    expect(where).toMatchObject({
      status: 'open',
      endWarningSentAt: null,
      participants: { none: {} },
      endsAt: { gt: now, lte: new Date('2026-10-27T10:10:00Z') },
    });
    expect(prisma.contest.updateMany).toHaveBeenCalledWith({
      where: { id: CONTEST_ID, endWarningSentAt: null },
      data: { endWarningSentAt: now },
    });
    expect(notifier.warnEmptyEnding).toHaveBeenCalledWith(CONTEST_ID, 'Пустой');
  });

  it('отметку уже поставила другая сверка — второго предупреждения нет', async () => {
    const { service, prisma, notifier } = setup();
    prisma.contest.findMany.mockResolvedValue([
      { id: CONTEST_ID, title: 'Пустой', endsAt: new Date() },
    ]);
    prisma.contest.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.warnEmptyEndingContests(new Date())).resolves.toBe(0);
    expect(notifier.warnEmptyEnding).not.toHaveBeenCalled();
  });
});

describe('ContestsService.editContest', () => {
  it('новый срок сбрасывает отметку предупреждения — продлённый предупредит снова', async () => {
    const { service, tx } = setup({
      id: CONTEST_ID,
      status: 'open',
      endsAt: new Date('2099-01-01T00:00:00Z'),
    });

    await service.editContest(CONTEST_ID, {
      title: 'Т',
      endsAt: new Date('2099-02-01T00:00:00Z'),
    });

    const { data } = (
      tx.contest.updateMany.mock.calls as unknown[][]
    )[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data.endWarningSentAt).toBeNull();
  });

  it('конкурс удалили, пока форма сохранялась, — NOT_FOUND, а не 500', async () => {
    const { service, tx } = setup({ id: CONTEST_ID, status: 'open' });
    tx.$queryRaw.mockResolvedValue([]);

    await expect(
      service.editContest(CONTEST_ID, { title: 'Новое' }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('сохранение без правки — без записи в журнал', async () => {
    const contest = {
      id: CONTEST_ID,
      status: 'open',
      title: 'Конкурс',
      description: null,
      joinButtonLabel: null,
      resultsButtonLabel: null,
      notifyWinners: true,
      publishResultsInPost: true,
      startsAt: null,
      endsAt: null,
    };
    const { service, audit } = setup(contest);
    const same = {
      title: 'Конкурс',
      joinButtonLabel: null,
      resultsButtonLabel: null,
      notifyWinners: true,
      publishResultsInPost: true,
    } as never;

    await service.editContest(CONTEST_ID, same);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses to edit a contest whose draw already happened', async () => {
    const { service, tx } = setup({ id: CONTEST_ID, status: 'drawn' });

    await expect(
      service.editContest(CONTEST_ID, { title: 'Новое название' }),
    ).rejects.toMatchObject({ code: ErrorCode.CONTEST_ALREADY_DRAWN });
    expect(tx.contest.updateMany).not.toHaveBeenCalled();
  });

  it('allows editing a contest that is already open, not just a draft', async () => {
    const { service, tx } = setup({ id: CONTEST_ID, status: 'open' });

    await service.editContest(CONTEST_ID, { title: 'Новое название' });

    expect(tx.contest.updateMany).toHaveBeenCalled();
  });

  it('rejects an end date at or before the start date', async () => {
    const { service, tx } = setup({ id: CONTEST_ID, status: 'open' });

    await expect(
      service.editContest(CONTEST_ID, {
        title: 'x',
        startsAt: new Date('2026-01-02T00:00:00Z'),
        endsAt: new Date('2026-01-01T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(tx.contest.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an end date already in the past', async () => {
    const { service, tx } = setup({ id: CONTEST_ID, status: 'open' });
    const now = new Date('2026-06-15T12:00:00Z');

    await expect(
      service.editContest(
        CONTEST_ID,
        { title: 'x', endsAt: new Date('2026-06-15T11:59:59Z') },
        now,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(tx.contest.updateMany).not.toHaveBeenCalled();
  });

  it('does not block an unrelated edit just because the stored end date has already passed', async () => {
    // A contest the reconciler couldn't draw (too few participants) sits
    // `open` with `endsAt` now in the past, waiting on the admin. The edit
    // form always resubmits the contest's current fields — title-only edits
    // must still go through, not get stuck behind a date nobody touched.
    const { service, tx } = setup({
      id: CONTEST_ID,
      status: 'open',
      endsAt: new Date('2026-06-15T11:00:00Z'),
    });
    const now = new Date('2026-06-15T12:00:00Z');

    await expect(
      service.editContest(
        CONTEST_ID,
        { title: 'новое название', endsAt: new Date('2026-06-15T11:00:00Z') },
        now,
      ),
    ).resolves.toBeDefined();
    expect(tx.contest.updateMany).toHaveBeenCalled();
  });

  it('rejects scheduling an end date with no prize places', async () => {
    const { service, prisma, tx } = setup({ id: CONTEST_ID, status: 'open' });
    prisma.contestPrize.count.mockResolvedValue(0);

    await expect(
      service.editContest(CONTEST_ID, {
        title: 'x',
        endsAt: new Date('2099-01-01T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(tx.contest.updateMany).not.toHaveBeenCalled();
  });

  it('accepts an end date once there is at least one prize place', async () => {
    const { service, prisma, tx } = setup({ id: CONTEST_ID, status: 'open' });
    prisma.contestPrize.count.mockResolvedValue(1);

    await service.editContest(CONTEST_ID, {
      title: 'x',
      endsAt: new Date('2099-01-01T00:00:00Z'),
    });

    expect(tx.contest.updateMany).toHaveBeenCalled();
  });

  it('saves the full set of editable fields in one update', async () => {
    const { service, tx } = setup({ id: CONTEST_ID, status: 'draft' });

    await service.editContest(CONTEST_ID, {
      title: 'Новый заголовок',
      description: 'новое описание',
      joinButtonLabel: 'Хочу приз',
      resultsButtonLabel: 'Итоги',
      notifyWinners: false,
      publishResultsInPost: false,
    });

    const updateCall = callArg<{
      where: unknown;
      data: Record<string, unknown>;
    }>(tx.contest.updateMany, 0, 0);
    expect(updateCall).toEqual({
      // Условием: сохранение, дождавшееся коммита розыгрыша, не перепишет
      // условия уже разыгранного конкурса.
      where: { id: CONTEST_ID, status: { notIn: ['drawn', 'cancelled'] } },
      data: {
        title: 'Новый заголовок',
        description: 'новое описание',
        joinButtonLabel: 'Хочу приз',
        resultsButtonLabel: 'Итоги',
        notifyWinners: false,
        publishResultsInPost: false,
        startsAt: null,
        endsAt: null,
      },
    });
  });

  it('отказывает, если розыгрыш успел пройти, пока правка ждала блокировку', async () => {
    const { service, tx } = setup({ id: CONTEST_ID, status: 'open' });
    tx.contest.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.editContest(CONTEST_ID, { title: 'x' }),
    ).rejects.toMatchObject({ code: ErrorCode.CONTEST_ALREADY_DRAWN });
    expect(tx.contestRequiredGroup.deleteMany).not.toHaveBeenCalled();
  });

  it('does not touch the linked post — the public announcement text is edited on its own card', async () => {
    const { service, prisma } = setup({ id: CONTEST_ID, status: 'draft' });

    await service.editContest(CONTEST_ID, {
      title: 'x',
      description: 'panel-only text',
    });

    expect(prisma.post.findUnique).not.toHaveBeenCalled();
  });
});
