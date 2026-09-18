/**
 * Creates (or re-links) the first AdminUser so MAX commands have someone to
 * recognise — `MaxAdminResolver` matches a sender by `AdminUser.maxUserId`,
 * and until the web panel can create admins (Step 9) there's no other way to
 * get that row in.
 *
 * Usage:
 *   yarn seed:admin <email> <maxUserId>
 *
 * Find your own `maxUserId` by sending `/start` to the bot — it replies with
 * it precisely for this bootstrap.
 *
 * Plain CommonJS against the *built* client (`yarn seed:admin` builds first)
 * rather than TypeScript run through ts-node: the generated Prisma client
 * imports its internals with ESM-style `./internal/class.js` specifiers,
 * which ts-node can't resolve from the .ts sources under `module: nodenext`.
 * The app itself only works because it runs compiled JS; this script does the
 * same instead of maintaining a second resolution setup. The `.cjs` extension
 * also keeps it from being mistaken for compiler output.
 *
 * About the password: this writes a deliberately unusable placeholder into
 * `passwordHash`, because password hashing arrives with authentication in
 * Step 9 and inventing a scheme now would mean two of them. The placeholder
 * is not a valid hash in any format, so no password can ever verify against
 * it — web login for this row is impossible by construction until Step 9
 * sets a real one. That's the intended state, not an oversight.
 */
const path = require('node:path');
const fs = require('node:fs');

require('dotenv').config();

/** Not a valid hash in any supported format — nothing can verify against it. */
const UNUSABLE_PASSWORD_HASH = '!no-password-set:seeded-for-max-bootstrap';

const CLIENT_PATH = path.join(
  __dirname,
  '..',
  'dist',
  'generated',
  'prisma',
  'client.js',
);

async function main() {
  const [email, maxUserId] = process.argv.slice(2);
  if (!email || !maxUserId) {
    throw new Error('Использование: yarn seed:admin <email> <maxUserId>');
  }
  if (!/^\d+$/.test(maxUserId)) {
    throw new Error(`maxUserId должен быть числом, получено: ${maxUserId}`);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL не задан');
  }

  if (!fs.existsSync(CLIENT_PATH)) {
    throw new Error(
      'Сборка не найдена. Запустите `yarn build`, затем повторите (или используйте `yarn seed:admin`, который собирает сам).',
    );
  }

  const { PrismaClient } = require(CLIENT_PATH);
  const { PrismaPg } = require('@prisma/adapter-pg');

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  try {
    // maxUserId is unique, so a re-run with the same id must not fail — and
    // moving an id to a different admin has to clear it from the old one
    // first, or the unique constraint rejects the write.
    await prisma.adminUser.updateMany({
      where: { maxUserId, email: { not: email } },
      data: { maxUserId: null },
    });

    const admin = await prisma.adminUser.upsert({
      where: { email },
      update: { maxUserId },
      create: {
        email,
        maxUserId,
        role: 'developer',
        passwordHash: UNUSABLE_PASSWORD_HASH,
      },
    });

    console.log(
      `Администратор готов: ${admin.email} (роль ${admin.role}, maxUserId ${admin.maxUserId ?? '—'})`,
    );
    console.log(
      'Пароль не задан — вход в веб-панель будет невозможен до Шага 9.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
