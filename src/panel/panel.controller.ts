import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Render,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { PANEL_PREFIX } from '../common/panel.constants';
import { AuthService } from '../auth/auth.service';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { CsrfInterceptor } from '../auth/csrf.interceptor';
import { CurrentAdmin } from '../auth/current-admin.decorator';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { effectivePermissions } from '../auth/permissions';
import {
  CSRF_COOKIE,
  REFRESH_COOKIE,
  clearAuthCookies,
  setAuthCookies,
} from '../auth/auth.cookies';
import { readCookie } from '../auth/read-cookie';
import { PostsService } from '../posts/posts.service';
import { PostModerationService } from '../posts/post-moderation.service';
import { GroupsService } from '../groups/groups.service';
import { MediaService, MAX_FILE_BYTES } from '../media/media.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AdminUser, Permission } from '../generated/prisma/client';
import {
  deliveryColor,
  deliveryLabel,
  formatDate,
  groupColor,
  groupLabel,
  statusColor,
  statusLabel,
} from './view-helpers';
import { zonedToUtc } from './zoned-time';

/**
 * Веб-панель: серверный рендер, обычные HTML-формы, без обязательного JS.
 *
 * Живёт под `/panel` — по этому префиксу и конверт `{success,data}`, и
 * обработчик ошибок понимают, что здесь нужен HTML, а не JSON.
 */
