import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Проверка подлинности данных запуска мини-приложения MAX.
 *
 * Мини-апп — это обычная веб-страница, открытая в клиенте MAX, и всё, что она
 * присылает нашему серверу, приходит от недоверенной стороны: подделать
 * «я пользователь 12345» тривиально. Единственное, что отличает настоящий
 * запуск от подделки, — подпись `hash`, которую клиент MAX кладёт в
 * `window.WebApp.initData` и которую может построить только владелец токена
 * бота.
 *
 * Алгоритм — из документации MAX (https://dev.max.ru/docs/webapps/validation):
 *   1. разобрать строку по `&` на пары `key=value`;
 *   2. вынуть `hash` и исключить из дальнейшей обработки;
 *   3. URL-декодировать значения;
 *   4. отсортировать пары по ключу;
 *   5. склеить `key=value` через `\n` — это `launch_params`;
 *   6. `secret_key = HMAC_SHA256("WebAppData", botToken)`;
 *   7. сверить `hex(HMAC_SHA256(secret_key, launch_params))` с `hash`.
 *
 * Не путать с проверкой номера телефона из `requestContact()`: там другая
 * формула (`HMAC_SHA256(authDate + phone + userId, botToken)`), и поиск по
 * документации выдаёт именно её.
 */

/** Ключ, в котором клиент MAX передаёт подписанные данные запуска. */
const WEB_APP_DATA_KEY = 'WebAppData';

/**
 * Сколько данные запуска считаются свежими. Подпись сама по себе вечна, так
 * что перехваченный `initData` иначе работал бы как бессрочный пропуск.
 * Сутки — компромисс: мини-апп могут держать открытым долго, но не неделями.
 */
const DEFAULT_MAX_AGE_S = 24 * 60 * 60;

export interface InitDataUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string | null;
  language_code?: string;
  photo_url?: string | null;
}

export interface InitDataChat {
  id: number;
  type: 'DIALOG' | 'CHAT' | 'CHANNEL';
}

export interface InitData {
  user?: InitDataUser;
  chat?: InitDataChat;
  query_id?: string;
  auth_date?: number;
  ip?: string;
  /** Payload из диплинка `?startapp=<payload>` — например, id конкурса. */
  start_param?: string;
}

export type InitDataResult =
  { valid: true; data: InitData } | { valid: false; reason: InitDataFailure };

export type InitDataFailure =
  | 'EMPTY'
  | 'NO_HASH'
  | 'DUPLICATE_HASH'
  | 'BAD_SIGNATURE'
  | 'EXPIRED'
  | 'MALFORMED';

export interface ValidateOptions {
  /** Максимальный возраст `auth_date` в секундах. 0 отключает проверку. */
  maxAgeSeconds?: number;
  /** Подменяется в тестах; по умолчанию — системное время. */
  now?: () => number;
}

/**
 * Вытаскивает подписанные данные из URL-фрагмента, которым MAX открывает
 * страницу: `https://example.com#WebAppData=...&WebAppPlatform=web`.
 */
export function extractWebAppData(url: string): string | null {
  const fragment = url.includes('#') ? url.slice(url.indexOf('#') + 1) : '';
  if (!fragment) {
    return null;
  }
  return new URLSearchParams(fragment).get(WEB_APP_DATA_KEY);
}

export function validateInitData(
  raw: string,
  botToken: string,
  options: ValidateOptions = {},
): InitDataResult {
  if (!raw) {
    return { valid: false, reason: 'EMPTY' };
  }

  const pairs = raw.split('&').map(splitPair);
  const hashes = pairs.filter(([key]) => key === 'hash');
  if (hashes.length === 0) {
    return { valid: false, reason: 'NO_HASH' };
  }
  if (hashes.length > 1) {
    // Два `hash` — это попытка сбить проверку тем, что реализация возьмёт
    // один, а подпись посчитается по другому.
    return { valid: false, reason: 'DUPLICATE_HASH' };
  }

  const receivedHash = hashes[0][1];
  const signed = pairs
    .filter(([key]) => key !== 'hash')
    .map(([key, value]) => [key, safeDecode(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const launchParams = signed
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = createHmac('sha256', botToken)
    .update(WEB_APP_DATA_KEY)
    .digest();
  const expected = createHmac('sha256', secretKey)
    .update(launchParams)
    .digest('hex');

  if (!constantTimeEquals(expected, receivedHash)) {
    return { valid: false, reason: 'BAD_SIGNATURE' };
  }

  let data: InitData;
  try {
    data = buildInitData(signed);
  } catch {
    // Подпись сошлась, но содержимое нечитаемо — считаем это сбоем, а не
    // подделкой: подписать такое мог только владелец токена.
    return { valid: false, reason: 'MALFORMED' };
  }

  const maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_S;
  if (maxAge > 0 && data.auth_date !== undefined) {
    const now = options.now?.() ?? Date.now();
    const ageSeconds = now / 1000 - data.auth_date;
    if (ageSeconds > maxAge) {
      return { valid: false, reason: 'EXPIRED' };
    }
  }

  return { valid: true, data };
}

/**
 * Делит пару по **первому** знаку равенства. Документация MAX показывает
 * `split('=')`, но это ломается на значении, внутри которого есть `=`;
 * для корректного входа поведение то же, а для пограничного — правильное.
 */
function splitPair(pair: string): [string, string] {
  const at = pair.indexOf('=');
  return at === -1 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)];
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Битая процентная последовательность: оставляем как есть, подпись всё
    // равно не сойдётся.
    return value;
  }
}

function buildInitData(
  pairs: readonly (readonly [string, string])[],
): InitData {
  const data: InitData = {};
  for (const [key, value] of pairs) {
    switch (key) {
      case 'user':
        data.user = JSON.parse(value) as InitDataUser;
        break;
      case 'chat':
        data.chat = JSON.parse(value) as InitDataChat;
        break;
      case 'auth_date':
        data.auth_date = Number(value);
        break;
      case 'query_id':
        data.query_id = value;
        break;
      case 'ip':
        data.ip = value;
        break;
      case 'start_param':
        data.start_param = value;
        break;
      default:
        break;
    }
  }
  return data;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual требует одинаковой длины, а сама разница длин секретом
  // не является.
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Собирает подписанную строку — нужна тестам и отладке, чтобы не зависеть от
 * живого клиента MAX при проверке самой логики.
 */
export function signInitData(
  params: Record<string, string>,
  botToken: string,
): string {
  const sorted = Object.entries(params).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const launchParams = sorted.map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = createHmac('sha256', botToken)
    .update(WEB_APP_DATA_KEY)
    .digest();
  const hash = createHmac('sha256', secretKey)
    .update(launchParams)
    .digest('hex');
  const encoded = sorted
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${encoded}&hash=${hash}`;
}
