import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { CSRF_COOKIE, CSRF_HEADER } from './auth.cookies';
import { constantTimeEquals } from './session.service';
import { readCookie } from './read-cookie';

/** Методы, которые ничего не меняют, подделывать бессмысленно. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method)) {
      return true;
    }

    const fromCookie = readCookie(request, CSRF_COOKIE);
    const fromHeader = request.headers[CSRF_HEADER];
    const header = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;

    if (!fromCookie || !header || !constantTimeEquals(fromCookie, header)) {
      throw new AppException(
        ErrorCode.UNAUTHORIZED,
        'Запрос отклонён: не пройдена проверка CSRF',
      );
    }
    return true;
  }
}
