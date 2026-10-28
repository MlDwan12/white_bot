import type { Request } from 'express';

/**
 * Читает куку, не полагаясь на типы: `cookie-parser` объявляет `cookies` как
 * `any`, и каждое обращение к нему протаскивает `any` дальше по коду — в
 * гвард, в контроллер, в проверку CSRF. Здесь `any` кончается.
 */
export function readCookie(req: Request, name: string): string | undefined {
  const bag: unknown = (req as { cookies?: unknown }).cookies;
  if (typeof bag !== 'object' || bag === null) {
    return undefined;
  }
  const value = (bag as Record<string, unknown>)[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
