import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { DirectMessageRecipientsService } from './direct-message-recipients.service';

function callArg<T>(mockFn: jest.Mock, callIndex = 0, argIndex = 0): T {
  const calls = mockFn.mock.calls as unknown[][];
  return calls[callIndex][argIndex] as T;
}

function setup() {
  const prisma = {
    platformUser: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    group: {
      // По умолчанию группа существует — большинство тестов проверяют не это.
      findUnique: jest.fn().mockResolvedValue({ id: 'group-1' }),
    },
  };
  const service = new DirectMessageRecipientsService(
    prisma as unknown as PrismaService,
  );
  return { service, prisma };
}

const USER = {
  id: 'pu-1',
  platform: 'max' as const,
  externalUserId: '42',
  consentedAt: new Date(),
};

describe('DirectMessageRecipientsService.resolve — user', () => {
  it('возвращает согласившегося получателя', async () => {
    const { service, prisma } = setup();
    prisma.platformUser.findUnique.mockResolvedValue(USER);

    const result = await service.resolve({
      mode: 'user',
      platformUserId: 'pu-1',
    });

    expect(result).toEqual([
      { id: 'pu-1', platform: 'max', externalUserId: '42' },
    ]);
  });

  it('падает NOT_FOUND, если такого пользователя нет', async () => {
    const { service, prisma } = setup();
    prisma.platformUser.findUnique.mockResolvedValue(null);

    await expect(
      service.resolve({ mode: 'user', platformUserId: 'ghost' }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('падает NOT_FOUND, если согласие отозвано между поиском и отправкой', async () => {
    const { service, prisma } = setup();
    prisma.platformUser.findUnique.mockResolvedValue({
      ...USER,
      consentedAt: null,
    });

    await expect(
      service.resolve({ mode: 'user', platformUserId: 'pu-1' }),
    ).rejects.toBeInstanceOf(AppException);
  });
});

describe('DirectMessageRecipientsService.resolve — group', () => {
  it('ищет уникальных PlatformUser по доставкам анонса в эту группу, только согласившихся', async () => {
    const { service, prisma } = setup();
    prisma.platformUser.findMany.mockResolvedValue([
      { id: 'pu-1', platform: 'max', externalUserId: '42' },
    ]);

    const result = await service.resolve({
      mode: 'group',
      groupId: 'group-1',
    });

    expect(result).toEqual([
      { id: 'pu-1', platform: 'max', externalUserId: '42' },
    ]);
    // Не `ContestParticipant.groupId` самого участника: в MAX участие идёт
    // по кнопке-ссылке под постом, а не по колбэку из конкретной группы, и
    // у конкурса, кросс-постнутого в 2+ MAX-группы, это поле участника
    // всегда null (см. комментарий у resolveGroup). Доставки поста —
    // единственное место, которое всегда знает, в какие группы он вышел.
    const call = callArg<{
      where: {
        consentedAt: { not: null };
        contestEntries: {
          some: { contest: { post: { deliveries: { some: unknown } } } };
        };
      };
    }>(prisma.platformUser.findMany);
    expect(call.where).toEqual({
      consentedAt: { not: null },
      contestEntries: {
        some: {
          contest: { post: { deliveries: { some: { groupId: 'group-1' } } } },
        },
      },
    });
  });

  it('падает NOT_FOUND на несуществующую/удалённую группу — не отдаёт пустой список молча', async () => {
    const { service, prisma } = setup();
    prisma.group.findUnique.mockResolvedValue(null);

    await expect(
      service.resolve({ mode: 'group', groupId: 'ghost-group' }),
    ).rejects.toBeInstanceOf(AppException);
    expect(prisma.platformUser.findMany).not.toHaveBeenCalled();
  });
});

describe('DirectMessageRecipientsService.resolve — all', () => {
  it('берёт всех согласившихся, без дополнительных условий', async () => {
    const { service, prisma } = setup();
    prisma.platformUser.findMany.mockResolvedValue([
      { id: 'pu-1', platform: 'max', externalUserId: '42' },
    ]);

    const result = await service.resolve({ mode: 'all' });

    expect(result).toEqual([
      { id: 'pu-1', platform: 'max', externalUserId: '42' },
    ]);
    const call = callArg<{ where: { consentedAt: { not: null } } }>(
      prisma.platformUser.findMany,
    );
    expect(call.where).toEqual({ consentedAt: { not: null } });
  });
});
