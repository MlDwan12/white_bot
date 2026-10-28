import type { ContestStatus, DeliveryStatus, NotifyStatus } from './api';

export const CONTEST_STATUS: Record<ContestStatus, { label: string; color: string }> = {
  draft: { label: 'Черновик', color: 'gray' },
  open: { label: 'Идёт приём', color: 'green' },
  drawn: { label: 'Итоги подведены', color: 'blue' },
  cancelled: { label: 'Отменён', color: 'red' },
};

export const NOTIFY: Record<NotifyStatus, { label: string; color: string }> = {
  pending: { label: 'уведомление в очереди', color: 'gray' },
  sent: { label: 'уведомлён в личку', color: 'green' },
  failed: { label: 'не дошло — напишите сами', color: 'orange' },
  manual_required: { label: 'уведомить вручную', color: 'orange' },
  notified_manually: { label: 'уведомлён вручную', color: 'green' },
};

export const DELIVERY: Record<DeliveryStatus, { label: string; color: string }> = {
  pending: { label: 'ждёт отправки', color: 'gray' },
  sending: { label: 'отправляется', color: 'blue' },
  sent: { label: 'опубликовано', color: 'green' },
  failed: { label: 'ошибка', color: 'red' },
  skipped_by_stop: { label: 'остановлено', color: 'gray' },
  unknown: { label: 'исход неизвестен', color: 'orange' },
};
