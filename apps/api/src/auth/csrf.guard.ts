import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { CSRF_COOKIE, CSRF_HEADER } from './auth.cookies';
import { readCookie } from './read-cookie';
import { constantTimeEquals } from './session.service';

/**
 * Double-submit: сторонний сайт может заставить браузер **отправить** куки,
 * но не может их **прочитать**. Значит, тот, кто смог положить значение куки
 * в заголовок, выполняется на нашем источнике.
 *
 * `SameSite=strict` закрывает почти то же самое, но полагаться на него одного
 * — значит доверить безопасность реализации браузера и его будущим
 * послаблениям. Здесь это второй рубеж, а не единственный.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    assertCsrf(context.switchToHttp().getRequest<Request>());
    return true;
  }
}

/** Методы, которые ничего не меняют, подделывать бессмысленно. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function assertCsrf(request: Request): void {
  if (SAFE_METHODS.has(request.method)) {
    return;
  }

  const fromCookie = readCookie(request, CSRF_COOKIE);
  const fromHeader = request.headers[CSRF_HEADER];
  const submitted = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;

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
