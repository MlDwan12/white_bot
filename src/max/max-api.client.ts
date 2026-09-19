import { Inject, Injectable } from '@nestjs/common';
import { Bot } from '@maxhub/max-bot-api';
import type { AttachmentRequest, Button } from '@maxhub/max-bot-api/types';
import {
  toRequestAttachments,
  unsupportedAttachmentTypes,
} from './max-attachments';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { MaxApiError } from './max-api.error';
import { MAX_BOT } from './max-bot.provider';

/**
 * Covers pushing the whole file, not one round trip, so it's well above the
 * 10s budget for ordinary API calls (see max-bot.provider).
 */
const UPLOAD_TIMEOUT_MS = 60_000;

export interface MaxChatInfo {
  externalId: string;
  title: string;
  /** Maps MAX's chat type onto our GroupKind; `dialog` is a 1:1 chat, never a delivery target. */
  kind: 'chat' | 'channel' | 'dialog';
}

export interface MaxAttachmentInput {
  kind: 'image' | 'video' | 'audio' | 'file';
  /**
   * A filesystem path, or the bytes themselves.
   *
   * Caveat worth knowing before Step 6 wires real attachments up: the SDK
   * derives the displayed file name from the source and offers no way to
   * override it — a path keeps its basename, but a Buffer gets a random UUID
   * with no extension. That's invisible for images (MAX renders them inline)
   * and wrong for documents, where the recipient sees the name. So pass a
   * path whenever the name matters.
   */
  source: Buffer | string;
}

export interface MaxSendOptions {
  attachments?: AttachmentRequest[];
  /** Rendered as an inline keyboard attachment — MAX has no separate keyboard field. */
  buttons?: Button[][];
}

/**
 * Чем заменить сообщение в ответ на нажатие кнопки. В MAX нет всплывающих
 * уведомлений: единственный ответ на колбэк — замена самого сообщения, на
 * котором сидит кнопка. Поэтому в публичном посте отвечать «по-человечески»
 * нечем, и замена должна воспроизводить пост почти без изменений.
 */
export interface MaxCallbackReplacement {
  text: string;
  buttons?: Button[][];
  /**
   * Медиа исходного сообщения. Замена перезаписывает сообщение целиком, так
   * что не передать их — значит стереть картинку у всех, кто видит пост.
   */
  attachments?: AttachmentRequest[];
}

/**
 * Adapter over the official `@maxhub/max-bot-api` SDK.
 *
 * Its whole job is to keep SDK types out of the domain: services above see
 * our own inputs/results and our `MaxApiError`, so replacing or dropping the
 * SDK later is a change to this file rather than to every caller. No
 * queue/retry logic here — that's the delivery pipeline's job, same split as
 * VkApiClient.
 */
@Injectable()
export class MaxApiClient {
  constructor(@Inject(MAX_BOT) private readonly bot: Bot | null) {}

  /** False when MAX_BOT_TOKEN isn't configured — callers can degrade instead of throwing. */
  get configured(): boolean {
    return this.bot !== null;
  }

  async sendMessageToChat(
    chatId: number,
    text: string,
    options: MaxSendOptions = {},
  ): Promise<{ messageId: string }> {
    const api = this.requireBot().api;
    const message = await this.call(() =>
      api.sendMessageToChat(chatId, text, this.buildSendExtra(options)),
    );
    return { messageId: message.body.mid };
  }

  async sendMessageToUser(
    userId: number,
    text: string,
    options: MaxSendOptions = {},
  ): Promise<{ messageId: string }> {
    const api = this.requireBot().api;
    const message = await this.call(() =>
      api.sendMessageToUser(userId, text, this.buildSendExtra(options)),
    );
    return { messageId: message.body.mid };
  }

  async editMessage(
    messageId: string,
    text: string,
    options: MaxSendOptions = {},
  ): Promise<void> {
    const api = this.requireBot().api;
    await this.call(() =>
      api.editMessage(messageId, { text, ...this.buildSendExtra(options) }),
    );
  }

  /**
   * Тело уже опубликованного сообщения. Нужно перед правкой: MAX заменяет
   * сообщение целиком, поэтому вложения приходится снимать со старой версии
   * и передавать заново.
   */
  async getMessageBody(messageId: string): Promise<{
    text: string;
    attachments: AttachmentRequest[];
    unsupported: string[];
  }> {
    const api = this.requireBot().api;
    const message = await this.call(() => api.getMessage(messageId));
    return {
      text: message.body.text ?? '',
      attachments: toRequestAttachments(message.body.attachments),
      unsupported: unsupportedAttachmentTypes(message.body.attachments),
    };
  }

  async deleteMessage(messageId: string): Promise<void> {
    const api = this.requireBot().api;
    await this.call(() => api.deleteMessage(messageId));
  }

