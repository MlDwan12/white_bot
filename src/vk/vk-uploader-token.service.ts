import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { TokenEncryptionService } from '../common/crypto/token-encryption.service';
import { PrismaService } from '../prisma/prisma.service';
import { VkApiError } from './vk-api.error';

// VK's own docs (dev.vk.ru/ru/api/access-token/getting-started) say this
// classic Authorization Code Flow "отключён с 25 июня 2024" for *new*
// registrations, with old ones grandfathered ("не отозванные, продолжают
// работать") — this app is newer than that cutoff and it still works as of
// 2026-09-17 (confirmed live), but VK could close that gap without notice.
// The current/"official" replacement (VK ID) issues user tokens living only
// 1 hour with no refresh_token either — strictly worse for our purposes, so
// deliberately not migrated to it. If this endpoint ever stops working, the
// fix is a new reauth flow, not a bug in this service.
const SINGLETON_ID = 'singleton';
const OAUTH_BASE = 'https://oauth.vk.ru';
const VK_API_VERSION = '5.199';
// Phase 1 content (PLAN.md "Фазировка типов контента"): text (community
// token, no scope needed) + photo/document wall attachments (this token).
const SCOPE = 'wall,photos,docs';
// The only redirect_uri VK accepts for this app — see env.validation.ts.
const REDIRECT_URI = 'https://oauth.vk.com/blank.html';
// Refuse a token this close to expiry rather than risk it dying mid-upload.
// Classic VK OAuth issues no refresh_token, so there is no automatic renewal
// path — expiry always means "an admin must click the reauth link".
const EXPIRY_SAFETY_MARGIN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
// A fixed, relative path rather than a freshly built VK URL: the surfaced
// link must go through our own /authorize route (which sets the CSRF state
// cookie) — a link straight to VK's authorize endpoint would skip that and
// fail the callback's state check. See VkOAuthController.
const REAUTHORIZE_PATH = '/vk/oauth/authorize';

function parseTokenResponse(body: unknown): {
  accessToken: string;
  expiresInSeconds: number;
  userId: number;
} {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const description =
      'error_description' in body && typeof body.error_description === 'string'
        ? body.error_description
        : 'неизвестная ошибка';
    throw new VkApiError(0, `VK отклонил обмен кода на токен: ${description}`);
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !('access_token' in body) ||
    !('expires_in' in body) ||
    !('user_id' in body) ||
    typeof body.access_token !== 'string' ||
    typeof body.expires_in !== 'number' ||
    typeof body.user_id !== 'number'
  ) {
    throw new VkApiError(
      0,
      'VK вернул неожиданный формат ответа при обмене кода',
    );
  }
  return {
    accessToken: body.access_token,
    expiresInSeconds: body.expires_in,
    userId: body.user_id,
  };
}

/**
 * Manages the single personal VK access token used only for wall photo/
 * document uploads (community tokens can't call those endpoints at all —
 * confirmed empirically, VK error 27). One admin's token covers every
 * connected community they administer via `group_id`, so this is a
 * singleton, not per-Group. See the model comment in schema.prisma.
 */
@Injectable()
export class VkUploaderTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenEncryption: TokenEncryptionService,
    private readonly config: ConfigService,
  ) {}

  /** `state` is a CSRF nonce the controller generates and later validates — see VkOAuthController. */
  buildAuthorizeUrl(state: string): string {
    const url = new URL(`${OAUTH_BASE}/authorize`);
    url.searchParams.set('client_id', this.config.getOrThrow('VK_APP_ID'));
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('v', VK_API_VERSION);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeAuthorizationCode(code: string): Promise<{ expiresAt: Date }> {
    const url = new URL(`${OAUTH_BASE}/access_token`);
    url.searchParams.set('client_id', this.config.getOrThrow('VK_APP_ID'));
    url.searchParams.set(
      'client_secret',
      this.config.getOrThrow('VK_APP_CLIENT_SECRET'),
    );
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('code', code);

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new VkApiError(
        0,
        'Не удалось обратиться к VK для обмена кода на токен',
      );
    }
    if (!res.ok) {
      throw new VkApiError(
        0,
        `VK вернул HTTP ${res.status} при обмене кода на токен`,
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new VkApiError(
        0,
        'VK вернул нераспознаваемый ответ при обмене кода на токен',
      );
    }

    const parsed = parseTokenResponse(body);
    const expiresAt = new Date(Date.now() + parsed.expiresInSeconds * 1000);

    const data = {
      accessTokenEncrypted: this.tokenEncryption.encrypt(parsed.accessToken),
      vkUserId: String(parsed.userId),
      expiresAt,
    };
    await this.prisma.vkUploaderToken.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...data },
      update: data,
    });

    return { expiresAt };
  }

  /**
   * Non-throwing check, for deciding *before* a campaign starts whether its
   * attachments can be uploaded at all.
   *
   * VK issues no refresh_token for this flow (confirmed empirically in Step 4),
   * so an expired token can only be renewed by the admin clicking through
   * authorization again. Finding that out mid-campaign is far worse than
   * refusing to start: by then some groups have the post and others don't.
   */
  async isUsable(): Promise<boolean> {
    return (await this.getStatus()).state === 'usable';
  }

  /**
   * Состояние токена для панели: подключён ли он вообще, действует ли ещё и
   * до какого момента. «Действует» считается с тем же запасом, что и у
   * `isUsable`, — иначе панель показывала бы зелёное там, где отправка уже
   * откажет.
   */
  async getStatus(): Promise<{
    state: 'usable' | 'expired' | 'missing';
    expiresAt: Date | null;
  }> {
    const row = await this.prisma.vkUploaderToken.findUnique({
      where: { id: SINGLETON_ID },
    });
    if (!row) {
      return { state: 'missing', expiresAt: null };
    }
    const usable =
      row.expiresAt.getTime() - EXPIRY_SAFETY_MARGIN_MS > Date.now();
    return { state: usable ? 'usable' : 'expired', expiresAt: row.expiresAt };
  }

  /** Throws AppException(VK_UPLOADER_TOKEN_EXPIRED, details.reauthorizeUrl) if missing/expired. */
  async getValidAccessToken(): Promise<string> {
    const row = await this.prisma.vkUploaderToken.findUnique({
      where: { id: SINGLETON_ID },
    });
    if (
      !row ||
      row.expiresAt.getTime() - EXPIRY_SAFETY_MARGIN_MS <= Date.now()
    ) {
      throw new AppException(
        ErrorCode.VK_UPLOADER_TOKEN_EXPIRED,
        'Личный VK-токен для загрузки вложений истёк или не настроен — нужна повторная авторизация',
        undefined,
        { reauthorizeUrl: REAUTHORIZE_PATH },
      );
    }
    return this.tokenEncryption.decrypt(row.accessTokenEncrypted);
  }
}
