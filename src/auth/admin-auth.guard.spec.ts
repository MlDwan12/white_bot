import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '../common/error-code.enum';
import { AuthService } from './auth.service';
import { AdminAuthGuard, type AdminRequest } from './admin-auth.guard';
import { ACCESS_COOKIE } from './auth.cookies';
import { CSRF_COOKIE, CSRF_HEADER } from './auth.cookies';
import { CsrfGuard } from './csrf.guard';

const admin = (overrides: Record<string, unknown> = {}) => ({
  id: 'admin-1',
  email: 'dev@local',
  role: 'admin',
  extraPermissions: [],
  ...overrides,
});

function contextWith(
  cookies: Record<string, string>,
  extra: { method?: string; headers?: Record<string, string> } = {},
) {
  const request = {
    cookies,
    method: extra.method ?? 'GET',
    headers: extra.headers ?? {},
  } as unknown as AdminRequest;
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
  return { context, request };
}

function buildGuard(
  resolved: Record<string, unknown> | Error,
  required: string[] | undefined,
) {
  // Мок возвращается отдельной ссылкой: обращение к `auth.resolveAdmin`
  // через объект — это несвязанный метод, на что справедливо ругается линтер.
  const resolveAdmin = jest.fn(() =>
    resolved instanceof Error
      ? Promise.reject(resolved)
      : Promise.resolve(resolved),
  );
  const auth = { resolveAdmin } as unknown as AuthService;
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(required),
  } as unknown as Reflector;
  return { guard: new AdminAuthGuard(auth, reflector), resolveAdmin };
}

describe('AdminAuthGuard', () => {
  it('lets a signed-in admin through and exposes them on the request', async () => {
    const { guard } = buildGuard(admin(), undefined);
    const { context, request } = contextWith({ [ACCESS_COOKIE]: 'token' });

    expect(await guard.canActivate(context)).toBe(true);
    expect(request.admin.id).toBe('admin-1');
  });

  it('refuses a request with no access cookie', async () => {
    const { guard, resolveAdmin } = buildGuard(admin(), undefined);
    const { context } = contextWith({});

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
    expect(resolveAdmin).not.toHaveBeenCalled();
  });

  it('allows an endpoint whose permission the admin has', async () => {
    const { guard } = buildGuard(admin(), ['posts_manage']);
    const { context } = contextWith({ [ACCESS_COOKIE]: 'token' });

    expect(await guard.canActivate(context)).toBe(true);
  });

  it('refuses an endpoint whose permission the admin lacks', async () => {
    const { guard } = buildGuard(admin(), ['admins_manage']);
    const { context } = contextWith({ [ACCESS_COOKIE]: 'token' });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_PERMISSIONS,
    });
  });

  it('requires all listed permissions, not just one', async () => {
    const { guard } = buildGuard(admin(), ['posts_manage', 'admins_manage']);
    const { context } = contextWith({ [ACCESS_COOKIE]: 'token' });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_PERMISSIONS,
    });
  });

  it('honours an extra permission granted to one admin', async () => {
    const { guard } = buildGuard(
      admin({ extraPermissions: ['audit_viewAll'] }),
      ['audit_viewAll'],
    );
    const { context } = contextWith({ [ACCESS_COOKIE]: 'token' });

    expect(await guard.canActivate(context)).toBe(true);
  });

  it('rejects when the session no longer resolves to an admin', async () => {
    const { guard } = buildGuard(
      Object.assign(new Error('gone'), { code: ErrorCode.UNAUTHORIZED }),
      undefined,
    );
    const { context } = contextWith({ [ACCESS_COOKIE]: 'stale' });

    await expect(guard.canActivate(context)).rejects.toThrow('gone');
  });
});

describe('CsrfGuard', () => {
  const guard = new CsrfGuard();

  it('lets a read through without a token', () => {
    const { context } = contextWith({}, { method: 'GET' });

    // Подделывать запрос, который ничего не меняет, бессмысленно.
    expect(guard.canActivate(context)).toBe(true);
  });

  it('accepts a write whose header matches the cookie', () => {
    const { context } = contextWith(
      { [CSRF_COOKIE]: 'token-abc' },
      { method: 'POST', headers: { [CSRF_HEADER]: 'token-abc' } },
    );

    expect(guard.canActivate(context)).toBe(true);
  });

  it('refuses a write with no header', () => {
    // Именно этот случай и есть CSRF: браузер приложит куки сам, а заголовок
    // сторонний сайт поставить не может — прочитать чужую куку ему нечем.
    const { context } = contextWith(
      { [CSRF_COOKIE]: 'token-abc' },
      { method: 'POST' },
    );

    expect(() => guard.canActivate(context)).toThrow();
  });

  it('refuses a write whose header does not match', () => {
    const { context } = contextWith(
      { [CSRF_COOKIE]: 'token-abc' },
      { method: 'POST', headers: { [CSRF_HEADER]: 'token-xyz' } },
    );

    expect(() => guard.canActivate(context)).toThrow();
  });

  it('accepts a hidden form field when there is no header', () => {
    // Панель по замыслу работает без JS, а обычная форма заголовки ставить
    // не умеет. Защита не слабеет: чужой сайт не может прочитать куку,
    // чтобы подставить её значение в поле.
    const request = {
      cookies: { [CSRF_COOKIE]: 'token-abc' },
      method: 'POST',
      headers: {},
      body: { _csrf: 'token-abc' },
    } as unknown as AdminRequest;
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    expect(guard.canActivate(context)).toBe(true);
  });

  it('refuses a form field that does not match the cookie', () => {
    const request = {
      cookies: { [CSRF_COOKIE]: 'token-abc' },
      method: 'POST',
      headers: {},
      body: { _csrf: 'token-xyz' },
    } as unknown as AdminRequest;
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    expect(() => guard.canActivate(context)).toThrow();
  });

  it('refuses a write when the cookie is missing entirely', () => {
    const { context } = contextWith(
      {},
      { method: 'POST', headers: { [CSRF_HEADER]: 'token-abc' } },
    );

    expect(() => guard.canActivate(context)).toThrow();
  });
});
