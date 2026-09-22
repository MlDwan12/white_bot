import { Inject, Injectable } from '@nestjs/common';
import { Bot } from '@maxhub/max-bot-api';
import type { Attachment } from '@maxhub/max-bot-api/types';
import { PinoLogger } from 'nestjs-pino';
import { GroupsService, PublicGroup } from '../groups/groups.service';
import { MaxAdminResolver } from './max-admin.resolver';
import { MaxApiClient } from './max-api.client';
import {
  ContestParticipationService,
  type JoinOutcome,
  type StartedFromLink,
} from '../contests/contest-participation.service';
import {
  PlatformUsersService,
  type PlatformUserProfile,
} from '../platform-users/platform-users.service';
import {
  CONTEST_JOIN_PAYLOAD,
  CONTEST_START_PAYLOAD,
  contestDmUrl,
  contestKeyboard,
} from '../contests/contest-button';
import {
  CONSENT_ACCEPT_PAYLOAD,
  CONSENT_TEXT,
  consentKeyboard,
} from './consent-gate';
import {
  toRequestAttachments,
  unsupportedAttachmentTypes,
} from './max-attachments';
import { MAX_BOT } from './max-bot.provider';

/** Callback payloads for the pending-group review buttons. */
const GROUP_REVIEW_PAYLOAD = /^group:(confirm|reject):([0-9a-fA-F-]{36})$/;

export function groupReviewPayload(
  action: 'confirm' | 'reject',
  groupId: string,
): string {
  return `group:${action}:${groupId}`;
}

/** Пользователь MAX в том виде, в каком его несут апдейты. */
interface MaxUserLike {
  user_id: number;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  is_bot?: boolean;
}

/**
 * Профиль участника из пользователя MAX — одинаково для нажатия кнопки и для
 * старта бота по ссылке: оба пути записывают одного и того же человека, и
 * два разных способа собрать имя дали бы одному участнику два вида в списке.
 */
function toProfile(user: MaxUserLike): PlatformUserProfile {
  return {
    externalUserId: String(user.user_id),
    // Имя нужно только для читаемого списка победителей; дедуп идёт по id,
    // так что отсутствие имени ничего не ломает.
    displayName:
      user.name ?? user.first_name ?? user.username ?? `id${user.user_id}`,
    firstName: user.first_name,
    lastName: user.last_name,
    username: user.username,
    isBot: user.is_bot,
    raw: user,
  };
}

/**
 * Registers the bot's update handlers, in the Composer style the MAX docs
 * document (`bot.on` / `bot.action` / `bot.command`) rather than a hand-rolled
 * switch over `update_type` — the SDK narrows `ctx` to the matching update
 * type, so the payload fields are typed per handler.
 *
 * Handlers stay thin on purpose: every decision that outlives the update lives
 * in GroupsService, so the web panel and the bot can't drift apart.
 */
