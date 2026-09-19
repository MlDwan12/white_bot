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
    adminUser: { findUnique: jest.fn().mockResolvedValue(admin) },
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
  const logger = { setContext: jest.fn() } as unknown as PinoLogger;
  const service = new AuthService(
    prisma as unknown as PrismaService,
    passwords as unknown as PasswordService,
    sessions as unknown as SessionService,
    jwt as unknown as JwtService,
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

  it('refuses an unknown refresh token', async () => {
    const { service, sessions } = setup();
    sessions.rotate.mockResolvedValue({ status: 'invalid' });

    await expect(service.refresh('nonsense')).rejects.toThrow();
  });
});

describe('AuthService.resolveAdmin', () => {
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
