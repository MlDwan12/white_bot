import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { PasswordService } from '../auth/password.service';
import { SessionService } from '../auth/session.service';
import { AdminsService } from './admins.service';

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: OTHER,
    email: 'other@example.com',
    role: 'developer',
    maxUserId: null,
    passwordHash: 'hash',
    extraPermissions: [],
    createdAt: new Date('2026-09-01'),
    disabledAt: null,
    ...overrides,
  };
}

function setup(target = row()) {
  const prisma = {
    adminUser: {
      findUnique: jest.fn().mockResolvedValue(target),
      findMany: jest.fn().mockResolvedValue([target]),
      create: jest.fn(({ data }: { data: object }) =>
        Promise.resolve(row(data as Record<string, unknown>)),
      ),
      update: jest.fn(({ data }: { data: object }) =>
        Promise.resolve({ ...target, ...data }),
      ),
    },
    // Активные developer'ы под блокировкой: по умолчанию целевой и ещё один.
    $queryRaw: jest.fn().mockResolvedValue([{ id: OTHER }, { id: SELF }]),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
  );
  const passwords = {
    hash: jest.fn((p: string) => Promise.resolve(`h(${p})`)),
  };
  const sessions = { revokeAll: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminsService(
    prisma as unknown as PrismaService,
    passwords as unknown as PasswordService,
    sessions as unknown as SessionService,
  );
  return { service, prisma, passwords, sessions };
}

describe('AdminsService', () => {
  describe('create', () => {
    it('генерирует пароль, хранит только хеш и не отдаёт хеш наружу', async () => {
      const { service, prisma } = setup();

      const issued = await service.create({
        email: '  New@Example.com ',
        role: 'admin',
        maxUserId: ' 123456 ',
      });

      expect(issued.password).toMatch(/^[A-Za-z0-9_-]{24}$/);
      const data = (
        prisma.adminUser.create.mock.calls[0] as [
          { data: Record<string, unknown> },
        ]
      )[0].data;
      expect(data).toMatchObject({
        email: 'new@example.com',
        role: 'admin',
        maxUserId: '123456',
        passwordHash: `h(${issued.password})`,
      });
      expect(issued.admin).not.toHaveProperty('passwordHash');
    });

    it.each([
      [{ email: 'dev@local', role: 'admin' }, 'email'],
      [{ email: 'a@b.ru', role: 'root' }, 'роль'],
      [{ email: 'a@b.ru', role: 'admin', maxUserId: 'abc' }, 'число'],
    ])('отказывает на неверном вводе %j', async (input, fragment) => {
      const { service, prisma } = setup();

      await expect(service.create(input as never)).rejects.toThrow(
        new RegExp(fragment, 'i'),
      );
      expect(prisma.adminUser.create).not.toHaveBeenCalled();
    });

    it('дубль email — понятный отказ, а не 500', async () => {
      const { service, prisma } = setup();
      prisma.adminUser.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { constraint: { index: 'AdminUser_email_key' } },
        }),
      );

      await expect(
        service.create({ email: 'a@b.ru', role: 'admin' }),
      ).rejects.toThrow('Админ с таким email уже есть');
    });
  });

  describe('disable', () => {
    it('гасит сессии — отключение действует сразу', async () => {
      const { service, prisma, sessions } = setup(row({ role: 'admin' }));

      await service.disable(OTHER, SELF);

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: OTHER },
        data: { disabledAt: expect.any(Date) as Date },
      });
      expect(sessions.revokeAll).toHaveBeenCalledWith(OTHER);
    });

    it('себя отключить нельзя', async () => {
      const { service, prisma } = setup(row({ id: SELF }));

      await expect(service.disable(SELF, SELF)).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
      expect(prisma.adminUser.update).not.toHaveBeenCalled();
    });

    it('последнего активного developer отключить нельзя', async () => {
      const { service, prisma } = setup();
      prisma.$queryRaw.mockResolvedValue([{ id: OTHER }]);

      await expect(service.disable(OTHER, SELF)).rejects.toThrow(
        /последний активный developer/,
      );
      expect(prisma.adminUser.update).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('себя понизить нельзя', async () => {
      const { service } = setup(row({ id: SELF }));

      await expect(
        service.update(SELF, { role: 'admin' }, SELF),
      ).rejects.toBeInstanceOf(AppException);
    });

    it('последнего developer понизить нельзя', async () => {
      const { service, prisma } = setup();
      prisma.$queryRaw.mockResolvedValue([{ id: OTHER }]);

      await expect(
        service.update(OTHER, { role: 'admin' }, SELF),
      ).rejects.toThrow(/последний активный developer/);
    });

    it('пустой MAX id отвязывает аккаунт', async () => {
      const { service, prisma } = setup(row({ maxUserId: '42' }));

      await service.update(OTHER, { role: 'developer', maxUserId: '  ' }, SELF);

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: OTHER },
        data: { role: 'developer', maxUserId: null },
      });
    });
  });

  it('сброс пароля выдаёт новый и завершает все входы', async () => {
    const { service, sessions, prisma } = setup();

    const issued = await service.resetPassword(OTHER);

    expect(prisma.adminUser.update).toHaveBeenCalledWith({
      where: { id: OTHER },
      data: { passwordHash: `h(${issued.password})` },
    });
    expect(sessions.revokeAll).toHaveBeenCalledWith(OTHER);
  });
});