@Injectable()
export class MaxBotHandlers {
  constructor(
    @Inject(MAX_BOT) private readonly bot: Bot | null,
    private readonly groups: GroupsService,
    private readonly admins: MaxAdminResolver,
    private readonly contests: ContestParticipationService,
    private readonly platformUsers: PlatformUsersService,
    private readonly api: MaxApiClient,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MaxBotHandlers.name);
  }

  /** Конкурсы, у которых сейчас идёт перерисовка счётчика, — см. `redrawAnnouncements`. */
  private readonly redrawing = new Map<string, { again: boolean }>();

  register(): void {
    const bot = this.bot;
    if (!bot) {
      return;
    }

    // A thrown handler would otherwise bubble into the polling loop and kill
    // it, taking every future update with it.
    bot.catch((err, ctx) => {
      this.logger.error(
        { err, updateType: ctx.updateType },
        'Ошибка в обработчике MAX-апдейта',
      );
    });

    bot.command('start', async (ctx) => {
      // `message_created` carries no top-level `user` (unlike the chat-
      // membership events) — the sender lives on the message itself, and MAX
      // leaves it unset for channel posts published on the channel's behalf.
      const senderId = ctx.message.sender?.user_id;
      const chatId = ctx.chatId;
      if (senderId === undefined || chatId === null) {
        return;
      }
      await this.handleStart(senderId, chatId);
    });

    // «Начать» в диалоге с ботом — в том числе после перехода по ссылке с
    // кнопки конкурса. Обычная команда `/start` сюда не попадает: это другое
    // событие, поэтому обработчик выше её не ловит.
    bot.on('bot_started', async (ctx) => {
      await this.handleBotStarted(
        ctx.update.payload,
        ctx.update.user,
        ctx.update.chat_id,
      );
    });

    bot.on('bot_added', async (ctx) => {
      await this.handleBotAdded(ctx.chatId, ctx.update.is_channel);
    });

    bot.on('bot_removed', async (ctx) => {
      await this.handleBotRemoved(ctx.chatId);
    });

    bot.action(CONSENT_ACCEPT_PAYLOAD, async (ctx) => {
      const resumePayload = ctx.match?.[1] ?? '';
      await this.handleConsentAccepted(
        resumePayload,
        ctx.user,
        ctx.chatId,
        ctx.callback.callback_id,
      );
    });

    bot.action(CONTEST_JOIN_PAYLOAD, async (ctx) => {
      const contestId = ctx.match?.[1];
      if (!contestId) {
        return;
      }
      await this.handleContestJoin(
        contestId,
        ctx.user,
        ctx.callback.callback_id,
        ctx.chatId,
        // Апдейт приносит исходное сообщение целиком, так что медиа не
        // приходится запрашивать отдельно — только передать обратно.
        ctx.update.message?.body?.attachments,
      );
    });

    bot.action(GROUP_REVIEW_PAYLOAD, async (ctx) => {
      const match = ctx.match;
      if (!match) {
        return;
      }
      await this.handleGroupReview(
        ctx.user.user_id,
        ctx.callback.callback_id,
        match[1] as 'confirm' | 'reject',
        match[2],
      );
    });
  }

  /**
   * Answers with the sender's own MAX user id. Until the web panel can create
   * admins (Step 9), this is how the first AdminUser row gets its `maxUserId`
   * — there's no other way to discover it. Replying to a stranger leaks
   * nothing: they already know the bot exists (they just messaged it) and the
   * id returned is their own.
   */
  private async handleStart(userId: number, chatId: number): Promise<void> {
    const admin = await this.admins.findByMaxUserId(userId);
    const text = admin
      ? `Бот на связи. Вы опознаны как ${admin.email} (роль: ${admin.role}).`
      : `Бот на связи, но ваш MAX-аккаунт не привязан ни к одному администратору.\n\nВаш MAX user id: ${userId}\nЧтобы получить доступ, впишите его в поле maxUserId нужного администратора.`;
    await this.api.sendMessageToChat(chatId, text);
  }

  /**
   * The bot was added to a chat or channel. MAX's `bot_added` payload carries
   * no title, so the name has to be fetched separately before the draft can
   * be created.
   */
  private async handleBotAdded(
    chatId: number,
    isChannel: boolean,
  ): Promise<void> {
    const info = await this.api.getChat(chatId);
    // `is_channel` and the chat's own type can disagree (the event flag is
    // derived, the chat record is authoritative), and a `dialog` is a 1:1
    // conversation that must never become a delivery target.
    if (info.kind === 'dialog') {
      this.logger.info(
        { chatId },
        'Бот добавлен в личный диалог — группа не создаётся',
      );
      return;
    }
    // The chat record wins outright: `is_channel` is a derived flag on the
    // event, while `getChat` returns the chat's own type. Letting the flag
    // override it would file a group chat as a channel (or the reverse), and
    // `kind` decides how the group is addressed everywhere downstream.
    const kind = info.kind;
    if (isChannel !== (kind === 'channel')) {
      this.logger.warn(
        { chatId, isChannel, kind },
        'Флаг is_channel расходится с типом чата — использован тип из getChat',
      );
    }

    const group = await this.groups.createOrReactivateMaxDraft({
      externalId: info.externalId,
      kind,
      title: info.title,
    });

    if (group.status !== 'pending_confirmation') {
      this.logger.info(
        { chatId, groupId: group.id },
        'Бот возвращён в ранее подтверждённую MAX-группу — переподтверждение не требуется',
      );
      return;
    }
    await this.notifyAdminsOfPendingGroup(group);
  }

  private async handleBotRemoved(chatId: number): Promise<void> {
    const marked = await this.groups.markMaxGroupBotRemoved(String(chatId));
    this.logger.info(
      { chatId, marked },
      marked
        ? 'MAX-группа помечена как bot_removed'
        : 'Событие bot_removed для неизвестной группы — пропущено',
    );
  }

  /**
   * Нажатие кнопки под анонс-постом.
   *
   * В MAX ответ на колбэк не всплывашка, а замена сообщения целиком, поэтому
   * анонс возвращается на место тем же текстом и той же кнопкой — меняется
   * только счётчик участников. Личный ответ («вы уже участвуете») уходит в
   * лс и только если бот вообще может писать этому человеку.
   */
  private async handleContestJoin(
    contestId: string,
    user: MaxUserLike,
    callbackId: string,
    chatId: number | null | undefined,
    attachments?: Attachment[] | null,
  ): Promise<void> {
    let outcome: JoinOutcome;
    try {
      outcome = await this.contests.join({
        contestId,
        platform: 'max',
        user: toProfile(user),
        groupExternalId: String(chatId ?? ''),
      });
    } catch (err: unknown) {
      // Участие не записалось. Клик всё равно надо подтвердить, иначе клиент
      // будет ждать вечно; пустой ответ безопаснее замены — сообщение
      // останется как есть.
      this.logger.error(
        { err, contestId, userId: user.user_id },
        'Не удалось записать участие в конкурсе',
      );
      await this.safeAnswer(callbackId);
      return;
    }

    const dropped = unsupportedAttachmentTypes(attachments);
    if (dropped.length > 0) {
      this.logger.warn(
        { contestId, dropped },
        'Вложения анонса, которые нечем пересобрать, потеряются при перерисовке',
      );
    }

    // Отсюда и ниже участие уже зафиксировано: любой сбой — это неудачное
    // уведомление, а не неудачная запись, и путать их в логах нельзя.
    await this.safeAnswer(
      callbackId,
      outcome.refresh
        ? {
            text: outcome.refresh.text,
            // Та же клавиатура, что и при отправке: ответ заменяет сообщение
            // целиком, и без второй кнопки ссылка на бота пропала бы после
            // первого же клика.
            buttons: contestKeyboard(
              {
                text: outcome.refresh.buttonText,
                payload: outcome.refresh.payload,
              },
              contestDmUrl(this.api.botUsername(), contestId),
            ),
            // Без этого первое же нажатие стёрло бы картинку анонса у всех.
            attachments: toRequestAttachments(attachments),
          }
        : undefined,
    );

    await this.sendPrivately(user.user_id, outcome.message);
  }

  /**
   * Человек попал в диалог с ботом — по ссылке конкурса (`payload` несёт
   * метку `c_<uuid>`) или обычным «Начать» через поиск (`payload` пуст).
   * Оба пути обязаны сначала пройти экран согласия на обработку
   * персональных данных (152-ФЗ, требование MAX) — без него дальше не
   * идём, а `payload` едет в кнопке «Продолжить», чтобы после согласия
   * сразу выполнить то, ради чего человек пришёл.
   */
  private async handleBotStarted(
    payload: string | null | undefined,
    user: MaxUserLike,
    chatId: number,
  ): Promise<void> {
    const resumePayload = payload ?? '';
    let consented: boolean;
    try {
      consented = await this.platformUsers.hasConsented(
        'max',
        String(user.user_id),
      );
    } catch (err: unknown) {
      // Без этого сбой БД молча ронял бы весь старт: ни экрана согласия, ни
      // участия, ни единого слова человеку — тот же класс отказа, что и в
      // handleContestJoin, только раньше по конвейеру.
      this.logger.error(
        { err, userId: user.user_id },
        'Не удалось проверить согласие при старте бота',
      );
      await this.replyBestEffort(
        chatId,
        'Не получилось обработать запуск. Нажмите «Начать» ещё раз.',
        resumePayload,
        user.user_id,
      );
      return;
    }
    if (!consented) {
      await this.sendConsentGate(chatId, resumePayload);
      return;
    }
    await this.proceedAfterStart(resumePayload, user, chatId);
  }

  /** Экран согласия — сообщение с двумя ссылками на документы и кнопкой «Продолжить». */
  private async sendConsentGate(
    chatId: number,
    resumePayload: string,
  ): Promise<void> {
    await this.api.sendMessageToChat(chatId, CONSENT_TEXT, {
      buttons: consentKeyboard(resumePayload),
    });
  }

  /**
   * Нажатие «Продолжить». Ответ на колбэк заменяет сообщение целиком (в
   * MAX нет всплывающих уведомлений), поэтому экран согласия сменяется
   * коротким подтверждением, а исходное действие уходит отдельным
   * сообщением через `proceedAfterStart` — тем же путём, что и без
   * экрана согласия.
   */
  private async handleConsentAccepted(
    resumePayload: string,
    user: MaxUserLike,
    chatId: number | null | undefined,
    callbackId: string,
  ): Promise<void> {
    try {
      await this.platformUsers.recordConsent('max', toProfile(user));
    } catch (err: unknown) {
      // Клик всё равно надо подтвердить — иначе клиент будет ждать вечно,
      // тот же принцип, что и у handleContestJoin/handleGroupReview. Пустой
      // ответ безопаснее замены: экран согласия остаётся как есть, и кнопку
      // можно нажать ещё раз.
      this.logger.error(
        { err, userId: user.user_id },
        'Не удалось записать согласие на обработку персональных данных',
      );
      await this.safeAnswer(callbackId);
      return;
    }
    await this.safeAnswer(callbackId, 'Спасибо! Согласие принято.');
    if (chatId == null) {
      // Не должно случаться — колбэк пришёл из уже открытого диалога, и
      // MAX сам его туда адресовал. Если всё же происходит, молчать нельзя:
      // согласие отмечено, а то, ради чего человек пришёл (например,
      // участие в конкурсе), без лога терялось бы без единого следа.
      this.logger.warn(
        { userId: user.user_id, resumePayload },
        'У колбэка согласия пуст chatId — исходное действие не выполнено',
      );
      return;
    }
    await this.proceedAfterStart(resumePayload, user, chatId);
  }

  /**
   * Метку разбираем только у нашей ссылки; любой другой старт (без метки
   * или с чужой) остаётся как был — молчим, а не отвечаем незнакомцу про
   * конкурс, которого он не выбирал.
   */
  private async proceedAfterStart(
    payload: string,
    user: MaxUserLike,
    chatId: number,
  ): Promise<void> {
    const contestId = CONTEST_START_PAYLOAD.exec(payload)?.[1];
    if (!contestId) {
      return;
    }

    let reply: StartedFromLink;
    try {
      reply = await this.contests.startedFromLink(contestId, toProfile(user));
    } catch (err: unknown) {
      this.logger.error(
        { err, contestId, userId: user.user_id },
        'Не удалось обработать запуск бота по ссылке конкурса',
      );
      // Кнопка — ссылка, и человек видит пустой диалог: без слова от бота он
      // не поймёт, записан он или нет. Повторное нажатие безопасно — участие
      // дедуплицируется, — так что прямо об этом и просим.
      await this.replyBestEffort(
        chatId,
        'Не получилось обработать участие. Нажмите кнопку под постом ещё раз — повторное нажатие ничего не сломает.',
        contestId,
        user.user_id,
      );
      return;
    }

    const replied = await this.replyBestEffort(
      chatId,
      reply.text,
      contestId,
      user.user_id,
    );
    this.logger.info(
      {
        contestId,
        userId: user.user_id,
        chatId,
        lateWinner: reply.prizeIdsToMark.length > 0,
        joined: reply.joined,
      },
      'Обработан запуск бота по ссылке конкурса',
    );
    // Места помечаются только после успешной отправки: иначе победитель
    // числился бы поздравленным, не получив ничего, и пометки «напишите
    // сами» в панели уже не было бы.
    if (replied) {
      await this.contests.markWinnersNotified(reply.prizeIdsToMark);
    }
    // Счётчик обновляется независимо от ответа: участие уже записано.
    if (reply.joined) {
      await this.redrawAnnouncements(contestId);
    }
  }

  /** Ответ в диалоге, провал которого только логируется. */
  /**
   * `resumePayload` — не всегда id конкурса: `handleBotStarted` зовёт это
   * и для обычного «Начать» без метки (пустая строка), и только
   * `proceedAfterStart` (после разбора `c_<uuid>`) передаёт сюда настоящий
   * id. Раньше параметр назывался `contestId`, и лог безусловно утверждал
   * «диалог открыт по ссылке конкурса» даже когда это был просто пустой
   * старт — записи по обоим путям было не различить при разборе логов.
   */
  private async replyBestEffort(
    chatId: number,
    text: string,
    resumePayload: string,
    userId: number,
  ): Promise<boolean> {
    try {
      await this.api.sendMessageToChat(chatId, text);
      return true;
    } catch (err: unknown) {
      // Диалог только что открыт, так что провал — уже настоящий сбой, а не
      // ожидаемое «бот не может писать». Участие (если оно тут было) при
      // этом уже записано.
      this.logger.warn(
        { err, resumePayload, userId },
        'Не удалось ответить в диалоге, открытом при старте бота',
      );
      return false;
    }
  }

  /**
   * Обновляет счётчик на кнопке у анонса — после записи нового участника.
   *
   * Правка заменяет сообщение целиком, поэтому вложения снимаются с текущей
   * версии и передаются заново, иначе картинка исчезла бы у всех. Провал по
   * одному сообщению не должен мешать остальным: участие уже записано.
   *
   * Правки от разных участников идут вперемешку, и с каждой уходило бы по
   * два запроса на каждое сообщение — последовательно, внутри обработчика
   * события. Поэтому на конкурс работает один проход: пока он идёт, остальные
   * лишь отмечают «нужен ещё один» и возвращаются сразу, а проход по
   * окончании повторяется со **свежими** данными. Так счётчик не откатывается
   * назад из-за запоздавшей правки, а число запросов не растёт с числом
   * нажавших.
   */
  private async redrawAnnouncements(contestId: string): Promise<void> {
    const running = this.redrawing.get(contestId);
    if (running) {
      running.again = true;
      return;
    }
    const state = { again: false };
    this.redrawing.set(contestId, state);
    try {
      do {
        state.again = false;
        await this.redrawOnce(contestId);
      } while (state.again);
    } finally {
      this.redrawing.delete(contestId);
    }
  }

  private async redrawOnce(contestId: string): Promise<void> {
    let redraw: Awaited<
      ReturnType<ContestParticipationService['announcementRefresh']>
    >;
    try {
      redraw = await this.contests.announcementRefresh(contestId);
    } catch (err: unknown) {
      this.logger.warn(
        { err, contestId },
        'Не удалось собрать данные для обновления счётчика под анонсом',
      );
      return;
    }
    if (!redraw) {
      return;
    }

    const buttons = contestKeyboard(
      { text: redraw.buttonText, payload: redraw.payload },
      contestDmUrl(this.api.botUsername(), contestId),
    );
    for (const messageId of redraw.messageIds) {
      try {
        const current = await this.api.getMessageBody(messageId);
        if (current.unsupported.length > 0) {
          this.logger.warn(
            { contestId, dropped: current.unsupported },
            'Вложения анонса, которые нечем пересобрать, потеряются при правке',
          );
        }
        await this.api.editMessage(messageId, redraw.text, {
          attachments: current.attachments,
          buttons,
        });
      } catch (err: unknown) {
        this.logger.warn(
          { err, contestId, messageId },
          'Не удалось обновить счётчик участников под анонсом',
        );
      }
    }
  }

  /**
   * Подтверждение клика. Протухший `callback_id` или сетевой сбой здесь не
   * должны мешать остальному: участник уже записан.
   */
  private async safeAnswer(
    callbackId: string,
    replacement?: Parameters<MaxApiClient['answerCallback']>[1],
  ): Promise<void> {
    try {
      await this.api.answerCallback(callbackId, replacement);
    } catch (err: unknown) {
      this.logger.warn(
        { err },
        'Не удалось подтвердить нажатие кнопки — участие при этом уже записано',
      );
    }
  }

  /**
   * Личное сообщение участнику — best-effort. MAX не доставит первое
   * сообщение тому, кто сам не открывал диалог с ботом, так что провал здесь
   * ожидаем: счётчик на кнопке остаётся единственным общим подтверждением.
   */
  private async sendPrivately(userId: number, text: string): Promise<void> {
    try {
      await this.api.sendMessageToUser(userId, text);
    } catch (err: unknown) {
      this.logger.info(
        { err, userId },
        'Личное подтверждение участия не доставлено — у бота нет диалога с пользователем',
      );
    }
  }

  private async handleGroupReview(
    userId: number,
    callbackId: string,
    action: 'confirm' | 'reject',
    groupId: string,
  ): Promise<void> {
    const admin = await this.admins.findByMaxUserId(userId);
    if (!admin) {
      // Silence rather than "доступ запрещён": an unknown sender shouldn't
      // learn that this button maps to anything real.
      this.logger.warn(
        { userId, groupId },
        'Нажатие кнопки подтверждения группы от неизвестного пользователя — проигнорировано',
      );
      await this.api.answerCallback(callbackId);
      return;
    }

    try {
      if (action === 'confirm') {
        const group = await this.groups.confirmMaxGroup(groupId);
        await this.api.answerCallback(
          callbackId,
          `Группа «${group.title}» подключена`,
        );
      } else {
        await this.groups.rejectMaxGroup(groupId);
        await this.api.answerCallback(callbackId, 'Группа отклонена');
      }
    } catch (err: unknown) {
      // Most likely the other admin already decided, or the draft is gone —
      // the click still has to be acknowledged or the client spins forever.
      this.logger.warn(
        { err, groupId, action, adminId: admin.id },
        'Не удалось применить решение по MAX-группе',
      );
      await this.api.answerCallback(
        callbackId,
        'Не удалось применить решение — возможно, группа уже обработана',
      );
    }
  }

  /**
   * Best-effort, like the VK connection test post: MAX refuses to deliver a
   * bot's first message to a user who never opened a dialog with it, so a
   * failure here is expected rather than exceptional. The draft is already
   * saved and stays confirmable through the REST endpoints either way.
   */
  private async notifyAdminsOfPendingGroup(group: PublicGroup): Promise<void> {
    const admins = await this.admins.listNotifiableAdmins();
    if (admins.length === 0) {
      this.logger.warn(
        { groupId: group.id },
        'Нет администраторов с привязанным maxUserId — некому подтвердить группу',
      );
      return;
    }

    const kindLabel = group.kind === 'channel' ? 'канал' : 'чат';
    const text = `Бот добавлен в ${kindLabel} «${group.title}».\nПодтвердить его как цель для рассылок?`;
    const buttons = [
      [
        {
          type: 'callback' as const,
          text: 'Подтвердить',
          payload: groupReviewPayload('confirm', group.id),
        },
        {
          type: 'callback' as const,
          text: 'Отклонить',
          payload: groupReviewPayload('reject', group.id),
        },
      ],
    ];

    for (const admin of admins) {
      try {
        await this.api.sendMessageToUser(Number(admin.maxUserId), text, {
          buttons,
        });
      } catch (err: unknown) {
        this.logger.warn(
          { err, adminId: admin.id, groupId: group.id },
          'Не удалось уведомить администратора о новой MAX-группе',
        );
      }
    }
  }
}
