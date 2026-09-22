import { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { ContestNotifier } from './contest-notifier';
import { ContestsService } from './contests.service';

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

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('duplicate', {
    code: 'P2002',
    clientVersion: 'test',
  });

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
    },
    contestParticipant: {
      findMany: jest.fn(() => Promise.resolve(participants.current)),
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
    },
    contestDrawLog: { create: jest.fn().mockResolvedValue({}) },
  };

  const prisma = {
    contest: {
      findUnique: jest.fn().mockResolvedValue(contest),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(contest),
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
    post: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
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

  const notifier = { announceResults: jest.fn().mockResolvedValue(undefined) };
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const service = new ContestsService(
    prisma as unknown as PrismaService,
    notifier as unknown as ContestNotifier,
    logger as unknown as PinoLogger,
  );
  return { service, prisma, tx, notifier, participants, logger };
}

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
    const { service, tx } = setup();

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
    const { service, tx } = setup();

    await service.overrideWinner('prize-1', 'p2');

    // One participant, one place: without releasing their previous place the
    // unique index on the winner would reject the update.
    const { where } = callArg<{ where: { winnerParticipantId: string } }>(
      tx.contestPrize.updateMany,
    );
    expect(where.winnerParticipantId).toBe('p2');
  });

  it('resets the notification status for the new winner', async () => {
    const { service, tx } = setup();

    await service.overrideWinner('prize-1', 'p2');

    const { data } = callArg<{ data: { notifyStatus: string } }>(
      tx.contestPrize.update,
    );
    // The old "sent" referred to a different person.
    expect(data.notifyStatus).toBe('pending');
  });

  it('re-announces the result so the post stops showing the old winner', async () => {
    const { service, notifier } = setup();

    await service.overrideWinner('prize-1', 'p2');

    expect(notifier.announceResults).toHaveBeenCalledWith(
      CONTEST_ID,
      'override',
    );
  });

  it('frees the previous place completely, not just its winner', async () => {
    const { service, tx } = setup();

    await service.overrideWinner('prize-1', 'p2');

    // Otherwise that place would sit winnerless while still claiming the
    // previous winner had been notified.
    const { data } = callArg<{
      data: { isForced: boolean; notifyStatus: string };
    }>(tx.contestPrize.updateMany);
    expect(data.isForced).toBe(false);
    expect(data.notifyStatus).toBe('pending');
  });

  it('rejects a participant from another contest', async () => {
    const { service, prisma } = setup();
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
    const { service, prisma } = setup();
    prisma.contestParticipant.create
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValueOnce({});

    const result = await service.addParticipantsFromText(
      CONTEST_ID,
      'Иван @ivan\nИван @ivan\nМария @maria',
    );

    expect(result).toEqual({ added: 2, duplicateLines: [2] });
  });

  it('refuses to add anyone once the draw has happened', async () => {
    const { service } = setup({ id: CONTEST_ID, status: 'drawn' });

    await expect(
      service.addParticipantsFromText(CONTEST_ID, 'Иван @ivan'),
    ).rejects.toMatchObject({ code: ErrorCode.CONTEST_ALREADY_DRAWN });
  });
});

