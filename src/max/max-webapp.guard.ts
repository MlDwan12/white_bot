import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { Request } from 'express';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { InitDataUser, validateInitData } from './webapp-init-data';

/** Схема в заголовке `Authorization`, по аналогии с `Bearer`. */
const SCHEME = 'MaxWebApp';

export interface MaxWebAppContext {
  user: InitDataUser;
  /**
   * Payload из диплинка `?startapp=<payload>` — у нас это id конкурса.
   *
   * Подпись подтверждает, что запуск пришёл из MAX, но **не** что payload
   * законен: открыть ссылку с любым id может кто угодно, и MAX подпишет
   * то, что ему дали. Поэтому доступ к конкурсу проверяется отдельно.
   */
  startParam?: string;
  chatId?: number;
}

/** Запрос, прошедший гвард, несёт разобранные данные запуска. */
export interface MaxWebAppRequest extends Request {
  maxWebApp: MaxWebAppContext;
}

/**
 * Пропускает только запросы от настоящего запуска мини-приложения.
 *
 * Мини-апп — страница в чужом браузере, и всё, что она присылает, недоверенно:
 * назваться чужим `user_id` может кто угодно. Доверять можно ровно одному —
 * подписи `hash`, которую способен построить лишь владелец токена бота.
 * Поэтому личность берётся **из подписанных данных**, а не из тела запроса,
 * и никакие `userId` в параметрах эндпоинты не принимают.
 */
@Injectable()
export class MaxWebAppGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MaxWebAppGuard.name);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<MaxWebAppRequest>();
    const token = this.config.get<string>('MAX_BOT_TOKEN');

    if (!token) {
      // Без токена подпись проверить нечем, а пускать «на честном слове»
      // нельзя: это открыло бы участие в конкурсах кому угодно.
      throw new AppException(
        ErrorCode.UNAUTHORIZED,
        'Проверка запуска мини-приложения недоступна: не настроен MAX_BOT_TOKEN',
      );
    }

    const raw = extractInitData(request.headers.authorization);
    if (!raw) {
      throw new AppException(
        ErrorCode.UNAUTHORIZED,
        'Нет данных запуска мини-приложения',
      );
    }

    const result = validateInitData(raw, token);
    if (!result.valid) {
      // Причина не раскрывается наружу: подбирающему подпись незачем знать,
      // чем именно не подошла его попытка. В лог она пишется.
      this.logger.warn(
        { reason: result.reason },
        'Запуск мини-приложения не прошёл проверку',
      );
      throw new AppException(
        ErrorCode.UNAUTHORIZED,
        'Не удалось подтвердить запуск мини-приложения',
      );
    }

    if (!result.data.user) {
      throw new AppException(
        ErrorCode.UNAUTHORIZED,
        'В данных запуска нет пользователя',
      );
    }

    request.maxWebApp = {
      user: result.data.user,
      startParam: result.data.start_param,
      chatId: result.data.chat?.id,
    };
    return true;
  }
}

function extractInitData(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const prefix = `${SCHEME} `;
  // Схемы авторизации регистронезависимы по RFC 7235, и некоторые клиенты и
  // прокси приводят их к своему регистру. Строгое сравнение превращало бы
  // это в отказ, неотличимый от «заголовка нет».
  if (header.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) {
    return null;
  }
  return header.slice(prefix.length).trim() || null;
}
