import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { MaxWebAppGuard, type MaxWebAppRequest } from '../max/max-webapp.guard';
import { MiniAppService, type MiniAppViewer } from './miniapp.service';
import { ContestView } from './contest-view';

/**
 * Эндпоинты мини-приложения. Всё за `MaxWebAppGuard`: личность берётся из
 * подписанных данных запуска, а не из запроса, поэтому `userId` в параметрах
 * нет и быть не должно.
 */
@Controller('miniapp')
@UseGuards(MaxWebAppGuard)
export class MiniAppController {
  constructor(private readonly miniApp: MiniAppService) {}

  @Get('contest')
  getContest(@Req() req: MaxWebAppRequest): Promise<ContestView> {
    return this.miniApp.getContest(contestIdOf(req), viewerOf(req));
  }

  @Post('contest/join')
  join(@Req() req: MaxWebAppRequest): Promise<ContestView> {
    return this.miniApp.join(contestIdOf(req), viewerOf(req));
  }
}

/**
 * Какой конкурс открыт, говорит `start_param` диплинка.
 *
 * Подпись доказывает, что запуск настоящий, но не что человек имеет право
 * именно на этот конкурс: диплинк с любым id может открыть кто угодно, и MAX
 * подпишет то, что ему подсунули. Право на просмотр проверяет сервис.
 */
function contestIdOf(req: MaxWebAppRequest): string {
  const startParam = req.maxWebApp.startParam;
  if (!startParam) {
    // Приложение открыли не по ссылке конкурса — например, из меню бота.
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      'Не указан конкурс: приложение открыто не по ссылке из поста',
    );
  }
  return startParam;
}

function fullName(user: {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string | null;
}): string {
  const parts = [user.first_name, user.last_name].filter(Boolean);
  return parts.length > 0
    ? parts.join(' ')
    : (user.username ?? `id${String(user.id)}`);
}

function viewerOf(req: MaxWebAppRequest): MiniAppViewer {
  const user = req.maxWebApp.user;
  return {
    externalUserId: String(user.id),
    chatId: req.maxWebApp.chatId,
    profile: {
      externalUserId: String(user.id),
      // Собирается так же, как в обработчике кнопки: иначе участник,
      // пришедший из мини-аппа, сохранился бы как «Иван» — и это имя попало
      // бы в список победителей под постом, а заодно затёрло бы полное имя
      // в профиле при следующем открытии приложения.
      displayName: fullName(user),
      firstName: user.first_name,
      lastName: user.last_name,
      username: user.username,
      isBot: false,
      raw: user,
    },
  };
}
