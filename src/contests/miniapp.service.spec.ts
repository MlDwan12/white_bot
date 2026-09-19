import { PrismaService } from '../prisma/prisma.service';
import { ErrorCode } from '../common/error-code.enum';
import { ContestParticipationService } from './contest-participation.service';
import { MiniAppService, type MiniAppViewer } from './miniapp.service';

const CONTEST_ID = '11111111-1111-4111-8111-111111111111';

const viewer = (): MiniAppViewer => ({
  externalUserId: '42',
  chatId: -79114405995998,
  profile: {
    externalUserId: '42',
    displayName: 'Иван',
    firstName: 'Иван',
    lastName: 'Петренко',
    username: null,
    isBot: false,
  },
});

function setup(
  options: { status?: string; entry?: { id: string } | null } = {},
) {
  const prisma = {
    contest: {
      findUnique: jest.fn().mockResolvedValue({
        id: CONTEST_ID,
        title: 'Конкурс',
        status: options.status ?? 'open',
        post: {
          text: 'условия из анонса',
          vkTextOverride: null,
          maxTextOverride: null,
          deliveries: [{ id: 'd1' }],
        },
        prizes: [{ id: 'p1' }, { id: 'p2' }],
      }),
    },
    contestParticipant: {
      count: jest.fn().mockResolvedValue(7),
      findFirst: jest
        .fn()
        .mockResolvedValue(options.entry === undefined ? null : options.entry),
    },
    contestPrize: {
      findMany: jest.fn().mockResolvedValue([
        {
          place: 1,
          winnerParticipant: {
            id: 'mine',
            displayName: 'Иван Петренко',
            platformUser: { firstName: 'Иван', lastName: 'Петренко' },
          },
        },
        {
          place: 2,
          winnerParticipant: {
            id: 'other',
            displayName: 'Мария Сидорова',
            platformUser: null,
          },
        },
      ]),
    },
  };
  const participation = {
    join: jest.fn().mockResolvedValue({ status: 'joined', message: 'ok' }),
  };
  const service = new MiniAppService(
    prisma as unknown as PrismaService,
    participation as unknown as ContestParticipationService,
  );
  return { service, prisma, participation };
}

describe('MiniAppService.getContest', () => {
  it('shows the announcement text as the terms', async () => {
    const { service } = setup();

    const view = await service.getContest(CONTEST_ID, viewer());

    // Условия не хранятся отдельно, чтобы им негде было разойтись с тем,
    // что человек прочёл в канале.
    expect(view.terms).toBe('условия из анонса');
    expect(view.participantsCount).toBe(7);
    expect(view.placesCount).toBe(2);
    expect(view.joined).toBe(false);
  });

  it('hides the winners until the draw has happened', async () => {
    const { service, prisma } = setup({ status: 'open' });

    const view = await service.getContest(CONTEST_ID, viewer());

    expect(view.winners).toEqual([]);
    expect(prisma.contestPrize.findMany).not.toHaveBeenCalled();
  });

  it('marks the viewer among the winners and shortens the names', async () => {
    const { service } = setup({ status: 'drawn', entry: { id: 'mine' } });

    const view = await service.getContest(CONTEST_ID, viewer());

    expect(view.winners).toEqual([
      { place: 1, name: 'Иван П.', isMe: true },
      { place: 2, name: 'Мария С.', isMe: false },
    ]);
  });

  it('hides a contest whose announcement was never published', async () => {
    const { service, prisma } = setup();
    prisma.contest.findUnique.mockResolvedValue({
      id: CONTEST_ID,
      title: 'Черновик',
      status: 'open',
      post: {
        text: 'ещё не опубликовано',
        vkTextOverride: null,
        maxTextOverride: null,
        deliveries: [],
      },
      prizes: [],
    });

    // Ссылку с любым id может открыть кто угодно — подпись это не запрещает.
    // Без проверки публикации так читался бы текст неотправленного поста.
    await expect(
      service.getContest(CONTEST_ID, viewer()),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('hides a contest that has no announcement post at all', async () => {
    const { service, prisma } = setup();
    prisma.contest.findUnique.mockResolvedValue({
      id: CONTEST_ID,
      title: 'Ручной конкурс',
      status: 'open',
      post: null,
      prizes: [],
    });

    await expect(
      service.getContest(CONTEST_ID, viewer()),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('fails clearly when the contest is gone', async () => {
    const { service, prisma } = setup();
    prisma.contest.findUnique.mockResolvedValue(null);

    // Ссылка живёт в опубликованном посте и переживает удаление конкурса.
    await expect(
      service.getContest(CONTEST_ID, viewer()),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });
});

describe('MiniAppService.join', () => {
  it('registers through the same service as the chat button', async () => {
    const { service, participation } = setup();

    await service.join(CONTEST_ID, viewer());

    // Правила приёма и дедупликация не должны зависеть от того, откуда
    // человек пришёл — из кнопки под постом или из мини-приложения.
    expect(participation.join).toHaveBeenCalledWith(
      expect.objectContaining({ contestId: CONTEST_ID, platform: 'max' }),
    );
  });

  it('treats a repeat join as success and returns the current state', async () => {
    const { service, participation } = setup({ entry: { id: 'mine' } });
    participation.join.mockResolvedValue({
      status: 'already_joined',
      message: 'уже',
    });

    const view = await service.join(CONTEST_ID, viewer());

    // Человек нажал дважды — правильный ответ показать состояние, а не отказ.
    expect(view.joined).toBe(true);
  });

  it('refuses to report success when the draw already happened', async () => {
    const { service, participation } = setup();
    participation.join.mockResolvedValue({
      status: 'drawn',
      message: 'поздно',
    });

    // Иначе страница показала бы «вы участвуете», а в конкурсе человека нет.
    await expect(service.join(CONTEST_ID, viewer())).rejects.toMatchObject({
      code: ErrorCode.CONTEST_ALREADY_DRAWN,
    });
  });

  it('refuses to report success while entries are closed', async () => {
    const { service, participation } = setup();
    participation.join.mockResolvedValue({
      status: 'not_open',
      message: 'рано',
    });

    await expect(service.join(CONTEST_ID, viewer())).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
  });

  it('reports a vanished contest as not found', async () => {
    const { service, participation } = setup();
    participation.join.mockResolvedValue({
      status: 'unknown_contest',
      message: 'нет',
    });

    await expect(service.join(CONTEST_ID, viewer())).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });
});
