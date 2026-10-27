import { isEmail } from 'class-validator';

/**
 * Адрес администратора: одна нормализация и одна проверка на все места, где
 * аккаунт заводится (панель, `seed-admin`). Та же строгость, что у формы
 * входа (`IsEmail`): иначе завели бы аккаунт, которым нельзя войти, — ровно
 * это когда-то случилось с `dev@local`.
 */
export function normalizeAdminEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidAdminEmail(email: string): boolean {
  // Та же функция, что за `@IsEmail()` у входа: своя регулярка пропускала
  // `a@b.c` и `a..b@x.com`, которыми потом нельзя было войти.
  return isEmail(email);
}
