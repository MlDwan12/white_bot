import { Platform } from '../generated/prisma/client';

/**
 * Участники приходят двумя путями. Основной — нажатие кнопки под анонс-постом:
 * платформа сама сообщает id и имя. Запасной — админ вставляет список руками,
 * когда кнопка почему-то не сработала; формат строки задан в `PLAN.md`:
 * «Имя + ссылка/ник», например `Иван Иванов, vk.com/id123` или `Иван Иванов
 * @max_nick`.
 */

export interface ParticipantIdentity {
  platform: Platform;
  /** Null, если в строке не нашлось ни ссылки, ни ника. */
  externalUserId: string | null;
  /**
   * Чем именно является `externalUserId`. Различать обязательно: уведомить
   * автоматически можно только по числовому id, а ник для этого бесполезен.
   */
  externalUserIdKind?: 'id' | 'handle';
  displayName: string;
}

/**
 * Ключ дедупликации. Группа в него намеренно не входит: пул участников общий
 * на весь конкурс, поэтому нажатие кнопки в двух разных группах — один и тот
 * же человек, а не два, иначе у него удвоился бы шанс выиграть.
 *
 * Человек без id склеивается только по точному (с точностью до регистра и
 * пробелов) совпадению имени — слабее, чем по id, но это всё, что о нём
 * известно.
 */
export function buildDedupKey(identity: ParticipantIdentity): string {
  if (identity.externalUserId) {
    // Ник и числовой id — разные пространства имён, и одно в другое не
    // переводится: платформа не даёт поиска пользователя по нику. Поэтому
    // ключи разведены явно. Цена — человек, вписанный админом по нику, и он
    // же, нажавший кнопку, останутся двумя строками; склеить их может только
    // глаз админа, и лучше честно это показать, чем делать вид, что дедуп
    // сработал.
    if (identity.externalUserIdKind === 'handle') {
      // Ники на обеих платформах регистронезависимы: `@Nick` и `@nick` —
      // один человек, и без приведения к нижнему регистру он получил бы две
      // строки в пуле и удвоенный шанс.
      return `${identity.platform}:handle:${identity.externalUserId.toLowerCase()}`;
    }
    return `${identity.platform}:id:${identity.externalUserId}`;
  }
  return `name:${normalizeName(identity.displayName)}`;
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

const VK_NUMERIC_ID = /(?:https?:\/\/)?(?:m\.)?vk\.com\/id(\d+)\b/i;
const VK_SCREEN_NAME = /(?:https?:\/\/)?(?:m\.)?vk\.com\/([a-z0-9._]+)/i;
const MAX_HANDLE = /(?:^|\s)@([a-z0-9._]+)/i;

export interface ParsedParticipantLine extends ParticipantIdentity {
  /** Номер строки во вставленном тексте — чтобы показать, что не разобралось. */
  lineNumber: number;
}

/**
 * Разбирает вставленный список. Пустые строки пропускаются; строка, в которой
 * не нашлось ни ссылки, ни ника, всё равно становится участником — просто без
 * id, и тогда уведомить его автоматически будет нечем.
 */
export function parseParticipantLines(
  text: string,
  fallbackPlatform: Platform,
): ParsedParticipantLine[] {
  const parsed: ParsedParticipantLine[] = [];

  text.split('\n').forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;

    const identity = parseLine(line, fallbackPlatform);
    parsed.push({ ...identity, lineNumber: index + 1 });
  });

  return parsed;
}

function parseLine(
  line: string,
  fallbackPlatform: Platform,
): ParticipantIdentity {
  const vkNumeric = VK_NUMERIC_ID.exec(line);
  if (vkNumeric) {
    return {
      platform: Platform.vk,
      externalUserId: vkNumeric[1],
      externalUserIdKind: 'id',
      displayName: stripToken(line, vkNumeric[0]),
    };
  }

  const vkScreenName = VK_SCREEN_NAME.exec(line);
  if (vkScreenName) {
    return {
      platform: Platform.vk,
      externalUserId: vkScreenName[1],
      externalUserIdKind: 'handle',
      displayName: stripToken(line, vkScreenName[0]),
    };
  }

  const maxHandle = MAX_HANDLE.exec(line);
  if (maxHandle) {
    return {
      platform: Platform.max,
      externalUserId: maxHandle[1],
      externalUserIdKind: 'handle',
      displayName: stripToken(line, maxHandle[0]),
    };
  }

  return {
    platform: fallbackPlatform,
    externalUserId: null,
    displayName: normalizeDisplayName(line),
  };
}

/** Убирает распознанную ссылку/ник из строки, оставляя имя. */
function stripToken(line: string, token: string): string {
  const name = normalizeDisplayName(line.replace(token, ' '));
  // Строка без имени («просто ссылка») — имя подставится из платформы позже,
  // а пока пусть ссылка и будет подписью, лишь бы не пустая.
  return name || token.trim();
}

function normalizeDisplayName(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;–-]+|[\s,;–-]+$/g, '')
    .trim();
}
