import { AdminRole, Permission } from '../generated/prisma/client';

/**
 * Матрица прав. Базовый набор задаётся ролью, а `extraPermissions` может его
 * только **расширить** — урезать нельзя.
 *
 * Такая однонаправленность выбрана осознанно: иначе у двух админов с одной
 * ролью были бы разные, непредсказуемые наборы прав, и ответ на вопрос «что
 * может admin?» зависел бы от конкретной строки в базе. Сейчас ответ такой:
 * «как минимум базовый набор роли, возможно больше».
 */
export const ROLE_DEFAULTS: Record<AdminRole, readonly Permission[]> = {
  // У developer есть всё; `extraPermissions` для него бессмысленны.
  developer: [
    'groups_manage',
    'groups_tags_edit',
    'groups_tokens_manage',
    'groups_pendingMax_review',
    'groups_view',
    'posts_manage',
    'contests_manage',
    'admins_manage',
    'system_health',
    'audit_viewAll',
  ],
  // admin ведёт контент: посты и конкурсы. Группы видит только затем, чтобы
  // выбрать цели рассылки, а управлять ими не может.
  admin: ['groups_view', 'posts_manage', 'contests_manage'],
};

export interface AdminPrincipal {
  id: string;
  role: AdminRole;
  extraPermissions: Permission[];
}

/** Эффективный набор прав: база роли плюс точечные добавки. */
export function effectivePermissions(admin: AdminPrincipal): Set<Permission> {
  return new Set([...ROLE_DEFAULTS[admin.role], ...admin.extraPermissions]);
}

export function hasPermission(
  admin: AdminPrincipal,
  permission: Permission,
): boolean {
  return effectivePermissions(admin).has(permission);
}

/**
 * Требуются **все** перечисленные права, а не любое из них.
 *
 * Выбор в пользу строгого «и»: эндпоинт, помеченный двумя правами, делает две
 * вещи, и разрешать его тому, у кого есть лишь одно, — тихая дыра.
 */
export function hasAllPermissions(
  admin: AdminPrincipal,
  permissions: readonly Permission[],
): boolean {
  const effective = effectivePermissions(admin);
  return permissions.every((permission) => effective.has(permission));
}
