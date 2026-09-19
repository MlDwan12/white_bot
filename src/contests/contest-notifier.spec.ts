import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { MaxApiClient } from '../max/max-api.client';
import { MaxAdminResolver } from '../max/max-admin.resolver';
import { ContestNotifier } from './contest-notifier';
import { ContestParticipationService } from './contest-participation.service';

const CONTEST_ID = '11111111-1111-4111-8111-111111111111';

/** Reads one argument of a recorded call as `T` — the mock itself is untyped. */
function callArg<T>(mockFn: jest.Mock, callIndex = 0, argIndex = 0): T {
  return (mockFn.mock.calls as unknown[][])[callIndex][argIndex] as T;
}

const winnerPrize = (overrides: Record<string, unknown> = {}) => ({
  id: 'prize-1',
  place: 1,
  label: 'Главный приз',
  winnerParticipant: {
    platform: 'max',
    externalUserId: '42',
    displayName: 'Иван',
  },
  ...overrides,
});

function setup(
  options: { notifyWinners?: boolean; publishResultsInPost?: boolean } = {},
) {
  const contestWithPost = {
    id: CONTEST_ID,
    title: 'Конкурс',
    resultsButtonLabel: 'Узнать результаты',
    notifyWinners: options.notifyWinners ?? true,
    publishResultsInPost: options.publishResultsInPost ?? false,
    post: {
      text: 'Анонс',
      vkTextOverride: null,
      maxTextOverride: null,
      deliveries: [
        { id: 'd1', externalMessageId: 'mid.1', group: { title: 'Канал' } },
      ],
    },
  };

  const prisma = {
    contest: { findUnique: jest.fn().mockResolvedValue(contestWithPost) },
    contestPrize: {
      findMany: jest.fn().mockResolvedValue([winnerPrize()]),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const max = {
    editMessage: jest.fn().mockResolvedValue(undefined),
    sendMessageToUser: jest.fn().mockResolvedValue({ messageId: 'm1' }),
    getMessageBody: jest.fn().mockResolvedValue({
      text: 'Анонс',
      attachments: [{ type: 'image', payload: { token: 'tok' } }],
      unsupported: [],
    }),
  };
  const admins = {
    listNotifiableAdmins: jest
      .fn()
      .mockResolvedValue([{ id: 'a1', maxUserId: '7' }]),
  };
  const participation = {
    winnersList: jest.fn().mockResolvedValue('1. Главный приз — Иван'),
  };
  const logger = { setContext: jest.fn(), warn: jest.fn(), info: jest.fn() };

  const notifier = new ContestNotifier(
    prisma as unknown as PrismaService,
    max as unknown as MaxApiClient,
    admins as unknown as MaxAdminResolver,
    participation as unknown as ContestParticipationService,
    logger as unknown as PinoLogger,
  );
  return { notifier, prisma, max, admins, logger };
}

/** The status written for a prize by the notification pass. */
const notifyStatusOf = (prisma: ReturnType<typeof setup>['prisma']) =>
  callArg<{ data: { notifyStatus: string } }>(prisma.contestPrize.update).data
    .notifyStatus;

describe('ContestNotifier', () => {
  it('swaps the button to the results label', async () => {
    const { notifier, max } = setup();

    await notifier.announceResults(CONTEST_ID);

    const [messageId, text, options] = max.editMessage.mock.calls[0] as [
      string,
      string,
      { buttons: { text: string }[][]; attachments: { type: string }[] },
    ];
    expect(messageId).toBe('mid.1');
    expect(text).toBe('Анонс');
    expect(options.buttons[0][0].text).toBe('Узнать результаты');
    // Правка заменяет сообщение целиком: без переданного медиа картинка
    // анонса исчезла бы у всех подписчиков.
    expect(options.attachments).toEqual([
      { type: 'image', payload: { token: 'tok' } },
    ]);
  });

  it('appends the winners to the post when publishing is on', async () => {
    const { notifier, max } = setup({ publishResultsInPost: true });

    await notifier.announceResults(CONTEST_ID);

    // A DM reaches only people who already wrote to the bot; the post is the
    // one channel every subscriber can see.
    const [, text] = max.editMessage.mock.calls[0] as [string, string];
    expect(text).toContain('Анонс');
    expect(text).toContain('1. Главный приз — Иван');
  });

  it('still notifies the winner when the button swap fails', async () => {
    const { notifier, max, prisma } = setup();
    max.editMessage.mockRejectedValue(new Error('too old'));

    await notifier.announceResults(CONTEST_ID);

    // The draw is already recorded; a stale message must not cost the winner
    // their notification.
    expect(max.sendMessageToUser).toHaveBeenCalled();
    expect(notifyStatusOf(prisma)).toBe('sent');
  });

  it('marks the winner for manual contact when auto-notification is off', async () => {
    const { notifier, max, prisma } = setup({ notifyWinners: false });

    await notifier.announceResults(CONTEST_ID);

    expect(max.sendMessageToUser).not.toHaveBeenCalledWith(
      42,
      expect.anything(),
    );
    expect(notifyStatusOf(prisma)).toBe('manual_required');
  });

  it('marks a winner with no platform id as manual rather than failing quietly', async () => {
    const { notifier, prisma } = setup();
    prisma.contestPrize.findMany.mockResolvedValue([
      winnerPrize({
        winnerParticipant: {
          platform: 'max',
          externalUserId: null,
          displayName: 'Анна',
        },
      }),
    ]);

    await notifier.announceResults(CONTEST_ID);

    expect(notifyStatusOf(prisma)).toBe('manual_required');
  });

  it('marks an undelivered DM as manual and records why', async () => {
    const { notifier, max, prisma } = setup();
    max.sendMessageToUser.mockRejectedValueOnce(new Error('нет диалога'));

    await notifier.announceResults(CONTEST_ID);

    const { data } = callArg<{
      data: { notifyStatus: string; notifyError: string };
    }>(prisma.contestPrize.update);
    // MAX refuses a bot's first message to someone who never opened a dialog
    // with it, so this is an expected outcome — and the winner must stay
    // visible instead of being silently dropped.
    expect(data.notifyStatus).toBe('manual_required');
    expect(data.notifyError).toBe('нет диалога');
  });

  it('only notifies winners who have not been told yet', async () => {
    const { notifier, prisma } = setup();

    await notifier.announceResults(CONTEST_ID);

    // After a manual override this runs again; re-congratulating everyone
    // would spam the winners who already heard at the draw.
    const { where } = callArg<{ where: { notifyStatus: string } }>(
      prisma.contestPrize.findMany,
    );
    expect(where.notifyStatus).toBe('pending');
  });

  it('tells the admins when a winner was replaced by hand', async () => {
    const { notifier, max } = setup();

    await notifier.announceResults(CONTEST_ID, 'override');

    const adminCall = max.sendMessageToUser.mock.calls.find(
      ([userId]) => userId === 7,
    ) as [number, string];
    expect(adminCall[1]).toContain('победитель изменён вручную');
  });

  it('reports the finished contest to the admins', async () => {
    const { notifier, max } = setup();

    await notifier.announceResults(CONTEST_ID);

    const adminCall = max.sendMessageToUser.mock.calls.find(
      ([userId]) => userId === 7,
    ) as [number, string];
    expect(adminCall[1]).toContain('Конкурс «Конкурс» завершён');
    expect(adminCall[1]).toContain('Канал');
    expect(adminCall[1]).toContain('1. Главный приз — Иван');
  });

  it('warns rather than throws when no admin can be reached', async () => {
    const { notifier, admins, logger } = setup();
    admins.listNotifiableAdmins.mockResolvedValue([]);

    await expect(notifier.announceResults(CONTEST_ID)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
