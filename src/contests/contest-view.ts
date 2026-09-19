/**
 * То, что мини-приложение показывает человеку. Собирается на сервере, а не в
 * браузере, по двум причинам: страница не должна знать лишнего, и один и тот
 * же ответ должен получаться у всех эндпоинтов, чтобы фронтенду не приходилось
 * догадываться о состоянии.
 */

export interface ContestWinnerView {
  place: number;
  /** Сокращённое имя: «Иван П.». Полная фамилия наружу не уходит. */
  name: string;
  /** Это тот, кто смотрит. */
  isMe: boolean;
}

export interface ContestView {
  id: string;
  title: string;
  /**
   * Условия — текст анонс-поста. Отдельного поля у конкурса нет намеренно:
   * описанию негде разойтись с тем, что человек прочёл в канале.
   */
  terms: string;
  status: 'draft' | 'open' | 'drawn';
  participantsCount: number;
  placesCount: number;
  joined: boolean;
  /** Пусто, пока розыгрыш не проведён. */
  winners: ContestWinnerView[];
}

/**
 * Сокращает имя до «Иван П.».
 *
 * Делается на сервере, а не на странице: обрежь фамилию в браузере — и полные
 * данные всё равно уедут каждому, кто откроет конкурс и посмотрит ответ API.
 * В базе (`PlatformUser`) полное имя, разумеется, остаётся.
 */
export function shortenName(
  displayName: string,
  firstName?: string | null,
  lastName?: string | null,
): string {
  const first = (firstName ?? '').trim();
  const last = (lastName ?? '').trim();

  if (first && last) {
    return `${first} ${firstLetter(last)}.`;
  }
  if (first) {
    return first;
  }

  // Ручной ввод даёт только `displayName` — разбираем его как «Имя Фамилия».
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return 'Участник';
  }
  if (parts.length === 1) {
    return parts[0];
  }
  return `${parts[0]} ${firstLetter(parts[1])}.`;
}

function firstLetter(value: string): string {
  // Берём символ целиком, а не первый code unit: иначе эмодзи или буква вне
  // BMP развалится на половину суррогатной пары.
  return [...value][0] ?? '';
}
