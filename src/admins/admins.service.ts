import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { PrismaService } from '../prisma/prisma.service';
import { AdminRole, AdminUser, Prisma } from '../generated/prisma/client';
import { PasswordService } from '../auth/password.service';
import { SessionService } from '../auth/session.service';
import { isValidAdminEmail, normalizeAdminEmail } from '../auth/admin-email';

/** Админ в списке панели — без хеша пароля. */
export interface AdminSummary {
  id: string;
  email: string;
  role: AdminRole;
  maxUserId: string | null;
  createdAt: Date;
  disabledAt: Date | null;
}

export interface IssuedPassword {
  admin: AdminSummary;
  /** Показывается один раз — в базе только хеш. */
  password: string;
}

/**
 * Управление админами из панели. Удаления нет — только отключение: на строке
 * админа держатся сессии и журнал розыгрышей («кто провёл»), и удалить её
 * значило бы потерять ответ на вопрос «кто это сделал».
 *
 * Два инварианта охраняются здесь, а не в панели:
 * - нельзя отключить или понизить **себя** — иначе одним кликом легко
 *   остаться снаружи собственной панели;
 * - нельзя оставить систему без **активного developer**: только у него есть
 *   `admins_manage`, и без него вернуть доступ можно было бы лишь с сервера.
 */
@Injectable()
export class AdminsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
  ) {}

  async list(): Promise<AdminSummary[]> {
    const admins = await this.prisma.adminUser.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return admins.map(toSummary);
  }

  async create(input: {
    email: string;
    role: AdminRole;
    maxUserId?: string | null;
  }): Promise<IssuedPassword> {
    const email = normalizeAdminEmail(input.email);
    if (!isValidAdminEmail(email)) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Непохоже на email. Нужен домен с точкой, например admin@example.com',
      );
    }
    const role = parseRole(input.role);
    const maxUserId = parseMaxUserId(input.maxUserId);
    const password = generatePassword();

    try {
      const admin = await this.prisma.adminUser.create({
        data: {
          email,
          role,
          maxUserId,
          passwordHash: await this.passwords.hash(password),
          extraPermissions: [],
        },
      });
      return { admin: toSummary(admin), password };
    } catch (err: unknown) {
      throw uniqueToValidation(err);
    }
  }

  /** Роль и MAX id. Себя понизить нельзя, последнего developer — тоже. */
  async update(
    id: string,
    input: { role: AdminRole; maxUserId?: string | null },
    actorId: string,
  ): Promise<AdminSummary> {
    const target = await this.require(id);
    const role = parseRole(input.role);
    const maxUserId = parseMaxUserId(input.maxUserId);

    if (target.role === 'developer' && role !== 'developer') {
      if (target.id === actorId) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Свою роль понизить нельзя — это сделает другой developer',
        );
      }
    }

    try {
      const admin = await this.prisma.$transaction(async (tx) => {
        if (target.role === 'developer' && role !== 'developer') {
          await this.assertAnotherActiveDeveloper(tx, target.id);
        }
        return tx.adminUser.update({
          where: { id },
          data: { role, maxUserId },
        });
      });
      return toSummary(admin);
    } catch (err: unknown) {
      throw uniqueToValidation(err);
    }
  }

  /** Новый пароль вместо забытого; старые сессии гаснут — старым паролем уже никто не сидит. */
  async resetPassword(id: string): Promise<IssuedPassword> {
    await this.require(id);
    const password = generatePassword();
    const admin = await this.prisma.adminUser.update({
      where: { id },
      data: { passwordHash: await this.passwords.hash(password) },
    });
    await this.sessions.revokeAll(id);
    return { admin: toSummary(admin), password };
  }

  /**
   * Отключение действует сразу: сессии гасятся (обновить вход нечем), а
   * текущий access-токен перестаёт приниматься, потому что админ
   * перечитывается из базы на каждом запросе и отключённый там отвергается.
   */
  async disable(id: string, actorId: string): Promise<AdminSummary> {
    const target = await this.require(id);
    if (target.id === actorId) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Себя отключить нельзя — это сделает другой developer',
      );
    }
    if (target.disabledAt) {
      return toSummary(target);
    }
    const admin = await this.prisma.$transaction(async (tx) => {
      if (target.role === 'developer') {
        await this.assertAnotherActiveDeveloper(tx, target.id);
      }
      return tx.adminUser.update({
        where: { id },
        data: { disabledAt: new Date() },
      });
    });
    await this.sessions.revokeAll(id);
    return toSummary(admin);
  }

  async enable(id: string): Promise<AdminSummary> {
    await this.require(id);
    const admin = await this.prisma.adminUser.update({
      where: { id },
      data: { disabledAt: null },
    });
    return toSummary(admin);
  }

  /**
   * Внутри транзакции, которая следом и отключает/понижает: активные
   * developer'ы блокируются `FOR UPDATE`. Иначе двое, одновременно
   * отключающие друг друга, оба увидели бы «есть ещё один» — и не осталось
   * бы никого. Второй ждёт первого и после его коммита перечитывает строки
   * уже с новым `disabledAt`/ролью.
   */
  private async assertAnotherActiveDeveloper(
    tx: Prisma.TransactionClient,
    exceptId: string,
  ): Promise<void> {
    const active = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "AdminUser"
      WHERE role = 'developer' AND "disabledAt" IS NULL
      FOR UPDATE`;
    const others = active.filter((row) => row.id !== exceptId).length;
    if (others === 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Это последний активный developer: без него управлять админами будет некому',
      );
    }
  }

  private async require(id: string): Promise<AdminUser> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!admin) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Админ не найден');
    }
    return admin;
  }
}

function toSummary(admin: AdminUser): AdminSummary {
  return {
    id: admin.id,
    email: admin.email,
    role: admin.role,
    maxUserId: admin.maxUserId,
    createdAt: admin.createdAt,
    disabledAt: admin.disabledAt,
  };
}

/**
 * Пароль не задаётся руками, а генерируется: набранный человеком почти
 * наверняка слабее и уже где-то используется. Та же длина, что у
 * `seed-admin`.
 */
function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

function parseRole(role: unknown): AdminRole {
  if (role !== 'developer' && role !== 'admin') {
    throw new AppException(ErrorCode.VALIDATION_ERROR, 'Неизвестная роль');
  }
  return role;
}

/**
 * MAX user id — число, которое бот сообщает в ответ на `/start`. Пусто —
 * не привязан: такой админ не получает уведомлений бота и не может
 * подтверждать группы из чата.
 */
function parseMaxUserId(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    return null;
  }
  if (!/^\d{1,20}$/.test(trimmed)) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      'MAX user id — это число; бот присылает его в ответ на /start',
    );
  }
  return trimmed;
}

function uniqueToValidation(err: unknown): unknown {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002'
  ) {
    const target = JSON.stringify(err.meta ?? {});
    return new AppException(
      ErrorCode.VALIDATION_ERROR,
      target.includes('maxUserId')
        ? 'Этот MAX user id уже привязан к другому админу'
        : 'Админ с таким email уже есть',
    );
  }
  return err;
}
