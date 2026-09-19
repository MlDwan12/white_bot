import type { Attachment, AttachmentRequest } from '@maxhub/max-bot-api/types';

/**
 * Превращает вложения уже опубликованного сообщения обратно в форму запроса.
 *
 * Нужно потому, что в MAX и правка сообщения, и ответ на нажатие кнопки
 * заменяют сообщение **целиком**: передашь один текст — и картинка,
 * приложенная к анонсу, исчезнет у всех. Поэтому перед каждой такой заменой
 * медиа снимается со старого сообщения и передаётся заново.
 *
 * Клавиатура отбрасывается сознательно: её вызывающий собирает сам, и как раз
 * ради её подмены всё и затевается.
 */
export function toRequestAttachments(
  attachments: Attachment[] | undefined | null,
): AttachmentRequest[] {
  if (!attachments?.length) {
    return [];
  }

  const rebuilt: AttachmentRequest[] = [];
  for (const attachment of attachments) {
    switch (attachment.type) {
      case 'image':
      case 'video':
      case 'audio':
      case 'file':
        // Токен — это и есть ссылка на уже загруженный файл: повторно
        // заливать ничего не нужно.
        rebuilt.push({
          type: attachment.type,
          payload: { token: attachment.payload.token },
        });
        break;
      case 'sticker':
        rebuilt.push({
          type: 'sticker',
          payload: { code: attachment.payload.code },
        });
        break;
      case 'inline_keyboard':
        break;
      default:
        // Остальные типы (location, contact, share) наши посты не создают.
        // Молча терять их всё же не стоит — пусть о них узнают из логов
        // вызывающего, а не из пропавшего вложения.
        break;
    }
  }
  return rebuilt;
}

/** Типы, которые мы не умеем пересобрать, — для предупреждения в лог. */
export function unsupportedAttachmentTypes(
  attachments: Attachment[] | undefined | null,
): string[] {
  const supported = new Set([
    'image',
    'video',
    'audio',
    'file',
    'sticker',
    'inline_keyboard',
  ]);
  return [
    ...new Set(
      (attachments ?? [])
        .map((attachment) => attachment.type)
        .filter((type) => !supported.has(type)),
    ),
  ];
}
