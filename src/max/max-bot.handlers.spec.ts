import { Bot } from '@maxhub/max-bot-api';
import { PinoLogger } from 'nestjs-pino';
import { GroupsService, PublicGroup } from '../groups/groups.service';
import { MaxAdminResolver } from './max-admin.resolver';
import { ContestParticipationService } from '../contests/contest-participation.service';
import { MaxApiClient } from './max-api.client';
import { MaxBotHandlers, groupReviewPayload } from './max-bot.handlers';

const GROUP_ID = '11111111-2222-3333-4444-555555555555';

/** See the same helper in max-api.client.spec.ts — `mock.calls` is `any[][]`. */
function callArg<T>(mockFn: jest.Mock, callIndex: number, argIndex: number): T {
  const calls = mockFn.mock.calls as unknown[][];
  return calls[callIndex][argIndex] as T;
}

type Handler = (ctx: unknown) => Promise<void>;

/** Captures what `register()` wires up so handlers can be driven directly. */
function fakeBot() {
  const on = new Map<string, Handler>();
  const commands = new Map<string, Handler>();
  const actions: { pattern: RegExp; handler: Handler }[] = [];
  const onCatch = jest.fn();
  const bot = {
    catch: onCatch,
    command: (name: string, handler: Handler) => commands.set(name, handler),
    on: (type: string, handler: Handler) => on.set(type, handler),
    action: (pattern: RegExp, handler: Handler) =>
      actions.push({ pattern, handler }),
  } as unknown as Bot;

  return {
    bot,
    onCatch,
    fire: (type: string, ctx: unknown) => on.get(type)!(ctx),
    fireCommand: (name: string, ctx: unknown) => commands.get(name)!(ctx),
    /** Mimics the SDK: match the payload, then hand the match to the handler. */
    fireAction: (payload: string, ctx: Record<string, unknown>) => {
      for (const { pattern, handler } of actions) {
        const match = pattern.exec(payload);
        if (match) {
          return handler({ ...ctx, match });
        }
      }
      throw new Error(`Нет обработчика для payload ${payload}`);
    },
  };
}

function publicGroup(overrides: Partial<PublicGroup> = {}): PublicGroup {
  return {
    id: GROUP_ID,
    platform: 'max',
    kind: 'chat',
    externalId: '500',
    title: 'Тестовый чат',
    tokenMask: null,
    tags: [],
    status: 'pending_confirmation',
    createdAt: new Date(),
    ...overrides,
  };
}

function setup() {
  const harness = fakeBot();
  const groups = {
    createOrReactivateMaxDraft: jest.fn().mockResolvedValue(publicGroup()),
    markMaxGroupBotRemoved: jest.fn().mockResolvedValue(true),
    confirmMaxGroup: jest.fn().mockResolvedValue(publicGroup()),
    rejectMaxGroup: jest.fn().mockResolvedValue(undefined),
  };
  const admins = {
    findByMaxUserId: jest.fn().mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
      role: 'developer',
      maxUserId: '777',
    }),
    listNotifiableAdmins: jest
      .fn()
      .mockResolvedValue([{ id: 'admin-1', maxUserId: '777' }]),
  };
  const api = {
    getChat: jest.fn().mockResolvedValue({
      externalId: '500',
      title: 'Тестовый чат',
      kind: 'chat',
    }),
    sendMessageToUser: jest.fn().mockResolvedValue({ messageId: 'm1' }),
    sendMessageToChat: jest.fn().mockResolvedValue({ messageId: 'm1' }),
    getMessageBody: jest.fn().mockResolvedValue({
      text: 'Анонс',
      attachments: [{ type: 'image', payload: { token: 'tok' } }],
      unsupported: [],
    }),
    editMessage: jest.fn().mockResolvedValue(undefined),
    answerCallback: jest.fn().mockResolvedValue(undefined),
    botUsername: jest.fn().mockReturnValue('test_bot'),
  };
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const contests = {
    join: jest.fn().mockResolvedValue({
      status: 'joined',
      message: 'Вы участвуете в конкурсе!',
    }),
    startedFromLink: jest.fn().mockResolvedValue({
      text: 'Вы участвуете! Итоги пришлю сюда.',
      prizeIdsToMark: [],
      joined: false,
    }),
    announcementRefresh: jest.fn().mockResolvedValue({
      text: 'Анонс',
      buttonText: 'Участвовать (5)',
      payload: 'contest:join:x',
      messageIds: ['mid.1', 'mid.2'],
    }),
    markWinnersNotified: jest.fn().mockResolvedValue(undefined),
  };

  const handlers = new MaxBotHandlers(
    harness.bot,
    groups as unknown as GroupsService,
    admins as unknown as MaxAdminResolver,
    contests as unknown as ContestParticipationService,
    api as unknown as MaxApiClient,
    logger as unknown as PinoLogger,
  );
  handlers.register();
  return { harness, groups, admins, contests, api, logger, handlers };
}

