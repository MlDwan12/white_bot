import { Prisma } from '../generated/prisma/client';

/**
 * Распознавание ошибок базы — одно место на весь код. Копии в сервисах уже
 * расходились: сырой SQL (`$executeRaw`) отдаёт не тот код, что запросы
 * клиента, и копия, не знавшая об этом, превращала штатный случай в 500.
 */

/** Ошибка адаптера pg внутри P2010 (сырой SQL). */
function driverCause(err: Prisma.PrismaClientKnownRequestError) {
  return (
    err.meta as
      | {
          driverAdapterError?: {
            cause?: { code?: unknown; originalCode?: unknown };
          };
        }
      | undefined
  )?.driverAdapterError?.cause;
}

/** Нарушение unique (P2002). */
export function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

/**
 * Нарушение внешнего ключа: строка ещё на что-то ссылается или ссылается на
 * удалённую. Запросы клиента — P2003, сырой SQL — P2010 с `originalCode:
 * '23503'` внутри (проверено живьём, 27.10.2026).
 */
export function isForeignKeyViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }
  return (
    err.code === 'P2003' ||
    (err.code === 'P2010' && driverCause(err)?.originalCode === '23503')
  );
}

/**
 * `55P03` — строка занята дольше `lock_timeout`. Приходит как P2010 с кодом
 * Postgres внутри (проверено живьём на dev-базе, 23.09.2026).
 */
export function isLockNotAvailable(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2010' &&
    driverCause(err)?.code === '55P03'
  );
}
