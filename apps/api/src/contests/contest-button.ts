/**
 * Общие мелочи кнопки участия. Вынесены отдельно намеренно: их нужны и
 * отправщику постов, и сервису участия, а те уже ссылаются друг на друга —
 * без этого файла импорты замкнулись бы в кольцо.
 */
import type { MaxApiClient } from '../max/max-api.client';

/** Полезная нагрузка кнопки участия: `contest:join:<uuid>`. */
export const CONTEST_JOIN_PAYLOAD = /^contest:join:([0-9a-fA-F-]{36})$/;

export function contestJoinPayload(contestId: string): string {
  return `contest:join:${contestId}`;
}

/**
 * Метка запуска бота: `c_<uuid>`. Приходит в `bot_started`, когда человек,
 * перейдя по ссылке с кнопки, нажал в диалоге «Начать».
 *
 * Двоеточий, как у `contest:join:…`, здесь нет намеренно: метка едет в
 * параметре адреса `?start=`, а не в теле колбэка, поэтому взяты только
 * буквы, цифры, дефис и подчёркивание — самое безопасное для адреса.
 * Проверено живьём: MAX принимает такую метку в ссылке, отдаёт её в
 * `bot_started`, и событие приходит при **каждом** переходе по ссылке — в том
 * числе у человека, диалог которого с ботом уже открыт (наблюдалось на одном
 * аккаунте при повторных нажатиях). Именно на этом держится участие: кнопка
 * — ссылка, и регистрирует человека только это событие.
 */
export const CONTEST_START_PAYLOAD = /^c_([0-9a-fA-F-]{36})$/;

export function contestStartPayload(contestId: string): string {
  return `c_${contestId}`;
}

/**
 * Ссылка, по которой открывается диалог с ботом и запускается его старт с
 * меткой конкурса. Без имени бота ссылки нет: оно известно только после
 * старта опроса (`getMyInfo`), и в первые секунды после запуска кнопка
 * остаётся колбэком — это лучше, чем ссылка в никуда.
 */
export function contestDmUrl(
  botUsername: string | null | undefined,
  contestId: string,
): string | null {
  return botUsername
    ? `https://max.ru/${botUsername}?start=${contestStartPayload(contestId)}`
    : null;
}

export type ContestKeyboardButton =
  | { type: 'callback'; text: string; payload: string }
  | { type: 'link'; text: string; url: string };

/**
 * Клавиатура под анонсом конкурса — **единственное** место, где она
 * собирается. Кнопка одна.
 *
 * Обычно это ссылка на бота: человек попадает в диалог, нажимает «Начать», и
 * по событию `bot_started` бот фиксирует участие и уже может ему писать. Одна
 * кнопка вместо двух (сперва была отдельная ссылка «Итоги в личку») — по
 * решению владельца: две смотрелись громоздко, а диалог у каждого участника
 * так открыт всегда.
 *
 * Без имени бота ссылку собрать нельзя (оно известно только после старта
 * опроса), и тогда остаётся прежняя кнопка с колбэком: нажатие по-прежнему
 * записывает участие, просто без личного диалога. Она же обслуживает посты,
 * опубликованные до перехода на ссылку.
 *
 * Пять мест перерисовывают этот пост (отправка, правка, ответ на нажатие,
 * подмена после розыгрыша, счётчик после старта бота), и ответ на колбэк в
 * MAX заменяет сообщение целиком: соберись клавиатура хоть в одном из них
 * по-своему, кнопка менялась бы после первого же клика.
 */
export function contestKeyboard(
  main: { text: string; payload: string },
  dmUrl: string | null,
): ContestKeyboardButton[][] {
  return [
    [
      dmUrl
        ? { type: 'link', text: main.text, url: dmUrl }
        : { type: 'callback', ...main },
    ],
  ];
}

/**
 * Клавиатура анонса по его текущему виду — или `undefined`, если кнопки нет
 * (конкурс отменён): правка без кнопок снимает клавиатуру.
 */
export function announcementKeyboard(
  view: { buttonText: string | null; payload: string },
  contestId: string,
  botUsername: string | null,
): ContestKeyboardButton[][] | undefined {
  return view.buttonText
    ? contestKeyboard(
        { text: view.buttonText, payload: view.payload },
        contestDmUrl(botUsername, contestId),
      )
    : undefined;
}

/** То, что нужно от клиента MAX для перерисовки анонса. */
type AnnouncementEditor = Pick<
  MaxApiClient,
  'botUsername' | 'getMessageBody' | 'editMessage'
>;

