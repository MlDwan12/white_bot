import { Bot } from '@maxhub/max-bot-api';
import { PinoLogger } from 'nestjs-pino';
import { GroupsService, PublicGroup } from '../groups/groups.service';
import { MaxAdminResolver } from './max-admin.resolver';
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
    answerCallback: jest.fn().mockResolvedValue(undefined),
  };
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const handlers = new MaxBotHandlers(
    harness.bot,
    groups as unknown as GroupsService,
    admins as unknown as MaxAdminResolver,
    api as unknown as MaxApiClient,
    logger as unknown as PinoLogger,
  );
  handlers.register();
  return { harness, groups, admins, api, logger, handlers };
}

describe('MaxBotHandlers', () => {
  it('does nothing at all when no bot is configured', () => {
    const logger = { setContext: jest.fn() } as unknown as PinoLogger;
    const handlers = new MaxBotHandlers(
      null,
      {} as GroupsService,
      {} as MaxAdminResolver,
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
});
