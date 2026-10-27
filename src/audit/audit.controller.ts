import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { CurrentAdmin } from '../auth/current-admin.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import type { AdminUser } from '../generated/prisma/client';
import { AuditService } from './audit.service';

class ListAuditQuery {
  /** Сколько записей — целое от 1 до 500 (по умолчанию 100). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  /**
   * «Показать ещё»: время последней показанной записи… Обязательно при
   * `beforeId`: без него id молча игнорировался бы, и клиент получал бы ту
   * же первую страницу по кругу.
   */
  @ValidateIf(
    (q: ListAuditQuery) => q.beforeAt !== undefined || q.beforeId !== undefined,
  )
  @IsDateString()
  beforeAt?: string;

  /** …и её id — вместе однозначная граница. */
  @IsOptional()
  @IsUUID()
  beforeId?: string;
}

class ClearAuditDto {
  /** Нет — очистить всё; есть — только записи старше этой даты. */
  @IsOptional()
  @IsDateString()
  before?: string;
}

/**
 * Журнал действий — только разработчику (`audit_viewAll`). Экран — в React;
 * пока это JSON для проверки, что запись идёт.
 */
@Controller('audit')
@UseGuards(AdminAuthGuard, CsrfGuard)
@RequirePermissions('audit_viewAll')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query() query: ListAuditQuery) {
    return this.audit.list({
      limit: query.limit,
      beforeAt: query.beforeAt ? new Date(query.beforeAt) : undefined,
      beforeId: query.beforeId,
    });
  }

  // Стереть историю — больше, чем смотреть её: право на просмотр можно
  // выдать админу через extraPermissions, и тогда он стирал бы записи о
  // собственных действиях. Нужно ещё и управление админами (разработчик).
  @Post('clear')
  @RequirePermissions('audit_viewAll', 'admins_manage')
  async clear(@Body() dto: ClearAuditDto, @CurrentAdmin() admin: AdminUser) {
    const deleted = await this.audit.clear(
      admin.id,
      dto.before ? new Date(dto.before) : undefined,
    );
    return { deleted };
  }
}