describe('ContestsService.setPrizes', () => {
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

describe('ContestsService.createContest', () => {
  it('rejects an end date at or before the start date', async () => {
    const { service, prisma } = setup();

    await expect(
      service.createContest({
        title: 'Конкурс',
        startsAt: new Date('2026-01-02T00:00:00Z'),
        endsAt: new Date('2026-01-01T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(prisma.contest.create).not.toHaveBeenCalled();
  });

  it('rejects a negative number of places', async () => {
    const { service, prisma } = setup();

    await expect(
      service.createContest({ title: 'Конкурс', placesCount: -1 }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(prisma.contest.create).not.toHaveBeenCalled();
  });

  it('lays out places 1..N when placesCount is given', async () => {
    const { service, prisma } = setup();

    await service.createContest({ title: 'Конкурс', placesCount: 3 });

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

    await service.createContest({ title: 'Конкурс' });

    expect(prisma.contestPrize.createMany).not.toHaveBeenCalled();
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
        { title: 'Конкурс', endsAt: now, placesCount: 1 },
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
    expect(prisma.contest.update).not.toHaveBeenCalled();
  });

  it('opens normally once there is at least one prize place', async () => {
    const { service, prisma } = setup({
      id: CONTEST_ID,
      status: 'draft',
      endsAt: new Date('2099-01-01T00:00:00Z'),
    });
    prisma.contestPrize.count.mockResolvedValue(1);

    await service.openContest(CONTEST_ID);

    expect(prisma.contest.update).toHaveBeenCalledWith({
      where: { id: CONTEST_ID },
      data: { status: 'open' },
    });
  });

  it('does not require prizes for a contest with no scheduled end date', async () => {
    const { service, prisma } = setup({ id: CONTEST_ID, status: 'draft' });

    await service.openContest(CONTEST_ID);

    expect(prisma.contestPrize.count).not.toHaveBeenCalled();
    expect(prisma.contest.update).toHaveBeenCalled();
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
    expect(prisma.contest.update).toHaveBeenCalledTimes(2);
  });

  it('opens the rest of the batch when one contest fails to open', async () => {
    const { service, prisma, logger } = setup();
    prisma.contest.findMany.mockResolvedValue([
      { id: 'c1', postId: null },
      { id: 'c2', postId: null },
    ]);
    prisma.contest.update
      .mockRejectedValueOnce(new Error('база недоступна'))
      .mockResolvedValueOnce({});

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

  it('does not count too few participants as a sweep failure', async () => {
    const { service, prisma, participants, logger } = setup();
    prisma.contest.findMany.mockResolvedValue([{ id: 'c1' }]);
    participants.current = [];

    // draw() refuses with CONTEST_INSUFFICIENT_PARTICIPANTS while the
    // contest waits for someone to join — expected, not a bug in the sweep,
    // and the contest must stay `open` for the next pass to retry.
    const { drawn } = await service.drawDueContests(new Date());

    expect(drawn).toBe(0);
    expect(logger.warn).toHaveBeenCalled();
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

describe('ContestsService.editContest', () => {
  it('refuses to edit a contest whose draw already happened', async () => {
    const { service, prisma } = setup({ id: CONTEST_ID, status: 'drawn' });

    await expect(
      service.editContest(CONTEST_ID, { title: 'Новое название' }),
    ).rejects.toMatchObject({ code: ErrorCode.CONTEST_ALREADY_DRAWN });
    expect(prisma.contest.update).not.toHaveBeenCalled();
  });

  it('allows editing a contest that is already open, not just a draft', async () => {
    const { service, prisma } = setup({ id: CONTEST_ID, status: 'open' });

    await service.editContest(CONTEST_ID, { title: 'Новое название' });

    expect(prisma.contest.update).toHaveBeenCalled();
  });

  it('rejects an end date at or before the start date', async () => {
    const { service, prisma } = setup({ id: CONTEST_ID, status: 'open' });

    await expect(
      service.editContest(CONTEST_ID, {
        title: 'x',
        startsAt: new Date('2026-01-02T00:00:00Z'),
        endsAt: new Date('2026-01-01T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(prisma.contest.update).not.toHaveBeenCalled();
  });

  it('rejects an end date already in the past', async () => {
    const { service, prisma } = setup({ id: CONTEST_ID, status: 'open' });
    const now = new Date('2026-06-15T12:00:00Z');

    await expect(
      service.editContest(
        CONTEST_ID,
        { title: 'x', endsAt: new Date('2026-06-15T11:59:59Z') },
        now,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(prisma.contest.update).not.toHaveBeenCalled();
  });

  it('does not block an unrelated edit just because the stored end date has already passed', async () => {
    // A contest the reconciler couldn't draw (too few participants) sits
    // `open` with `endsAt` now in the past, waiting on the admin. The edit
    // form always resubmits the contest's current fields — title-only edits
    // must still go through, not get stuck behind a date nobody touched.
    const { service, prisma } = setup({
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
    expect(prisma.contest.update).toHaveBeenCalled();
  });

  it('rejects scheduling an end date with no prize places', async () => {
    const { service, prisma } = setup({ id: CONTEST_ID, status: 'open' });
    prisma.contestPrize.count.mockResolvedValue(0);

    await expect(
      service.editContest(CONTEST_ID, {
        title: 'x',
        endsAt: new Date('2099-01-01T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(prisma.contest.update).not.toHaveBeenCalled();
  });

  it('accepts an end date once there is at least one prize place', async () => {
    const { service, prisma } = setup({ id: CONTEST_ID, status: 'open' });
    prisma.contestPrize.count.mockResolvedValue(1);

    await service.editContest(CONTEST_ID, {
      title: 'x',
      endsAt: new Date('2099-01-01T00:00:00Z'),
    });

    expect(prisma.contest.update).toHaveBeenCalled();
  });

  it('saves the full set of editable fields in one update', async () => {
    const { service, prisma } = setup({ id: CONTEST_ID, status: 'draft' });

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
    }>(prisma.contest.update, 0, 0);
    expect(updateCall).toEqual({
      where: { id: CONTEST_ID },
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

  it('does not touch the linked post — the public announcement text is edited on its own card', async () => {
    const { service, prisma } = setup({ id: CONTEST_ID, status: 'draft' });

    await service.editContest(CONTEST_ID, {
      title: 'x',
      description: 'panel-only text',
    });

    expect(prisma.post.findUnique).not.toHaveBeenCalled();
  });
});
