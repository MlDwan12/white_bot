import type { PostStatus } from '../generated/prisma/client';

/**
 * Помощники для шаблонов. Вынесены в код, а не в EJS: логика в шаблоне
 * невидима для типов и тестов, а «какого цвета бейдж у статуса» — как раз то,
 * что молча разъезжается при добавлении нового статуса.
 */

const LABELS: Record<PostStatus, string> = {
  draft: 'черновик',
  scheduled: 'запланирован',
  sending: 'отправляется',
  sent: 'отправлен',
  partially_failed: 'частично не дошёл',
  stopped: 'остановлен',
};

const COLORS: Record<PostStatus, string> = {
  draft: 'secondary',
  scheduled: 'azure',
  sending: 'blue',
  sent: 'green',
  partially_failed: 'orange',
  stopped: 'red',
};

export function statusLabel(status: PostStatus): string {
  return LABELS[status] ?? status;
}

export function statusColor(status: PostStatus): string {
  return COLORS[status] ?? 'secondary';
}

/** Дата в привычном виде и в часовом поясе сервера. */
export function formatDate(value: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}
