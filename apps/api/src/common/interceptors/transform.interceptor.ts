import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiSuccessResponse } from '../api-response.interface';

/**
 * Wraps every successful JSON response in `{ success: true, data }` so the
 * panel's API calls (and any future API) get one predictable envelope shape,
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
    return next.handle().pipe(map((data) => ({ success: true, data })));
  }
}
