import { Bot } from '@maxhub/max-bot-api';
import { AppException } from '../common/app-exception';
import { MaxApiClient, toMaxApiError } from './max-api.client';
import { MaxApiError } from './max-api.error';
import { classifyDeliveryError } from '../posts/delivery-outcome';
import { sleep } from '../common/sleep';

// Паузы ожидания обработки видео в тестах не ждём по-настоящему.
jest.mock('../common/sleep', () => ({
  sleep: jest.fn().mockResolvedValue(undefined),
}));

function fakeBot(api: Record<string, unknown>): Bot {
  return { api } as unknown as Bot;
}

/** Reads one argument of a recorded call as `T` — `mock.calls` is `any[][]`,
 * which trips the type-aware lint rules when indexed directly. */
function callArg<T>(mockFn: jest.Mock, callIndex: number, argIndex: number): T {
  const calls = mockFn.mock.calls as unknown[][];
  return calls[callIndex][argIndex] as T;
}

function message(mid: string) {
  return { body: { mid } };
}

describe('MaxApiClient', () => {
  it('reports itself unconfigured and fails cleanly without a bot token', async () => {
    const client = new MaxApiClient(null);

    expect(client.configured).toBe(false);
    // A missing token must surface as our domain error, not a raw
    // TypeError on a null reference.
    await expect(client.sendMessageToChat(1, 'hi')).rejects.toBeInstanceOf(
      AppException,
    );
  });

  it('returns the message id the delivery pipeline stores as externalMessageId', async () => {
    const sendMessageToChat = jest.fn().mockResolvedValue(message('mid-42'));
    const client = new MaxApiClient(fakeBot({ sendMessageToChat }));

    await expect(client.sendMessageToChat(7, 'текст')).resolves.toEqual({
      messageId: 'mid-42',
    });
    expect(sendMessageToChat).toHaveBeenCalledWith(7, 'текст', {});
  });

  it('sends buttons as an inline_keyboard attachment, which is the only way MAX takes them', async () => {
    const sendMessageToUser = jest.fn().mockResolvedValue(message('mid-1'));
    const client = new MaxApiClient(fakeBot({ sendMessageToUser }));

    await client.sendMessageToUser(5, 'вопрос', {
      buttons: [[{ type: 'callback', text: 'Да', payload: 'yes' }]],
    });

    expect(sendMessageToUser).toHaveBeenCalledWith(5, 'вопрос', {
      attachments: [
        {
          type: 'inline_keyboard',
          payload: {
            buttons: [[{ type: 'callback', text: 'Да', payload: 'yes' }]],
          },
        },
      ],
    });
  });

  it('keeps media attachments alongside the keyboard instead of replacing them', async () => {
    const sendMessageToChat = jest.fn().mockResolvedValue(message('mid-1'));
    const client = new MaxApiClient(fakeBot({ sendMessageToChat }));
    const photo = { type: 'image', payload: { token: 'tok' } } as never;

    await client.sendMessageToChat(1, 'текст', {
      attachments: [photo],
      buttons: [[{ type: 'callback', text: 'Да', payload: 'yes' }]],
    });

    const extra = callArg<{ attachments: unknown[] }>(sendMessageToChat, 0, 2);
    expect(extra.attachments).toHaveLength(2);
    expect(extra.attachments[0]).toBe(photo);
  });

  it('omits attachments entirely when sending a fresh message without any', async () => {
    const sendMessageToChat = jest.fn().mockResolvedValue(message('mid-1'));
    const client = new MaxApiClient(fakeBot({ sendMessageToChat }));

    await client.sendMessageToChat(1, 'текст');

    expect(sendMessageToChat).toHaveBeenCalledWith(1, 'текст', {});
  });

  it('always sends an explicit attachments field when editing, even empty', async () => {
    // Живой факт про MAX: PUT /messages без поля `attachments` оставляет
    // прежние вложения как есть, а не опускает их. Опустить поле здесь —
    // значит не суметь снять картинку с уже опубликованного поста.
    const editMessage = jest.fn().mockResolvedValue({});
    const client = new MaxApiClient(fakeBot({ editMessage }));

    await client.editMessage('mid-1', 'новый текст');

    expect(editMessage).toHaveBeenCalledWith('mid-1', {
      text: 'новый текст',
      attachments: [],
    });
  });

  it('edits with the given attachments and keyboard together', async () => {
    const editMessage = jest.fn().mockResolvedValue({});
    const client = new MaxApiClient(fakeBot({ editMessage }));
    const photo = { type: 'image', payload: { token: 'tok' } } as never;

    await client.editMessage('mid-1', 'текст', {
      attachments: [photo],
      buttons: [[{ type: 'callback', text: 'Да', payload: 'yes' }]],
    });

    const extra = callArg<{ attachments: unknown[] }>(editMessage, 0, 1);
    expect(extra.attachments).toHaveLength(2);
    expect(extra.attachments[0]).toBe(photo);
  });

  it('falls back to an identifiable title when MAX returns none', async () => {
    const getChat = jest
      .fn()
      .mockResolvedValue({ chat_id: 99, type: 'chat', title: null });
    const client = new MaxApiClient(fakeBot({ getChat }));

    // Group.title is non-nullable, so an empty string would write a
    // nameless group into the admin's list.
    await expect(client.getChat(99)).resolves.toEqual({
      externalId: '99',
      title: 'Чат 99',
      kind: 'chat',
      link: null,
    });
  });

  it('asks MAX which of the given users are members, in batches of 100', async () => {
    const getChatMembers = jest.fn(
      (_chatId: number, { user_ids }: { user_ids: number[] }) =>
        Promise.resolve({
          // Состоит только первый из каждой пачки.
          members: [{ user_id: user_ids[0] }],
        }),
    );
    const client = new MaxApiClient(fakeBot({ getChatMembers }));
    const ids = Array.from({ length: 150 }, (_, i) => i + 1);

    const members = await client.chatMemberIds(-100, ids);

    expect(getChatMembers).toHaveBeenCalledTimes(2);
    expect(
      callArg<{ user_ids: number[] }>(getChatMembers, 1, 1).user_ids,
    ).toHaveLength(50);
    expect([...members]).toEqual(['1', '101']);
  });

  it('replaces the prompt when answering a callback, since MAX has no toast', async () => {
    const answerOnCallback = jest.fn().mockResolvedValue({ success: true });
    const client = new MaxApiClient(fakeBot({ answerOnCallback }));

    await client.answerCallback('cb-1', 'Готово');
    // Ответ — это правка сообщения: пустой список вложений уходит явно, иначе
    // прежняя клавиатура («Проверить подписку», «Подтвердить») осталась бы
    // под новым текстом.
    expect(answerOnCallback).toHaveBeenCalledWith('cb-1', {
      message: { text: 'Готово', attachments: [] },
    });

    await client.answerCallback('cb-2');
    expect(answerOnCallback).toHaveBeenLastCalledWith('cb-2', {});
  });

  describe('waitForVideoReady', () => {
    const info = (width: number, duration: number) => ({ width, duration });

    it('опрашивает GET /videos/{token}, пока у видео не появятся размеры и длительность', async () => {
      const get = jest
        .fn()
        .mockResolvedValueOnce(info(0, 0))
        .mockResolvedValueOnce(info(0, 0))
        .mockResolvedValue(info(1280, 7000));
      const client = new MaxApiClient(fakeBot({ raw: { get } }));
      (sleep as jest.Mock).mockClear();

      await client.waitForVideoReady('tok');

      expect(get).toHaveBeenCalledTimes(3);
      // Токен — в пути: `getVideoInfo` из SDK кладёт его в query и ловит 404.
      expect(get).toHaveBeenCalledWith('videos/{video_token}', {
        path: { video_token: 'tok' },
      });
      expect(
        (sleep as jest.Mock).mock.calls.map((c: unknown[]) => c[0]),
      ).toEqual([1_000, 1_000]);
    });

    it('переживает сбой опроса и продолжает ждать, не бросая загруженное видео', async () => {
      const get = jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('502'), { status: 502, response: {} }),
        )
        .mockResolvedValue(info(1280, 7000));
      const client = new MaxApiClient(fakeBot({ raw: { get } }));

      await expect(client.waitForVideoReady('tok')).resolves.toBeUndefined();
      expect(get).toHaveBeenCalledTimes(2);
    });

    it('404 опроса не выходит наружу как есть — иначе группу сочли бы покинутой ботом', async () => {
      const get = jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('404'), { status: 404, response: {} }),
        );
      const client = new MaxApiClient(fakeBot({ raw: { get } }));

      const failure = client.waitForVideoReady('tok', 0);
      await expect(failure).rejects.toThrow('MAX не обработал видео');
      await expect(failure).rejects.toMatchObject({ status: 400 });
    });

    it('не спит дольше оставшегося до срока', async () => {
      const get = jest.fn().mockResolvedValue(info(0, 0));
      const client = new MaxApiClient(fakeBot({ raw: { get } }));
      (sleep as jest.Mock).mockClear();

      await expect(client.waitForVideoReady('tok', 300)).rejects.toThrow();

      for (const [ms] of (sleep as jest.Mock).mock.calls as [number][]) {
        expect(ms).toBeLessThanOrEqual(300);
      }
    });

    it('по сроку отказывает повторяемо — загрузка в кэше, автоповтор найдёт видео готовым', async () => {
      const get = jest.fn().mockResolvedValue(info(0, 0));
      const client = new MaxApiClient(fakeBot({ raw: { get } }));

      const failure = client.waitForVideoReady('tok', 0);
      await expect(failure).rejects.toThrow('MAX не обработал видео');
      // Тот же отказ, что MAX сам отдаёт на необработанное видео.
      const err = (await failure.catch((e: unknown) => e)) as MaxApiError;
      expect(classifyDeliveryError(err).kind).toBe('retryable');
    });
  });

  it('translates an SDK error into MaxApiError so callers never see SDK types', async () => {
    const sdkError = Object.assign(new Error('404: chat not found'), {
      status: 404,
      response: { code: 'chat.not.found', message: 'chat not found' },
    });
    const client = new MaxApiClient(
      fakeBot({ deleteMessage: jest.fn().mockRejectedValue(sdkError) }),
    );

    await expect(client.deleteMessage('mid')).rejects.toMatchObject({
      status: 404,
      code: 'chat.not.found',
    });
    await expect(client.deleteMessage('mid')).rejects.toBeInstanceOf(
      MaxApiError,
    );
  });

  it('опрос видео с отозванным токеном отказывает сразу, а не ждёт срока', async () => {
    const get = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('401'), { status: 401, response: {} }),
      );
    const client = new MaxApiClient(fakeBot({ raw: { get } }));

    await expect(client.waitForVideoReady('tok', 60_000)).rejects.toMatchObject(
      { status: 401 },
    );
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('удаление с `success: false` — отказ, а не успех (так MAX отвечает 200-м)', async () => {
    // Проверено живьём: несуществующий чат — 200 и `success: false`.
    const client = new MaxApiClient(
      fakeBot({
        deleteMessage: jest.fn().mockResolvedValue({
          success: false,
          message: 'Key: chat.not-found',
        }),
      }),
    );

    await expect(client.deleteMessage('mid')).rejects.toThrow('chat.not-found');
  });

  it('правка с `success: false` — отказ, а не успех (живьём: «Error on message edit»)', async () => {
    const client = new MaxApiClient(
      fakeBot({
        editMessage: jest.fn().mockResolvedValue({
          success: false,
          message: 'Error on message edit',
        }),
      }),
    );

    await expect(client.editMessage('mid', 'текст')).rejects.toThrow(
      'Error on message edit',
    );
  });

  it('уже удалённое сообщение MAX подтверждает успехом — это не ошибка', async () => {
    const client = new MaxApiClient(
      fakeBot({
        deleteMessage: jest.fn().mockResolvedValue({ success: true }),
      }),
    );

    await expect(client.deleteMessage('mid')).resolves.toBeUndefined();
  });
});

describe('toMaxApiError', () => {
  it('preserves the status and code the delivery policy classifies on', () => {
    const rateLimited = toMaxApiError({
      status: 429,
      response: { code: 'too.many.requests' },
    });

    expect(rateLimited.status).toBe(429);
    expect(rateLimited.code).toBe('too.many.requests');
  });

  it('marks a transport failure with status 0, since it never reached MAX', () => {
    const err = toMaxApiError(new TypeError('fetch failed'));

    expect(err.status).toBe(0);
    expect(err.code).toBe('network.error');
  });

  it('flags an invalid token so a global token problem is recognisable', () => {
    const err = toMaxApiError({
      status: 401,
      response: { code: 'verify.token' },
    });

    expect(err.tokenInvalid).toBe(true);
  });

  it('falls back to a placeholder code when MAX sends none', () => {
    expect(toMaxApiError({ status: 500, response: {} }).code).toBe('unknown');
  });
});
