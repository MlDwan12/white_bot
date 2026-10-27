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
import { sleep } from '../common/sleep';

/**
 * Covers pushing the whole file, not one round trip, so it's well above the
 * 10s budget for ordinary API calls (see max-bot.provider).
 */
const UPLOAD_TIMEOUT_MS = 60_000;

const MEMBERS_BATCH = 100;

/**
 * Ожидание обработки видео после загрузки: опрос с растущей паузой (до 5 с)
 * не дольше минуты. Живьём (23.09.2026) webm 0,5–4 МБ был готов за
 * 1,6–4,8 с. Предел держит доставку в `sending` вместе с загрузкой (до 60 с)
 * заметно ниже порога сверки зависших (`STUCK_SENDING_MS`, 5 мин).
 */
const VIDEO_READY_TIMEOUT_MS = 60_000;

/** Сырой `GET /videos/{token}` в том виде, в каком он реально работает. */
interface RawVideoInfoApi {
  get(
    method: 'videos/{video_token}',
    options: { path: { video_token: string } },
  ): Promise<{ width: number; duration: number }>;
}
const VIDEO_READY_POLL_MS = [1_000, 1_000, 2_000, 3_000, 5_000];

export interface MaxChatInfo {
  externalId: string;
  title: string;
  /** Maps MAX's chat type onto our GroupKind; `dialog` is a 1:1 chat, never a delivery target. */
  kind: 'chat' | 'channel' | 'dialog';
  /** Ссылка-приглашение (у приватного канала — `max.ru/join/…`); у диалога нет. */
  link: string | null;
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
      api.editMessage(messageId, { text, ...this.buildEditExtra(options) }),
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
    // Отказ (`success: false` при 200) превращается в ошибку в `call`.
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
      link: chat.link ?? null,
    };
  }

  /**
   * Ждёт, пока MAX обработает загруженное видео. Сообщение с необработанным
   * видео MAX отвергает 400 `errors.process.attachment.video.not.processed`
   * (прод, 23.09.2026). Признак готовности — `GET /videos/{token}`: сразу
   * после загрузки `width`/`duration` нулевые, после обработки — настоящие;
   * проверено живьём, что после этого отправка проходит с первой попытки.
   *
   * Ждём здесь, один раз на загрузку, а не повторами каждой отправки: готовое
   * видео ложится в кэш загрузок, и остальные группы и рассылки не ждут
   * вовсе, а сама отправка остаётся одним коротким вызовом (на это
   * рассчитаны «Стоп», правка опубликованного и сверка зависших доставок).
   */
  async waitForVideoReady(
    token: string,
    timeoutMs = VIDEO_READY_TIMEOUT_MS,
  ): Promise<void> {
    const api = this.requireBot().api;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    for (let attempt = 0; ; attempt++) {
      try {
        // Не `api.getVideoInfo`: в SDK 0.x он кладёт токен в query, путь
        // остаётся с литералом `{video_token}` — 404 (проверено живьём).
        // Сырой вызов с `path` работает, а типы SDK описывают его неверно.
        const video = await this.call(() =>
          (api.raw as unknown as RawVideoInfoApi).get('videos/{video_token}', {
            path: { video_token: token },
          }),
        );
        if (video.duration > 0 && video.width > 0) {
          return;
        }
      } catch (err: unknown) {
        // Сбой опроса — не повод бросать уже загруженное видео: пробуем
        // снова до срока. И наружу он не уходит ошибкой MAX: доставка
        // приняла бы 404 за «бота удалили из группы», а 5xx — за «могло и
        // опубликоваться», хотя до отправки дело не дошло.
        // Отозванный токен — не «видео ещё не готово»: ждать минуту и
        // отдавать повторяемый отказ значило бы прятать настоящую причину
        // и тратить повторы на запрос, который не пройдёт.
        if (err instanceof MaxApiError && err.tokenInvalid) {
          throw err;
        }
        lastError = err;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // Тот же отказ, что MAX сам отдаёт на необработанное видео, — и
        // классифицируется так же, повторяемым: загрузка уже в кэше, и
        // автоповтор доставки через backoff найдёт видео обработанным. Не
        // 404/5xx опроса как есть: доставка приняла бы их за «бота удалили»
        // или «могло опубликоваться», хотя до отправки дело не дошло.
        throw new MaxApiError(
          400,
          'errors.process.attachment.video.not.processed',
          `MAX не обработал видео за ${Math.round(timeoutMs / 1000)} с` +
            (lastError instanceof Error ? ` (${lastError.message})` : ''),
        );
      }
      await sleep(
        Math.min(
          remaining,
          VIDEO_READY_POLL_MS[
            Math.min(attempt, VIDEO_READY_POLL_MS.length - 1)
          ],
        ),
      );
    }
  }

  /**
   * Кто из `userIds` сейчас состоит в чате — для условия «подписаться на
   * канал». Проверено живьём (канал «Test», 23.09.2026): `GET
   * /chats/{id}/members?user_ids=a,b,c` возвращает только тех, кто состоит,
   * неучастник просто отсутствует в ответе; чат, где бота нет, — 403
   * `chat.denied`. Работает, пока бот сам в чате (у подключённых групп — он
   * там админ). Размер пачки MAX не документирует, поэтому режем на 100.
   */
  async chatMemberIds(chatId: number, userIds: number[]): Promise<Set<string>> {
    const api = this.requireBot().api;
    const members = new Set<string>();
    for (let i = 0; i < userIds.length; i += MEMBERS_BATCH) {
      const batch = userIds.slice(i, i + MEMBERS_BATCH);
      const response = await this.call(() =>
        api.getChatMembers(chatId, { user_ids: batch }),
      );
      for (const member of response.members) {
        members.add(String(member.user_id));
      }
    }
    return members;
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
        // картинка исчезнут. Это правка, а не новое сообщение, поэтому
        // `attachments` уходит всегда, даже пустым: «Проверить подписку» с
        // успешным ответом без кнопок обязана снять прежнюю клавиатуру, а
        // правка без поля оставляет вложения как были (см. `buildEditExtra`).
        message: { text, ...this.buildEditExtra({ buttons, attachments }) },
      }),
    );
  }

  /**
   * Имя бота (`id2311395309_bot`) — для ссылок на его диалог. Берётся из
   * `getMyInfo`, который SDK делает при старте опроса, а не из настроек:
   * токен однозначно определяет бота, и второе место, которое могло бы с ним
   * разойтись, не нужно. До завершения старта — `null`.
   */
  botUsername(): string | null {
    return this.bot?.botInfo?.username ?? null;
  }

  private buildSendExtra(options: MaxSendOptions) {
    const attachments = this.composeAttachments(options);
    return attachments.length > 0 ? { attachments } : {};
  }

  /**
   * То же, но для правки уже отправленного сообщения: `attachments`
   * присутствует в теле запроса **всегда**, даже пустым массивом.
   *
   * Подтверждено живьём (канал «Test», 21.09.2026): `PUT /messages` без поля
   * `attachments` оставляет прежние вложения как есть, а с `attachments: []`
   * убирает их. `buildSendExtra` для нового сообщения опускает пустой массив
   * намеренно (нечего сохранять), но для правки это же самое опущение молча
   * не даёт снять картинку — панель отрапортует об успехе, а вложение
   * останется висеть.
   */
  private buildEditExtra(options: MaxSendOptions) {
    return { attachments: this.composeAttachments(options) };
  }

  private composeAttachments(options: MaxSendOptions): AttachmentRequest[] {
    const attachments = [...(options.attachments ?? [])];
    if (options.buttons?.length) {
      attachments.push({
        type: 'inline_keyboard',
        payload: { buttons: options.buttons },
      });
    }
    return attachments;
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
    let result: T;
    try {
      result = await fn();
    } catch (err: unknown) {
      throw toMaxApiError(err);
    }
    // Отказ MAX у действий (правка, удаление сообщения, ответ на колбэк)
    // приходит не ошибкой HTTP, а ответом 200 с `success: false` — проверено
    // живьём 27.10.2026: «Error on message edit», «Key: chat.not-found».
    // Без этой проверки неудача рапортовалась бы успехом: панель писала бы
    // «Текст обновлён во всех группах», а в канале оставалось старое.
    // Уже удалённое сообщение MAX подтверждает `success: true` — это успех.
    if (
      typeof result === 'object' &&
      result !== null &&
      (result as { success?: unknown }).success === false
    ) {
      const message = (result as { message?: unknown }).message;
      throw new MaxApiError(
        400,
        'action.refused',
        `MAX отказал: ${typeof message === 'string' ? message : 'без причины'}`,
      );
    }
    return result;
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
