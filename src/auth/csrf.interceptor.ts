import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { Request } from 'express';
import { assertCsrf } from './csrf.check';

/**
 * Проверка CSRF для маршрутов с загрузкой файла.
 *
 * Гвард здесь бесполезен: Nest выполняет гварды **до** интерцепторов, а тело
 * `multipart/form-data` разбирает `FileInterceptor`. На момент работы гварда
 * скрытого поля `_csrf` в теле ещё нет, и форма без JS — а панель именно
 * такая — не проходила проверку никогда.
 *
 * Ставится в `@UseInterceptors` **после** `FileInterceptor`: тогда тело уже
 * разобрано.
 */
@Injectable()
export class CsrfInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    assertCsrf(context.switchToHttp().getRequest<Request>());
    return next.handle();
  }
}
