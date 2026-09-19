import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { MaxWebAppGuard, type MaxWebAppRequest } from './max-webapp.guard';
import { signInitData } from './webapp-init-data';

const TOKEN = 'bot-token';

const launchData = (overrides: Record<string, string> = {}) =>
  signInitData(
    {
      auth_date: String(Math.floor(Date.now() / 1000)),
      chat: '{"id":-79114405995998,"type":"CHANNEL"}',
      start_param: 'contest-1',
      user: '{"id":42,"first_name":"Иван","last_name":"Петренко"}',
      ...overrides,
    },
    TOKEN,
  );

function contextWith(authorization?: string): {
  context: ExecutionContext;
  request: MaxWebAppRequest;
} {
  const request = { headers: { authorization } } as unknown as MaxWebAppRequest;
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

// Токен передаётся явно: значение по умолчанию подменяло бы `undefined`
// обратно на токен, и проверка «без токена» молча проверяла бы не то.
function buildGuard(token: string | undefined) {
  const config = { get: () => token } as unknown as ConfigService;
  const logger = {
    setContext: jest.fn(),
    warn: jest.fn(),
  } as unknown as PinoLogger;
  return new MaxWebAppGuard(config, logger);
}

describe('MaxWebAppGuard', () => {
  it('accepts a correctly signed launch and exposes the user', () => {
    const { context, request } = contextWith(`MaxWebApp ${launchData()}`);

    expect(buildGuard(TOKEN).canActivate(context)).toBe(true);
    expect(request.maxWebApp.user.id).toBe(42);
    // The contest is named by the signed start_param, which is why no
    // endpoint takes a contest id as a parameter.
    expect(request.maxWebApp.startParam).toBe('contest-1');
    expect(request.maxWebApp.chatId).toBe(-79114405995998);
  });

  it('rejects a request with no Authorization header', () => {
    expect(() => buildGuard(TOKEN).canActivate(contextWith().context)).toThrow(
      expect.objectContaining({ code: ErrorCode.UNAUTHORIZED }) as Error,
    );
  });

  it('accepts the scheme in any case', () => {
    // Схемы авторизации регистронезависимы по RFC 7235, а клиенты и прокси
    // нередко нормализуют регистр сами.
    const { context } = contextWith(`maxwebapp ${launchData()}`);

    expect(buildGuard(TOKEN).canActivate(context)).toBe(true);
  });

  it('rejects another auth scheme', () => {
    const { context } = contextWith(`Bearer ${launchData()}`);

    expect(() => buildGuard(TOKEN).canActivate(context)).toThrow(AppException);
  });

  it('rejects a tampered signature', () => {
    const tampered = launchData().replace(/.$/, '0');
    const { context } = contextWith(`MaxWebApp ${tampered}`);

    expect(() => buildGuard(TOKEN).canActivate(context)).toThrow(AppException);
  });

  it('rejects data signed with a different bot token', () => {
    const foreign = signInitData(
      { auth_date: String(Math.floor(Date.now() / 1000)), user: '{"id":42}' },
      'not-our-token',
    );
    const { context } = contextWith(`MaxWebApp ${foreign}`);

    expect(() => buildGuard(TOKEN).canActivate(context)).toThrow(AppException);
  });

  it('does not reveal why the check failed', () => {
    const { context } = contextWith('MaxWebApp nonsense');

    try {
      buildGuard(TOKEN).canActivate(context);
      fail('ожидалась ошибка');
    } catch (error) {
      // Someone brute-forcing a signature should not learn which part of
      // their attempt was wrong.
      expect((error as AppException).message).not.toMatch(/подпис|hash/i);
    }
  });

  it('refuses everything when no bot token is configured', () => {
    const { context } = contextWith(`MaxWebApp ${launchData()}`);

    // Without the token the signature cannot be checked at all, and letting
    // requests through unchecked would open contests to anyone.
    expect(() => buildGuard(undefined).canActivate(context)).toThrow(
      AppException,
    );
  });

  it('rejects a launch that carries no user', () => {
    const noUser = signInitData(
      { auth_date: String(Math.floor(Date.now() / 1000)), start_param: 'x' },
      TOKEN,
    );
    const { context } = contextWith(`MaxWebApp ${noUser}`);

    expect(() => buildGuard(TOKEN).canActivate(context)).toThrow(AppException);
  });
});