@Controller('panel')
export class PanelController {
  constructor(
    private readonly auth: AuthService,
    private readonly posts: PostsService,
    private readonly moderation: PostModerationService,
    private readonly groups: GroupsService,
    private readonly media: MediaService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PanelController.name);
  }

  @Get()
  index(@Res() res: Response): void {
    res.redirect(`${PANEL_PREFIX}/campaigns`);
  }

  // ----- вход -------------------------------------------------------------

  /**
   * Единственная страница панели без входа — и единственная без
   * `AdminAuthGuard`. Гвард здесь означал бы «чтобы войти, войдите».
   */
  @Get('login')
  loginPage(@Req() req: Request, @Res() res: Response): void {
    res.render('layout', {
      ...this.shell(req, 'Вход', null),
      page: 'login',
      error: null,
      email: '',
    });
  }

  @Post('login')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(
    @Body() body: { email?: string; password?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const tokens = await this.auth.login(
        body.email ?? '',
        body.password ?? '',
      );
      setAuthCookies(res, tokens, this.secureCookies());
      res.redirect(`${PANEL_PREFIX}/campaigns`);
    } catch (err: unknown) {
      // Страница входа перерисовывается с ошибкой, а не улетает в общий
      // обработчик: человеку нужна форма с сохранённым адресом, а не экран
      // «401» без единого поля ввода.
      res.status(401).render('layout', {
        ...this.shell(req, 'Вход', null),
        page: 'login',
        error: err instanceof AppException ? err.message : 'Не удалось войти',
        email: body.email ?? '',
      });
    }
  }

  // Без AdminAuthGuard: протухшая сессия не должна мешать выйти. Иначе
  // куки остались бы лежать до собственного истечения, а человек получил бы
  // редирект на вход вместо ожидаемого «вышел».
  @Post('logout')
  @UseGuards(CsrfGuard)
  async logout(@Req() req: Request, @Res() res: Response): Promise<void> {
    const token = readCookie(req, REFRESH_COOKIE);
    if (token) {
      await this.auth.logout(token);
    }
    clearAuthCookies(res, this.secureCookies());
    res.redirect(`${PANEL_PREFIX}/login`);
  }

  // ----- кампании ---------------------------------------------------------

  @Get('campaigns')
  @Render('layout')
  @UseGuards(AdminAuthGuard)
  @RequirePermissions('posts_manage')
  async campaigns(
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Query('flash') flash?: string,
  ) {
    return {
      ...this.shell(req, 'Кампании', admin, 'campaigns', flash),
      page: 'campaigns',
      campaigns: await this.posts.listCampaigns(),
      statusColor,
      statusLabel,
      formatDate,
    };
  }

  @Get('campaigns/:id')
  @Render('layout')
  @UseGuards(AdminAuthGuard)
  @RequirePermissions('posts_manage')
  async campaign(
    @Param('id') id: string,
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Query('flash') flash?: string,
  ) {
    const post = await this.posts.getPostWithDeliveries(id);
    return {
      ...this.shell(req, 'Кампания', admin, 'campaigns', flash),
      page: 'campaign',
      post,
      // Править и удалять можно только там, где пост действительно вышел и
      // ещё не удалён: предлагать это для остальных групп — приглашать на
      // кнопку, которая вернёт ошибку.
      publishedGroups: post.deliveries
        // Условия те же, что в `publishedDeliveries`: доставка без id
        // сообщения сервису не подходит, и предложить её галочкой значило
        // бы привести человека на ошибку вместо действия.
        .filter(
          (d) => d.status === 'sent' && !d.deletedAt && d.externalMessageId,
        )
        .map((d) => d.group),
      formatDate,
      statusColor,
      statusLabel,
      deliveryColor,
      deliveryLabel,
    };
  }

  @Post('campaigns/:id/edit-published')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('posts_manage')
  async editPublished(
    @Param('id') id: string,
    @Body()
    body: {
      text?: string;
      vkTextOverride?: string;
      maxTextOverride?: string;
      autoDeleteAfterMinutes?: string;
    },
    @Res() res: Response,
  ): Promise<void> {
    let autoDeleteAfterMinutes: number | null;
    try {
      autoDeleteAfterMinutes = parseMinutes(body.autoDeleteAfterMinutes);
    } catch {
      // Проверяем **до** обращения к сервису: тот сначала останавливает
      // идущую рассылку, и падение после этого оставило бы кампанию
      // остановленной с неизменённым текстом.
      res.redirect(`${PANEL_PREFIX}/campaigns/${id}?flash=bad-minutes`);
      return;
    }

    const outcome = await this.moderation.editPublished(id, {
      text: body.text,
      // Поля формы — полная правда о тексте. Не передай их — и правка
      // отрапортовала бы об успехе, пока VK показывает старое
      // переопределение, которого в панели даже не видно.
      vkTextOverride: body.vkTextOverride?.trim() || null,
      maxTextOverride: body.maxTextOverride?.trim() || null,
      // Пустое поле означает «не удалять автоматически». Абсолютный срок
      // снимается тоже: он приоритетнее относительного, и без этого
      // очищенное поле не отменяло бы удаление, назначенное через API.
      autoDeleteAfterMinutes,
      autoDeleteAt: null,
    });
    res.redirect(
      `${PANEL_PREFIX}/campaigns/${id}?flash=${outcomeFlash(outcome, 'edited')}`,
    );
  }

  @Post('campaigns/:id/delete-published')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('posts_manage')
  async deletePublished(
    @Param('id') id: string,
    @Body() body: { groupIds?: string | string[] },
    @Res() res: Response,
  ): Promise<void> {
    const groupIds = asArray(body.groupIds);
    if (groupIds.length === 0) {
      // Браузер не присылает снятые галочки вовсе, а для сервиса пустой
      // список значит «во всех группах». Без этой проверки снятие всех
      // галочек удаляло бы пост отовсюду — ровно наоборот задуманному,
      // необратимо, да ещё и с рапортом «удалено из выбранных».
      res.redirect(`${PANEL_PREFIX}/campaigns/${id}?flash=nothing-selected`);
      return;
    }

    const outcome = await this.moderation.deletePublished(id, groupIds);
    res.redirect(
      `${PANEL_PREFIX}/campaigns/${id}?flash=${outcomeFlash(outcome, 'deleted')}`,
    );
  }

  @Post('campaigns/:id/send')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('posts_manage')
  async send(@Param('id') id: string, @Res() res: Response): Promise<void> {
    await this.posts.schedulePost(id);
    res.redirect(`${PANEL_PREFIX}/campaigns?flash=sent`);
  }

  @Post('campaigns/:id/stop')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('posts_manage')
  async stop(@Param('id') id: string, @Res() res: Response): Promise<void> {
    await this.posts.stopPost(id);
    res.redirect(`${PANEL_PREFIX}/campaigns?flash=stopped`);
  }

  @Post('campaigns/:id/resume')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('posts_manage')
  async resume(@Param('id') id: string, @Res() res: Response): Promise<void> {
    await this.posts.resumePost(id);
    res.redirect(`${PANEL_PREFIX}/campaigns?flash=resumed`);
  }

  // ----- группы -----------------------------------------------------------

  @Get('groups')
  @Render('layout')
  @UseGuards(AdminAuthGuard)
  @RequirePermissions('groups_view')
  async groupsPage(
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Query('flash') flash?: string,
    @Query('reason') reason?: string,
  ) {
    const all = await this.groups.listGroups();
    return {
      ...this.shell(req, 'Группы', admin, 'groups', flash, reason),
      page: 'groups',
      // Отключённые не прячем: без них непонятно, куда делась группа, в
      // которую раньше уходили посты.
      groups: all,
      pending: all.filter((g) => g.status === 'pending_confirmation'),
      groupColor,
      groupLabel,
    };
  }

  @Post('groups/vk')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('groups_manage')
  async addVkGroup(
    @Body() body: { token?: string; tags?: string },
    @Res() res: Response,
  ): Promise<void> {
    try {
      await this.groups.createVkGroup({
        token: body.token ?? '',
        // Пустое поле — «не трогать теги», а не «стереть». Эта же форма
        // обновляет токен у существующего сообщества, и обновление ради
        // токена не должно попутно обнулять его теги.
        tags: body.tags?.trim() ? parseTags(body.tags) : undefined,
      });
      res.redirect(`${PANEL_PREFIX}/groups?flash=group-added`);
    } catch (err: unknown) {
      // Причина отказа — единственное, что объясняет админу, что не так с
      // токеном, поэтому она доходит и до экрана, и до логов. Молчаливый
      // редирект оставлял бы запрос вообще без следа.
      this.logger.warn({ err }, 'Не удалось подключить VK-сообщество');
      const reason =
        err instanceof AppException
          ? err.message
          : 'Не удалось подключить сообщество';
      // Токен в форму не возвращаем — вводить заново. Он секрет, и его
      // место не в перерисованной странице, которая осядет в истории
      // браузера и в кэше.
      res.redirect(
        `${PANEL_PREFIX}/groups?flash=group-failed&reason=${encodeURIComponent(reason)}`,
      );
    }
  }

  @Post('groups/:id/confirm')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('groups_pendingMax_review')
  async confirmGroup(
    @Param('id') id: string,
    @Body() body: { tags?: string },
    @Res() res: Response,
  ): Promise<void> {
    await this.groups.confirmMaxGroup(id, parseTags(body.tags));
    res.redirect(`${PANEL_PREFIX}/groups?flash=group-confirmed`);
  }

  @Post('groups/:id/reject')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('groups_pendingMax_review')
  async rejectGroup(
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.groups.rejectMaxGroup(id);
    res.redirect(`${PANEL_PREFIX}/groups?flash=group-rejected-ok`);
  }

  @Post('groups/:id/tags')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('groups_tags_edit')
  async updateTags(
    @Param('id') id: string,
    @Body() body: { tags?: string },
    @Res() res: Response,
  ): Promise<void> {
    await this.groups.updateTags(id, parseTags(body.tags));
    res.redirect(`${PANEL_PREFIX}/groups?flash=tags-saved`);
  }

  @Post('groups/:id/deactivate')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('groups_manage')
  async deactivateGroup(
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.groups.deactivate(id);
    res.redirect(`${PANEL_PREFIX}/groups?flash=group-off`);
  }

  // ----- создание поста ---------------------------------------------------

  @Get('posts/new')
  @Render('layout')
  @UseGuards(AdminAuthGuard)
  // Только `posts_manage`: список групп здесь — часть создания поста, а не
  // отдельная возможность. С двумя правами админ видел бы пункт меню и
  // получал 403 при каждом клике.
  @RequirePermissions('posts_manage')
  async newPost(
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Query('flash') flash?: string,
  ) {
    return {
      ...this.shell(req, 'Новый пост', admin, 'new-post', flash),
      page: 'new-post',
      groups: await this.activeGroups(),
      media: await this.recentMedia(),
      draft: { text: '', groupIds: [], attachmentIds: [], scheduledAt: '' },
      error: null,
    };
  }

  private async activeGroups() {
    return (await this.groups.listGroups()).filter(
      (group) => group.status === 'active',
    );
  }

  private async recentMedia() {
    return this.prisma.mediaAsset.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, filename: true, kind: true },
    });
  }

  @Post('posts')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('posts_manage')
  async createPost(
    @Body()
    body: {
      text?: string;
      groupIds?: string | string[];
      attachmentIds?: string | string[];
      scheduledAt?: string;
      action?: string;
    },
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Res() res: Response,
  ): Promise<void> {
    const groupIds = asArray(body.groupIds);
    const attachmentIds = asArray(body.attachmentIds);

    try {
      const scheduledAt = this.parseSchedule(body.scheduledAt);
      const post = await this.posts.createPost({
        text: body.text ?? '',
        // Браузер шлёт одно значение строкой, а несколько — массивом. Без
        // приведения кампания с одной группой ушла бы с `groupIds: 'uuid'`,
        // и валидация отвергла бы её как не массив.
        groupIds,
        attachmentIds,
        scheduledAt,
      });

      if (body.action === 'send') {
        await this.posts.schedulePost(post.id);
        res.redirect(`${PANEL_PREFIX}/campaigns?flash=sent`);
        return;
      }
      res.redirect(`${PANEL_PREFIX}/campaigns?flash=draft`);
    } catch (err: unknown) {
      // Форма перерисовывается с тем, что человек набрал. Уронить его в
      // общий экран ошибки — значит потерять текст, выбор групп и
      // расписание из-за одной непоставленной галочки.
      res.status(400).render('layout', {
        ...this.shell(req, 'Новый пост', admin, 'new-post'),
        page: 'new-post',
        groups: await this.activeGroups(),
        media: await this.recentMedia(),
        draft: {
          text: body.text ?? '',
          groupIds,
          attachmentIds,
          scheduledAt: body.scheduledAt ?? '',
        },
        error:
          err instanceof AppException ? err.message : 'Не удалось создать пост',
      });
    }
  }

  /**
   * `datetime-local` присылает время без смещения — браузер не сообщает, в
   * каком поясе его набрали. `new Date()` истолковал бы такую строку в поясе
   * **сервера**: админ в Москве назначил бы 18:00, а на UTC-сервере пост ушёл
   * бы в 21:00 по Москве. Поэтому читаем в том же поясе, что и расписания
   * повторяющихся постов.
   */
  private parseSchedule(value: string | undefined): Date | undefined {
    if (!value) {
      return undefined;
    }
    const zone = this.config.getOrThrow<string>('DEFAULT_TIMEZONE');
    const parsed = zonedToUtc(value, zone);
    if (Number.isNaN(parsed.getTime())) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Не удалось разобрать дату отправки',
      );
    }
    return parsed;
  }

  @Post('media')
  @UseGuards(AdminAuthGuard)
  @RequirePermissions('posts_manage')
  // CsrfInterceptor, а не CsrfGuard, и строго **после** FileInterceptor:
  // гварды выполняются до интерцепторов, а скрытое поле `_csrf` лежит в
  // теле `multipart`, которое разбирает как раз FileInterceptor. С гвардом
  // загрузка через форму не проходила проверку никогда.
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_BYTES },
    }),
    CsrfInterceptor,
  )
  async uploadMedia(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!file) {
      res.redirect(`${PANEL_PREFIX}/posts/new?flash=no-file`);
      return;
    }
    await this.media.upload({
      buffer: file.buffer,
      // Multer отдаёт имя в latin1; без перекодировки кириллица приезжает
      // кракозябрами — а это имя видит получатель документа.
      filename: Buffer.from(file.originalname, 'latin1').toString('utf8'),
      declaredMimeType: file.mimetype,
    });
    res.redirect(`${PANEL_PREFIX}/posts/new?flash=uploaded`);
  }

  /** Поля, которые нужны каждому шаблону. */
  private shell(
    req: Request,
    title: string,
    admin: AdminUser | null,
    active = '',
    flash?: string,
    reason?: string,
  ) {
    // Права уезжают в шаблон, чтобы он не рисовал того, чего человеку
    // нельзя: кнопка, которая всегда возвращает «недостаточно прав», — это
    // приглашение на ошибку, а не защита.
    const permissions = admin
      ? effectivePermissions({
          id: admin.id,
          role: admin.role,
          extraPermissions: admin.extraPermissions,
        })
      : new Set<Permission>();

    return {
      title,
      admin: admin ? { email: admin.email } : null,
      can: (permission: Permission) => permissions.has(permission),
      active,
      // Значение берётся из куки: шаблон обязан положить его в скрытое поле,
      // а сторонний сайт прочитать чужую куку не может — в этом и смысл
      // double-submit.
      csrfToken: readCookie(req, CSRF_COOKIE) ?? '',
      // `Object.hasOwn`, а не прямой доступ: `?flash=constructor` вернул бы
      // унаследованное значение, и в шапке нарисовался бы пустой серый
      // баннер — ровно то, что список должен был исключить.
      flash: Object.hasOwn(FLASHES, flash ?? '') ? FLASHES[flash!] : null,
      // Причина отказа приходит текстом в адресе, поэтому выводится
      // отдельно и **только** экранированной: это единственное место, где
      // в шаблон попадает строка из запроса.
      flashReason: typeof reason === 'string' ? reason.slice(0, 300) : null,
    };
  }

  private secureCookies(): boolean {
    return this.config.get<string>('COOKIE_SECURE', 'true') !== 'false';
  }
}

