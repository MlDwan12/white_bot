/**
 * Ответы JSON API (`/api`, `/auth`, `/audit`) — общие для `apps/api` и
 * `apps/web`. Только типы: в рантайме пакета нет, импортировать — `import type`.
 *
 * Даты здесь — строки: так их видит браузер после JSON. Сервер собирает
 * ответ с `Date` и проверяет форму через `Wire<T>`.
 */

// --- Вход, конкурсы, посты ---

export interface Me {
  id: string;
  email: string;
  role: string;
  permissions: string[];
  /** `DEFAULT_TIMEZONE`: в нём панель показывает даты и сервер читает их ввод. */
  timeZone: string;
}

export type ContestStatus = 'draft' | 'open' | 'drawn' | 'cancelled';

export type NotifyStatus =
  | 'pending'
  | 'sent'
  | 'failed'
  | 'manual_required'
  | 'notified_manually';

export interface ContestSummary {
  id: string;
  title: string;
  status: ContestStatus;
  createdAt: string;
  startsAt: string | null;
  endsAt: string | null;
  scheduledAt: string | null;
  drawnAt: string | null;
  participantsCount: number;
  placesCount: number;
  imageMediaId: string | null;
  channels: string[];
  requiredGroups: string[];
  winners: { place: number; name: string; notifyStatus: NotifyStatus }[];
}

export interface Media {
  id: string;
  filename: string;
  kind: 'image' | 'document' | 'video';
}

export interface ChannelOption {
  id: string;
  title: string;
  platform: 'max' | 'vk';
  kind: 'community' | 'chat' | 'channel';
  tags: string[];
}

export type DeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped_by_stop' | 'unknown';

export interface ContestDetails {
  id: string;
  title: string;
  status: ContestStatus;
  createdAt: string;
  startsAt: string | null;
  endsAt: string | null;
  joinButtonLabel: string;
  resultsButtonLabel: string;
  notifyWinners: boolean;
  publishResultsInPost: boolean;
  participantsCount: number;
  participantsLastDay: number;
  post: {
    id: string;
    status: string;
    text: string;
    attachments: Media[];
    deliveries: {
      groupId: string;
      title: string;
      platform: 'max' | 'vk';
      status: DeliveryStatus;
      error: string | null;
    }[];
  } | null;
  requiredGroups: { id: string; title: string; status: string }[];
  prizes: {
    id: string;
    place: number;
    label: string;
    isForced: boolean;
    notifyStatus: NotifyStatus;
    notifyError: string | null;
    winner: { id: string; name: string; source: 'button' | 'manual' } | null;
  }[];
  prizesEditable: boolean;
  drawLogs: {
    id: string;
    kind: 'draw' | 'override';
    drawnAt: string;
    actor: string | null;
    note: string | null;
    seed: string | null;
    poolSize: number | null;
    disqualified: number | null;
    place: number | null;
    previous: string | null;
    next: string | null;
  }[];
}

export interface ParticipantsPage {
  total: number;
  pageSize: number;
  items: {
    id: string;
    name: string;
    group: string | null;
    joinedAt: string;
    source: 'button' | 'manual';
  }[];
}

export type FunnelStats = Record<string, number>;

export type PostStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'partially_failed' | 'stopped';

export interface PostSummary {
  id: string;
  text: string;
  status: PostStatus;
  createdAt: string;
  scheduledAt: string | null;
  total: number;
  sent: number;
  failed: number;
  pending: number;
  skipped: number;
  unknown: number;
  firstError: { groupTitle: string; platform: 'max' | 'vk'; error: string } | null;
}

export interface PostDetails {
  contestId: null;
  id: string;
  status: PostStatus;
  text: string;
  vkTextOverride: string | null;
  maxTextOverride: string | null;
  createdAt: string;
  scheduledAt: string | null;
  autoDeleteAfterMinutes: number | null;
  stopRequested: boolean;
  attachments: Media[];
  deliveries: {
    groupId: string;
    title: string;
    platform: 'max' | 'vk';
    status: DeliveryStatus;
    error: string | null;
    sentAt: string | null;
    deletedAt: string | null;
    autoDeleteDueAt: string | null;
    published: boolean;
  }[];
  directMessages: Record<string, number>;
}

export interface ModerationOutcome {
  succeeded: number;
  failed: { groupId: string; groupTitle: string; error: string }[];
}

export interface PlatformUser {
  id: string;
  externalUserId: string;
  displayName: string;
  username: string | null;
}

// --- Статистика ---

export interface StatsReport {
  days: number;
  posts: { sent: number; channels: number };
  deliveries: { attempted: number; failed: number; firstTry: number };
  contests: { drawn: number; open: number };
  participants: { total: number; unique: number };
  weekly: { week: string; count: number }[];
  channels: {
    id: string;
    title: string;
    platform: 'max' | 'vk';
    delivered: number | null;
    participants: number;
  }[];
  admins: {
    id: string;
    email: string;
    posts: number;
    contests: number;
    lastSeenAt: string | null;
  }[];
}

// --- Админы ---

export interface AdminRow {
  id: string;
  email: string;
  role: 'admin' | 'developer';
  maxUserId: string | null;
  createdAt: string;
  disabledAt: string | null;
  lastSeenAt: string | null;
}

export interface IssuedAdmin {
  admin: AdminRow;
  password: string;
}

// --- Журнал действий ---

export interface AuditRow {
  id: string;
  at: string;
  actorType: 'admin' | 'system' | 'bot';
  action: string;
  summary: string;
  details: unknown;
  actor: { id: string; email: string } | null;
}

// --- Каналы ---

export type GroupStatus = 'pending_confirmation' | 'active' | 'token_invalid' | 'bot_removed' | 'removed';

export interface GroupRow {
  id: string;
  title: string;
  platform: 'max' | 'vk';
  kind: 'community' | 'chat' | 'channel';
  status: GroupStatus;
  tags: string[];
  tokenMask: string | null;
  createdAt: string;
}

export interface GroupsData {
  groups: GroupRow[];
  vkUploader: {
    state: 'usable' | 'expired' | 'missing';
    expiresAt: string | null;
    appConfigured: boolean;
  } | null;
}

// --- Повторяющиеся посты ---

export type TemplateState = 'running' | 'paused' | 'disarmed' | 'no_targets';

export interface Schedule {
  mode: 'daily' | 'weekly' | 'monthly' | 'custom';
  time: string;
  weekday: number;
  monthday: number;
  custom: string;
}

export interface TemplateSummary {
  id: string;
  text: string;
  nextRunAt: string | null;
  targetsCount: number;
  occurrencesCount: number;
  state: TemplateState;
  scheduleText: string;
}

export interface TemplateDetails {
  id: string;
  text: string;
  vkTextOverride: string | null;
  maxTextOverride: string | null;
  state: TemplateState;
  nextRunAt: string | null;
  schedule: Schedule;
  scheduleText: string;
  targets: {
    id: string;
    title: string;
    platform: 'max' | 'vk';
    status: string;
  }[];
  attachments: Media[];
  occurrences: { id: string; status: PostStatus; createdAt: string }[];
}

/**
 * Что сервер вправе вернуть до сериализации: там, где клиент ждёт строку,
 * годится и `Date` — JSON превратит её в ISO-строку.
 */
export type Wire<T> = T extends string
  ? T | Date
  : T extends (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;
