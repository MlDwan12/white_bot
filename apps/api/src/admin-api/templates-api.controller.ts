import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { CurrentAdmin } from '../auth/current-admin.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import type { AdminUser } from '../generated/prisma/client';
import {
  buildCron,
  describeSchedule,
  parseCron,
  sameSchedule,
} from '../posts/cron-preset';
import { PostTemplatesService } from '../posts/post-templates.service';
import { PrismaService } from '../prisma/prisma.service';
import { showVk, withoutVk } from './vk-scope';
import { TemplateDto } from './templates-api.dto';
import type { TemplateDetails, TemplateSummary, Wire } from '@white-bot/shared';

/**
 * Повторяющиеся посты для React-панели — та же обвязка, что в
 * `PanelController`. У роли admin VK скрыт: VK-цели не видны и не снимаются
 * его правкой, VK-текст не трогается.
 */
@Controller('api/templates')
@UseGuards(AdminAuthGuard, CsrfGuard)
@RequirePermissions('posts_manage')
export class TemplatesApiController {
  constructor(
    private readonly templates: PostTemplatesService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async list(): Promise<Wire<TemplateSummary[]>> {
    const rows = await this.templates.listTemplates();
    return rows.map((t) => ({
      ...t,
      scheduleText: describeSchedule(t.recurrenceRule),
    }));
  }

  @Post()
  async create(@Body() dto: TemplateDto, @CurrentAdmin() admin: AdminUser) {
    const template = await this.templates.createTemplate({
      text: dto.text,
      vkTextOverride: showVk(admin)
        ? dto.vkTextOverride?.trim() || undefined
        : undefined,
      maxTextOverride: dto.maxTextOverride?.trim() || undefined,
      recurrenceRule: buildCron(dto.schedule),
      timezone: this.timezone(),
      groupIds: await withoutVk(this.prisma, admin, dto.groupIds),
      attachmentIds: dto.attachmentIds,
    });
    return { id: template.id };
  }

  @Get(':id')
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUser,
  ): Promise<Wire<TemplateDetails>> {
    const [template, occurrences, attachments] = await Promise.all([
      this.templates.getTemplate(id),
      this.templates.listOccurrences(id),
      this.prisma.postAttachment.findMany({
        where: { postId: id },
        orderBy: { position: 'asc' },
        select: {
          mediaAsset: { select: { id: true, filename: true, kind: true } },
        },
      }),
    ]);
    const vk = showVk(admin);
    const rule = template.recurrenceRule ?? '';
    return {
      id: template.id,
      text: template.text,
      vkTextOverride: vk ? template.vkTextOverride : null,
      maxTextOverride: template.maxTextOverride,
      state: template.state,
      nextRunAt: template.nextRunAt,
      schedule: parseCron(rule),
      scheduleText: describeSchedule(rule),
      targets: template.targets.filter((g) => vk || g.platform !== 'vk'),
      attachments: attachments.map((a) => a.mediaAsset),
      occurrences,
    };
  }

  @Post(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TemplateDto,
    @CurrentAdmin() admin: AdminUser,
  ) {
    const stored = await this.templates.getTemplate(id);
    const rule = stored.recurrenceRule ?? '';
    // Расписание по смыслу то же — правило отдаётся как было: пересборка
    // `0 09 * * *` в `0 9 * * *` выглядела бы для сервиса сменой, и он
    // пересчитал бы следующий запуск от текущего момента.
    const recurrenceRule = sameSchedule(parseCron(rule), dto.schedule)
      ? rule
      : buildCron(dto.schedule);
    const hiddenVk = showVk(admin)
      ? []
      : stored.targets.filter((g) => g.platform === 'vk').map((g) => g.id);
    await this.templates.updateTemplate(id, {
      text: dto.text,
      vkTextOverride: showVk(admin)
        ? dto.vkTextOverride?.trim() || null
        : undefined,
      maxTextOverride: dto.maxTextOverride?.trim() || null,
      recurrenceRule,
      timezone: stored.timezone ?? this.timezone(),
      groupIds: [
        ...(await withoutVk(this.prisma, admin, dto.groupIds)),
        ...hiddenVk,
      ],
      attachmentIds: dto.attachmentIds,
    });
    return { ok: true };
  }

  @Post(':id/pause')
  async pause(@Param('id', ParseUUIDPipe) id: string) {
    await this.templates.setPaused(id, true);
    return { ok: true };
  }

  @Post(':id/resume')
  async resume(@Param('id', ParseUUIDPipe) id: string) {
    await this.templates.setPaused(id, false);
    return { ok: true };
  }

  private timezone(): string {
    return this.config.getOrThrow<string>('DEFAULT_TIMEZONE');
  }
}
