import type {
  GroupStatus,
  PostDeliveryStatus,
  PostStatus,
} from '../generated/prisma/client';

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

/**
 * Состояние доставки для человека. Отдельно от статуса в базе, потому что
 * «удалено» и «удалится по сроку» — это не статусы, а то, что случилось с
 * сообщением после отправки: сам факт отправки остаётся историей.
 */
export interface DeliveryView {
  status: PostDeliveryStatus;
  deletedAt: Date | null;
  autoDeleteDueAt: Date | null;
}

const DELIVERY_LABELS: Record<PostDeliveryStatus, string> = {
  pending: 'в очереди',
  sending: 'отправляется',
  sent: 'опубликовано',
  failed: 'ошибка',
  skipped_by_stop: 'пропущено стопом',
  unknown: 'неизвестно',
};

const DELIVERY_COLORS: Record<PostDeliveryStatus, string> = {
  pending: 'secondary',
  sending: 'blue',
  sent: 'green',
  failed: 'red',
  skipped_by_stop: 'orange',
  unknown: 'yellow',
};

export function deliveryLabel(delivery: DeliveryView): string {
  if (delivery.deletedAt) {
    return 'удалено';
  }
  return DELIVERY_LABELS[delivery.status] ?? delivery.status;
}

export function deliveryColor(delivery: DeliveryView): string {
  if (delivery.deletedAt) {
    return 'dark';
  }
  return DELIVERY_COLORS[delivery.status] ?? 'secondary';
}

const GROUP_LABELS: Record<GroupStatus, string> = {
  pending_confirmation: 'ждёт подтверждения',
  active: 'активна',
  token_invalid: 'токен не работает',
  bot_removed: 'бот удалён',
  removed: 'отключена',
};

const GROUP_COLORS: Record<GroupStatus, string> = {
  pending_confirmation: 'yellow',
  active: 'green',
  token_invalid: 'red',
  bot_removed: 'red',
  removed: 'secondary',
};

export function groupLabel(status: GroupStatus): string {
  return GROUP_LABELS[status] ?? status;
}

export function groupColor(status: GroupStatus): string {
  return GROUP_COLORS[status] ?? 'secondary';
}
