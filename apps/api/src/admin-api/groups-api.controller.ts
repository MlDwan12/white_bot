import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { CurrentAdmin } from '../auth/current-admin.decorator';
import { readCookie } from '../auth/read-cookie';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import type { AdminUser } from '../generated/prisma/client';
import { GroupsService, type PublicGroup } from '../groups/groups.service';
import { VkApiError } from '../vk/vk-api.error';
import { parseVkAuthInput } from '../vk/vk-auth-input';
import { VK_OAUTH_STATE_COOKIE } from '../vk/vk-oauth-state';
import { VkUploaderTokenService } from '../vk/vk-uploader-token.service';
import {
  ConnectVkDto,
  PastedVkAuthDto,
  ReplaceTokenDto,
  TagsDto,
} from './groups-api.dto';
import type { ChannelOption, GroupsData, Wire } from '@white-bot/shared';
import { assertVkEnabled } from '../vk/vk-enabled';
import { showVk } from './vk-scope';

/**
 * Каналы для React-панели. VK — только у разработчика: admin его не видит и
 * не может тронуть, даже прислав запрос в обход интерфейса.
 */
@Controller('api/groups')
@UseGuards(AdminAuthGuard, CsrfGuard)
export class GroupsApiController {
  constructor(
    private readonly groups: GroupsService,
    private readonly vkToken: VkUploaderTokenService,
    private readonly config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GroupsApiController.name);
  }

  /** Каналы, куда можно публиковать: активные; у admin — без VK. */
  @Get('active')
  @RequirePermissions('groups_view')
  async active(
    @CurrentAdmin() admin: AdminUser,
  ): Promise<Wire<ChannelOption[]>> {
    const groups = await this.groups.listGroups();
    return groups
      .filter((g) => g.status === 'active')
      .filter((g) => showVk(admin) || g.platform !== 'vk')
      .map((g) => ({
        id: g.id,
        title: g.title,
        platform: g.platform,
        kind: g.kind,
        tags: g.tags,
      }));
  }

  /** Страница «Каналы»: все, кроме снятых; у admin — только MAX. */
  @Get()
  @RequirePermissions('groups_view')
  async list(@CurrentAdmin() admin: AdminUser): Promise<Wire<GroupsData>> {
    const dev = showVk(admin);
    const groups = (await this.groups.listGroups()).filter(
      (g) => (dev || g.platform !== 'vk') && (dev || g.status !== 'removed'),
    );
    return {
      groups: groups.map(publicView),
      vkUploader: dev
        ? {
            ...(await this.vkToken.getStatus()),
            appConfigured: Boolean(
              this.config.get<string>('VK_APP_ID') &&
              this.config.get<string>('VK_APP_CLIENT_SECRET'),
            ),
          }
        : null,
    };
  }

  @Post(':id/confirm')
  @RequirePermissions('groups_pendingMax_review')
  async confirm(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TagsDto) {
    return publicView(await this.groups.confirmMaxGroup(id, dto.tags));
  }

  @Post(':id/reject')
  @RequirePermissions('groups_pendingMax_review')
  async reject(@Param('id', ParseUUIDPipe) id: string) {
    await this.groups.rejectMaxGroup(id);
    return { ok: true };
  }

  @Post(':id/tags')
  @RequirePermissions('groups_tags_edit')
  async tags(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TagsDto,
    @CurrentAdmin() admin: AdminUser,
  ) {
    await this.assertVisible(admin, id);
    return publicView(await this.groups.updateTags(id, dto.tags));
  }

  @Post(':id/deactivate')
  @RequirePermissions('groups_manage')
  async deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUser,
  ) {
    await this.assertVisible(admin, id);
    return publicView(await this.groups.deactivate(id));
  }

  @Post('vk')
  @RequirePermissions('groups_tokens_manage')
  async connectVk(@Body() dto: ConnectVkDto, @CurrentAdmin() admin: AdminUser) {
    assertDeveloper(admin);
    return publicView(
      await this.groups.createVkGroup({ token: dto.token, tags: dto.tags }),
    );
  }

  @Post(':id/token')
  @RequirePermissions('groups_tokens_manage')
  async replaceToken(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceTokenDto,
    @CurrentAdmin() admin: AdminUser,
  ) {
    assertDeveloper(admin);
    return publicView(await this.groups.replaceVkToken(id, dto.token));
  }

  /**
   * Второй шаг личного токена VK (для загрузки картинок): адрес страницы
   * после разрешения доступа. Код принимается, только если авторизация
   * начата в этом браузере (кука со `state`) и `state` совпадает — иначе
   * подсунутый чужой код заменил бы токен всего развёртывания.
   */
  @Post('vk-uploader')
  @RequirePermissions('groups_tokens_manage')
  async vkUploader(
    @Body() dto: PastedVkAuthDto,
    @CurrentAdmin() admin: AdminUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    assertDeveloper(admin);
    const parsed = parseVkAuthInput(dto.pasted);
    if (!parsed) {
      throw validation(
        'Не нашёл в тексте код авторизации. Вставьте адрес страницы целиком — из адресной строки после того, как разрешили доступ.',
      );
    }
    if (parsed.kind === 'denied') {
      throw validation(`VK не выдал доступ: ${parsed.description}`);
    }
    const expected = readCookie(req, VK_OAUTH_STATE_COOKIE);
    if (!expected) {
      throw validation(
        'Авторизация не начата в этом браузере или прошло больше 10 минут — начните заново с первого шага.',
      );
    }
    if (parsed.state === null || parsed.state !== expected) {
      throw validation(
        parsed.state === null
          ? 'В скопированном тексте нет state — вставьте адрес страницы целиком, а не только код.'
          : 'Этот адрес относится к другой авторизации — начните заново с первого шага.',
      );
    }
    try {
      const { expiresAt } = await this.vkToken.exchangeAuthorizationCode(
        parsed.code,
      );
      res.clearCookie(VK_OAUTH_STATE_COOKIE);
      return { expiresAt };
    } catch (err: unknown) {
      if (err instanceof VkApiError) {
        this.logger.warn({ err }, 'Не удалось подключить личный токен VK');
        throw validation(
          `${err.message}. Код одноразовый и живёт недолго: если ошибка повторяется, пройдите авторизацию заново.`,
        );
      }
      throw err;
    }
  }

  /** У admin VK-канала как будто нет: «не найдено», а не «нет прав». */
  private async assertVisible(admin: AdminUser, id: string) {
    if (showVk(admin)) {
      return;
    }
    const group = await this.groups.getGroup(id);
    if (group.platform === 'vk') {
      throw new AppException(ErrorCode.NOT_FOUND, 'Канал не найден');
    }
  }
}

function assertDeveloper(admin: AdminUser): void {
  assertVkEnabled();
  if (!showVk(admin)) {
    throw new AppException(
      ErrorCode.INSUFFICIENT_PERMISSIONS,
      'Недостаточно прав для этого действия',
    );
  }
}

function validation(message: string): AppException {
  return new AppException(ErrorCode.VALIDATION_ERROR, message);
}

function publicView(g: PublicGroup) {
  return {
    id: g.id,
    title: g.title,
    platform: g.platform,
    kind: g.kind,
    status: g.status,
    tags: g.tags,
    tokenMask: g.tokenMask,
    createdAt: g.createdAt,
  };
}
