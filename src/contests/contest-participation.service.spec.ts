import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { ContestParticipationService } from './contest-participation.service';

const CONTEST_ID = '11111111-1111-4111-8111-111111111111';

/** Reads one argument of a recorded call as `T` — the mock itself is untyped. */
function callArg<T>(mockFn: jest.Mock, callIndex = 0, argIndex = 0): T {
  return (mockFn.mock.calls as unknown[][])[callIndex][argIndex] as T;
}

const contestRow = (overrides: Record<string, unknown> = {}) => ({
  id: CONTEST_ID,
  title: 'Конкурс',
  status: 'open',
  joinButtonLabel: 'Участвовать',
  resultsButtonLabel: 'Узнать результаты',
  notifyWinners: true,
  post: {
    id: 'post-1',
    text: 'Текст анонса',
    vkTextOverride: null,
    maxTextOverride: null,
  },
  ...overrides,
});

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('duplicate', {
    code: 'P2002',
    clientVersion: 'test',
  });

function setup(contest: ReturnType<typeof contestRow> | null = contestRow()) {
  const prisma = {
    contest: { findUnique: jest.fn().mockResolvedValue(contest) },
    group: { findUnique: jest.fn().mockResolvedValue({ id: 'group-1' }) },
    platformUser: {
      upsert: jest.fn().mockResolvedValue({ id: 'pu-1' }),
    },
    contestParticipant: {
      create: jest.fn().mockResolvedValue({ id: 'participant-1' }),
      count: jest.fn().mockResolvedValue(3),
    },
    contestPrize: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn() };
  const service = new ContestParticipationService(
    prisma as unknown as PrismaService,
    logger as unknown as PinoLogger,
  );
  return { service, prisma };
}

const request = () => ({
  contestId: CONTEST_ID,
  platform: 'max' as const,
  user: {
    externalUserId: '42',
    displayName: 'Иван Иванов',
    firstName: 'Иван',
    lastName: 'Иванов',
    username: 'ivan',
    isBot: false,
    raw: { user_id: 42 },
  },
  groupExternalId: '-100',
});

describe('ContestParticipationService.join', () => {
  it('registers a participant and links them to a stored profile', async () => {
    const { service, prisma } = setup();

    const outcome = await service.join(request());

    expect(outcome.status).toBe('joined');
    expect(prisma.platformUser.upsert).toHaveBeenCalled();
    const { data } = callArg<{
      data: { platformUserId: string; groupId: string; source: string };
    }>(prisma.contestParticipant.create);
    expect(data.platformUserId).toBe('pu-1');
    expect(data.groupId).toBe('group-1');
    expect(data.source).toBe('button');
  });

  it('treats a repeat press as "already joined" rather than an error', async () => {
    const { service, prisma } = setup();
    prisma.contestParticipant.create.mockRejectedValueOnce(uniqueViolation());

    const outcome = await service.join(request());

    // Pressing again — including from another group of the same contest — is
    // the same person: the pool is shared, so a second row would double their
    // odds.
    expect(outcome.status).toBe('already_joined');
  });

  it('returns the announcement unchanged apart from the counter', async () => {
    const { service } = setup();

    const outcome = await service.join(request());

    // MAX has no toast: answering a callback replaces the message the button
    // sits on. "Leave the post alone" therefore means "hand the same post
    // back", or one person's click would wipe the announcement for everyone.
    expect(outcome.refresh).toEqual({
      text: 'Текст анонса',
      buttonText: 'Участвовать (3)',
      payload: `contest:join:${CONTEST_ID}`,
    });
  });

  it('keeps the MAX text override when refreshing the post', async () => {
    const { service } = setup(
      contestRow({
        post: {
          id: 'post-1',
          text: 'общий',
          vkTextOverride: null,
          maxTextOverride: 'для MAX',
        },
      }),
    );

    const outcome = await service.join(request());

    expect(outcome.refresh?.text).toBe('для MAX');
  });

  it('does not register anyone once the draw has happened', async () => {
    const { service, prisma } = setup(contestRow({ status: 'drawn' }));

    const outcome = await service.join(request());

    expect(outcome.status).toBe('drawn');
    expect(prisma.contestParticipant.create).not.toHaveBeenCalled();
    // The button may still read "Участвовать" if the swap failed, so a late
    // press has to answer with the results instead of registering.
    expect(outcome.refresh?.buttonText).toBe('Узнать результаты');
  });

  it('keeps the published winners in the post text', async () => {
    const { service, prisma } = setup(
      contestRow({ status: 'drawn', publishResultsInPost: true }),
    );
    prisma.contestPrize.findMany.mockResolvedValue([
      {
        place: 1,
        label: 'Главный приз',
        winnerParticipant: { displayName: 'Иван' },
      },
    ]);

    const outcome = await service.join(request());

    // The draw appended the winners to the post; a later press must hand the
    // same text back, or the next click would wipe them.
    expect(outcome.refresh?.text).toContain('Текст анонса');
    expect(outcome.refresh?.text).toContain('1. Главный приз — Иван');
  });

  it('leaves the post alone when publishing results is off', async () => {
    const { service } = setup(
      contestRow({ status: 'drawn', publishResultsInPost: false }),
    );

    const outcome = await service.join(request());

    expect(outcome.refresh?.text).toBe('Текст анонса');
  });

  it('refuses while the contest is still a draft', async () => {
    const { service, prisma } = setup(contestRow({ status: 'draft' }));

    expect((await service.join(request())).status).toBe('not_open');
    expect(prisma.contestParticipant.create).not.toHaveBeenCalled();
  });

  it('survives a contest that was deleted after the post went out', async () => {
    const { service } = setup(null);

    const outcome = await service.join(request());

    expect(outcome.status).toBe('unknown_contest');
    expect(outcome.refresh).toBeUndefined();
  });

  it('still registers when the group is unknown', async () => {
    const { service, prisma } = setup();
    prisma.group.findUnique.mockResolvedValue(null);

    const outcome = await service.join(request());

    // The group is recorded for reporting only; losing it must not cost
    // someone their entry.
    expect(outcome.status).toBe('joined');
    const { data } = callArg<{ data: { groupId: string | null } }>(
      prisma.contestParticipant.create,
    );
    expect(data.groupId).toBeNull();
  });

  it('rethrows failures that are not a duplicate entry', async () => {
    const { service, prisma } = setup();
    prisma.contestParticipant.create.mockRejectedValueOnce(
      new Error('база недоступна'),
    );

    await expect(service.join(request())).rejects.toThrow('база недоступна');
  });
});

describe('ContestParticipationService.resultsMessage', () => {
  it('lists places with their winners', async () => {
    const { service, prisma } = setup();
    prisma.contestPrize.findMany.mockResolvedValue([
      {
        place: 1,
        label: 'Главный приз',
        winnerParticipant: { displayName: 'Иван' },
      },
      { place: 2, label: 'Утешительный', winnerParticipant: null },
    ]);

    const message = await service.resultsMessage(CONTEST_ID);

    expect(message).toContain('1. Главный приз — Иван');
    // A place with no winner is shown as empty rather than omitted: silence
    // would read as "there was no second place".
    expect(message).toContain('2. Утешительный — —');
  });

  it('says the contest is over even with no prizes recorded', async () => {
    const { service } = setup();

    expect(await service.resultsMessage(CONTEST_ID)).toBe('Конкурс завершён.');
  });
});
