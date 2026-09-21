import { ConfigService } from '@nestjs/config';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { VkApiError } from './vk-api.error';
import { VkUploaderTokenService } from './vk-uploader-token.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TokenEncryptionService } from '../common/crypto/token-encryption.service';

function mockFetchOnce(body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  }) as typeof fetch;
}

function buildService() {
  const prisma = {
    vkUploaderToken: { findUnique: jest.fn(), upsert: jest.fn() },
  };
  const tokenEncryption = {
    encrypt: jest.fn((plaintext: string) => `enc(${plaintext})`),
    decrypt: jest.fn((ciphertext: string) =>
      ciphertext.replace(/^enc\((.*)\)$/, '$1'),
    ),
  };
  const config = {
    getOrThrow: jest.fn((key: string) =>
      key === 'VK_APP_ID' ? 'app-id' : 'app-secret',
    ),
  };

  const service = new VkUploaderTokenService(
    prisma as unknown as PrismaService,
    tokenEncryption as unknown as TokenEncryptionService,
    config as unknown as ConfigService,
  );

  return { service, prisma, tokenEncryption };
}

describe('VkUploaderTokenService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getStatus', () => {
    const HOUR = 60 * 60 * 1000;

    it('говорит «не подключён», пока токена нет', async () => {
      const { service, prisma } = buildService();
      prisma.vkUploaderToken.findUnique.mockResolvedValue(null);

      expect(await service.getStatus()).toEqual({
        state: 'missing',
        expiresAt: null,
      });
    });

    it('говорит «действует» и называет срок', async () => {
      const { service, prisma } = buildService();
      const expiresAt = new Date(Date.now() + 10 * HOUR);
      prisma.vkUploaderToken.findUnique.mockResolvedValue({ expiresAt });

      expect(await service.getStatus()).toEqual({ state: 'usable', expiresAt });
    });

    it('говорит «истёк», если срок вышел, и всё равно называет его', async () => {
      const { service, prisma } = buildService();
      const expiresAt = new Date(Date.now() - HOUR);
      prisma.vkUploaderToken.findUnique.mockResolvedValue({ expiresAt });

      expect(await service.getStatus()).toEqual({
        state: 'expired',
        expiresAt,
      });
    });

    it('считает токен истёкшим за минуту до срока, как и isUsable', async () => {
      // Панель не должна показывать зелёное там, где отправка уже откажет:
      // статус и `isUsable` обязаны отвечать одинаково.
      const { service, prisma } = buildService();
      const expiresAt = new Date(Date.now() + 1000);
      prisma.vkUploaderToken.findUnique.mockResolvedValue({ expiresAt });

      expect((await service.getStatus()).state).toBe('expired');
      expect(await service.isUsable()).toBe(false);
    });
  });

  describe('getValidAccessToken', () => {
    it('throws VK_UPLOADER_TOKEN_EXPIRED with a reauthorize link when no token was ever saved', async () => {
      const { service, prisma } = buildService();
      prisma.vkUploaderToken.findUnique.mockResolvedValue(null);

      // `then` with both handlers, not `.catch`: a bare catch widens the type
      // to `string | AppException` (the success value included), which fails
      // the type check.
      const error: AppException = await service.getValidAccessToken().then(
        () => {
          throw new Error('Ожидалась ошибка, но токен был возвращён');
        },
        (err: unknown) => err as AppException,
      );

      expect(error).toBeInstanceOf(AppException);
      expect(error.code).toBe(ErrorCode.VK_UPLOADER_TOKEN_EXPIRED);
      const details = error.details as { reauthorizeUrl: string };
      expect(details.reauthorizeUrl).toBe('/vk/oauth/authorize');
    });

    it('throws when the stored token is within the expiry safety margin', async () => {
      const { service, prisma } = buildService();
      prisma.vkUploaderToken.findUnique.mockResolvedValue({
        accessTokenEncrypted: 'enc(token)',
        expiresAt: new Date(Date.now() + 60_000), // 1 minute left, margin is 5
      });

      await expect(service.getValidAccessToken()).rejects.toMatchObject({
        code: ErrorCode.VK_UPLOADER_TOKEN_EXPIRED,
      });
    });

    it('returns the decrypted token when it is comfortably valid', async () => {
      const { service, prisma } = buildService();
      prisma.vkUploaderToken.findUnique.mockResolvedValue({
        accessTokenEncrypted: 'enc(real-token)',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      });

      await expect(service.getValidAccessToken()).resolves.toBe('real-token');
    });
  });

  describe('exchangeAuthorizationCode', () => {
    it('encrypts and stores the token with its computed expiry', async () => {
      const { service, prisma, tokenEncryption } = buildService();
      mockFetchOnce({
        access_token: 'fresh-token',
        expires_in: 86400,
        user_id: 42,
      });
      prisma.vkUploaderToken.upsert.mockResolvedValue({});

      const { expiresAt } = await service.exchangeAuthorizationCode('code');

      expect(tokenEncryption.encrypt).toHaveBeenCalledWith('fresh-token');
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
      const [[call]] = prisma.vkUploaderToken.upsert.mock.calls as [
        [{ create: { vkUserId: string } }],
      ];
      expect(call.create.vkUserId).toBe('42');
    });

    it('throws a VkApiError when VK rejects the code', async () => {
      const { service } = buildService();
      mockFetchOnce({
        error: 'invalid_grant',
        error_description: 'code expired',
      });

      await expect(service.exchangeAuthorizationCode('code')).rejects.toThrow(
        VkApiError,
      );
    });

    it('throws a VkApiError on an unrecognized response shape', async () => {
      const { service } = buildService();
      mockFetchOnce({ unexpected: true });

      await expect(service.exchangeAuthorizationCode('code')).rejects.toThrow(
        VkApiError,
      );
    });

    it('throws a VkApiError on a non-2xx HTTP response instead of a raw parse error', async () => {
      const { service } = buildService();
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: () => Promise.reject(new SyntaxError('not json')),
      }) as typeof fetch;

      await expect(service.exchangeAuthorizationCode('code')).rejects.toThrow(
        VkApiError,
      );
    });

    it('throws a VkApiError when the network request itself fails', async () => {
      const { service } = buildService();
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('network down')) as typeof fetch;

      await expect(service.exchangeAuthorizationCode('code')).rejects.toThrow(
        VkApiError,
      );
    });
  });

  describe('buildAuthorizeUrl', () => {
    it('includes the given state so the callback can validate it', () => {
      const { service } = buildService();

      const url = service.buildAuthorizeUrl('nonce-123');

      expect(new URL(url).searchParams.get('state')).toBe('nonce-123');
    });
  });
});
