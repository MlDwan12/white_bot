import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { assertCsrf } from './csrf.check';

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
