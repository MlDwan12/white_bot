import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AdminsService } from '../admins/admins.service';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { CurrentAdmin } from '../auth/current-admin.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import type { AdminUser } from '../generated/prisma/client';
import type { AdminRow, IssuedAdmin, Wire } from '@white-bot/shared';

class AdminEditDto {
  @IsIn(['admin', 'developer'])
  role: 'admin' | 'developer';

  /** Пусто — MAX не привязан. Формат проверяет сервис. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  maxUserId?: string;
}

class AdminCreateDto extends AdminEditDto {
  @IsString()
  @MaxLength(254)
  email: string;
}

/**
 * Админы для React-панели. Пароль (новый или сброшенный) приходит в теле
 * ответа один раз и не кэшируется: в базе только хеш.
 */
@Controller('api/admins')
@UseGuards(AdminAuthGuard, CsrfGuard)
@RequirePermissions('admins_manage')
export class AdminsApiController {
  constructor(private readonly admins: AdminsService) {}

  @Get()
  list(): Promise<Wire<AdminRow[]>> {
    return this.admins.list();
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  create(@Body() dto: AdminCreateDto): Promise<Wire<IssuedAdmin>> {
    return this.admins.create({
      email: dto.email,
      role: dto.role,
      maxUserId: dto.maxUserId,
    });
  }

  @Post(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminEditDto,
    @CurrentAdmin() admin: AdminUser,
  ) {
    return this.admins.update(
      id,
      { role: dto.role, maxUserId: dto.maxUserId },
      admin.id,
    );
  }

  @Post(':id/disable')
  disable(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUser,
  ) {
    return this.admins.disable(id, admin.id);
  }

  @Post(':id/enable')
  enable(@Param('id', ParseUUIDPipe) id: string) {
    return this.admins.enable(id);
  }

  @Post(':id/reset-password')
  @Header('Cache-Control', 'no-store')
  resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUser,
  ) {
    return this.admins.resetPassword(id, admin.id);
  }
}
