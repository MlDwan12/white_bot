/**
 * Общие мелочи кнопки участия. Вынесены отдельно намеренно: их нужны и
 * отправщику постов, и сервису участия, а те уже ссылаются друг на друга —
 * без этого файла импорты замкнулись бы в кольцо.
 */

/** Полезная нагрузка кнопки участия: `contest:join:<uuid>`. */
export const CONTEST_JOIN_PAYLOAD = /^contest:join:([0-9a-fA-F-]{36})$/;

export function contestJoinPayload(contestId: string): string {
  return `contest:join:${contestId}`;
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
