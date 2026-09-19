import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { AuthService } from './auth.service';
import {
  CSRF_COOKIE,
  REFRESH_COOKIE,
  clearAuthCookies,
  setAuthCookies,
} from './auth.cookies';
import { AdminAuthGuard } from './admin-auth.guard';
import { CurrentAdmin } from './current-admin.decorator';
import { CsrfGuard } from './csrf.guard';
import { LoginDto } from './dto/login.dto';
import { effectivePermissions } from './permissions';
import { readCookie } from './read-cookie';
import type { AdminUser } from '../generated/prisma/client';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Вход. Ограничен по частоте: argon2 намеренно медленный, поэтому без
   * ограничителя форма входа — это и перебор паролей, и способ занять
   * процессор чужими запросами.
   */
  @Post('login')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const tokens = await this.auth.login(dto.email, dto.password);
    setAuthCookies(res, tokens, this.secureCookies());
    // Токенов в теле нет сознательно: им место только в куках.
    return { ok: true };
  }

  @Post('refresh')
  @UseGuards(CsrfGuard)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const token = cookie(req, REFRESH_COOKIE);
    try {
      const tokens = await this.auth.refresh(token);
      setAuthCookies(
        res,
        tokens,
        this.secureCookies(),
        readCookie(req, CSRF_COOKIE),
      );
      return { ok: true };
    } catch (err) {
      // Куку, которая больше никогда не сработает, оставлять нельзя: клиент
      // будет крутиться на «обновить → 401» вместо того, чтобы показать
      // форму входа. А в случае обнаруженной кражи вся семья сессий уже
      // отозвана, и держать её тем более незачем.
      //
      // Гонка вкладок — исключение: там в куках уже лежит рабочая пара,
      // выданная параллельному запросу, и стирать её значило бы выйти из
      // системы на ровном месте.
      if (
        !(err instanceof AppException) ||
        err.code !== ErrorCode.CONCURRENT_EDIT_CONFLICT
      ) {
        clearAuthCookies(res, this.secureCookies());
      }
      throw err;
    }
  }

  @Post('logout')
  @UseGuards(CsrfGuard)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const token = readCookie(req, REFRESH_COOKIE);
    if (token) {
      await this.auth.logout(token);
    }
    // Куки чистятся в любом случае: даже если токена не было, человек ждёт,
    // что после выхода он вышел.
    clearAuthCookies(res, this.secureCookies());
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AdminAuthGuard)
  me(@CurrentAdmin() admin: AdminUser) {
    return {
      id: admin.id,
      email: admin.email,
      role: admin.role,
      maxUserId: admin.maxUserId,
      permissions: [
        ...effectivePermissions({
          id: admin.id,
          role: admin.role,
          extraPermissions: admin.extraPermissions,
        }),
      ],
    };
  }

  /** В разработке панель открывается по http, и `secure` не даст поставить куку. */
  private secureCookies(): boolean {
    return this.config.get<string>('COOKIE_SECURE', 'true') !== 'false';
  }
}

function cookie(req: Request, name: string): string {
  const value = readCookie(req, name);
  if (!value) {
    throw new AppException(ErrorCode.UNAUTHORIZED, 'Сессия не найдена');
  }
  return value;
}
