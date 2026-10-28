import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { AuditActorType, Prisma } from '../generated/prisma/client';
import { currentAdminId } from './request-context';
import { postHtmlToPlain } from '../common/post-html';

/**
 * Сколько дней хранится журнал. Старше — удаляется сам, раз в проход сверки.
 * Решение пользователя (27.10.2026): месяц, с возможностью увеличить — для
 * этого достаточно поменять это число.
 */
export const AUDIT_RETENTION_DAYS = 30;

/**
 * Кто сделал: админ (по id), `'system'` (сверка по расписанию) или `'bot'`
 * (действие через MAX-бота без привязанного админа). Админ — объектом, а не
 * голой строкой: опечатка в служебном значении иначе молча становилась бы
 * «id админа», запись падала бы на внешнем ключе и терялась.
 */
export type AuditActor = { adminId: string } | 'system' | 'bot';

export interface AuditEntry {
  /**
   * Обычно не нужен: в HTTP-запросе автор — вошедший админ (см.
   * `request-context`), вне запроса — «автоматика». Явно — для бота.
   */
  actor?: AuditActor;
  /** Код действия: `contest.draw`, `post.send`… */
  action: string;
  entityType?: string;
  entityId?: string | null;
  /** Готовая фраза для таблицы в панели. */
  summary: string;
  details?: Prisma.InputJsonValue;
}

/**
 * Журнал действий. Запись — best-effort и **после** действия, не в его
 * транзакции (вариант А, решение пользователя): сбой здесь теряет строку
 * журнала, но не отменяет то, что уже сделано, и не превращается в ошибку
 * запроса. От журнала ничто в системе не зависит — журнал розыгрыша
 * (честность итогов) живёт отдельно, в `ContestDrawLog`.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuditService.name);
  }

  async record(entry: AuditEntry): Promise<void> {
    const { actorType, actorId } = resolveActor(entry.actor);
    try {
      await this.prisma.auditLog.create({
        data: {
          actorType,
          actorId,
          action: entry.action,
          entityType: entry.entityType ?? null,
          entityId: entry.entityId ?? null,
          summary: entry.summary,
          details: entry.details,
        },
      });
    } catch (err: unknown) {
      this.logger.error(
        { err, action: entry.action, entityId: entry.entityId },
        'Не удалось записать действие в журнал',
      );
    }
  }

  /**
   * Последние записи — новые сверху. «Показать ещё» — курсором по паре
   * (время, id) последней показанной записи: граница по одному времени
   * теряла бы записи той же миллисекунды, а курсор по одному id обрывал бы
   * список, если ту запись уже удалила автоочистка.
   */
  async list(
    options: {
      limit?: number;
      beforeAt?: Date;
      beforeId?: string;
      /** Id админа или `system` / `bot`. */
      actor?: string;
      /** Начало кода действия: `contest.` — все действия с конкурсами. */
      actionPrefix?: string;
      since?: Date;
      /** Подстрока текста записи. */
      q?: string;
    } = {},
  ) {
    const { beforeAt, beforeId, actor, actionPrefix, since, q } = options;
    const filters: Prisma.AuditLogWhereInput[] = [];
    if (beforeAt) {
      filters.push({
        OR: [
          { at: { lt: beforeAt } },
          ...(beforeId ? [{ at: beforeAt, id: { lt: beforeId } }] : []),
        ],
      });
    }
    if (actor === 'system' || actor === 'bot') {
      filters.push({ actorType: actor });
    } else if (actor) {
      filters.push({ actorId: actor });
    }
    if (actionPrefix) filters.push({ action: { startsWith: actionPrefix } });
    if (since) filters.push({ at: { gte: since } });
    if (q) filters.push({ summary: { contains: q, mode: 'insensitive' } });
    return this.prisma.auditLog.findMany({
      where: { AND: filters },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: options.limit ?? 100,
      include: { actor: { select: { id: true, email: true } } },
    });
  }

  /**
   * Ручная очистка: всё или записи старше `before`. След очистки — в той же
   * транзакции (вариант А для неё не годится: удаление без следа и есть то,
   * от чего след защищает), а прежние следы очисток ручная очистка не
   * трогает — иначе второй очисткой стирался бы след первой. Их убирает
   * только автоочистка по сроку.
   */
  async clear(actorId: string, before?: Date): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        const { count } = await tx.auditLog.deleteMany({
          where: {
            action: { not: 'audit.clear' },
            ...(before ? { at: { lt: before } } : {}),
          },
        });
        await tx.auditLog.create({
          data: {
            actorType: 'admin',
            actorId,
            action: 'audit.clear',
            summary: before
              ? `Очистил журнал до ${before.toISOString().slice(0, 16).replace('T', ' ')} UTC: удалено ${count}`
              : `Очистил журнал целиком: удалено ${count}`,
            details: { before: before?.toISOString() ?? null, deleted: count },
          },
        });
        return count;
        // Полная очистка месяца записей (с текстами «было → стало») может
        // идти дольше стандартных 5 с — откат оставил бы всё как было.
      },
      { timeout: 60_000 },
    );
  }

  /** Автоочистка по сроку хранения — зовёт сверка. */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const { count } = await this.prisma.auditLog.deleteMany({
      where: { at: { lt: cutoff } },
    });
    return count;
  }
}

function resolveActor(actor: AuditActor | undefined): {
  actorType: AuditActorType;
  actorId: string | null;
} {
  if (actor === 'bot') {
    return { actorType: 'bot', actorId: null };
  }
  if (actor === 'system') {
    return { actorType: 'system', actorId: null };
  }
  const adminId = typeof actor === 'object' ? actor.adminId : currentAdminId();
  return adminId
    ? { actorType: 'admin', actorId: adminId }
    : { actorType: 'system', actorId: null };
}

/**
 * «Сохранение формы без правки — не действие»: одно правило для всех мест,
 * где журнал пишет «было → стало». Сравнение по значению; порядок ключей —
 * тот, в каком их собирает вызывающий (один и тот же для «было» и «стало»).
 */
export function changed(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

/** Начало текста поста — для строки журнала. */
export function postSnippet(text: string | null | undefined): string {
  // Строка журнала не должна ронять действие, ради которого пишется.
  const flat = postHtmlToPlain(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  // По символам, а не UTF-16: эмодзи (частые в постах) — пара суррогатов,
  // и разрезанная пополам превратилась бы в «�».
  const chars = Array.from(flat);
  return chars.length > 50 ? `${chars.slice(0, 49).join('')}…` : flat;
}