/**
 * Перерисовывает все сообщения анонса под текущий вид. Одна реализация на
 * обоих — подмену после розыгрыша/отмены и счётчик после вступления: две
 * копии этого цикла уже расходились.
 *
 * Правка заменяет сообщение целиком, поэтому вложения снимаются с текущей
 * версии и передаются заново — иначе картинка анонса исчезла бы у всех.
 * Сбой по одному сообщению не мешает остальным; о нём сообщает `onError`.
 */
export async function rewriteAnnouncement(
  api: AnnouncementEditor,
  contestId: string,
  view: {
    text: string;
    buttonText: string | null;
    payload: string;
    messageIds: string[];
  },
  onError: (err: unknown, messageId: string) => void,
  onDropped: (dropped: string[]) => void,
): Promise<void> {
  const buttons = announcementKeyboard(view, contestId, api.botUsername());
  for (const messageId of view.messageIds) {
    try {
      const current = await api.getMessageBody(messageId);
      if (current.unsupported.length > 0) {
        onDropped(current.unsupported);
      }
      await api.editMessage(messageId, view.text, {
        attachments: current.attachments,
        buttons,
        html: true,
      });
    } catch (err: unknown) {
      onError(err, messageId);
    }
  }
}

/**
 * Поздравление победителя. Одно место для текста: его шлёт и уведомитель при
 * розыгрыше, и обработчик старта бота, когда победитель открыл диалог позже.
 * Две копии разошлись бы при первой же правке формулировки, и человек получал
 * бы разное в зависимости от того, каким путём до него дошло.
 */
export function winnerCongratulation(
  place: number,
  contestTitle: string,
  prizeLabel: string,
): string {
  return `Поздравляем! Вы заняли ${place} место в конкурсе «${contestTitle}»: ${prizeLabel}.`;
}

/**
 * Подпись кнопки со счётчиком участников. Пока никто не записался, счётчик не
 * показывается — «Участвовать (0)» выглядит как поломка, а не как приглашение.
 */
export function joinButtonText(
  label: string,
  participantCount: number,
): string {
  return participantCount > 0 ? `${label} (${participantCount})` : label;
}

/**
 * Текст анонса с учётом итогов. Единственное место, где он собирается:
 * иначе следующее нажатие кнопки перерисовало бы пост исходным текстом и
 * стёрло победителей, которых дописал розыгрыш.
 */
export function announcementText(
  postText: string,
  winnersList: string | null,
): string {
  return winnersList ? `${postText}\n\nПобедители:\n${winnersList}` : postText;
}

/**
 * Кнопка продления в предупреждении админам «участников нет»:
 * `contest:extend:<uuid>:<дней>`. Дни — из короткого списка, а не любое
 * число из нажатия: полезную нагрузку можно подделать.
 */
export const CONTEST_EXTEND_PAYLOAD =
  /^contest:extend:([0-9a-fA-F-]{36}):(1|3)$/;

export function contestExtendPayload(contestId: string, days: 1 | 3): string {
  return `contest:extend:${contestId}:${days}`;
}

/**
 * Кнопка «Проверить подписку» в лс: `contest:check:<uuid>`. Отдельная от
 * `contest:join:…` намеренно — ответ на колбэк заменяет сообщение, на котором
 * сидит кнопка, и обработчик кнопки под анонсом перерисовал бы личное
 * сообщение текстом анонса.
 */
export const CONTEST_CHECK_PAYLOAD = /^contest:check:([0-9a-fA-F-]{36})$/;

export function contestCheckPayload(contestId: string): string {
  return `contest:check:${contestId}`;
}

/** Длинное название канала растянуло бы кнопку на весь экран. */
const CHANNEL_BUTTON_TITLE_MAX = 40;

/**
 * Сообщение человеку, не выполнившему условие подписки: по кнопке-ссылке на
 * каждый канал и «Проверить подписку» последней строкой — после неё участие
 * записывается без повторного перехода по ссылке из поста.
 */
export function subscriptionKeyboard(
  missing: { title: string; link: string | null }[],
  contestId: string,
): ContestKeyboardButton[][] {
  const rows: ContestKeyboardButton[][] = missing.flatMap((channel) =>
    channel.link
      ? [
          [
            {
              type: 'link' as const,
              text: `Подписаться: ${truncate(channel.title, CHANNEL_BUTTON_TITLE_MAX)}`,
              url: channel.link,
            },
          ],
        ]
      : [],
  );
  rows.push([
    {
      type: 'callback',
      text: 'Проверить подписку',
      payload: contestCheckPayload(contestId),
    },
  ]);
  return rows;
}

export function notSubscribedText(missing: { title: string }[]): string {
  const list = missing.map((channel) => `• ${channel.title}`).join('\n');
  return `Чтобы участвовать, подпишитесь:\n${list}\n\nЗатем нажмите «Проверить подписку».`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
