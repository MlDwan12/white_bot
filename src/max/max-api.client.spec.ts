import { Bot } from '@maxhub/max-bot-api';
import { AppException } from '../common/app-exception';
import { MaxApiClient, toMaxApiError } from './max-api.client';
import { MaxApiError } from './max-api.error';

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
    });
  });

  it('replaces the prompt when answering a callback, since MAX has no toast', async () => {
    const answerOnCallback = jest.fn().mockResolvedValue({ success: true });
    const client = new MaxApiClient(fakeBot({ answerOnCallback }));

    await client.answerCallback('cb-1', 'Готово');
    expect(answerOnCallback).toHaveBeenCalledWith('cb-1', {
      message: { text: 'Готово' },
    });

    await client.answerCallback('cb-2');
    expect(answerOnCallback).toHaveBeenLastCalledWith('cb-2', {});
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