describe('MaxBotHandlers', () => {
  it('does nothing at all when no bot is configured', () => {
    const logger = { setContext: jest.fn() } as unknown as PinoLogger;
    const handlers = new MaxBotHandlers(
      null,
      {} as GroupsService,
      {} as MaxAdminResolver,
      {} as ContestParticipationService,
      {} as MaxApiClient,
      logger,
    );
    expect(() => handlers.register()).not.toThrow();
  });

  it('installs an error handler, or one thrown handler would kill polling', () => {
    const { harness, logger } = setup();
    expect(harness.onCatch).toHaveBeenCalled();

    // A handler that throws must be logged and swallowed here — left
    // unhandled it would propagate into the polling loop and stop it,
    // taking every future update with it.
    const onError = callArg<
      (err: unknown, ctx: { updateType: string }) => void
    >(harness.onCatch, 0, 0);
    onError(new Error('сломалось'), { updateType: 'message_created' });
    expect(logger.error).toHaveBeenCalled();
  });

  describe('bot_added', () => {
    it('fetches the title MAX omits from the event and notifies admins', async () => {
      const { harness, groups, api } = setup();

      await harness.fire('bot_added', {
        chatId: 500,
        update: { is_channel: false },
      });

      expect(api.getChat).toHaveBeenCalledWith(500);
      expect(groups.createOrReactivateMaxDraft).toHaveBeenCalledWith({
        externalId: '500',
        kind: 'chat',
        title: 'Тестовый чат',
      });
      expect(callArg<number>(api.sendMessageToUser, 0, 0)).toBe(777);
      const options = callArg<{ buttons: unknown[][] }>(
        api.sendMessageToUser,
        0,
        2,
      );
      expect(options.buttons[0]).toEqual([
        expect.objectContaining({
          payload: groupReviewPayload('confirm', GROUP_ID),
        }),
        expect.objectContaining({
          payload: groupReviewPayload('reject', GROUP_ID),
        }),
      ]);
    });

    it('trusts the chat record over the event flag when classifying a channel', async () => {
      const { harness, groups, api } = setup();
      api.getChat.mockResolvedValue({
        externalId: '500',
        title: 'Канал',
        kind: 'channel',
      });

      await harness.fire('bot_added', {
        chatId: 500,
        update: { is_channel: false },
      });

      expect(groups.createOrReactivateMaxDraft).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'channel' }),
      );
    });

    it('does not let a stale is_channel flag turn a group chat into a channel', async () => {
      const { harness, groups, api, logger } = setup();
      api.getChat.mockResolvedValue({
        externalId: '500',
        title: 'Чат',
        kind: 'chat',
      });

      await harness.fire('bot_added', {
        chatId: 500,
        update: { is_channel: true },
      });

      expect(groups.createOrReactivateMaxDraft).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'chat' }),
      );
      // The disagreement is worth knowing about rather than silently resolving.
      expect(logger.warn).toHaveBeenCalled();
    });

    it('never turns a 1:1 dialog into a delivery target', async () => {
      const { harness, groups, api } = setup();
      api.getChat.mockResolvedValue({
        externalId: '500',
        title: 'Диалог',
        kind: 'dialog',
      });

      await harness.fire('bot_added', {
        chatId: 500,
        update: { is_channel: false },
      });

      expect(groups.createOrReactivateMaxDraft).not.toHaveBeenCalled();
    });

    it('does not re-ask for confirmation when a known group is reactivated', async () => {
      const { harness, api, groups } = setup();
      groups.createOrReactivateMaxDraft.mockResolvedValue(
        publicGroup({ status: 'active' }),
      );

      await harness.fire('bot_added', {
        chatId: 500,
        update: { is_channel: false },
      });

      expect(api.sendMessageToUser).not.toHaveBeenCalled();
    });

    it('still saves the draft when the admin cannot be messaged', async () => {
      const { harness, api, groups, logger } = setup();
      api.sendMessageToUser.mockRejectedValue(new Error('chat not found'));

      // MAX refuses a bot's first message to a user who never opened a
      // dialog with it — expected, and must not lose the group.
      await expect(
        harness.fire('bot_added', {
          chatId: 500,
          update: { is_channel: false },
        }),
      ).resolves.toBeUndefined();
      expect(groups.createOrReactivateMaxDraft).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  it('marks the group bot_removed when the bot is kicked out', async () => {
    const { harness, groups } = setup();

    await harness.fire('bot_removed', { chatId: 500 });

    expect(groups.markMaxGroupBotRemoved).toHaveBeenCalledWith('500');
  });

  describe('group review buttons', () => {
    it('confirms the group and replaces the prompt with the outcome', async () => {
      const { harness, groups, api } = setup();

      await harness.fireAction(groupReviewPayload('confirm', GROUP_ID), {
        user: { user_id: 777 },
        callback: { callback_id: 'cb-1' },
      });

      expect(groups.confirmMaxGroup).toHaveBeenCalledWith(GROUP_ID);
      expect(api.answerCallback).toHaveBeenCalledWith(
        'cb-1',
        expect.stringContaining('Тестовый чат'),
      );
    });

    it('rejects the group when the reject button is pressed', async () => {
      const { harness, groups } = setup();

      await harness.fireAction(groupReviewPayload('reject', GROUP_ID), {
        user: { user_id: 777 },
        callback: { callback_id: 'cb-1' },
      });

      expect(groups.rejectMaxGroup).toHaveBeenCalledWith(GROUP_ID);
    });

    it('ignores a stranger without revealing that the button means anything', async () => {
      const { harness, groups, admins, api } = setup();
      admins.findByMaxUserId.mockResolvedValue(null);

      await harness.fireAction(groupReviewPayload('confirm', GROUP_ID), {
        user: { user_id: 999 },
        callback: { callback_id: 'cb-1' },
      });

      expect(groups.confirmMaxGroup).not.toHaveBeenCalled();
      // Still acknowledged, or the stranger's client spins forever.
      expect(api.answerCallback).toHaveBeenCalledWith('cb-1');
    });

    it('acknowledges the click even when the decision can no longer be applied', async () => {
      const { harness, groups, api } = setup();
      groups.confirmMaxGroup.mockRejectedValue(new Error('уже обработана'));

      await expect(
        harness.fireAction(groupReviewPayload('confirm', GROUP_ID), {
          user: { user_id: 777 },
          callback: { callback_id: 'cb-1' },
        }),
      ).resolves.toBeUndefined();
      expect(api.answerCallback).toHaveBeenCalledWith(
        'cb-1',
        expect.stringContaining('Не удалось'),
      );
    });

    it('does not match a payload that only looks like a review callback', () => {
      const { harness } = setup();
      // A non-uuid id must not reach confirmMaxGroup at all.
      expect(() =>
        harness.fireAction('group:confirm:not-a-uuid', {}),
      ).toThrow();
    });
  });

  describe('/start', () => {
    it('reports the sender id so the first admin can be seeded', async () => {
      const { harness, admins, api } = setup();
      admins.findByMaxUserId.mockResolvedValue(null);

      await harness.fireCommand('start', {
        chatId: 42,
        message: { sender: { user_id: 999 } },
      });

      expect(api.sendMessageToChat).toHaveBeenCalledWith(
        42,
        expect.stringContaining('999'),
      );
    });

    it('greets a linked admin by the account it resolved', async () => {
      const { harness, api } = setup();

      await harness.fireCommand('start', {
        chatId: 42,
        message: { sender: { user_id: 777 } },
      });

      expect(api.sendMessageToChat).toHaveBeenCalledWith(
        42,
        expect.stringContaining('admin@example.com'),
      );
    });

    it('ignores a channel post that carries no sender', async () => {
      const { harness, api } = setup();

      await harness.fireCommand('start', { chatId: 42, message: {} });

      expect(api.sendMessageToChat).not.toHaveBeenCalled();
    });
  });

  describe('bot_started по ссылке с кнопки конкурса', () => {
    const CONTEST = '11111111-1111-4111-8111-111111111111';
    const started = (payload: string | null | undefined) => ({
      update: {
        payload,
        user: { user_id: 42, first_name: 'Иван', last_name: 'Иванов' },
        chat_id: 900,
      },
    });

    it('записывает участника и отвечает в открытом диалоге', async () => {
      const { harness, api, contests } = setup();

      await harness.fire('bot_started', started(`c_${CONTEST}`));

      expect(contests.startedFromLink).toHaveBeenCalledWith(
        CONTEST,
        expect.objectContaining({
          externalUserId: '42',
          displayName: 'Иван',
          lastName: 'Иванов',
        }),
      );
      expect(api.sendMessageToChat).toHaveBeenCalledWith(
        900,
        'Вы участвуете! Итоги пришлю сюда.',
      );
    });

    it('после записи обновляет счётчик и возвращает картинку анонса', async () => {
      // Правка заменяет сообщение целиком: без переданного медиа картинка
      // исчезла бы у всех подписчиков.
      const { harness, api, contests } = setup();
      contests.startedFromLink.mockResolvedValue({
        text: 'Вы участвуете!',
        prizeIdsToMark: [],
        joined: true,
      });

      await harness.fire('bot_started', started(`c_${CONTEST}`));

      expect(contests.announcementRefresh).toHaveBeenCalledWith(CONTEST);
      expect(api.editMessage).toHaveBeenCalledTimes(2);
      const [id, text, options] = api.editMessage.mock.calls[0] as [
        string,
        string,
        { buttons: unknown; attachments: unknown },
      ];
      expect(id).toBe('mid.1');
      expect(text).toBe('Анонс');
      expect(options.attachments).toEqual([
        { type: 'image', payload: { token: 'tok' } },
      ]);
      expect(options.buttons).toEqual([
        [
          {
            type: 'link',
            text: 'Участвовать (5)',
            url: `https://max.ru/test_bot?start=c_${CONTEST}`,
          },
        ],
      ]);
    });

    it('без новой записи посты не перерисовываются', async () => {
      // Повторный старт по ссылке — обычное дело; правка сообщения ничего бы
      // не дала, зато стоила бы запросов.
      const { harness, api, contests } = setup();

      await harness.fire('bot_started', started(`c_${CONTEST}`));

      expect(contests.announcementRefresh).not.toHaveBeenCalled();
      expect(api.editMessage).not.toHaveBeenCalled();
    });

    it('сбой правки одного сообщения не мешает остальным и не роняет обработчик', async () => {
      const { harness, api, contests } = setup();
      contests.startedFromLink.mockResolvedValue({
        text: 'Вы участвуете!',
        prizeIdsToMark: [],
        joined: true,
      });
      api.editMessage.mockRejectedValueOnce(new Error('too old'));

      await harness.fire('bot_started', started(`c_${CONTEST}`));

      expect(api.editMessage).toHaveBeenCalledTimes(2);
    });

    it('параллельные вступления сводятся к одному проходу со свежими данными', async () => {
      // Правки от разных участников не должны идти вперемешку: запоздавшая
      // откатила бы счётчик назад, а число запросов росло бы с числом
      // нажавших.
      const { harness, api, contests } = setup();
      contests.startedFromLink.mockResolvedValue({
        text: 'ok',
        prizeIdsToMark: [],
        joined: true,
      });
      const refresh = (count: number) => ({
        text: 'Анонс',
        buttonText: `Участвовать (${count})`,
        payload: 'p',
        messageIds: ['mid.1'],
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      contests.announcementRefresh
        .mockImplementationOnce(async () => {
          await gate;
          return refresh(4);
        })
        .mockResolvedValue(refresh(5));

      const first = harness.fire('bot_started', started(`c_${CONTEST}`));
      const second = harness.fire('bot_started', started(`c_${CONTEST}`));
      // Второй не ждёт первого: он лишь помечает «нужен ещё проход».
      await second;
      expect(api.editMessage).not.toHaveBeenCalled();

      release();
      await first;

      expect(contests.announcementRefresh).toHaveBeenCalledTimes(2);
      const lastCall = api.editMessage.mock.calls.at(-1) as [
        string,
        string,
        { buttons: { text: string }[][] },
      ];
      // Последней ушла свежая версия — счётчик не откатился на 4.
      expect(lastCall[2].buttons[0][0].text).toBe('Участвовать (5)');
    });

    it('помечает места уведомлёнными после успешной отправки', async () => {
      const { harness, contests } = setup();
      contests.startedFromLink.mockResolvedValue({
        text: 'Поздравляем!',
        prizeIdsToMark: ['prize-1'],
      });

      await harness.fire('bot_started', started(`c_${CONTEST}`));

      expect(contests.markWinnersNotified).toHaveBeenCalledWith(['prize-1']);
    });

    it('не помечает место уведомлённым, если отправка не удалась', async () => {
      // Иначе победитель числился бы поздравленным, не получив ничего, и
      // пометки «напишите сами» в панели уже не было бы.
      const { harness, api, contests } = setup();
      contests.startedFromLink.mockResolvedValue({
        text: 'Поздравляем!',
        prizeIdsToMark: ['prize-1'],
      });
      api.sendMessageToChat.mockRejectedValue(new Error('boom'));

      await harness.fire('bot_started', started(`c_${CONTEST}`));

      expect(contests.markWinnersNotified).not.toHaveBeenCalled();
    });

    it('обновляет счётчик, даже если ответить в диалоге не вышло', async () => {
      // Участие уже записано, и пост без свежего счётчика был бы неправдой.
      const { harness, api, contests } = setup();
      contests.startedFromLink.mockResolvedValue({
        text: 'Вы участвуете!',
        prizeIdsToMark: [],
        joined: true,
      });
      api.sendMessageToChat.mockRejectedValue(new Error('boom'));

      await harness.fire('bot_started', started(`c_${CONTEST}`));

      expect(api.editMessage).toHaveBeenCalledTimes(2);
    });

    it('молчит на старт без метки и на чужую метку', async () => {
      const { harness, api, contests } = setup();

      await harness.fire('bot_started', started(null));
      await harness.fire('bot_started', started('ref_partner'));
      await harness.fire('bot_started', started('c_not-a-uuid'));

      expect(contests.startedFromLink).not.toHaveBeenCalled();
      expect(api.sendMessageToChat).not.toHaveBeenCalled();
    });

    it('сбой сервиса не роняет обработчик, а человеку отвечают, что делать', async () => {
      // Кнопка — ссылка, и без слова от бота человек видит пустой диалог и
      // не знает, записан ли он. Повторное нажатие безопасно, так что о нём
      // и просим.
      const { harness, api, contests, logger } = setup();
      contests.startedFromLink.mockRejectedValue(new Error('db down'));

      await expect(
        harness.fire('bot_started', started(`c_${CONTEST}`)),
      ).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalled();
      expect(api.sendMessageToChat).toHaveBeenCalledWith(
        900,
        expect.stringContaining('ещё раз'),
      );
      expect(api.editMessage).not.toHaveBeenCalled();
    });
  });

  describe('ответ на нажатие «Участвовать» в старом посте', () => {
    const CONTEST = '11111111-1111-4111-8111-111111111111';

    it('переводит пост на кнопку-ссылку, а не оставляет две разные кнопки', async () => {
      const { harness, api, contests } = setup();
      contests.join.mockResolvedValue({
        status: 'joined',
        message: 'Вы участвуете в конкурсе!',
        refresh: {
          text: 'Анонс',
          buttonText: 'Участвовать (1)',
          payload: `contest:join:${CONTEST}`,
        },
      });

      await harness.fireAction(`contest:join:${CONTEST}`, {
        user: { user_id: 42, first_name: 'Иван' },
        callback: { callback_id: 'cb-1' },
        chatId: 900,
        update: { message: { body: { attachments: [] } } },
      });

      const [, replacement] = api.answerCallback.mock.calls[0] as [
        string,
        { buttons: unknown },
      ];
      expect(replacement.buttons).toEqual([
        [
          {
            type: 'link',
            text: 'Участвовать (1)',
            url: `https://max.ru/test_bot?start=c_${CONTEST}`,
          },
        ],
      ]);
    });
  });
});
