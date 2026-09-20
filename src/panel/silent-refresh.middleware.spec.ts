import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { Request, Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../auth/auth.cookies';
import { SilentRefreshMiddleware } from './silent-refresh.middleware';

function setup(cookies: Record<string, string>) {
  const auth = {
    refresh: jest.fn().mockResolvedValue({
      access: 'new-access',
      refresh: { token: 'new-refresh', expiresAt: new Date() },
    }),
  };
  const config = { get: () => 'false' } as unknown as ConfigService;
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
  } as unknown as PinoLogger;
  const middleware = new SilentRefreshMiddleware(
    auth as unknown as AuthService,
    config,
    logger,
  );
  const req = { cookies } as unknown as Request;
  const res = { cookie: jest.fn() } as unknown as Response;
  const next = jest.fn();
  return { middleware, req, res, next, auth };
}

describe('SilentRefreshMiddleware', () => {
  it('renews the session when the access cookie has expired', async () => {
    const { middleware, req, res, next, auth } = setup({
      [REFRESH_COOKIE]: 'live-refresh',
    });

    await middleware.use(req, res, next);

    // Панель работает без JS, значит `/auth/refresh` никто не позовёт сам, и
    // без этого каждые 15 минут админа выбрасывало бы на форму входа.
    expect(auth.refresh).toHaveBeenCalledWith('live-refresh');
    expect(next).toHaveBeenCalled();
  });

  it('hands the fresh token to the guard through the request', async () => {
    const cookies = { [REFRESH_COOKIE]: 'live-refresh' };
    const { middleware, req, res, next } = setup(cookies);

    await middleware.use(req, res, next);

    // Гвард читает куки запроса, а не ответа: без подмены он не увидел бы
    // только что выданный токен и всё равно отказал.
    expect(cookies[ACCESS_COOKIE]).toBe('new-access');
  });

  it('does nothing while the access cookie is still alive', async () => {
    const { middleware, req, res, next, auth } = setup({
      [ACCESS_COOKIE]: 'still-good',
      [REFRESH_COOKIE]: 'live-refresh',
    });

    await middleware.use(req, res, next);

    expect(auth.refresh).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('does nothing for a visitor with no session at all', async () => {
    const { middleware, req, res, next, auth } = setup({});

    await middleware.use(req, res, next);

    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it('lets the guard decide when the refresh token is dead', async () => {
    const { middleware, req, res, next, auth } = setup({
      [REFRESH_COOKIE]: 'revoked',
    });
    auth.refresh.mockRejectedValue(new Error('сессия отозвана'));

    await middleware.use(req, res, next);

    // Падать здесь нельзя: отказ — это обычный «пора войти заново», и решает
    // это гвард, а не продление.
    expect(next).toHaveBeenCalled();
  });
});
