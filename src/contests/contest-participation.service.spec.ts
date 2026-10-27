import { ErrorCode } from '../common/error-code.enum';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { PlatformUsersService } from '../platform-users/platform-users.service';
import { ContestParticipationService } from './contest-participation.service';
import { ContestSubscriptions } from './contest-subscriptions';

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
    contestFunnelEvent: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    contest: {
      findUnique: jest.fn().mockResolvedValue(contest),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    group: { findUnique: jest.fn().mockResolvedValue({ id: 'group-1' }) },
    contestParticipant: {
      create: jest.fn().mockResolvedValue({ id: 'participant-1' }),
      count: jest.fn().mockResolvedValue(3),
    },
    contestPrize: { findMany: jest.fn().mockResolvedValue([]) },
    postDelivery: { findMany: jest.fn().mockResolvedValue([]) },
    // Статус под блокировкой строки перед записью — по умолчанию приём идёт.
    $queryRaw: jest.fn().mockResolvedValue([{ status: 'open' }]),
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
  );
  const platformUsers = {
    upsert: jest.fn().mockResolvedValue({ id: 'pu-1' }),
    // По умолчанию — уже согласившийся человек: сам шлюз согласия
    // проверяется отдельными тестами ниже.
    hasConsented: jest.fn().mockResolvedValue(true),
  };
  // По умолчанию условия подписки нет (или оно выполнено).
  const subscriptions = {
    missingFor: jest.fn().mockResolvedValue([]),
    requiredChannels: jest.fn().mockResolvedValue([]),
  };
  const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn() };
  const audit = { record: jest.fn(), purgeExpired: jest.fn() };
  const service = new ContestParticipationService(
    prisma as unknown as PrismaService,
    platformUsers as unknown as PlatformUsersService,
    subscriptions as unknown as ContestSubscriptions,
    audit as never,
    logger as unknown as PinoLogger,
  );
  return { service, prisma, platformUsers, subscriptions, logger, audit };
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
  it('отменённый конкурс: отказ «отменён», анонс — без кнопки и с пометкой', async () => {
    const { service } = setup(contestRow({ status: 'cancelled' }));

    const outcome = await service.join(request());

    expect(outcome.status).toBe('not_open');
    expect(outcome.message).toMatch(/отменён/);
    expect(outcome.refresh).toMatchObject({ buttonText: null, finished: true });
    expect(outcome.refresh?.text).toMatch(/Текст анонса\n\nКонкурс отменён/);
  });

  it('старт бота по ссылке не собирает вид анонса — он не нужен', async () => {
    const { service, prisma } = setup();

    await service.startedFromLink(CONTEST_ID, request().user);

    // Счётчик участников под кнопкой считает только `announcementView`.
    expect(prisma.contestParticipant.count).not.toHaveBeenCalled();
  });

  it('повторное нажатие не шлёт вставки воронки повторно', async () => {
    const { service, prisma } = setup();
    prisma.contestParticipant.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await service.join(request());
    await service.join(request());

    // consented + already_joined — по разу, а не на каждое нажатие.
    expect(prisma.contestFunnelEvent.createMany).toHaveBeenCalledTimes(2);
  });

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

  it('без подписки на каналы-условия не записывает и называет, на что подписаться', async () => {
    const { service, prisma, platformUsers, subscriptions } = setup();
    subscriptions.missingFor.mockResolvedValue([
      { title: 'Новости', link: 'https://max.ru/join/abc' },
    ]);

    const outcome = await service.join(request());

    expect(outcome.status).toBe('not_subscribed');
    expect(outcome.message).toContain('• Новости');
    expect(outcome.missingChannels).toEqual([
      { title: 'Новости', link: 'https://max.ru/join/abc' },
    ]);
    // Пост под кнопкой перерисовывается как был — ответ на колбэк заменяет его.
    expect(outcome.refresh).toBeDefined();
    expect(platformUsers.upsert).not.toHaveBeenCalled();
    expect(prisma.contestParticipant.create).not.toHaveBeenCalled();
  });

  it('сбой проверки подписки — отказ «попробуйте позже», а не участие без проверки', async () => {
    const { service, prisma, subscriptions } = setup();
    subscriptions.missingFor.mockRejectedValue(new Error('MAX недоступен'));

    const outcome = await service.join(request());

    expect(outcome.status).toBe('subscription_check_failed');
    expect(prisma.contestParticipant.create).not.toHaveBeenCalled();
  });

  it('подписку проверяет только после согласия', async () => {
    const { service, platformUsers, subscriptions } = setup();
    platformUsers.hasConsented.mockResolvedValue(false);

    await service.join(request());

    expect(subscriptions.missingFor).not.toHaveBeenCalled();
  });

  it('пока идёт розыгрыш (строка конкурса занята), не пишет участника мимо пула', async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Raw query failed', {
        code: 'P2010',
        clientVersion: 'test',
        meta: {
          driverAdapterError: {
            name: 'DriverAdapterError',
            cause: { code: '55P03', kind: 'postgres' },
          },
        },
      }),
    );

    const outcome = await service.join(request());

    expect(outcome.status).toBe('not_open');
    expect(outcome.message).toContain('Нажмите ещё раз');
    expect(prisma.contestParticipant.create).not.toHaveBeenCalled();
  });

  it('если розыгрыш успел закрыть приём до записи — тоже отказ, а не участие', async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw.mockResolvedValue([{ status: 'drawn' }]);

    const outcome = await service.join(request());

    expect(outcome.status).toBe('not_open');
    expect(prisma.contestParticipant.create).not.toHaveBeenCalled();
  });

  it('«идёт розыгрыш» оставляет кнопку повтора только у конкурса с условием', async () => {
    // Человек мог прийти кнопкой «Проверить подписку» — ответ заменяет то
    // сообщение, и без клавиатуры «нажмите ещё раз» было бы нечем.
    const withCondition = setup();
    withCondition.prisma.$queryRaw.mockResolvedValue([{ status: 'drawn' }]);
    withCondition.subscriptions.requiredChannels.mockResolvedValue([
      { groupId: 'g', externalId: '-1', title: 'Канал' },
    ]);
    expect(
      (await withCondition.service.join(request())).missingChannels,
    ).toEqual([]);

    // Без условия «Проверить подписку» — про несуществующую проверку.
    const without = setup();
    without.prisma.$queryRaw.mockResolvedValue([{ status: 'drawn' }]);
    expect((await without.service.join(request())).missingChannels).toBe(
      undefined,
    );
  });

  it('сбой проверки подписки оставляет кнопку «Проверить подписку»', async () => {
    const { service, subscriptions } = setup();
    subscriptions.missingFor.mockRejectedValue(new Error('MAX недоступен'));

    const outcome = await service.join(request());

    expect(outcome.missingChannels).toEqual([]);
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
      finished: false,
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

  it('после даты завершения не записывает, даже если розыгрыш ещё не прошёл', async () => {
    // Сверка не успела или конкурс ждёт админа (мало подписанных) — опоздавший
    // не должен попасть в конкурс после объявленного конца.
    const { service, prisma } = setup(
      contestRow({ status: 'open', endsAt: new Date(Date.now() - 1000) }),
    );

    expect((await service.join(request())).status).toBe('not_open');
    expect(prisma.contestParticipant.create).not.toHaveBeenCalled();
  });

  it('конкурс, удалённый прямо во время нажатия, — «не найден», а не «идёт розыгрыш»', async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw.mockResolvedValue([]);

    const outcome = await service.join(request());

    expect(outcome.status).toBe('unknown_contest');
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
    winnerParticipant: {
      platform: 'max',
      externalUserId: '42',
      source: 'button',
    },
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

    it('без подписки отвечает списком каналов с кнопками «Подписаться» и «Проверить подписку»', async () => {
      const { service, subscriptions } = setup(
        contestRow({ status: 'open', prizes: [] }),
      );
      subscriptions.missingFor.mockResolvedValue([
        { title: 'Новости', link: 'https://max.ru/join/abc' },
        { title: 'Без ссылки', link: null },
      ]);

      const reply = await service.startedFromLink(CONTEST_ID, profile());

      expect(reply.joined).toBe(false);
      expect(reply.text).toContain('• Без ссылки');
      expect(reply.buttons).toEqual([
        [
          {
            type: 'link',
            text: 'Подписаться: Новости',
            url: 'https://max.ru/join/abc',
          },
        ],
        [
          {
            type: 'callback',
            text: 'Проверить подписку',
            payload: `contest:check:${CONTEST_ID}`,
          },
        ],
      ]);
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

    it('ручной участник с цифровым ником, совпавшим с id, — не этот человек', async () => {
      // `Иван @42` — ник «42», а нажал «Начать» человек с id 42.
      const { service } = setupDrawn([
        winner({
          winnerParticipant: {
            platform: 'max',
            externalUserId: '42',
            source: 'manual',
          },
        }),
      ]);

      const reply = await service.startedFromLink(CONTEST_ID, profile());

      expect(reply.text).not.toContain('Поздравляем');
      expect(reply.prizeIdsToMark).toEqual([]);
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

  it('после розыгрыша отдаёт вид итогов, а не «Участвовать (N)»', async () => {
    // Один вид на все перерисовки: запоздавшая правка счётчика и подмена
    // после розыгрыша пишут одно и то же, и итоги не затираются.
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
    prisma.postDelivery.findMany.mockResolvedValue([
      { externalMessageId: 'mid.1' },
    ]);

    const refresh = await service.announcementRefresh(CONTEST_ID);

    expect(refresh).toMatchObject({
      text: 'Текст анонса\n\nПобедители:\n1. Главный приз — Иван',
      buttonText: 'Узнать результаты',
      messageIds: ['mid.1'],
    });
    expect(prisma.contestParticipant.count).not.toHaveBeenCalled();
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

describe('contestButton', () => {
  it('у поста без конкурса — null', async () => {
    const { service } = setup();

    expect(
      await service.contestButton({
        ...contestRow().post,
        contest: null,
      } as never),
    ).toBeNull();
  });

  it('после розыгрыша правка поста получает итоги и «Узнать результаты»', async () => {
    // Иначе правка текста опубликованного конкурса возвращала кнопку
    // «Участвовать» и стирала победителей (найдено живой проверкой).
    const { service, prisma } = setup();
    prisma.contestPrize.findMany.mockResolvedValue([
      {
        place: 1,
        label: 'Главный приз',
        winnerParticipant: { displayName: 'Иван' },
      },
    ]);
    const { post, ...contest } = contestRow({
      status: 'drawn',
      publishResultsInPost: true,
    });

    const button = await service.contestButton({
      ...post,
      text: 'Исправленный текст',
      contest,
    } as never);

    expect(button).toEqual({
      contestId: CONTEST_ID,
      label: 'Узнать результаты',
      text: 'Исправленный текст\n\nПобедители:\n1. Главный приз — Иван',
    });
  });
});

describe('воронка участия', () => {
  const stages = (prisma: { contestFunnelEvent: { createMany: jest.Mock } }) =>
    (prisma.contestFunnelEvent.createMany.mock.calls as unknown[][]).map(
      (call) => (call[0] as { data: { stage: string }[] }).data[0].stage,
    );

  it('записанный проходит этапы «согласие» и «записан»', async () => {
    const { service, prisma } = setup();

    await service.join(request());

    expect(stages(prisma)).toEqual(['consented', 'joined']);
  });

  it('неподписанный — «согласие» и «не подписан», без «записан»', async () => {
    const { service, prisma, subscriptions } = setup();
    subscriptions.missingFor.mockResolvedValue([
      { title: 'Новости', link: null },
    ]);

    await service.join(request());

    expect(stages(prisma)).toEqual(['consented', 'not_subscribed']);
  });

  it('повторное нажатие не плодит строк: пропуск дублей и платформа в ключе', async () => {
    const { service, prisma } = setup();

    await service.join(request());

    const arg = (
      prisma.contestFunnelEvent.createMany.mock.calls as unknown[][]
    )[0][0] as {
      data: { platform: string }[];
      skipDuplicates: boolean;
    };
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data[0].platform).toBe('max');
  });

  it('после розыгрыша нажатие «Узнать результаты» не считается началом участия', async () => {
    const { service, prisma } = setup(contestRow({ status: 'drawn' }));

    await service.join(request());

    expect(stages(prisma)).toEqual([]);
  });

  it('кнопка без согласия — ни строки с id человека, ни счёта (счёт — у экрана согласия)', async () => {
    const { service, prisma, platformUsers } = setup();
    platformUsers.hasConsented.mockResolvedValue(false);

    expect((await service.join(request())).status).toBe('consent_required');
    await new Promise((resolve) => setImmediate(resolve));

    expect(stages(prisma)).toEqual([]);
    // Ответ ведёт по ссылке в бота, где старт посчитает `noteAnonymousStart`
    // — счёт и здесь дал бы двойной учёт.
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('noteAnonymousStart — один запрос, только у принимающего конкурса, отдельной строкой', async () => {
    const { service, prisma } = setup();

    service.noteAnonymousStart(CONTEST_ID);
    await new Promise((resolve) => setImmediate(resolve));

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const sql = (
      (prisma.$executeRaw.mock.calls as unknown[][])[0][0] as string[]
    ).join('?');
    expect(sql).toContain('"ContestAnonymousStarts"');
    // То же правило, что `isAcceptingEntries`: открыт и срок не прошёл.
    expect(sql).toContain("status = 'open'");
    expect(sql).toContain('"endsAt" IS NULL OR "endsAt" > now()');
    expect(prisma.contest.updateMany).not.toHaveBeenCalled();
    expect(stages(prisma)).toEqual([]);
  });

  it('конкурс удалили между проверкой и счётом — тихо (сырой SQL отдаёт P2010 с 23503)', async () => {
    const { service, prisma, logger } = setup();
    // Форма ошибки снята живьём с адаптера pg.
    prisma.$executeRaw.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('fk', {
        code: 'P2010',
        clientVersion: 'test',
        meta: {
          driverAdapterError: {
            name: 'DriverAdapterError',
            cause: { originalCode: '23503' },
          },
        },
      }),
    );

    service.noteAnonymousStart(CONTEST_ID);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('удалённый конкурс (кнопка под старым постом) — тихо, без предупреждения в лог', async () => {
    const { service, prisma, logger } = setup();
    prisma.contestFunnelEvent.createMany.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('fk', {
        code: 'P2003',
        clientVersion: 'test',
      }),
    );

    await service.join(request());
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('сбой записи события не мешает участию', async () => {
    const { service, prisma } = setup();
    prisma.contestFunnelEvent.createMany.mockRejectedValue(new Error('db'));

    expect((await service.join(request())).status).toBe('joined');
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

describe('ContestParticipationService.extendContest', () => {
  function extendSetup(row: { status: string; endsAt: Date | null }) {
    const ctx = setup();
    const prisma = ctx.prisma as unknown as Record<string, unknown>;
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([row]),
      contest: {
        update: jest.fn(({ data }: { data: { endsAt: Date } }) =>
          Promise.resolve({ title: 'Конкурс', endsAt: data.endsAt }),
        ),
      },
    };
    (prisma.$transaction as jest.Mock).mockImplementation(
      (fn: (t: typeof tx) => unknown) => fn(tx),
    );
    return { ...ctx, tx };
  }

  it('продлевает от прежнего срока и сбрасывает отметку предупреждения', async () => {
    const endsAt = new Date(Date.now() + 5 * 60 * 1000);
    const { service, tx, audit } = extendSetup({ status: 'open', endsAt });

    const result = await service.extendContest(CONTEST_ID, 1, 'admin-1');

    expect(result.endsAt.getTime()).toBe(
      endsAt.getTime() + 24 * 60 * 60 * 1000,
    );
    const { data } = (tx.contest.update.mock.calls as unknown[][])[0][0] as {
      data: { endWarningSentAt: unknown };
    };
    expect(data.endWarningSentAt).toBeNull();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'contest.extend' }),
    );
  });

  it('срок уже прошёл — продлевает от сейчас', async () => {
    const { service } = extendSetup({
      status: 'open',
      endsAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const result = await service.extendContest(CONTEST_ID, 3, 'admin-1');

    expect(result.endsAt.getTime()).toBeGreaterThan(
      Date.now() + 3 * 24 * 60 * 60 * 1000 - 5000,
    );
  });

  it('отменённый конкурс не продлевается', async () => {
    const { service, tx } = extendSetup({ status: 'cancelled', endsAt: null });

    await expect(
      service.extendContest(CONTEST_ID, 1, 'admin-1'),
    ).rejects.toMatchObject({ code: ErrorCode.CONTEST_ALREADY_DRAWN });
    expect(tx.contest.update).not.toHaveBeenCalled();
  });
});
