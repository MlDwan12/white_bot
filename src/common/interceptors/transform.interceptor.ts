import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiSuccessResponse } from '../api-response.interface';
import { isPanelRequest } from '../panel.constants';

/**
 * Wraps every successful JSON response in `{ success: true, data }` so panel
 * AJAX calls (and any future API) get one predictable envelope shape,
 * matching the error envelope built by AllExceptionsFilter.
 */
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<
  T,
  ApiSuccessResponse<T> | T
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiSuccessResponse<T> | T> {
    // Страница панели возвращает модель для шаблона. Заверни её — и шаблон
    // получит `success`/`data` вместо своих полей, а рендер тихо развалится.
    const request = context.switchToHttp().getRequest<{ path?: string }>();
    if (isPanelRequest(request.path)) {
      return next.handle();
    }
    return next.handle().pipe(map((data) => ({ success: true, data })));
  }
}
