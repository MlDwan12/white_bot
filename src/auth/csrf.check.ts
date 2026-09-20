import type { Request } from 'express';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { CSRF_COOKIE, CSRF_FIELD, CSRF_HEADER } from './auth.cookies';
import { readCookie } from './read-cookie';
import { constantTimeEquals } from './session.service';

/** Методы, которые ничего не меняют, подделывать бессмысленно. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Общая проверка double-submit. Вынесена из гварда, потому что нужна в двух
 * точках жизненного цикла: обычные запросы проверяет гвард, а загрузку файла —
 * интерцептор после `FileInterceptor`. Раньше тела запроса там просто нет.
 */
export function assertCsrf(request: Request): void {
  if (SAFE_METHODS.has(request.method)) {
    return;
  }

  const fromCookie = readCookie(request, CSRF_COOKIE);
  const fromHeader = request.headers[CSRF_HEADER];
  const header = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;
  const body = request.body as Record<string, unknown> | undefined;
  const fromForm = body?.[CSRF_FIELD];
  const submitted =
    header ?? (typeof fromForm === 'string' ? fromForm : undefined);

  if (!fromCookie || !submitted || !constantTimeEquals(fromCookie, submitted)) {
    // REQUEST_ERROR, а не UNAUTHORIZED: сессия человека может быть цела, не
    // в порядке сам запрос. С 401 панель отправляла бы его на форму входа —
    // выглядело бы как «вас разлогинило», хотя это не так.
    throw new AppException(
      ErrorCode.REQUEST_ERROR,
      'Запрос отклонён: не пройдена проверка CSRF',
    );
  }
}
