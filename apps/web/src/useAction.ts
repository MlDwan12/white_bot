import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

export interface Notice {
  color: 'green' | 'red' | 'orange';
  text: string;
}

/**
 * Действие над конкурсом с сообщением об итоге вместо тихого успеха.
 * Отказ здесь — рядовое состояние («розыгрыш уже проведён», «участников
 * меньше, чем мест»), поэтому показывается текстом сервера.
 */
export function useAction(
  contestId: string,
  /** Что сбросить после действия; по умолчанию — конкурс, его участники и список. */
  invalidate: unknown[][] = [['contest', contestId], ['participants', contestId], ['contests']],
  /** Итог, с которым на страницу пришли (например, отказ публикации из мастера). */
  initial: Notice | null = null,
) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(initial);
  const [pending, setPending] = useState(false);

  const run = async (action: () => Promise<unknown>, ok: string | ((result: unknown) => Notice)) => {
    setPending(true);
    setNotice(null);
    try {
      const result = await action();
      setNotice(typeof ok === 'string' ? { color: 'green', text: ok } : ok(result));
      return true;
    } catch (err) {
      setNotice({ color: 'red', text: err instanceof ApiError ? err.message : 'Не удалось выполнить действие' });
      return false;
    } finally {
      setPending(false);
      // И после отказа: состояние могли поменять параллельно (сверка разыграла).
      await Promise.all(invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    }
  };

  return { run, notice, setNotice, pending };
}

/** Сводка правки опубликованного: сколько каналов обновилось, где отказ. */
export function outcomeNotice(result: unknown, ok: string): Notice {
  const outcome = (result as { outcome?: { succeeded: number; failed: { groupTitle: string; error: string }[] } | null })
    ?.outcome;
  if (!outcome || outcome.failed.length === 0) {
    return { color: 'green', text: ok };
  }
  const failed = outcome.failed.map((f) => `«${f.groupTitle}»: ${f.error}`).join('; ');
  return {
    color: outcome.succeeded > 0 ? 'orange' : 'red',
    text: `${outcome.succeeded > 0 ? 'Обновлено не везде' : 'Не обновилось'} — ${failed}`,
  };
}

export type Run = ReturnType<typeof useAction>['run'];
