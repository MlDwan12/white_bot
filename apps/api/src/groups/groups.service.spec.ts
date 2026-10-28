import { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { GroupsService } from './groups.service';
import { VkApiError } from '../vk/vk-api.error';
import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { VkApiClient } from '../vk/vk-api.client';
import type { AdminNotifier } from '../max/admin-notifier';
import type { TokenEncryptionService } from '../common/crypto/token-encryption.service';

function uniqueConstraintError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

/** Reads the last call's first argument as `T` — avoids `expect.objectContaining`,
 * whose `any` return type trips `no-unsafe-assignment` when nested in an object literal. */
function lastCallArg<T>(mockFn: jest.Mock): T {
  const calls = mockFn.mock.calls as unknown[][];
  return calls[calls.length - 1][0] as T;
}

function buildService() {
  const prisma = {
    group: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn(),
    },
    // «Бота удалили» — одним UPDATE … RETURNING.
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const vkApiClient = {
    resolveGroupInfo: jest.fn(),
  };
  const notifier = { notifyAll: jest.fn().mockResolvedValue(1) };
  const tokenEncryption = {
    encrypt: jest.fn((plaintext: string) => `enc(${plaintext})`),
    decrypt: jest.fn(),
  };
  const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const vkTokenProvider = {
    resolveToken: jest.fn(
      (input: { pastedToken: string }) => input.pastedToken,
    ),
  };

  const audit = { record: jest.fn(), purgeExpired: jest.fn() };
  const service = new GroupsService(
    prisma as unknown as PrismaService,
    vkApiClient as unknown as VkApiClient,
    tokenEncryption as unknown as TokenEncryptionService,
    notifier as unknown as AdminNotifier,
    audit as never,
    logger as unknown as PinoLogger,
    vkTokenProvider,
  );

  return {
    service,
    prisma,
    vkApiClient,
    tokenEncryption,
    notifier,
    logger,
    audit,
  };
}

describe('GroupsService', () => {
  describe('createVkGroup', () => {
    it('creates a new active group and tells the admins, not the community wall', async () => {
      const { service, prisma, vkApiClient, notifier } = buildService();
      prisma.group.findUnique.mockResolvedValue(null);
      vkApiClient.resolveGroupInfo.mockResolvedValue({
        externalId: '42',
        title: 'Тестовое сообщество',
      });
      prisma.group.create.mockResolvedValue({
        id: 'g1',
        platform: 'vk',
        kind: 'community',
        externalId: '42',
        title: 'Тестовое сообщество',
        accessTokenEncrypted: 'enc(token)',
        tokenMask: 'toke****oken',
        tags: ['news'],
        status: 'active',
        createdAt: new Date('2026-01-01'),
      });

      const result = await service.createVkGroup({
        token: 'token',
        tags: ['news'],
      });

      expect(lastCallArg(prisma.group.create)).toMatchObject({
        data: {
          platform: 'vk',
          kind: 'community',
          externalId: '42',
          status: 'active',
          tags: ['news'],
        },
      });
      expect(notifier.notifyAll).toHaveBeenCalledWith(
        'VK-сообщество «Тестовое сообщество» подключено.',
      );
      expect(result).not.toHaveProperty('accessTokenEncrypted');
    });

    it('reactivates an existing group by (platform, externalId) instead of duplicating it', async () => {
      const { service, prisma, vkApiClient } = buildService();
      prisma.group.findUnique.mockResolvedValue({
        id: 'g1',
        platform: 'vk',
        externalId: '42',
        tags: ['old-tag'],
        status: 'bot_removed',
      });
      vkApiClient.resolveGroupInfo.mockResolvedValue({
        externalId: '42',
        title: 'Тестовое сообщество',
      });
      prisma.group.update.mockResolvedValue({
        id: 'g1',
        platform: 'vk',
        kind: 'community',
        externalId: '42',
        title: 'Тестовое сообщество',
        tokenMask: 'mask',
        tags: ['old-tag'],
        status: 'active',
        createdAt: new Date(),
      });

      await service.createVkGroup({ token: 'token' });

      expect(prisma.group.create).not.toHaveBeenCalled();
      expect(lastCallArg(prisma.group.update)).toMatchObject({
        where: { id: 'g1' },
        data: { status: 'active', tags: ['old-tag'] },
      });
    });

    it.each([
      ['active', true],
      // Слетевший токен заменили той же формой — это замена, не подключение.
      ['token_invalid', true],
      // Отключённое админом и подключённое снова — подключение.
      ['removed', false],
    ])('статус %s: «токен обновлён» = %s', async (status, tokenUpdate) => {
      const { service, prisma, vkApiClient, notifier, audit } = buildService();
      prisma.group.findUnique.mockResolvedValue({
        id: 'g1',
        platform: 'vk',
        externalId: '42',
        tags: [],
        status,
      });
      vkApiClient.resolveGroupInfo.mockResolvedValue({
        externalId: '42',
        title: 'Тестовое сообщество',
      });
      prisma.group.update.mockResolvedValue({
        id: 'g1',
        platform: 'vk',
        kind: 'community',
        externalId: '42',
        title: 'Тестовое сообщество',
        tokenMask: 'mask',
        tags: [],
        status: 'active',
        createdAt: new Date(),
      });

      await service.createVkGroup({ token: 'token' });

      expect(notifier.notifyAll).toHaveBeenCalledWith(
        tokenUpdate
          ? 'Токен VK-сообщества «Тестовое сообщество» обновлён.'
          : 'VK-сообщество «Тестовое сообщество» подключено.',
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: tokenUpdate ? 'group.token' : 'group.connect_vk',
        }),
      );
    });

    it('сохранение тех же тегов — без записи в журнал', async () => {
      const { service, prisma, audit } = buildService();
      prisma.group.findUnique.mockResolvedValue({
        id: 'g1',
        title: 'Канал',
        tags: ['a', 'b'],
      });
      prisma.group.updateMany.mockResolvedValue({ count: 1 });

      await service.updateTags('g1', ['a', 'b']);
      expect(audit.record).not.toHaveBeenCalled();

      await service.updateTags('g1', ['a']);
      expect(audit.record).toHaveBeenCalledTimes(1);
    });

    it('throws a validation error when VK rejects the token', async () => {
      const { service, vkApiClient } = buildService();
      vkApiClient.resolveGroupInfo.mockRejectedValue(
        new VkApiError(5, 'User authorization failed'),
      );

      await expect(service.createVkGroup({ token: 'bad' })).rejects.toThrow(
        AppException,
      );
      await expect(
        service.createVkGroup({ token: 'bad' }),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('converges to an update when a concurrent request wins the create race', async () => {
      const { service, prisma, vkApiClient } = buildService();
      prisma.group.findUnique.mockResolvedValue(null);
      vkApiClient.resolveGroupInfo.mockResolvedValue({
        externalId: '42',
        title: 'Тестовое сообщество',
      });
      prisma.group.create.mockRejectedValue(uniqueConstraintError());
      prisma.group.findUniqueOrThrow.mockResolvedValue({
        id: 'winner',
        tags: ['from-winner'],
      });
      prisma.group.update.mockResolvedValue({
        id: 'winner',
        platform: 'vk',
        kind: 'community',
        externalId: '42',
        title: 'Тестовое сообщество',
        tokenMask: 'mask',
        tags: ['from-winner'],
        status: 'active',
        createdAt: new Date(),
      });

      const result = await service.createVkGroup({ token: 'token' });

      expect(lastCallArg(prisma.group.update)).toMatchObject({
        where: { id: 'winner' },
      });
      expect(result.id).toBe('winner');
    });
  });

  describe('replaceVkToken', () => {
    it('rejects a token that resolves to a different community', async () => {
      const { service, prisma, vkApiClient } = buildService();
      prisma.group.findUnique.mockResolvedValue({
        id: 'g1',
        platform: 'vk',
        externalId: '42',
      });
      vkApiClient.resolveGroupInfo.mockResolvedValue({
        externalId: '999',
        title: 'Другое сообщество',
      });

      await expect(
        service.replaceVkToken('g1', 'other-token'),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('rejects replacing a token on a non-VK group', async () => {
      const { service, prisma } = buildService();
      prisma.group.findUnique.mockResolvedValue({ id: 'g1', platform: 'max' });

      await expect(service.replaceVkToken('g1', 'token')).rejects.toMatchObject(
        { code: ErrorCode.REQUEST_ERROR },
      );
    });
  });

  describe('deactivate', () => {
    it('rejects deactivating an already-removed group', async () => {
      const { service, prisma } = buildService();
      prisma.group.findUnique.mockResolvedValue({
        id: 'g1',
        status: 'removed',
      });

      await expect(service.deactivate('g1')).rejects.toMatchObject({
        code: ErrorCode.REQUEST_ERROR,
      });
    });

    it('throws NOT_FOUND for an unknown id', async () => {
      const { service, prisma } = buildService();
      prisma.group.findUnique.mockResolvedValue(null);

      await expect(service.deactivate('missing')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });

  describe('createOrReactivateMaxDraft', () => {
    it('creates a pending draft for a brand-new chat', async () => {
      const { service, prisma } = buildService();
      prisma.group.findUnique.mockResolvedValue(null);
      prisma.group.create.mockResolvedValue({
        id: 'g1',
        platform: 'max',
        kind: 'chat',
        externalId: 'c1',
        title: 'Чат',
        tokenMask: null,
        tags: [],
        status: 'pending_confirmation',
        createdAt: new Date(),
      });

      const result = await service.createOrReactivateMaxDraft({
        externalId: 'c1',
        kind: 'chat',
        title: 'Чат',
      });

      expect(result.status).toBe('pending_confirmation');
    });

    it('reactivates a previously-confirmed chat straight to active, skipping confirmation', async () => {
      const { service, prisma } = buildService();
      prisma.group.findUnique.mockResolvedValue({
        id: 'g1',
        status: 'bot_removed',
      });
      prisma.group.updateMany.mockResolvedValue({ count: 1 });
      prisma.group.findUniqueOrThrow.mockResolvedValue({
        id: 'g1',
        platform: 'max',
        kind: 'chat',
        externalId: 'c1',
        title: 'Чат',
        tokenMask: null,
        tags: [],
        status: 'active',
        createdAt: new Date(),
      });

      const result = await service.createOrReactivateMaxDraft({
        externalId: 'c1',
        kind: 'chat',
        title: 'Чат',
      });

      expect(lastCallArg(prisma.group.updateMany)).toMatchObject({
        where: { id: 'g1' },
        data: { status: 'active' },
      });
      expect(result.status).toBe('active');
    });

    it('keeps a still-pending draft pending instead of skipping confirmation', async () => {
      const { service, prisma } = buildService();
      prisma.group.findUnique.mockResolvedValue({
        id: 'g1',
        status: 'pending_confirmation',
      });
      prisma.group.updateMany.mockResolvedValue({ count: 1 });
      prisma.group.findUniqueOrThrow.mockResolvedValue({
        id: 'g1',
        status: 'pending_confirmation',
        tags: [],
      });

      await service.createOrReactivateMaxDraft({
        externalId: 'c1',
        kind: 'chat',
        title: 'Чат',
      });

      expect(lastCallArg(prisma.group.updateMany)).toMatchObject({
        where: { id: 'g1' },
        data: { status: 'pending_confirmation' },
      });
    });

    it('requires re-confirmation for a group an admin explicitly removed', async () => {
      const { service, prisma } = buildService();
      prisma.group.findUnique.mockResolvedValue({
        id: 'g1',
        status: 'removed',
      });
      prisma.group.updateMany.mockResolvedValue({ count: 1 });
      prisma.group.findUniqueOrThrow.mockResolvedValue({
        id: 'g1',
        status: 'pending_confirmation',
        tags: [],
      });

      await service.createOrReactivateMaxDraft({
        externalId: 'c1',
        kind: 'chat',
        title: 'Чат',
      });

      expect(lastCallArg(prisma.group.updateMany)).toMatchObject({
        where: { id: 'g1' },
        data: { status: 'pending_confirmation' },
      });
    });

    it('converges to an update when a concurrent webhook delivery wins the create race', async () => {
      const { service, prisma } = buildService();
      prisma.group.findUnique.mockResolvedValue(null);
      prisma.group.create.mockRejectedValue(uniqueConstraintError());
      prisma.group.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'winner',
        status: 'pending_confirmation',
      });
      prisma.group.updateMany.mockResolvedValue({ count: 1 });
      prisma.group.findUniqueOrThrow.mockResolvedValue({
        id: 'winner',
        platform: 'max',
        kind: 'chat',
        externalId: 'c1',
        title: 'Чат',
        tokenMask: null,
        tags: [],
        status: 'pending_confirmation',
        createdAt: new Date(),
      });

      const result = await service.createOrReactivateMaxDraft({
        externalId: 'c1',
        kind: 'chat',
        title: 'Чат',
      });

      expect(lastCallArg(prisma.group.updateMany)).toMatchObject({
        where: { id: 'winner' },
      });
      expect(result.id).toBe('winner');
    });
  });

  describe('createOrReactivateMaxDraft — журнал', () => {
    it('параллельное такое же событие успело раньше — без второй записи «бота добавили»', async () => {
      const { service, prisma, audit } = buildService();
      prisma.group.findUnique.mockResolvedValue({
        id: 'g1',
        status: 'bot_removed',
      });
      // Строка уже не `bot_removed` — её перевело первое событие.
      prisma.group.updateMany.mockResolvedValue({ count: 0 });
      prisma.group.update.mockResolvedValue({
        id: 'g1',
        status: 'active',
        tags: [],
      });

      await service.createOrReactivateMaxDraft({
        externalId: 'c1',
        kind: 'chat',
        title: 'Чат',
      });

      expect(lastCallArg(prisma.group.updateMany)).toMatchObject({
        where: { id: 'g1', status: 'bot_removed' },
      });
      // Статус не трогаем, а свежее название из события — записываем.
      expect(lastCallArg(prisma.group.update)).toEqual({
        where: { id: 'g1' },
        data: { title: 'Чат', kind: 'chat' },
      });
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('confirmMaxGroup / rejectMaxGroup', () => {
    it('rejects confirming a group that is not pending', async () => {
      const { service, prisma } = buildService();
      prisma.group.findUnique.mockResolvedValue({
        id: 'g1',
        platform: 'max',
        status: 'active',
      });

      await expect(service.confirmMaxGroup('g1')).rejects.toMatchObject({
        code: ErrorCode.REQUEST_ERROR,
      });
    });

    it('activates a pending MAX group and applies provided tags', async () => {
      const { service, prisma } = buildService();
      prisma.group.findUnique.mockResolvedValue({
        id: 'g1',
        platform: 'max',
        status: 'pending_confirmation',
        tags: [],
      });
      prisma.group.updateMany.mockResolvedValue({ count: 1 });
      prisma.group.findUniqueOrThrow.mockResolvedValue({
        id: 'g1',
        status: 'active',
        tags: ['vip'],
      });

      await service.confirmMaxGroup('g1', ['vip']);

      expect(prisma.group.updateMany).toHaveBeenCalledWith({
        where: { id: 'g1', status: 'pending_confirmation' },
        data: { status: 'active', tags: ['vip'] },
      });
    });

    it('группу успели отклонить — отказ, а не «подключена»', async () => {
      const { service, prisma, audit } = buildService();
      prisma.group.findUnique.mockResolvedValue({
        id: 'g1',
        platform: 'max',
        status: 'pending_confirmation',
        tags: [],
      });
      prisma.group.updateMany.mockResolvedValue({ count: 0 });
      prisma.group.findUniqueOrThrow.mockResolvedValue({
        id: 'g1',
        status: 'removed',
        tags: [],
      });

      await expect(service.confirmMaxGroup('g1')).rejects.toMatchObject({
        code: ErrorCode.REQUEST_ERROR,
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('второе почти одновременное «Подтвердить» — без второй записи в журнале', async () => {
      const { service, prisma, audit } = buildService();
      prisma.group.findUnique.mockResolvedValue({
        id: 'g1',
        platform: 'max',
        status: 'pending_confirmation',
        tags: [],
      });
      // Первое уже перевело строку в `active`.
      prisma.group.updateMany.mockResolvedValue({ count: 0 });
      prisma.group.findUniqueOrThrow.mockResolvedValue({
        id: 'g1',
        status: 'active',
        tags: [],
      });

      await service.confirmMaxGroup('g1');

      expect(audit.record).not.toHaveBeenCalled();
    });

    it('hard-deletes a rejected pending draft', async () => {
      const { service, prisma } = buildService();
      prisma.group.findUnique.mockResolvedValue({
        id: 'g1',
        platform: 'max',
        status: 'pending_confirmation',
      });

      await service.rejectMaxGroup('g1');

      expect(prisma.group.deleteMany).toHaveBeenCalledWith({
        where: { id: 'g1', status: 'pending_confirmation' },
      });
    });

    it('второе «Отклонить» — понятный отказ, а не 500 и не вторая запись', async () => {
      const { service, prisma, audit } = buildService();
      prisma.group.findUnique.mockResolvedValue({
        id: 'g1',
        platform: 'max',
        status: 'pending_confirmation',
      });
      prisma.group.deleteMany.mockResolvedValue({ count: 0 });

      await expect(service.rejectMaxGroup('g1')).rejects.toMatchObject({
        code: ErrorCode.REQUEST_ERROR,
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('falls back to a soft delete when a returning group still has history pinning it', async () => {
      const { service, prisma } = buildService();
      prisma.group.findUnique.mockResolvedValue({
        id: 'g1',
        platform: 'max',
        status: 'pending_confirmation',
      });
      prisma.group.deleteMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('fk', {
          code: 'P2003',
          clientVersion: 'test',
        }),
      );
      prisma.group.updateMany.mockResolvedValue({ count: 1 });

      await service.rejectMaxGroup('g1');

      expect(prisma.group.updateMany).toHaveBeenCalledWith({
        where: { id: 'g1', status: 'pending_confirmation' },
        data: { status: 'removed' },
      });
    });
  });

  describe('markMaxGroupBotRemoved', () => {
    const sqlOf = (prisma: { $queryRaw: jest.Mock }) =>
      ((prisma.$queryRaw.mock.calls as unknown[][])[0][0] as string[]).join(
        '?',
      );

    it('повтор того же события — без второй записи «бота удалили» в журнале', async () => {
      // Уже помеченная группа не попадает под условие: строк нет — и
      // записи нет, даже когда два одинаковых события пришли одновременно.
      const { service, prisma, audit } = buildService();
      prisma.$queryRaw.mockResolvedValue([]);

      await expect(service.markMaxGroupBotRemoved('500')).resolves.toBe(false);

      expect(audit.record).not.toHaveBeenCalled();
    });

    it('первое событие — запись с id и названием группы, не с id чата', async () => {
      const { service, prisma, audit } = buildService();
      prisma.$queryRaw.mockResolvedValue([{ id: 'g-1', title: 'Новости' }]);

      await expect(service.markMaxGroupBotRemoved('500')).resolves.toBe(true);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: 'g-1',
          action: 'group.bot_removed',
          summary: 'Бота удалили из канала «Новости»',
        }),
      );
    });

    it('не трогает отключённую админом, неподтверждённую и уже помеченную', async () => {
      const { service, prisma } = buildService();

      await service.markMaxGroupBotRemoved('500');

      // `removed` means an admin disconnected it on purpose. And overwriting
      // a `pending_confirmation` draft would be worse than cosmetic:
      // maxDraftStatus reads `bot_removed` as "was confirmed once", so a
      // draft removed before review and then re-added would come back
      // `active` — a live broadcast target nobody ever approved. Уже
      // помеченная `bot_removed` тоже не трогается — повтор события не
      // должен давать вторую запись в журнале.
      expect(sqlOf(prisma)).toContain(
        "status NOT IN ('removed', 'pending_confirmation', 'bot_removed')",
      );
      expect(sqlOf(prisma)).toContain("platform = 'max'");
    });

    it('does not let an unreviewed draft reach active by way of bot_removed', async () => {
      const { service, prisma } = buildService();
      // The draft was never reviewed, so the removal must not touch it...
      prisma.$queryRaw.mockResolvedValue([]);
      await service.markMaxGroupBotRemoved('500');

      // ...and re-adding the bot must therefore still ask for confirmation.
      prisma.group.findUnique.mockResolvedValue({
        id: 'g1',
        status: 'pending_confirmation',
      });
      prisma.group.updateMany.mockResolvedValue({ count: 1 });
      prisma.group.findUniqueOrThrow.mockResolvedValue({
        id: 'g1',
        status: 'pending_confirmation',
        tags: [],
      });

      await service.createOrReactivateMaxDraft({
        externalId: '500',
        kind: 'chat',
        title: 'Чат',
      });
      expect(lastCallArg(prisma.group.updateMany)).toMatchObject({
        data: { status: 'pending_confirmation' },
      });
    });

    it('reports an unknown chat as nothing-to-do rather than failing', async () => {
      const { service, prisma } = buildService();
      prisma.$queryRaw.mockResolvedValue([]);

      // A rejected draft is hard-deleted, so its removal event has no row.
      await expect(service.markMaxGroupBotRemoved('999')).resolves.toBe(false);
    });
  });
});