/**
 * Какое сообщение показать после действия над опубликованным.
 *
 * Частичный отказ — обычное дело: в одной группе сообщение слишком старое,
 * в другой VK не выдал прав. Показать «готово» в таком случае значило бы
 * соврать, а показать «ошибка» — скрыть, что в остальных всё получилось.
 */
export function outcomeFlash(
  outcome: { succeeded: number; failed: unknown[] },
  ok: string,
): string {
  if (outcome.failed.length === 0) {
    // Ноль успехов и ноль ошибок — это «делать было нечего», а не «готово».
    // Случается, когда последнюю доставку удалили между отрисовкой страницы
    // и отправкой формы.
    return outcome.succeeded > 0 ? ok : 'nothing-done';
  }
  return outcome.succeeded > 0 ? 'partial' : 'failed';
}

/** Минуты автоудаления из формы. Бросает, если значение не годится. */
function parseMinutes(raw: string | undefined): number | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  // `type="number"` и `min="1"` проверяют только браузер; подделанный или
  // повторённый запрос дошёл бы до Prisma как NaN или дробь и вернулся
  // пятисоткой вместо внятного отказа.
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 60 * 24 * 365) {
    throw new Error('bad minutes');
  }
  return parsed;
}

/** Сообщения после редиректа: держим списком, чтобы не пускать текст из URL. */
export const FLASHES: Record<string, { kind: string; message: string }> = {
  // Каждое действие обязано иметь свою запись: без неё `shell` отфильтрует
  // ключ и страница перерисуется молча — отказ станет неотличим от успеха.
  'nothing-selected': {
    kind: 'warning',
    message: 'Ни одна группа не отмечена — ничего не удалено',
  },
  'nothing-done': {
    kind: 'info',
    message: 'Нечего было обновлять: пост нигде не опубликован',
  },
  'bad-minutes': {
    kind: 'danger',
    message: 'Срок автоудаления — целое число минут от 1 до года',
  },
  'group-added': { kind: 'success', message: 'Сообщество подключено' },
  'group-failed': {
    kind: 'danger',
    message: 'Не удалось подключить сообщество',
  },
  'group-confirmed': { kind: 'success', message: 'Группа подтверждена' },
  'group-rejected-ok': { kind: 'info', message: 'Группа отклонена' },
  'tags-saved': { kind: 'success', message: 'Теги сохранены' },
  'group-off': { kind: 'warning', message: 'Группа отключена' },
  sent: { kind: 'success', message: 'Пост поставлен в отправку' },
  draft: { kind: 'info', message: 'Черновик сохранён' },
  stopped: { kind: 'warning', message: 'Рассылка остановлена' },
  resumed: { kind: 'success', message: 'Отправляем оставшимся' },
  uploaded: { kind: 'success', message: 'Вложение загружено' },
  'no-file': { kind: 'danger', message: 'Файл не выбран' },
  edited: { kind: 'success', message: 'Текст обновлён во всех группах' },
  deleted: { kind: 'success', message: 'Удалено из выбранных групп' },
  partial: {
    kind: 'warning',
    message: 'Получилось не везде — смотрите ошибки в списке доставок',
  },
  failed: {
    kind: 'danger',
    message:
      'Не получилось ни в одной группе — смотрите ошибки в списке доставок',
  },
};

/**
 * Теги из одного поля: «новости, акции» → `['новости', 'акции']`.
 *
 * Отдельным полем на тег было бы честнее по структуре, но на странице с
 * десятком групп это десяток форм с динамическим добавлением строк — то
 * есть JS, без которого панель по замыслу работает.
 */
export function parseTags(value: string | undefined): string[] {
  // Повторы убираются: API их отвергает как `@ArrayUnique`, и панель не
  // должна складывать в базу то, что тот же запрос через REST не принял бы.
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
