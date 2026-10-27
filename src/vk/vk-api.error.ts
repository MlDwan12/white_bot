/** Wraps a VK API error response ({ error: { error_code, error_msg } }). */
export class VkApiError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Наш код для отказа сервера загрузки файлов. Он отвечает вне обычного
 * конверта API, своего числового кода не даёт, а отказ однозначен — до
 * `wall.post` дело не дошло. Отличается от 0 (обрыв сети, «могло и
 * пройти»), чтобы доставка считала это окончательной ошибкой.
 */
export const VK_UPLOAD_REJECTED = -1;
