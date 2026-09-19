import { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { ContestNotifier } from './contest-notifier';
import { ContestsService } from './contests.service';

const CONTEST_ID = '11111111-1111-4111-8111-111111111111';

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
      update: jest.fn().mockResolvedValue(contest),
      create: jest.fn().mockResolvedValue({ id: CONTEST_ID }),
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
    },
    $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) =>
      fn(tx),
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
  return { service, prisma, tx, notifier, participants };
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
});
