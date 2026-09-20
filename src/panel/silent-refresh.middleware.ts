import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { NextFunction, Request, Response } from 'express';
import { AuthService } from '../auth/auth.service';
import {
  ACCESS_COOKIE,
  CSRF_COOKIE,
  REFRESH_COOKIE,
  setAuthCookies,
} from '../auth/auth.cookies';
import { readCookie } from '../auth/read-cookie';

/**
 * Продлевает сессию панели, пока жив refresh-токен.
 *
 * Access-кука живёт 15 минут, а панель по замыслу работает без JS — значит
 * никто не позовёт `/auth/refresh` сам. Без этого каждые четверть часа админа
 * выбрасывало бы на форму входа, причём при отправке формы браузер превращает
 * редирект в GET и **молча теряет** набранное: ни поста, ни сообщения о том,
 * что произошло.
 *
 * Работает как middleware, потому что должно случиться **до** гварда: тот уже
 * увидит свежую куку и пропустит запрос как обычный.
 */
@Injectable()
export class SilentRefreshMiddleware implements NestMiddleware {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SilentRefreshMiddleware.name);
  }

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const access = readCookie(req, ACCESS_COOKIE);
    const refresh = readCookie(req, REFRESH_COOKIE);

    // Браузер сам удаляет протухшую куку по `maxAge`, поэтому «access нет, а
    // refresh есть» — это ровно случай истёкшего доступа, и лишней работы мы
    // не делаем, пока он жив.
    if (access || !refresh) {
      next();
      return;
    }

    try {
      const tokens = await this.auth.refresh(refresh);
      setAuthCookies(
        res,
        tokens,
        this.config.get<string>('COOKIE_SECURE', 'true') !== 'false',
        readCookie(req, CSRF_COOKIE),
      );
      // Гвард читает куки из запроса, а не из ответа: без подмены он бы не
      // увидел только что выданный токен и всё равно отказал.
      const bag = (req as Request & { cookies?: Record<string, string> })
        .cookies;
      if (bag) {
        bag[ACCESS_COOKIE] = tokens.access;
        bag[REFRESH_COOKIE] = tokens.refresh.token;
      }
    } catch (err: unknown) {
      // Refresh мёртв или отозван — пусть гвард отправит на вход как обычно.
      this.logger.info(
        { err },
        'Продлить сессию панели не удалось, потребуется вход',
      );
    }
    next();
  }
}
