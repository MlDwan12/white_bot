import { Permission } from '../generated/prisma/enums';
import {
  effectivePermissions,
  hasAllPermissions,
  hasPermission,
} from './permissions';
import type { AdminPrincipal } from './permissions';

const admin = (overrides: Partial<AdminPrincipal> = {}): AdminPrincipal => ({
  id: 'a1',
  role: 'admin',
  extraPermissions: [],
  ...overrides,
});

describe('permissions', () => {
  it('gives developer every permission that exists', () => {
    // Список берётся из enum в схеме, а не из самой таблицы под тестом:
    // иначе проверка сводилась бы к «таблица равна себе» и пропустила бы
    // ровно тот случай, ради которого написана — новое право, о котором
    // developer не знает.
    const all = Object.values(Permission);
    const dev = effectivePermissions(admin({ role: 'developer' }));

    expect(all.length).toBeGreaterThan(0);
    for (const permission of all) {
      expect(dev.has(permission)).toBe(true);
    }
  });

  it('keeps group management away from a plain admin', () => {
    const principal = admin();

    expect(hasPermission(principal, 'groups_view')).toBe(true);
    expect(hasPermission(principal, 'groups_manage')).toBe(false);
    expect(hasPermission(principal, 'admins_manage')).toBe(false);
  });

  it('extends a role with extra permissions', () => {
    const principal = admin({ extraPermissions: ['audit_viewAll'] });

    expect(hasPermission(principal, 'audit_viewAll')).toBe(true);
    // Добавка расширяет, а не заменяет: базовые права роли остаются.
    expect(hasPermission(principal, 'posts_manage')).toBe(true);
  });

  it('cannot take a base permission away through extras', () => {
    // Список только расширяющий — иначе у двух админов с одной ролью были бы
    // непредсказуемо разные наборы прав.
    const principal = admin({ extraPermissions: [] });

    expect(hasPermission(principal, 'contests_manage')).toBe(true);
  });

  it('requires every listed permission, not any of them', () => {
    const principal = admin();

    expect(hasAllPermissions(principal, ['posts_manage'])).toBe(true);
    // Эндпоинт с двумя правами делает две вещи; пускать туда по одному —
    // тихая дыра.
    expect(
      hasAllPermissions(principal, ['posts_manage', 'admins_manage']),
    ).toBe(false);
  });

  it('treats an empty requirement as satisfied', () => {
    expect(hasAllPermissions(admin(), [])).toBe(true);
  });
});
