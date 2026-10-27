import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

/**
 * Кто действует в текущем HTTP-запросе — чтобы журнал сам узнавал автора,
 * без протаскивания его параметром через каждый сервис и каждый вызов.
 * Хранится только id, а не весь запрос: контекст наследуют и долгоживущие
 * ресурсы, впервые созданные внутри запроса, и держать ими тело и заголовки
 * незачем. `AdminAuthGuard` проставляет id, как только опознал админа. Вне
 * запроса (сверка по таймеру, MAX-бот) хранилища нет — это «автоматика»,
 * если автор не передан явно.
 */
const storage = new AsyncLocalStorage<{ adminId?: string }>();

export function requestContextMiddleware(
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  storage.run({}, next);
}

/** Зовёт `AdminAuthGuard`: админ этого запроса опознан. */
export function setCurrentAdmin(adminId: string): void {
  const store = storage.getStore();
  if (store) {
    store.adminId = adminId;
  }
}

/** Id вошедшего админа текущего запроса — или null. */
export function currentAdminId(): string | null {
  return storage.getStore()?.adminId ?? null;
}

/**
 * Выполнить действие от имени админа вне HTTP-запроса — для MAX-бота, где
 * админ известен по `maxUserId` (подтверждение группы из чата): иначе журнал
 * записал бы такое действие как «автоматику».
 */
export function runAsAdmin<T>(
  adminId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run({ adminId }, fn);
}
