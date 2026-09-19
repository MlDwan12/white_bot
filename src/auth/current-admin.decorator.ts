import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { AdminUser } from '../generated/prisma/client';
import type { AdminRequest } from './admin-auth.guard';

/**
 * Админ из текущего запроса. Кладёт его `AdminAuthGuard`, поэтому без гварда
 * декоратор вернул бы `undefined` — использовать их врозь нельзя.
 */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AdminUser =>
    context.switchToHttp().getRequest<AdminRequest>().admin,
);
