import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { PlatformUsersService } from '../platform-users/platform-users.service';
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
    contestParticipant: {
      create: jest.fn().mockResolvedValue({ id: 'participant-1' }),
      count: jest.fn().mockResolvedValue(3),
    },
    contestPrize: { findMany: jest.fn().mockResolvedValue([]) },
    postDelivery: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const platformUsers = {
    upsert: jest.fn().mockResolvedValue({ id: 'pu-1' }),
    // По умолчанию — уже согласившийся человек: сам шлюз согласия
    // проверяется отдельными тестами ниже.
    hasConsented: jest.fn().mockResolvedValue(true),
  };
  const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn() };
  const service = new ContestParticipationService(
    prisma as unknown as PrismaService,
    platformUsers as unknown as PlatformUsersService,
    logger as unknown as PinoLogger,
  );
  return { service, prisma, platformUsers };
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
    const { service, prisma, platformUsers } = setup();

    const outcome = await service.join(request());

    expect(outcome.status).toBe('joined');
    expect(platformUsers.upsert).toHaveBeenCalled();
    const { data } = callArg<{
      data: { platformUserId: string; groupId: string; source: string };
    }>(prisma.contestParticipant.create);
    expect(data.platformUserId).toBe('pu-1');
    expect(data.groupId).toBe('group-1');
    expect(data.source).toBe('button');
  });

  it('без согласия отказывает и не пишет ни профиль, ни участие', async () => {
    // Единственная точка входа, которая реально сохраняет профиль и
    // записывает участие: обязана отказать до записи, а не только когда её
    // зовут из обработчика, явно показывающего экран согласия. Иначе кнопка
    // прямо под постом в канале (без диалога с ботом) записывала бы участие
    // в обход согласия целиком.
    const { service, prisma, platformUsers } = setup();
    platformUsers.hasConsented.mockResolvedValue(false);

    const outcome = await service.join(request());

    expect(outcome.status).toBe('consent_required');
    expect(platformUsers.upsert).not.toHaveBeenCalled();
    expect(prisma.contestParticipant.create).not.toHaveBeenCalled();
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

describe('startedFromLink', () => {
  const profile = () => request().user;

  const winner = (overrides: Record<string, unknown> = {}) => ({
    id: 'prize-1',
    place: 1,
    label: 'Главный приз',
    notifyStatus: 'manual_required',
    winnerParticipant: { platform: 'max', externalUserId: '42' },
    ...overrides,
  });

  function setupDrawn(
    prizes: unknown[],
    contestOverrides: Record<string, unknown> = {},
  ) {
    return setup(contestRow({ status: 'drawn', prizes, ...contestOverrides }));
  }

  describe('до розыгрыша — это и есть участие', () => {
    it('записывает нового участника и сообщает, что счётчик надо обновить', async () => {
      const { service, prisma } = setup(
        contestRow({ status: 'open', prizes: [] }),
      );

      const reply = await service.startedFromLink(CONTEST_ID, profile());

      expect(prisma.contestParticipant.create).toHaveBeenCalled();
      expect(reply.text).toContain('Вы участвуете в конкурсе «Конкурс»');
      expect(reply.text).toContain('Итоги пришлю сюда');
      expect(reply.joined).toBe(true);
    });

    it('повторный старт не пишет второго участника и не перерисовывает посты', async () => {
      // Ссылку нажимают по несколько раз — счётчик при этом расти не должен,
      // а лишняя правка сообщения ничего не даёт.
      const { service, prisma } = setup(
        contestRow({ status: 'open', prizes: [] }),
      );
      prisma.contestParticipant.create.mockRejectedValue(uniqueViolation());

      const reply = await service.startedFromLink(CONTEST_ID, profile());

      expect(reply.text).toContain('Вы уже участвуете');
      expect(reply.joined).toBe(false);
    });

    it('пока приём не открыт, участие не пишет и говорит об этом', async () => {
      const { service, prisma } = setup(
        contestRow({ status: 'draft', prizes: [] }),
      );

      const reply = await service.startedFromLink(CONTEST_ID, profile());

      expect(prisma.contestParticipant.create).not.toHaveBeenCalled();
      expect(reply.text).toBe('Приём участников ещё не открыт.');
      expect(reply.joined).toBe(false);
    });

    it('запоминает группу, если анонс вышел ровно в одну', async () => {
      // Со ссылки группы нет: человек приходит в диалог, а не из канала.
      // Одна группа — однозначный ответ, две — уже угадывание.
      const { service, prisma } = setup(
        contestRow({ status: 'open', prizes: [] }),
      );
      prisma.postDelivery.findMany.mockResolvedValue([
        { externalMessageId: 'mid.1', groupId: 'only-group' },
      ]);

      await service.startedFromLink(CONTEST_ID, profile());

      const data = callArg<{ data: { groupId: string | null } }>(
        prisma.contestParticipant.create,
      ).data;
      expect(data.groupId).toBe('only-group');
    });

    it('оставляет группу пустой, если анонс вышел в несколько', async () => {
      const { service, prisma } = setup(
        contestRow({ status: 'open', prizes: [] }),
      );
      prisma.postDelivery.findMany.mockResolvedValue([
        { externalMessageId: 'mid.1', groupId: 'g1' },
        { externalMessageId: 'mid.2', groupId: 'g2' },
      ]);

      await service.startedFromLink(CONTEST_ID, profile());

      const data = callArg<{ data: { groupId: string | null } }>(
        prisma.contestParticipant.create,
      ).data;
      expect(data.groupId).toBeNull();
    });
  });

  describe('после розыгрыша', () => {
    it('победитель, открывший диалог позже, получает поздравление', async () => {
      const { service } = setupDrawn([winner()]);

      const reply = await service.startedFromLink(CONTEST_ID, profile());

      expect(reply.text).toBe(
        'Поздравляем! Вы заняли 1 место в конкурсе «Конкурс»: Главный приз.',
      );
      expect(reply.prizeIdsToMark).toEqual(['prize-1']);
    });

    it('уже уведомлённого победителя не помечает заново', async () => {
      // `notified_manually` — отметка человека, автоматика её затирать не
      // должна; `sent` повторять незачем.
      const { service } = setupDrawn([
        winner({ id: 'a', notifyStatus: 'sent' }),
        winner({ id: 'b', place: 2, notifyStatus: 'notified_manually' }),
        winner({ id: 'c', place: 3, notifyStatus: 'failed' }),
      ]);

      const reply = await service.startedFromLink(CONTEST_ID, profile());

      expect(reply.prizeIdsToMark).toEqual(['c']);
    });

    it('не победителю отвечает списком победителей и не регистрирует участие', async () => {
      const { service, prisma } = setupDrawn([winner()]);
      prisma.contestPrize.findMany.mockResolvedValue([
        {
          place: 1,
          label: 'Главный приз',
          winnerParticipant: { displayName: 'Пётр' },
        },
      ]);

      const reply = await service.startedFromLink(CONTEST_ID, {
        ...profile(),
        externalUserId: '999',
      });

      expect(reply.text).toContain('Конкурс завершён');
      expect(reply.text).toContain('1. Главный приз — Пётр');
      expect(reply.text).not.toContain('Поздравляем');
      expect(prisma.contestParticipant.create).not.toHaveBeenCalled();
      expect(reply.prizeIdsToMark).toEqual([]);
    });

    it('победитель с другой площадки того же id не считается', async () => {
      // id пользователей VK и MAX — независимые пространства: совпадение
      // числа не делает людей одним человеком.
      const { service } = setupDrawn([
        winner({ winnerParticipant: { platform: 'vk', externalUserId: '42' } }),
      ]);

      const reply = await service.startedFromLink(CONTEST_ID, profile());

      expect(reply.text).not.toContain('Поздравляем');
    });

    it('уважает отключённое автоуведомление победителей', async () => {
      // Владелец конкурса запретил писать победителям в личку — ссылка на
      // бота не должна обходить это решение.
      const { service } = setupDrawn([winner()], { notifyWinners: false });

      const reply = await service.startedFromLink(CONTEST_ID, profile());

      expect(reply.text).not.toContain('Поздравляем');
      expect(reply.prizeIdsToMark).toEqual([]);
    });
  });

  describe('победитель и уведомитель не мешают друг другу', () => {
    it('место в `pending` принадлежит уведомителю — поздравления здесь нет', async () => {
      // Розыгрыш только что прошёл, и уведомитель вот-вот пришлёт своё.
      // Ответь мы тоже — победитель получил бы два одинаковых поздравления.
      const { service, prisma } = setupDrawn([
        winner({ notifyStatus: 'pending' }),
      ]);
      prisma.contestPrize.findMany.mockResolvedValue([
        {
          place: 1,
          label: 'Главный приз',
          winnerParticipant: { displayName: 'Иван' },
        },
      ]);

      const reply = await service.startedFromLink(CONTEST_ID, profile());

      expect(reply.text).not.toContain('Поздравляем');
      expect(reply.text).toContain('1. Главный приз — Иван');
      expect(reply.prizeIdsToMark).toEqual([]);
    });

    it('уже поздравленному победителю показывает список, а не второе поздравление', async () => {
      const { service, prisma } = setupDrawn([
        winner({ notifyStatus: 'sent' }),
      ]);
      prisma.contestPrize.findMany.mockResolvedValue([
        {
          place: 1,
          label: 'Главный приз',
          winnerParticipant: { displayName: 'Иван' },
        },
      ]);

      const reply = await service.startedFromLink(CONTEST_ID, profile());

      expect(reply.text).not.toContain('Поздравляем');
      expect(reply.prizeIdsToMark).toEqual([]);
    });
  });

  it('несуществующему конкурсу отвечает без исключения', async () => {
    const { service } = setup(null);

    const reply = await service.startedFromLink(CONTEST_ID, profile());

    expect(reply.text).toContain('не найден');
  });
});

describe('announcementRefresh', () => {
  it('считает счётчик заново и отдаёт сообщения во все MAX-группы', async () => {
    // Свежее число, а не значение из ответа `join`: правки от разных
    // участников идут вперемешку, и устаревшее перезаписало бы новое.
    const { service, prisma } = setup(contestRow({ status: 'open' }));
    prisma.postDelivery.findMany.mockResolvedValue([
      { externalMessageId: 'mid.1', groupId: 'g1' },
      { externalMessageId: 'mid.2', groupId: 'g2' },
    ]);

    const refresh = await service.announcementRefresh(CONTEST_ID);

    expect(refresh).toMatchObject({
      text: 'Текст анонса',
      buttonText: 'Участвовать (3)',
      messageIds: ['mid.1', 'mid.2'],
    });
    expect(prisma.contestParticipant.count).toHaveBeenCalled();
  });

  it('после розыгрыша ничего не отдаёт — пост принадлежит уведомителю', async () => {
    // Запоздавшая правка счётчика затёрла бы победителей, дописанных в пост.
    const { service } = setup(contestRow({ status: 'drawn' }));

    expect(await service.announcementRefresh(CONTEST_ID)).toBeNull();
  });

  it('у конкурса без анонса или несуществующего — null', async () => {
    expect(
      await setup(contestRow({ post: null })).service.announcementRefresh(
        CONTEST_ID,
      ),
    ).toBeNull();
    expect(
      await setup(null).service.announcementRefresh(CONTEST_ID),
    ).toBeNull();
  });
});

describe('markWinnersNotified', () => {
  it('помечает места отправленными', async () => {
    const { service, prisma } = setup();
    (prisma as Record<string, unknown>).contestPrize = {
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    };

    await service.markWinnersNotified(['a', 'b']);

    const args = callArg<{
      where: { id: { in: string[] } };
      data: { notifyStatus: string; notifyError: null };
    }>(
      (prisma.contestPrize as unknown as { updateMany: jest.Mock }).updateMany,
    );
    expect(args.where.id.in).toEqual(['a', 'b']);
    expect(args.data.notifyStatus).toBe('sent');
    expect(args.data.notifyError).toBeNull();
  });

  it('пустой список — без обращения к базе', async () => {
    const { service, prisma } = setup();
    const updateMany = jest.fn();
    (prisma as Record<string, unknown>).contestPrize = { updateMany };

    await service.markWinnersNotified([]);

    expect(updateMany).not.toHaveBeenCalled();
  });
});
