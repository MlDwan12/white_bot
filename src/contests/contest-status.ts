import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import type { ContestStatus } from '../generated/prisma/client';

/**
 * Итог подведён — разыгран или отменён. Дальше конкурс не меняется: ни
 * условия, ни места, ни участники. Одно правило вместо сравнений с `drawn`
 * по всему коду — иначе отменённый конкурс прошёл бы там, где забыли.
 */
export const FINISHED_STATUSES: ContestStatus[] = ['drawn', 'cancelled'];

export function isFinished(status: ContestStatus): boolean {
  return FINISHED_STATUSES.includes(status);
}

/** Отказ для завершённого конкурса: `whenDrawn` — что сказать про разыгранный. */
export function assertNotFinished(
  status: ContestStatus,
  whenDrawn: string,
): void {
  if (status === 'drawn') {
    throw new AppException(ErrorCode.CONTEST_ALREADY_DRAWN, whenDrawn);
  }
  if (status === 'cancelled') {
    throw new AppException(
      ErrorCode.CONTEST_ALREADY_DRAWN,
      'Конкурс отменён — изменить его уже нельзя',
    );
  }
}
