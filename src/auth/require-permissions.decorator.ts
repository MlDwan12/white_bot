import { SetMetadata } from '@nestjs/common';
import type { Permission } from '../generated/prisma/client';

export const PERMISSIONS_KEY = 'requiredPermissions';

/**
 * Права, без которых эндпоинт недоступен. Требуются **все** перечисленные:
 * метод, помеченный двумя правами, делает две вещи.
 *
 * Отсутствие декоратора означает «нужен вход, но особых прав не требуется», а
 * не «можно всем»: публичность задаётся отдельно, отсутствием гварда.
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
