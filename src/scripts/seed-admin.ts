import { config as loadEnv } from 'dotenv';
import { createInterface } from 'node:readline/promises';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../generated/prisma/client';
import { isValidAdminEmail, normalizeAdminEmail } from '../auth/admin-email';
import { generatePassword, PasswordService } from '../auth/password.service';

/**
 * Заводит первого администратора.
 *
 * Отдельным скриптом на сервере, а не публичной регистрацией: эндпоинт
 * «создать первого админа» живёт вечно и рано или поздно оказывается
 * доступен не тому. Здесь же для создания аккаунта нужен доступ к серверу —
 * то есть тот, кто и так может всё.
 *
 * Заменяет прежний `scripts/seed-admin.cjs`, который ставил заведомо
 * непригодный хеш пароля и ждал появления аутентификации: теперь она есть,
 * и аккаунт заводится сразу рабочим.
 *
 * Запуск: `yarn build && yarn seed:admin <email> [maxUserId]` — сборка
 * отдельной командой, потому что в рантайм-образе nest-cli нет, а скрипт
 * нужен именно там.
 *
 * Аргументы, а не вопросы: в контейнере запускают неинтерактивно, а
 * `readline` на конвейере обрывается с «readline was closed». В живом
 * терминале недостающее всё равно спросим.
 *
 * `maxUserId` необязателен и привязывает MAX-аккаунт: бот сообщает этот id
 * в ответ на `/start`, без него команды из чата не опознаются.
 */
async function main(): Promise<void> {
  // Скрипт запускается сам по себе, без Nest, поэтому `.env` никто за него
  // не прочитает.
  loadEnv();

  const [argEmail, argMaxUserId] = process.argv.slice(2);
  const email = normalizeAdminEmail(
    argEmail ?? (await ask('Email администратора: ')),
  );

  if (!isValidAdminEmail(email)) {
    throw new Error(
      'Непохоже на email. Нужен домен с точкой, например admin@example.com',
    );
  }

  const maxUserId = (argMaxUserId ?? '').trim() || null;

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const existing = await prisma.adminUser.findUnique({ where: { email } });
    if (existing) {
      throw new Error(`Администратор ${email} уже существует`);
    }

    const password = generatePassword();

    const admin = await prisma.adminUser.create({
      data: {
        email,
        // Те же параметры argon2, что у входа, — из одного места.
        passwordHash: await new PasswordService().hash(password),
        role: 'developer',
        extraPermissions: [],
        maxUserId,
      },
    });

    console.log(`\nСоздан администратор ${admin.email} с ролью developer.`);
    console.log(`Пароль: ${password}`);
    console.log('\nСохраните его сейчас — второй раз он не показывается.');
    if (!admin.maxUserId) {
      console.log(
        'MAX-аккаунт не привязан: команды боту из чата опознаваться не будут.',
      );
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

/** Спрашивает только в живом терминале; на конвейере требует аргумент. */
async function ask(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error('Использование: yarn seed:admin <email> [maxUserId]');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
