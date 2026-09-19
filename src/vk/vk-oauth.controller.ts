import { randomBytes } from 'node:crypto';
import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { VkApiError } from './vk-api.error';
import { VkUploaderTokenService } from './vk-uploader-token.service';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';

const STATE_COOKIE = 'vk_oauth_state';
const STATE_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/**
 * Re-authorization flow for the personal VK uploader token (see
 * VkUploaderTokenService). Not exposed to end users — an admin-only manual
 * step until the panel (Step 8) can show a "reconnect" button instead of
 * a raw link, and MAX (Step 5) can push that link into chat proactively.
 *
 * `state` cookie guards against a login-CSRF: without it, an attacker could
 * get their own valid VK authorization code for this app, then trick an
 * admin into opening /callback?code=<attacker's code> — silently replacing
 * the singleton uploader token with the attacker's VK identity. The cookie
 * ties a callback to a browser that genuinely visited /authorize first.
 *
 * Но одного `state` мало: он защищает админа от подсунутого кода и никак не
 * мешает злоумышленнику пройти весь поток в **своём** браузере — зайти на
 * /authorize, получить свою же куку, авторизоваться своим аккаунтом VK и
 * подменить загрузочный токен всего развёртывания. Поэтому выдача `state`
 * закрыта входом: без него получить валидную пару state+cookie нельзя.
 *
 * На самом /callback гварда нет и быть не может: это переход из vk.com,
 * то есть межсайтовая навигация, на которой access-кука с `SameSite=strict`
 * браузером не отправляется. Его пропуском служит `state`, кука которого
 * помечена `lax` и на такой навигации доходит.
 */
@Controller('vk/oauth')
export class VkOAuthController {
  constructor(private readonly uploaderToken: VkUploaderTokenService) {}

  @Get('authorize')
  @UseGuards(AdminAuthGuard)
  @RequirePermissions('groups_tokens_manage')
  authorize(@Res() res: Response): void {
    const state = randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: STATE_COOKIE_MAX_AGE_MS,
    });
    res.redirect(this.uploaderToken.buildAuthorizeUrl(state));
  }

  @Get('callback')
  async callback(
    @Req() req: Request,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error_description') errorDescription?: string,
  ): Promise<{ status: 'connected'; expiresAt: Date }> {
    if (!code) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        errorDescription ?? 'VK не вернул код авторизации',
      );
    }

    const expectedState = readCookie(req, STATE_COOKIE);
    if (!state || !expectedState || state !== expectedState) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Недействительный или истёкший state — начните авторизацию заново через /vk/oauth/authorize',
      );
    }

    try {
      const { expiresAt } =
        await this.uploaderToken.exchangeAuthorizationCode(code);
      return { status: 'connected', expiresAt };
    } catch (err: unknown) {
      if (err instanceof VkApiError) {
        throw new AppException(ErrorCode.VALIDATION_ERROR, err.message);
      }
      throw err;
    }
  }
}