  async getChat(chatId: number): Promise<MaxChatInfo> {
    const api = this.requireBot().api;
    const chat = await this.call(() => api.getChat(chatId));
    return {
      externalId: String(chat.chat_id),
      // MAX leaves `title` null for dialogs and occasionally for freshly
      // created chats; Group.title is non-nullable, so fall back to
      // something identifiable rather than writing an empty string.
      title: chat.title ?? `Чат ${chat.chat_id}`,
      kind: chat.type,
    };
  }

  /**
   * Two-phase on MAX's side (request an upload URL, then push the bytes), but
   * the SDK handles both and hands back an attachment object. Returns the
   * request form, ready to drop into a message's `attachments`.
   */
  async uploadAttachment(
    input: MaxAttachmentInput,
  ): Promise<AttachmentRequest> {
    const api = this.requireBot().api;
    // Passed explicitly because the SDK pushes file bytes through its own
    // node:http/node:https transport, which never consults the
    // `clientOptions.fetch` wrapper covering every other call. Its fallback
    // there is 20s for the whole upload — fine for a photo, too tight for a
    // video on a slow link, and it's a hard deadline rather than an idle one.
    const source = { source: input.source, timeout: UPLOAD_TIMEOUT_MS };
    // Annotated explicitly: the four upload methods return four different
    // attachment classes, and TS would otherwise infer the union as the
    // first branch's type. All we need from them is `toJson()`.
    const attachment = await this.call<{ toJson(): AttachmentRequest }>(() => {
      switch (input.kind) {
        case 'image':
          return api.uploadImage(source);
        case 'video':
          return api.uploadVideo(source);
        case 'audio':
          return api.uploadAudio(source);
        case 'file':
          return api.uploadFile(source);
      }
    });
    return attachment.toJson();
  }

  /**
   * Acknowledges a button press — without it the client keeps spinning.
   *
   * MAX offers no toast/alert here (unlike Telegram): the only feedback
   * channel is `message`, which *replaces* the message the button sits on.
   *
   * That suits a decision prompt in a DM — the question is swapped for its
   * outcome and the stale buttons go away, so the same choice can't be
   * submitted twice. In a public post it is destructive instead: one person's
   * click would rewrite the announcement for everyone. Callers there must
   * pass the post back unchanged (text *and* buttons), or nothing at all.
   */
  async answerCallback(
    callbackId: string,
    replacement?: string | MaxCallbackReplacement,
  ): Promise<void> {
    const api = this.requireBot().api;
    if (!replacement) {
      await this.call(() => api.answerOnCallback(callbackId, {}));
      return;
    }
    const { text, buttons, attachments } =
      typeof replacement === 'string'
        ? { text: replacement, buttons: undefined, attachments: undefined }
        : replacement;
    await this.call(() =>
      api.answerOnCallback(callbackId, {
        // Клавиатура и медиа передаются вместе с текстом не для красоты:
        // ответ перезаписывает сообщение целиком, и без них кнопка и
        // картинка исчезнут.
        message: { text, ...this.buildSendExtra({ buttons, attachments }) },
      }),
    );
  }

  private buildSendExtra(options: MaxSendOptions) {
    const attachments = [...(options.attachments ?? [])];
    if (options.buttons?.length) {
      attachments.push({
        type: 'inline_keyboard',
        payload: { buttons: options.buttons },
      });
    }
    return attachments.length > 0 ? { attachments } : {};
  }

  private requireBot(): Bot {
    if (!this.bot) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'MAX-бот не настроен: не задан MAX_BOT_TOKEN',
      );
    }
    return this.bot;
  }

  /**
   * The SDK throws its own `MaxError`, which we can't `instanceof` against
   * without importing an internal path. It's identified structurally instead
   * (numeric `status` plus a `response` envelope) and re-thrown as our
   * MaxApiError so callers never see an SDK type.
   */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: unknown) {
      throw toMaxApiError(err);
    }
  }
}

export function toMaxApiError(err: unknown): MaxApiError {
  if (err instanceof MaxApiError) {
    return err;
  }
  // Our own domain errors must pass through untouched. Without this, an
  // AppException (which carries an HTTP `status`) would be re-labelled as a
  // MAX API failure — a misconfiguration would then look like a transient
  // platform error and be retried forever by the delivery pipeline.
  if (err instanceof AppException) {
    throw err;
  }
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = err.status;
    const response = (err as { response?: unknown }).response;
    if (typeof status === 'number') {
      const code =
        typeof response === 'object' &&
        response !== null &&
        'code' in response &&
        typeof response.code === 'string'
          ? (response as { code: string }).code
          : 'unknown';
      const message =
        err instanceof Error && err.message ? err.message : 'Ошибка MAX API';
      return new MaxApiError(status, code, message);
    }
  }
  // A transport-level failure (DNS, TLS, our own abort timeout) never reached
  // MAX in a form it could answer, so it has no status of its own. Status 0
  // marks exactly that, and the delivery pipeline reads it as ambiguous — the
  // request may still have been processed before the answer was lost.
  const message = err instanceof Error ? err.message : 'Ошибка MAX API';
  return new MaxApiError(0, 'network.error', message);
}
