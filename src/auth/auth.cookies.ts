import type { CookieOptions, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { ACCESS_TTL_SECONDS } from './auth.service';
import type { IssuedRefresh } from './session.service';

export const ACCESS_COOKIE = 'wb_access';
export const REFRESH_COOKIE = 'wb_refresh';
export const CSRF_COOKIE = 'wb_csrf';
export const CSRF_HEADER = 'x-csrf-token';
/** Скрытое поле формы — для страниц панели, которые шлются без JS. */
export const CSRF_FIELD = '_csrf';

/**
 * Токены живут только в куках и никогда не попадают в тело ответа: положи их
 * в JSON — и фронтенду придётся где-то их хранить, а любое такое хранилище
 * читается при XSS. `httpOnly` закрывает их от скриптов вовсе.
 */
function baseOptions(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure,
    // strict, а не lax: панель не нужна переходами со сторонних сайтов, и это
    // первый рубеж против CSRF.
    sameSite: 'strict',
    path: '/',
  };
}

export function setAuthCookies(
  res: Response,
  tokens: { access: string; refresh: IssuedRefresh },
  secure: boolean,
  /**
   * Уже выданный CSRF-токен, если он есть. Передаётся при обновлении
   * сессии: выпусти новый — и запрос, ушедший до обновления, или соседняя
   * вкладка, прочитавшая куку секундой раньше, будут отвергнуты как
   * подделка. В логе это выглядит как атака, а на деле обычная гонка.
   */
  keepCsrf?: string,
): void {
  res.cookie(ACCESS_COOKIE, tokens.access, {
    ...baseOptions(secure),
    maxAge: ACCESS_TTL_SECONDS * 1000,
  });
  res.cookie(REFRESH_COOKIE, tokens.refresh.token, {
    ...baseOptions(secure),
    expires: tokens.refresh.expiresAt,
  });
  // CSRF-токен, наоборот, должен читаться скриптом: в этом и смысл
  // double-submit — страница обязана суметь положить его в заголовок,
  // а сторонний сайт прочитать чужую куку не может.
  res.cookie(CSRF_COOKIE, keepCsrf ?? randomBytes(32).toString('base64url'), {
    httpOnly: false,
    secure,
    sameSite: 'strict',
    path: '/',
    expires: tokens.refresh.expiresAt,
  });
}

export function clearAuthCookies(res: Response, secure: boolean): void {
  const options = baseOptions(secure);
  res.clearCookie(ACCESS_COOKIE, options);
  res.clearCookie(REFRESH_COOKIE, options);
  res.clearCookie(CSRF_COOKIE, { ...options, httpOnly: false });
}
