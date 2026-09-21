import { PrismaService } from '../prisma/prisma.service';
import { PlatformUsersService } from './platform-users.service';

/** Reads one argument of a recorded call as `T` — `mock.calls` is `any[][]`. */
function callArg<T>(mockFn: jest.Mock, callIndex = 0, argIndex = 0): T {
  const calls = mockFn.mock.calls as unknown[][];
  return calls[callIndex][argIndex] as T;
}

function setup() {
  const prisma = {
    platformUser: {
      upsert: jest.fn().mockResolvedValue({ id: 'pu-1' }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
  const service = new PlatformUsersService(prisma as unknown as PrismaService);
  return { service, prisma };
}

const PROFILE = {
  externalUserId: '42',
  displayName: 'Иван',
  firstName: 'Иван',
  lastName: null,
  username: 'ivan',
  isBot: false,
  raw: { user_id: 42 },
};

describe('PlatformUsersService.upsert', () => {
  it('заводит новую запись данными профиля, не трогая согласие', async () => {
    const { service, prisma } = setup();

    await service.upsert('max', PROFILE);

    const call = callArg<{
      where: unknown;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }>(prisma.platformUser.upsert);
    expect(call.where).toEqual({
      platform_externalUserId: { platform: 'max', externalUserId: '42' },
    });
    expect(call.create).toMatchObject({
      platform: 'max',
      externalUserId: '42',
      displayName: 'Иван',
    });
    expect(call.create).not.toHaveProperty('consentedAt');
    expect(call.update).not.toHaveProperty('consentedAt');
  });
});

describe('PlatformUsersService.hasConsented', () => {
  it('false, если профиля ещё нет — согласия точно не было', async () => {
    const { service, prisma } = setup();
    prisma.platformUser.findUnique.mockResolvedValue(null);

    expect(await service.hasConsented('max', '42')).toBe(false);
  });

  it('false, если профиль есть, а согласия нет', async () => {
    const { service, prisma } = setup();
    prisma.platformUser.findUnique.mockResolvedValue({ consentedAt: null });

    expect(await service.hasConsented('max', '42')).toBe(false);
  });

  it('true, если согласие отмечено', async () => {
    const { service, prisma } = setup();
    prisma.platformUser.findUnique.mockResolvedValue({
      consentedAt: new Date(),
    });

    expect(await service.hasConsented('max', '42')).toBe(true);
  });
});

describe('PlatformUsersService.recordConsent', () => {
  it('заводит профиль и отмечает согласие текущим временем, даже если профиля не было', async () => {
    const { service, prisma } = setup();

    await service.recordConsent('max', PROFILE);

    const call = callArg<{
      create: { consentedAt: Date };
      update: { consentedAt: Date };
    }>(prisma.platformUser.upsert);
    expect(call.create.consentedAt).toBeInstanceOf(Date);
    expect(call.update.consentedAt).toBeInstanceOf(Date);
  });
});
