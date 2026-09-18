import { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { GroupsService } from './groups.service';
import { VkApiError } from '../vk/vk-api.error';
import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { VkApiClient } from '../vk/vk-api.client';
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
      updateMany: jest.fn(),
    },
  };
  const vkApiClient = {
    resolveGroupInfo: jest.fn(),
    postTestMessage: jest.fn(),
  };
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

  const service = new GroupsService(
    prisma as unknown as PrismaService,
    vkApiClient as unknown as VkApiClient,
    tokenEncryption as unknown as TokenEncryptionService,
    logger as unknown as PinoLogger,
    vkTokenProvider,
  );

  return { service, prisma, vkApiClient, tokenEncryption, logger };
}

describe('GroupsService', () => {
  describe('createVkGroup', () => {
    it('creates a new active group and sends the test message', async () => {
      const { service, prisma, vkApiClient } = buildService();
      prisma.group.findUnique.mockResolvedValue(null);
      vkApiClient.resolveGroupInfo.mockResolvedValue({
        externalId: '42',
        title: 'Тестовое сообщество',
      });
      vkApiClient.postTestMessage.mockResolvedValue(undefined);
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
      expect(result.testMessageSent).toBe(true);
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
      vkApiClient.postTestMessage.mockResolvedValue(undefined);
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

    it('still connects the group when only the test message fails', async () => {
      const { service, prisma, vkApiClient, logger } = buildService();
      prisma.group.findUnique.mockResolvedValue(null);
      vkApiClient.resolveGroupInfo.mockResolvedValue({
        externalId: '42',
        title: 'Тестовое сообщество',
      });
      vkApiClient.postTestMessage.mockRejectedValue(
        new VkApiError(214, 'Access denied: no rights to perform this action'),
      );
      prisma.group.create.mockResolvedValue({
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

      const result = await service.createVkGroup({ token: 'token' });

      expect(result.testMessageSent).toBe(false);
      expect(logger.warn).toHaveBeenCalled();
      expect(prisma.group.create).toHaveBeenCalled();
    });

    it('converges to an update when a concurrent request wins the create race', async () => {
      const { service, prisma, vkApiClient } = buildService();
      prisma.group.findUnique.mockResolvedValue(null);
      vkApiClient.resolveGroupInfo.mockResolvedValue({
        externalId: '42',
        title: 'Тестовое сообщество',
      });
      vkApiClient.postTestMessage.mockResolvedValue(undefined);
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
      prisma.group.update.mockResolvedValue({
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

      expect(lastCallArg(prisma.group.update)).toMatchObject({
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
      prisma.group.update.mockResolvedValue({
        id: 'g1',
        status: 'pending_confirmation',
        tags: [],
      });

      await service.createOrReactivateMaxDraft({
        externalId: 'c1',
        kind: 'chat',
        title: 'Чат',
      });

      expect(lastCallArg(prisma.group.update)).toMatchObject({
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
      prisma.group.update.mockResolvedValue({
        id: 'g1',
        status: 'pending_confirmation',
        tags: [],
      });

      await service.createOrReactivateMaxDraft({
        externalId: 'c1',
        kind: 'chat',
        title: 'Чат',
      });

      expect(lastCallArg(prisma.group.update)).toMatchObject({
        where: { id: 'g1' },
        data: { status: 'pending_confirmation' },
      });
    });

    it('converges to an update when a concurrent webhook delivery wins the create race', async () => {
      const { service, prisma } = buildService();
      prisma.group.findUnique.mockResolvedValue(null);
      prisma.group.create.mockRejectedValue(uniqueConstraintError());
      prisma.group.findUniqueOrThrow.mockResolvedValue({
        id: 'winner',
        status: 'pending_confirmation',
      });
      prisma.group.update.mockResolvedValue({
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

      expect(lastCallArg(prisma.group.update)).toMatchObject({
        where: { id: 'winner' },
      });
      expect(result.id).toBe('winner');
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
      prisma.group.update.mockResolvedValue({
        id: 'g1',
        status: 'active',
        tags: ['vip'],
      });

      await service.confirmMaxGroup('g1', ['vip']);

      expect(prisma.group.update).toHaveBeenCalledWith({
        where: { id: 'g1' },
        data: { status: 'active', tags: ['vip'] },
      });
    });

    it('hard-deletes a rejected pending draft', async () => {
      const { service, prisma } = buildService();
      prisma.group.findUnique.mockResolvedValue({
        id: 'g1',
        platform: 'max',
        status: 'pending_confirmation',
      });

      await service.rejectMaxGroup('g1');

      expect(prisma.group.delete).toHaveBeenCalledWith({ where: { id: 'g1' } });
    });
  });

  describe('markMaxGroupBotRemoved', () => {
    it('marks a known MAX group as bot_removed', async () => {
      const { service, prisma } = buildService();
      prisma.group.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.markMaxGroupBotRemoved('500')).resolves.toBe(true);
      expect(prisma.group.updateMany).toHaveBeenCalledWith({
        where: {
          platform: 'max',
          externalId: '500',
          status: { notIn: ['removed', 'pending_confirmation'] },
        },
        data: { status: 'bot_removed' },
      });
    });

    it('leaves an explicitly disconnected group and an unreviewed draft alone', async () => {
      const { service, prisma } = buildService();
      prisma.group.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.markMaxGroupBotRemoved('500')).resolves.toBe(false);
      const where = lastCallArg<{ where: { status: unknown } }>(
        prisma.group.updateMany,
      ).where;
      // `removed` means an admin disconnected it on purpose. And overwriting
      // a `pending_confirmation` draft would be worse than cosmetic:
      // maxDraftStatus reads `bot_removed` as "was confirmed once", so a
      // draft removed before review and then re-added would come back
      // `active` — a live broadcast target nobody ever approved.
      expect(where.status).toEqual({
        notIn: ['removed', 'pending_confirmation'],
      });
    });

    it('does not let an unreviewed draft reach active by way of bot_removed', async () => {
      const { service, prisma } = buildService();
      // The draft was never reviewed, so the removal must not touch it...
      prisma.group.updateMany.mockResolvedValue({ count: 0 });
      await service.markMaxGroupBotRemoved('500');

      // ...and re-adding the bot must therefore still ask for confirmation.
      prisma.group.findUnique.mockResolvedValue({
        id: 'g1',
        status: 'pending_confirmation',
      });
      prisma.group.update.mockImplementation(
        (args: { data: { status: string } }) => ({
          id: 'g1',
          platform: 'max',
          kind: 'chat',
          externalId: '500',
          title: 'Чат',
          tokenMask: null,
          tags: [],
          status: args.data.status,
          createdAt: new Date(),
        }),
      );

      const group = await service.createOrReactivateMaxDraft({
        externalId: '500',
        kind: 'chat',
        title: 'Чат',
      });
      expect(group.status).toBe('pending_confirmation');
    });

    it('reports an unknown chat as nothing-to-do rather than failing', async () => {
      const { service, prisma } = buildService();
      prisma.group.updateMany.mockResolvedValue({ count: 0 });

      // A rejected draft is hard-deleted, so its removal event has no row.
      await expect(service.markMaxGroupBotRemoved('999')).resolves.toBe(false);
    });
  });

  describe('listPendingMaxGroups', () => {
    it('returns only MAX drafts awaiting review, oldest first', async () => {
      const { service, prisma } = buildService();
      prisma.group.findMany.mockResolvedValue([]);

      await service.listPendingMaxGroups();

      expect(prisma.group.findMany).toHaveBeenCalledWith({
        where: { platform: 'max', status: 'pending_confirmation' },
        orderBy: { createdAt: 'asc' },
      });
    });
  });
});
