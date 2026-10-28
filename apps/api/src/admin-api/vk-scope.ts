import type { AdminUser } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { zonedToUtc } from '../common/zoned-time';
import { vkEnabled } from '../vk/vk-enabled';

/**
 * VK у роли admin скрыт целиком: его каналы в ответы не попадают, а правки
 * admin их не трогают. Единственное место этого правила для всех `*-api`.
 * При выключенном VK (`VK_ENABLED`) он скрыт у всех.
 */
export function showVk(admin: AdminUser): boolean {
  return vkEnabled() && admin.role === 'developer';
}

/** VK-каналы из списка — те, что admin не видит. */
export async function hiddenVkIds(
  prisma: PrismaService,
  admin: AdminUser,
  ids: string[],
): Promise<string[]> {
  if (showVk(admin) || ids.length === 0) {
    return [];
  }
  const rows = await prisma.group.findMany({
    where: { id: { in: ids }, platform: 'vk' },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** У admin выбор каналов — только среди MAX; VK из запроса отбрасывается. */
export async function withoutVk(
  prisma: PrismaService,
  admin: AdminUser,
  ids: string[],
): Promise<string[]> {
  const hidden = await hiddenVkIds(prisma, admin, ids);
  return ids.filter((id) => !hidden.includes(id));
}

/** «Настенное» время из `datetime-local` в поясе `DEFAULT_TIMEZONE`. */
export function parseLocal(
  value: string | undefined,
  timeZone: string,
): Date | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = zonedToUtc(value, timeZone);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      'Не удалось разобрать дату',
    );
  }
  return parsed;
}
