import type { Media } from '@white-bot/shared';

export type * from '@white-bot/shared';

/** Ошибка API в том виде, в каком её отдаёт глобальный фильтр Nest. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Envelope<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string } };

function csrfToken(): string | undefined {
  return document.cookie
    .split('; ')
    .find((part) => part.startsWith('wb_csrf='))
    ?.slice('wb_csrf='.length);
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const isForm = body instanceof FormData;
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  const csrf = csrfToken();
  // Кука уже url-safe base64, раскодировать нечего.
  if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const json = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!json) {
    throw new ApiError(res.status, 'BAD_RESPONSE', `Сервер ответил ${res.status}`);
  }
  if (!json.success) {
    throw new ApiError(res.status, json.error.code, json.error.message);
  }
  return json.data;
}

// Один общий refresh на все запросы, упавшие разом: иначе каждый крутил бы
// свой, и сервер принял бы второй за повтор украденного токена.
let refreshing: Promise<void> | null = null;

function refresh(): Promise<void> {
  refreshing ??= send<unknown>('POST', '/auth/refresh')
    .then(() => undefined)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

const NO_REFRESH = new Set(['/auth/login', '/auth/logout', '/auth/refresh']);

/**
 * Запрос с одной попыткой продлить сессию: access-токен живёт недолго, и
 * 401 обычно значит «пора обновить», а не «вышел».
 */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await send<T>(method, path, body);
  } catch (err) {
    // У входа и выхода 401 — это ответ по существу (неверный пароль), а не
    // протухший токен.
    if (!(err instanceof ApiError) || err.status !== 401 || NO_REFRESH.has(path)) throw err;
    // Продлить не вышло (входа не было, сессия отозвана, нет CSRF-куки) —
    // для вызывающего это тот же 401: показать форму входа.
    await refresh().catch(() => Promise.reject(err));
  }
  return send<T>(method, path, body);
}

/**
 * Ссылки, которые открывает сам браузер (CSV, авторизация VK), мимо `api()` и
 * его продления сессии: без этого после 15 минут простоя вместо файла
 * скачался бы JSON с 401.
 */
export async function openWithSession(url: string, newTab = false): Promise<void> {
  await api('GET', '/auth/me');
  if (newTab) window.open(url, '_blank', 'noopener');
  else window.location.assign(url);
}

export function uploadMedia(file: File): Promise<Media> {
  const form = new FormData();
  form.append('file', file);
  return api<Media>('POST', '/api/media', form);
}

export function previewUrl(mediaId: string): string {
  return `/api/media/${mediaId}/preview`;
}

