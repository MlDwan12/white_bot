import { JwtService } from '@nestjs/jwt';
import { PinoLogger } from 'nestjs-pino';
import { ErrorCode } from '../common/error-code.enum';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';

const ADMIN = {
  id: 'admin-1',
  email: 'dev@local',
  passwordHash: 'hash',
  role: 'developer' as const,
};

function setup(admin: Record<string, unknown> | null = ADMIN) {
  const prisma = {
    adminUser: {
      findUnique: jest.fn().mockResolvedValue(admin),
      // «не отключён» + отметка «был в панели» одним условным update
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const passwords = { verify: jest.fn().mockResolvedValue(true) };
  const sessions = {
    issue: jest
      .fn()
      .mockResolvedValue({ token: 'refresh-1', expiresAt: new Date() }),
    rotate: jest.fn().mockResolvedValue({
      status: 'ok',
      adminUserId: 'admin-1',
      next: { token: 'refresh-2', expiresAt: new Date() },
    }),
    revoke: jest.fn().mockResolvedValue(undefined),
  };
  const jwt = {
    sign: jest.fn().mockReturnValue('access-token'),
    verifyAsync: jest.fn().mockResolvedValue({ sub: 'admin-1' }),
  };
  const logger = {
    setContext: jest.fn(),
    warn: jest.fn(),
  } as unknown as PinoLogger;
  const service = new AuthService(
    prisma as unknown as PrismaService,
    passwords as unknown as PasswordService,
    sessions as unknown as SessionService,
    jwt as unknown as JwtService,
    { record: jest.fn(), purgeExpired: jest.fn() } as never,
    logger,
  );
  return { service, prisma, passwords, sessions, jwt };
}

describe('AuthService.login', () => {
  it('issues an access token and a refresh session', async () => {
    const { service, sessions } = setup();

    const result = await service.login('dev@local', 'пароль');

    expect(result.access).toBe('access-token');
    expect(result.refresh.token).toBe('refresh-1');
    expect(sessions.issue).toHaveBeenCalledWith('admin-1');
  });

  it('не пускает отключённого админа — тем же ответом, что и неверный пароль', async () => {
    const { service, sessions, passwords } = setup({
      ...ADMIN,
      disabledAt: new Date(),
    });

    await expect(service.login('dev@local', 'пароль')).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
      message: 'Неверный email или пароль',
    });
    // Пароль всё равно проверен — по времени ответа отключённого не отличить.
    expect(passwords.verify).toHaveBeenCalled();
    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it('гасит выданную сессию, если админа отключили за время проверки пароля', async () => {
    const { service, prisma, sessions } = setup();
    // Первое чтение — до argon2 (активен); условный update после выдачи
    // сессии не нашёл активного — успели отключить.
    prisma.adminUser.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.login('dev@local', 'пароль')).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
    expect(sessions.revoke).toHaveBeenCalledWith('refresh-1');
  });

  it('normalises the email before looking it up', async () => {
    const { service, prisma } = setup();

    await service.login('  DEV@Local  ', 'пароль');

    const { where } = (
      prisma.adminUser.findUnique.mock.calls as unknown[][]
    )[0][0] as { where: { email: string } };
    expect(where.email).toBe('dev@local');
  });

  it('still hashes a password for an unknown email', async () => {
    const { service, passwords } = setup(null);

    await expect(service.login('никого@нет', 'пароль')).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
    // Пропусти проверку — и по времени ответа стало бы видно, какие адреса
    // заведены в системе.
    expect(passwords.verify).toHaveBeenCalled();
  });

  it('answers the same way for a wrong password and an unknown email', async () => {
    const unknown = setup(null);
    const wrong = setup();
    wrong.passwords.verify.mockResolvedValue(false);

    const message = async (run: () => Promise<unknown>): Promise<string> => {
      try {
        await run();
        return 'без ошибки';
      } catch (error) {
        return (error as Error).message;
      }
    };

    expect(await message(() => unknown.service.login('нет@нет', 'x'))).toBe(
      await message(() => wrong.service.login('dev@local', 'x')),
    );
  });

  it('does not issue a session when the password is wrong', async () => {
    const { service, passwords, sessions } = setup();
    passwords.verify.mockResolvedValue(false);

    await expect(service.login('dev@local', 'не тот')).rejects.toThrow();
    expect(sessions.issue).not.toHaveBeenCalled();
  });
});

describe('AuthService.refresh', () => {
  it('returns a fresh pair when rotation succeeds', async () => {
    const { service } = setup();

    const result = await service.refresh('refresh-1');

    expect(result.refresh.token).toBe('refresh-2');
  });

  it('refuses a rotation that reported theft', async () => {
    const { service, sessions } = setup();
    sessions.rotate.mockResolvedValue({
      status: 'reused',
      adminUserId: 'admin-1',
    });

    await expect(service.refresh('stolen')).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
  });

  it('reports a parallel rotation as a conflict, not a dead session', async () => {
    const { service, sessions } = setup();
    sessions.rotate.mockResolvedValue({ status: 'stale' });

    // Контроллер по этому коду отличает гонку вкладок от протухшей сессии и
    // не стирает куки — в них уже лежит рабочая пара.
    await expect(service.refresh('raced')).rejects.toMatchObject({
      code: ErrorCode.CONCURRENT_EDIT_CONFLICT,
    });
  });

  it('гасит только что выданную сессию, если админа успели отключить', async () => {
    // Обновление прочитало старую сессию до гашения при отключении и
    // вставило новую после него — без этой проверки она пережила бы
    // отключение и снова заработала бы после «Включить».
    const { service, prisma, sessions } = setup();
    prisma.adminUser.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.refresh('refresh-1')).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
    expect(sessions.revoke).toHaveBeenCalledWith('refresh-2');
  });

  it('отмечает «был в панели» тем же запросом, что проверяет отключение', async () => {
    const { service, prisma } = setup();

    await service.refresh('refresh-1');

    const arg = (
      prisma.adminUser.updateMany.mock.calls as unknown[][]
    )[0][0] as {
      where: unknown;
      data: { lastSeenAt: unknown };
    };
    expect(arg.where).toEqual({ id: 'admin-1', disabledAt: null });
    expect(arg.data.lastSeenAt).toBeInstanceOf(Date);
  });

  it('refuses an unknown refresh token', async () => {
    const { service, sessions } = setup();
    sessions.rotate.mockResolvedValue({ status: 'invalid' });

    await expect(service.refresh('nonsense')).rejects.toThrow();
  });
});

