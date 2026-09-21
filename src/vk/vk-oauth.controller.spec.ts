import type { Request, Response } from 'express';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { VkApiError } from './vk-api.error';
import { VkOAuthController } from './vk-oauth.controller';
import type { VkUploaderTokenService } from './vk-uploader-token.service';

function buildController() {
  const uploaderToken = {
    buildAuthorizeUrl: jest.fn(
      (state: string) => `https://vk/authorize?state=${state}`,
    ),
    exchangeAuthorizationCode: jest.fn(),
  };
  const controller = new VkOAuthController(
    uploaderToken as unknown as VkUploaderTokenService,
  );
  return { controller, uploaderToken };
}

function fakeResponse() {
  return { cookie: jest.fn(), redirect: jest.fn() };
}

/**
 * Контроллер читает куки через общий `readCookie` (см. `../auth/read-cookie`),
 * который смотрит в `req.cookies` — туда их в реальном запросе кладёт
 * `cookie-parser` (подключён глобально в `main.ts`). Здесь эта разборка
 * сделана вручную, чтобы не тянуть само мидлварное в юнит-тест.
 */
function fakeRequest(cookieHeader?: string): Request {
  const cookies: Record<string, string> = {};
  for (const part of (cookieHeader ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  }
  return { cookies } as unknown as Request;
}

describe('VkOAuthController', () => {
  it('sets a state cookie and redirects to a URL carrying the same state', () => {
    const { controller, uploaderToken } = buildController();
    const res = fakeResponse();

    controller.authorize(res as unknown as Response);

    const [[cookieName, cookieValue]] = res.cookie.mock.calls as [
      [string, string],
    ];
    expect(cookieName).toBe('vk_oauth_state');
    expect(uploaderToken.buildAuthorizeUrl).toHaveBeenCalledWith(cookieValue);
    expect(res.redirect).toHaveBeenCalledWith(
      `https://vk/authorize?state=${cookieValue}`,
    );
  });

  it('rejects a callback whose state does not match the cookie (CSRF)', async () => {
    const { controller } = buildController();
    const req = fakeRequest('vk_oauth_state=expected-nonce');

    await expect(
      controller.callback(req, 'some-code', 'attacker-supplied-nonce'),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it('rejects a callback with no state cookie at all', async () => {
    const { controller } = buildController();
    const req = fakeRequest(undefined);

    await expect(
      controller.callback(req, 'some-code', 'whatever'),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('exchanges the code once the state matches the cookie', async () => {
    const { controller, uploaderToken } = buildController();
    const req = fakeRequest('vk_oauth_state=matching-nonce');
    const expiresAt = new Date();
    uploaderToken.exchangeAuthorizationCode.mockResolvedValue({ expiresAt });

    const result = await controller.callback(req, 'the-code', 'matching-nonce');

    expect(uploaderToken.exchangeAuthorizationCode).toHaveBeenCalledWith(
      'the-code',
    );
    expect(result).toEqual({ status: 'connected', expiresAt });
  });

  it('wraps a VkApiError from the exchange into a clean AppException instead of leaking a 500', async () => {
    const { controller, uploaderToken } = buildController();
    const req = fakeRequest('vk_oauth_state=nonce');
    uploaderToken.exchangeAuthorizationCode.mockRejectedValue(
      new VkApiError(0, 'code expired'),
    );

    await expect(
      controller.callback(req, 'the-code', 'nonce'),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it('rejects when VK returns no code', async () => {
    const { controller } = buildController();
    const req = fakeRequest('vk_oauth_state=nonce');

    await expect(
      controller.callback(req, undefined, 'nonce', 'access_denied'),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });
});
