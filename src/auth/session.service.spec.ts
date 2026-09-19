import { createHash } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { SessionService, constantTimeEquals } from './session.service';

const hashOf = (token: string) =>
  createHash('sha256').update(token).digest('hex');

function setup(session: Record<string, unknown> | null = null) {
  const tx = {
    adminSession: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    adminSession: {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(session),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const logger = {
    setContext: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  } as unknown as PinoLogger;
  const service = new SessionService(
    prisma as unknown as PrismaService,
    logger,
  );
  return { service, prisma, tx, logger };
}

const liveSession = (overrides: Record<string, unknown> = {}) => ({
  id: 's1',
  adminUserId: 'admin-1',
  revoked: false,
  revokedAt: null,
  expiresAt: new Date(Date.now() + 60_000),
  ...overrides,
});

describe('SessionService.issue', () => {
  it('stores only a hash of the refresh token', async () => {
    const { service, prisma } = setup();

    const issued = await service.issue('admin-1');

    const { data } = (
      prisma.adminSession.create.mock.calls as unknown[][]
    )[0][0] as { data: { refreshTokenHash: string } };
    // Дамп базы не должен превращаться в набор готовых пропусков.
    expect(data.refreshTokenHash).toBe(hashOf(issued.token));
    expect(data.refreshTokenHash).not.toContain(issued.token);
  });

  it('issues a different token every time', async () => {
    const { service } = setup();

    const first = await service.issue('admin-1');
    const second = await service.issue('admin-1');

    expect(first.token).not.toBe(second.token);
  });
});

describe('SessionService.rotate', () => {
  it('burns the old token and issues a new one', async () => {
    const { service, tx } = setup(liveSession());

    const result = await service.rotate('old-token');

    expect(result.status).toBe('ok');
    const burn = (
      tx.adminSession.updateMany.mock.calls as unknown[][]
    )[0][0] as {
      where: { revoked: boolean };
      data: { revoked: boolean };
    };
    // Гасим с условием `revoked: false`, а не просто по id: иначе два
    // одновременных обновления выдали бы по новой сессии, и один токен стал
    // бы двумя живыми.
    expect(burn.where.revoked).toBe(false);
    expect(burn.data.revoked).toBe(true);
    expect(tx.adminSession.create).toHaveBeenCalled();
  });

  it('treats a second rotation moments later as a race, not theft', async () => {
    const { service, prisma } = setup(
      liveSession({ revoked: true, revokedAt: new Date(Date.now() - 500) }),
    );

    const result = await service.rotate('just-used');

    // Панель легко шлёт два обновления подряд; выкидывать за это со всех
    // устройств — наказание за перезагрузку страницы.
    expect(result.status).toBe('stale');
    expect(prisma.adminSession.updateMany).not.toHaveBeenCalled();
  });

  it('gives up its new session when another request burned the token first', async () => {
    const { service, tx } = setup(liveSession());
    tx.adminSession.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.rotate('contended');

    expect(result.status).toBe('stale');
    expect(tx.adminSession.create).not.toHaveBeenCalled();
  });

  it('revokes every session when a burnt token comes back', async () => {
    const { service, prisma } = setup(
      liveSession({
        revoked: true,
        revokedAt: new Date(Date.now() - 60 * 60 * 1000),
      }),
    );

    const result = await service.rotate('stolen');

    // Погашенный токен предъявляют либо вор, либо обворованный — отличить
    // нельзя, поэтому выходят все: лучше лишний вход, чем чужой внутри.
    expect(result.status).toBe('reused');
    const { where } = (
      prisma.adminSession.updateMany.mock.calls as unknown[][]
    )[0][0] as { where: { adminUserId: string } };
    expect(where.adminUserId).toBe('admin-1');
  });

  it('treats a session revoked before revokedAt existed as theft', async () => {
    // У старых строк момент гашения не записан; считать их «только что
    // погашенными» значило бы открыть поблажку навсегда.
    const { service, prisma } = setup(
      liveSession({ revoked: true, revokedAt: null }),
    );

    expect((await service.rotate('ancient')).status).toBe('reused');
    expect(prisma.adminSession.updateMany).toHaveBeenCalled();
  });

  it('rejects an unknown token without touching anything', async () => {
    const { service, prisma } = setup(null);

    expect((await service.rotate('nonsense')).status).toBe('invalid');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.adminSession.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an expired session', async () => {
    const { service } = setup(
      liveSession({ expiresAt: new Date(Date.now() - 1000) }),
    );

    expect((await service.rotate('old')).status).toBe('invalid');
  });

  it('does not treat an expired token as theft', async () => {
    const { service, prisma } = setup(
      liveSession({ expiresAt: new Date(Date.now() - 1000) }),
    );

    await service.rotate('old');

    // Просрочка — обычное дело, выкидывать человека со всех устройств за неё
    // было бы наказанием за то, что он неделю не заходил.
    expect(prisma.adminSession.updateMany).not.toHaveBeenCalled();
  });
});

describe('SessionService.revokeAll', () => {
  it('kills only sessions that are still live', async () => {
    const { service, prisma } = setup();

    await service.revokeAll('admin-1');

    const { where } = (
      prisma.adminSession.updateMany.mock.calls as unknown[][]
    )[0][0] as { where: { revoked: boolean } };
    expect(where.revoked).toBe(false);
  });
});

describe('constantTimeEquals', () => {
  it('matches identical strings', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
  });

  it('rejects different strings of equal length', () => {
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
  });

  it('rejects different lengths without throwing', () => {
    // timingSafeEqual падает на разной длине, а сама длина секретом не
    // является — сравнение обязано просто вернуть false.
    expect(constantTimeEquals('abc', 'abcdef')).toBe(false);
  });
});