describe('AuthService.resolveAdmin', () => {
  it('после сброса пароля отвергает access-токен, выданный раньше', async () => {
    const { service, prisma, jwt } = setup();
    const resetAt = new Date('2026-10-27T10:00:00Z');
    prisma.adminUser.findUnique.mockResolvedValue({
      ...ADMIN,
      passwordChangedAt: resetAt,
    });
    const seconds = Math.floor(resetAt.getTime() / 1000);

    jwt.verifyAsync.mockResolvedValue({ sub: 'admin-1', iat: seconds - 60 });
    await expect(service.resolveAdmin('old')).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });

    // Токен той же секунды, что и сброс, — тоже: он мог быть выдан за миг
    // до сброса и прожил бы ещё 15 минут.
    jwt.verifyAsync.mockResolvedValue({ sub: 'admin-1', iat: seconds });
    await expect(service.resolveAdmin('same')).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });

    // Вход новым паролем после сброса проходит.
    jwt.verifyAsync.mockResolvedValue({ sub: 'admin-1', iat: seconds + 1 });
    await expect(service.resolveAdmin('new')).resolves.toMatchObject({
      id: 'admin-1',
    });
  });

  it('re-reads the admin from the database on every request', async () => {
    const { service, prisma } = setup();

    await service.resolveAdmin('access-token');

    // Права и роль берутся из базы, а не из токена: понижение и удаление
    // должны действовать сразу, а не через четверть часа.
    expect(prisma.adminUser.findUnique).toHaveBeenCalled();
  });

  it('rejects an admin who no longer exists', async () => {
    const { service, prisma } = setup();
    prisma.adminUser.findUnique.mockResolvedValue(null);

    await expect(service.resolveAdmin('access-token')).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
  });

  it('отвергает живой access-токен отключённого админа', async () => {
    const { service, prisma } = setup();
    prisma.adminUser.findUnique.mockResolvedValue({
      ...ADMIN,
      disabledAt: new Date(),
    });

    await expect(service.resolveAdmin('access-token')).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
  });

  it('rejects a token that fails verification', async () => {
    const { service, jwt } = setup();
    jwt.verifyAsync.mockRejectedValue(new Error('jwt expired'));

    await expect(service.resolveAdmin('stale')).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
  });

  it('rejects a token with no subject', async () => {
    const { service, jwt, prisma } = setup();
    jwt.verifyAsync.mockResolvedValue({});

    await expect(service.resolveAdmin('weird')).rejects.toThrow();
    expect(prisma.adminUser.findUnique).not.toHaveBeenCalled();
  });
});
