import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
import { VkUploaderTokenService } from '../vk/vk-uploader-token.service';
import { VkApiError } from '../vk/vk-api.error';
import { VK_OAUTH_STATE_COOKIE } from '../vk/vk-oauth-state';
import { parseVkAuthInput } from '../vk/vk-auth-input';
import { PostsService } from '../posts/posts.service';
import {
  PostModerationService,
  ModerationOutcome,
} from '../posts/post-moderation.service';
import { GroupsService } from '../groups/groups.service';
import { ContestsService } from '../contests/contests.service';
import {
  OCCURRENCE_PAGE_SIZE,
  PostTemplatesService,
} from '../posts/post-templates.service';
import { MediaService, MAX_FILE_BYTES } from '../media/media.service';
import { PlatformUsersService } from '../platform-users/platform-users.service';
import { DirectMessageDispatchService } from '../direct-messages/direct-message-dispatch.service';
import { DirectMessageRecipientSelector } from '../direct-messages/direct-message-recipients.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AdminUser,
  MediaAsset,
  Permission,
} from '../generated/prisma/client';
import {
  contestColor,
  contestLabel,
  deliveryColor,
  deliveryLabel,
  formatDate,
  groupColor,
  groupLabel,
  groupKindLabel,
  mediaKindLabel,
  notifyColor,
  notifyLabel,
  platformColor,
  platformLabel,
  templateColor,
  templateHint,
  templateLabel,
  statusColor,
  statusLabel,
} from './view-helpers';
import {
  DEFAULT_SCHEDULE,
  MAX_PRESET_MONTHDAY,
  WEEKDAYS,
  buildCron,
  describeSchedule,
  parseCron,
  sameSchedule,
} from './cron-preset';
import type { ScheduleForm, SchedulePreset } from './cron-preset';
import { utcToZoned, zonedToUtc } from './zoned-time';

interface TemplateFormBody {
  text?: string;
  vkTextOverride?: string;
  maxTextOverride?: string;
  timezone?: string;
  groupIds?: string | string[];
  attachmentIds?: string | string[];
  mode?: string;
  time?: string;
  weekday?: string;
  monthday?: string;
  custom?: string;
}

interface TemplateDraft {
  text: string;
  vkTextOverride: string;
  maxTextOverride: string;
  timezone: string;
  groupIds: string[];
  attachmentIds: string[];
  schedule: ScheduleForm;
}

function isSchedulePreset(value: string | undefined): value is SchedulePreset {
  return (
    value === 'daily' ||
    value === 'weekly' ||
    value === 'monthly' ||
    value === 'custom'
  );
}

/** Поля формы «Новый пост» — как их присылает браузер. */
interface PostFormBody {
  text?: string;
  groupIds?: string | string[];
  attachmentIds?: string | string[];
  scheduledAt?: string;
  action?: string;
  /**
   * Имя файла, выбранного в поле загрузки. Форма поста уходит как
   * urlencoded, и браузер прикладывает к ней **только имя** — сам файл нет.
   */
  file?: string;
}

interface PostDraft {
  text: string;
  groupIds: string[];
  attachmentIds: string[];
  scheduledAt: string;
}

/** Поля формы «Новый конкурс» — как их присылает браузер. */
interface NewContestFormBody {
  title?: string;
  description?: string;
  groupIds?: string | string[];
  attachmentIds?: string | string[];
  file?: string;
  joinButtonLabel?: string;
  resultsButtonLabel?: string;
  notifyWinners?: string;
  publishResultsInPost?: string;
  publishAt?: string;
  endsAt?: string;
  placesCount?: string;
}

interface NewContestDraft {
  title: string;
  description: string;
  groupIds: string[];
  attachmentIds: string[];
  joinButtonLabel: string;
  resultsButtonLabel: string;
  notifyWinners: boolean;
  publishResultsInPost: boolean;
  publishAt: string;
  endsAt: string;
  placesCount: string;
}

/** Поля формы «Правка опубликованного» — как их присылает браузер. */
interface EditPublishedFormBody {
  text?: string;
  vkTextOverride?: string;
  maxTextOverride?: string;
  autoDeleteAfterMinutes?: string;
  attachmentIds?: string | string[];
}

interface EditDraft {
  text: string;
  vkTextOverride: string;
  maxTextOverride: string;
  autoDeleteAfterMinutes: string;
  attachmentIds: string[];
}

/**
 * Поля формы «Править черновик» — как их присылает браузер. Отдельный тип от
 * `EditPublishedFormBody`: здесь есть группы и расписание, которых там нет и
 * быть не может (черновик ещё нигде не доставлен).
 */
interface EditDraftPostFormBody {
  text?: string;
  vkTextOverride?: string;
  maxTextOverride?: string;
  groupIds?: string | string[];
  attachmentIds?: string | string[];
  scheduledAt?: string;
  file?: string;
}

interface DraftEditState {
  text: string;
  vkTextOverride: string;
  maxTextOverride: string;
  groupIds: string[];
  attachmentIds: string[];
  scheduledAt: string;
}

/** Поля формы «Разослать в личку» — как их присылает браузер. */
interface DirectMessageFormBody {
  mode?: string;
  platformUserId?: string;
  groupId?: string;
}

/** Поля формы «Написать в личку» — как их присылает браузер. */
interface DirectMessageDraftFormBody extends DirectMessageFormBody {
  text?: string;
  attachmentIds?: string | string[];
  /** Как у `PostFormBody.file` — имя выбранного, но не загруженного файла. */
  file?: string;
}

interface DirectMessageDraft {
  text: string;
  attachmentIds: string[];
}

/** Сколько строк показывают списки конкурсов и постов-кандидатов. */
const LIST_LIMIT = 50;

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
    private readonly contests: ContestsService,
    private readonly templates: PostTemplatesService,
    private readonly vkToken: VkUploaderTokenService,
    private readonly media: MediaService,
    private readonly platformUsers: PlatformUsersService,
    private readonly directMessages: DirectMessageDispatchService,
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
    // Причина отказа отправки приходит сюда же: без неё баннер говорил бы
    // «пост не отправлен», не объясняя почему.
    @Query('reason') reason?: string,
  ) {
    return {
      ...this.shell(req, 'Посты', admin, 'campaigns', flash, reason),
      page: 'campaigns',
      campaigns: await this.posts.listCampaigns(),
      statusColor,
      statusLabel,
      formatDate,
    };
  }

  @Get('campaigns/:id')
  @UseGuards(AdminAuthGuard)
  @RequirePermissions('posts_manage')
  async campaign(
    @Param('id') id: string,
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Res() res: Response,
    @Query('flash') flash?: string,
    // Причина отказа, как и у списка кампаний: без неё баннер об отказе
    // рассылки в личку не сказал бы, почему — реальный кейс с появлением
    // этого маршрута, до него отказы сюда не редиректили.
    @Query('reason') reason?: string,
    @Query('dmQuery') dmQuery?: string,
  ): Promise<void> {
    // Через тот же `renderCampaign`, что и повтороный показ после загрузки
    // файла посреди правки: разошедшиеся копии полей — на первом же
    // добавленном.
    await this.renderCampaign(res, req, admin, id, { flash, reason, dmQuery });
  }

  @Post('campaigns/:id/edit-published')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('posts_manage')
  async editPublished(
    @Param('id') id: string,
    @Body() body: EditPublishedFormBody,
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Res() res: Response,
  ): Promise<void> {
    const draft = this.editDraftFrom(body);

    let autoDeleteAfterMinutes: number | null;
    try {
      autoDeleteAfterMinutes = parseMinutes(body.autoDeleteAfterMinutes);
    } catch {
      // Проверяем **до** обращения к сервису: тот сначала останавливает
      // идущую рассылку, и падение после этого оставило бы кампанию
      // остановленной с неизменённым текстом. Перерисовываем форму, а не
      // редиректим голым флэшем — тот же принцип, что и у отказа валидации
      // вложений ниже: без него правка текста и вложений терялась бы
      // из-за одной опечатки в поле срока.
      await this.renderCampaign(res, req, admin, id, {
        status: 400,
        editDraft: draft,
        editError: 'Срок автоудаления — целое число минут от 1 до года',
      });
      return;
    }

    let outcome: ModerationOutcome;
    try {
      outcome = await this.moderation.editPublished(id, {
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
        // Форма правки всегда несёт полный список вложений (даже пустой):
        // снятые галочки — осознанное «убрать картинку», а не «поле не
        // прислали». Именно этот путь и снимает вложения с уже
        // опубликованного — в MAX теперь тоже (см. `buildEditExtra`).
        attachmentIds: asArray(body.attachmentIds),
      });
    } catch (err: unknown) {
      // Отказ валидации (например, часть вложений уже удалена кем-то ещё)
      // перерисовывает форму с набранным, а не роняет в общий экран ошибки:
      // тот стёр бы текст, переопределения и срок автоудаления, которые
      // человек только что набрал.
      if (!(err instanceof AppException)) {
        throw err;
      }
      await this.renderCampaign(res, req, admin, id, {
        status: 400,
        editDraft: draft,
        editError: err.message,
      });
      return;
    }
    res.redirect(
      `${PANEL_PREFIX}/campaigns/${id}?flash=${outcomeFlash(outcome, 'edited')}`,
    );
  }

  /**
   * Загрузка файла посреди правки опубликованного — тот же приём, что и у
   * «Нового поста»: вся форма уходит на другой адрес вместе с файлом, а
   * сервер перерисовывает страницу с набранным и сам отмечает новое
   * вложение. Пост при этом не меняется — правка применяется только по
   * «Сохранить и обновить везде».
   */
  @Post('campaigns/:id/media')
  @UseGuards(AdminAuthGuard)
  @RequirePermissions('posts_manage')
  // Тот же порядок и то же обоснование, что у `/panel/media`: CsrfInterceptor
  // вместо CsrfGuard, и строго после FileInterceptor — скрытое поле `_csrf`
  // лежит в multipart-теле, которое разбирает именно FileInterceptor.
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_BYTES },
    }),
    CsrfInterceptor,
  )
  async uploadCampaignMedia(
    // Без `ParseUUIDPipe` — как и у остальных маршрутов `campaigns/:id/…`:
    // `Post.id` обычная `String`-колонка, невалидный id просто не найдётся
    // и даст доменное «Пост не найден» через `getPostWithDeliveries`,
    // вместо отдельной генерик-ошибки Nest только на этом одном маршруте.
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: EditPublishedFormBody,
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Res() res: Response,
  ): Promise<void> {
    const draft = this.editDraftFrom(body);

    if (!file) {
      await this.renderCampaign(res, req, admin, id, {
        status: 400,
        editDraft: draft,
        editError: 'Файл не выбран',
      });
      return;
    }

    let asset: MediaAsset;
    try {
      asset = await this.uploadFormFile(file);
    } catch (err: unknown) {
      if (!(err instanceof AppException)) {
        this.logger.error({ err }, 'Не удалось загрузить вложение');
      }
      await this.renderCampaign(res, req, admin, id, {
        status: 400,
        editDraft: draft,
        editError:
          err instanceof AppException
            ? err.message
            : 'Не удалось загрузить файл',
      });
      return;
    }

    const attachmentIds = [...new Set([...draft.attachmentIds, asset.id])];
    try {
      // Проверяется здесь же, а не только при «Сохранить»: иначе человек
      // отмечал бы лишние файлы одним за другим, ничего не подозревая, и
      // узнал бы о лимите VK лишь на сохранении, потеряв весь набранный к
      // тому моменту список отметок.
      await this.posts.assertAttachmentsUsable(attachmentIds);
    } catch (err: unknown) {
      await this.renderCampaign(res, req, admin, id, {
        status: 400,
        editDraft: { ...draft, attachmentIds },
        editError:
          err instanceof AppException
            ? err.message
            : 'Не удалось загрузить файл',
      });
      return;
    }

    await this.renderCampaign(res, req, admin, id, {
      flash: 'uploaded',
      editDraft: {
        ...draft,
        // Новый файл отмечается сам — тот же приём, что и в «Новом посте».
        attachmentIds,
      },
    });
  }

  /**
   * Правка черновика — текст, оба переопределения, группы, расписание и
   * вложения. В отличие от «Правки опубликованного», подтверждения на
   * проталкивание тоже нет: ничего ещё не доставлено, менять можно свободно.
   */
  @Post('campaigns/:id/edit-draft')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('posts_manage')
  async editDraftPost(
    @Param('id') id: string,
    @Body() body: EditDraftPostFormBody,
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Res() res: Response,
  ): Promise<void> {
    const draft = this.draftEditFrom(body);

    // Тот же приём, что у «Нового поста»: имя выбранного, но не
    // загруженного файла присутствует, а тела файла в этой форме нет.
    const pendingFile = body.file?.trim();
    if (pendingFile) {
      await this.renderCampaign(res, req, admin, id, {
        status: 400,
        draftEdit: draft,
        draftEditError: `Вы выбрали файл «${pendingFile}», но не загрузили его. Выберите файл заново, нажмите «Загрузить», а потом сохраняйте.`,
      });
      return;
    }

    try {
      const scheduledAt = this.parseSchedule(draft.scheduledAt);
      await this.posts.editDraft(id, {
        text: draft.text,
        vkTextOverride: draft.vkTextOverride,
        maxTextOverride: draft.maxTextOverride,
        groupIds: draft.groupIds,
        attachmentIds: draft.attachmentIds,
        scheduledAt,
      });
    } catch (err: unknown) {
      await this.renderCampaign(res, req, admin, id, {
        status: 400,
        draftEdit: draft,
        draftEditError:
          err instanceof AppException ? err.message : 'Не удалось сохранить',
      });
      return;
    }

    await this.renderCampaign(res, req, admin, id, { flash: 'draft-edited' });
  }

  /** Загрузка вложения для правки черновика — своя копия, тот же приём, что у `campaigns/:id/media`. */
  @Post('campaigns/:id/media-draft')
  @UseGuards(AdminAuthGuard)
  @RequirePermissions('posts_manage')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_BYTES },
    }),
    CsrfInterceptor,
  )
  async uploadDraftMedia(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: EditDraftPostFormBody,
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Res() res: Response,
  ): Promise<void> {
    const draft = this.draftEditFrom(body);

    if (!file) {
      await this.renderCampaign(res, req, admin, id, {
        status: 400,
        draftEdit: draft,
        draftEditError: 'Файл не выбран',
      });
      return;
    }

    let asset: MediaAsset;
    try {
      asset = await this.uploadFormFile(file);
    } catch (err: unknown) {
      if (!(err instanceof AppException)) {
        this.logger.error({ err }, 'Не удалось загрузить вложение');
      }
      await this.renderCampaign(res, req, admin, id, {
        status: 400,
        draftEdit: draft,
        draftEditError:
          err instanceof AppException
            ? err.message
            : 'Не удалось загрузить файл',
      });
      return;
    }

    const attachmentIds = [...new Set([...draft.attachmentIds, asset.id])];
    try {
      await this.posts.assertAttachmentsUsable(attachmentIds);
    } catch (err: unknown) {
      await this.renderCampaign(res, req, admin, id, {
        status: 400,
        draftEdit: { ...draft, attachmentIds },
        draftEditError:
          err instanceof AppException
            ? err.message
            : 'Не удалось загрузить файл',
      });
      return;
    }

    await this.renderCampaign(res, req, admin, id, {
      flash: 'uploaded',
      draftEdit: { ...draft, attachmentIds },
    });
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
    try {
      await this.posts.schedulePost(id);
    } catch (err: unknown) {
      this.redirectSendFailure(res, err);
      return;
    }
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
    try {
      await this.posts.resumePost(id);
    } catch (err: unknown) {
      this.redirectSendFailure(res, err);
      return;
    }
    res.redirect(`${PANEL_PREFIX}/campaigns?flash=resumed`);
  }

  /**
   * Режим решает форма (`mode`), не то, какие поля заполнены: три радио на
   * одной странице, без JS, отправляют все свои поля разом, и только
   * отмеченный режим говорит, какое из них имеет значение.
   */
  @Post('campaigns/:id/direct-messages')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('posts_manage')
  async sendDirectMessages(
    @Param('id') id: string,
    @Body() body: DirectMessageFormBody,
    @Res() res: Response,
  ): Promise<void> {
    const selector = this.dmSelectorFrom(body);
    if (!selector) {
      this.redirectFlash(res, `campaigns/${id}`, 'dm-no-selection');
      return;
    }
    try {
      const { queued } = await this.directMessages.sendNow(id, selector);
      this.redirectFlash(
        res,
        `campaigns/${id}`,
        'dm-sent',
        `Поставлено в очередь: ${queued}`,
      );
    } catch (err: unknown) {
      if (!(err instanceof AppException)) {
        throw err;
      }
      this.redirectFlash(res, `campaigns/${id}`, 'dm-failed', err.message);
    }
  }

  private dmSelectorFrom(
    body: DirectMessageFormBody,
  ): DirectMessageRecipientSelector | null {
    if (body.mode === 'user' && body.platformUserId) {
      return { mode: 'user', platformUserId: body.platformUserId };
    }
    if (body.mode === 'group' && body.groupId) {
      return { mode: 'group', groupId: body.groupId };
    }
    if (body.mode === 'all') {
      return { mode: 'all' };
    }
    return null;
  }

  /**
   * «Написать в личку»: в отличие от «Разослать в личку» на карточке
   * поста, здесь пост не существует заранее — форма сама пишет текст и
   * вложения и в одном запросе создаёт DM-only пост да отправляет его,
   * без промежуточного черновика на экране и без выбора групп.
   *
   * Поиск получателя перезагружает страницу той же формой, но с
   * `formmethod="get"` на кнопке «Найти» (см. `direct-message-new.ejs`) —
   * все поля формы, включая `text`/`attachmentIds`, едут вместе с этим
   * запросом, а не только `dmQuery`, иначе перерисовка стирала бы то, что
   * админ уже успел набрать.
   */
  @Get('direct-messages/new')
  @UseGuards(AdminAuthGuard)
  @RequirePermissions('posts_manage')
  async newDirectMessage(
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Res() res: Response,
    @Query()
    query: DirectMessageDraftFormBody & {
      flash?: string;
      reason?: string;
      dmQuery?: string;
    },
  ): Promise<void> {
    await this.renderDirectMessageForm(
      res,
      req,
      admin,
      this.directMessageDraftFrom(query),
      { flash: query.flash, reason: query.reason, dmQuery: query.dmQuery },
    );
  }

  @Post('direct-messages')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('posts_manage')
  async createDirectMessage(
    @Body() body: DirectMessageDraftFormBody,
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Res() res: Response,
  ): Promise<void> {
    const draft = this.directMessageDraftFrom(body);

    // Тот же приём, что у «Нового поста»: имя выбранного, но не
    // загруженного файла присутствует, а тела файла в этой форме нет —
    // молча отправить без картинки, которую человек выбрал, нельзя.
    const pendingFile = body.file?.trim();
    if (pendingFile) {
      await this.renderDirectMessageForm(res, req, admin, draft, {
        status: 400,
        error: `Вы выбрали файл «${pendingFile}», но не загрузили его. Выберите файл заново, нажмите «Загрузить», а потом отправляйте.`,
      });
      return;
    }

    const selector = this.dmSelectorFrom(body);
    if (!selector) {
      await this.renderDirectMessageForm(res, req, admin, draft, {
        status: 400,
        error: 'Выберите получателя',
      });
      return;
    }

    let post: { id: string };
    try {
      post = await this.posts.createDirectMessageDraft({
        text: draft.text,
        attachmentIds: draft.attachmentIds,
      });
    } catch (err: unknown) {
      await this.renderDirectMessageForm(res, req, admin, draft, {
        status: 400,
        error:
          err instanceof AppException
            ? err.message
            : 'Не удалось создать сообщение',
      });
      return;
    }

    // Сообщение уже создано на этом шаге — отказ рассылки ниже не теряет
    // набранное (перерисовывать форму как при ошибке валидации незачем,
    // текста и вложений это уже не касается) и не удваивает создание при
    // повторной отправке той же формы.
    try {
      const { queued } = await this.directMessages.sendNow(post.id, selector);
      this.redirectFlash(
        res,
        'direct-messages/new',
        'dm-sent',
        `Поставлено в очередь: ${queued}`,
      );
    } catch (err: unknown) {
      if (!(err instanceof AppException)) {
        throw err;
      }
      this.redirectFlash(res, 'direct-messages/new', 'dm-failed', err.message);
    }
  }

  /** Загрузка вложения для «Написать в личку» — своя копия `uploadMedia` под свой рендер, тот же приём, что у `campaigns/:id/media`. */
  @Post('direct-messages/media')
  @UseGuards(AdminAuthGuard)
  @RequirePermissions('posts_manage')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_BYTES },
    }),
    CsrfInterceptor,
  )
  async uploadDirectMessageMedia(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: DirectMessageDraftFormBody,
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Res() res: Response,
  ): Promise<void> {
    const draft = this.directMessageDraftFrom(body);

    if (!file) {
      await this.renderDirectMessageForm(res, req, admin, draft, {
        status: 400,
        error: 'Файл не выбран',
      });
      return;
    }

    let asset: MediaAsset;
    try {
      asset = await this.uploadFormFile(file);
    } catch (err: unknown) {
      if (!(err instanceof AppException)) {
        this.logger.error({ err }, 'Не удалось загрузить вложение');
      }
      await this.renderDirectMessageForm(res, req, admin, draft, {
        status: 400,
        error:
          err instanceof AppException
            ? err.message
            : 'Не удалось загрузить файл',
      });
      return;
    }

    // Тот же приём, что у остальных загрузок вложений (campaigns/:id/media,
    // media-draft, contests/media): дедуп через `Set` — повторный клик
    // «Загрузить» на уже отмеченном файле не должен задваивать id в списке
    // — и проверка лимита сразу, а не только на «Разослать».
    const attachmentIds = [...new Set([asset.id, ...draft.attachmentIds])];
    try {
      await this.posts.assertAttachmentsUsable(attachmentIds);
    } catch (err: unknown) {
      await this.renderDirectMessageForm(
        res,
        req,
        admin,
        { ...draft, attachmentIds },
        {
          status: 400,
          error:
            err instanceof AppException
              ? err.message
              : 'Не удалось загрузить файл',
        },
      );
      return;
    }

    await this.renderDirectMessageForm(res, req, admin, {
      ...draft,
      attachmentIds,
    });
  }

  private directMessageDraftFrom(
    body: DirectMessageDraftFormBody,
  ): DirectMessageDraft {
    return {
      text: body.text ?? '',
      attachmentIds: asArray(body.attachmentIds),
    };
  }

  private async renderDirectMessageForm(
    res: Response,
    req: Request,
    admin: AdminUser,
    draft: DirectMessageDraft,
    options: {
      status?: number;
      flash?: string;
      reason?: string;
      error?: string | null;
      dmQuery?: string;
    } = {},
  ): Promise<void> {
    // Тот же приём, что у карточки поста: пусто — поиск ещё не запускали,
    // отличать от «запустили и никого не нашли».
    const dmQuery = options.dmQuery?.trim() || null;
    const [dmResults, activeGroups] = await Promise.all([
      dmQuery ? this.platformUsers.search('max', dmQuery) : null,
      this.activeGroups(),
    ]);
    // Только MAX — тот же фильтр, что у карточки поста: личка через VK не
    // умеет уходить от имени сообщества.
    const dmGroups = activeGroups.filter((group) => group.platform === 'max');
    res.status(options.status ?? 200).render('layout', {
      ...this.shell(
        req,
        'Написать в личку',
        admin,
        'direct-message-new',
        options.flash,
        options.reason,
      ),
      page: 'direct-message-new',
      draft,
      media: await this.mediaWithPinned(draft.attachmentIds),
      error: options.error ?? null,
      dmQuery,
      dmResults,
      dmGroups,
      mediaKindLabel,
    });
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
    const [all, vkToken] = await Promise.all([
      this.groups.listGroups(),
      this.vkToken.getStatus(),
    ]);
    return {
      ...this.shell(req, 'Группы', admin, 'groups', flash, reason),
      page: 'groups',
      vkToken,
      // Без ключей приложения VK кнопка вела бы в ошибку 500: ссылка на
      // авторизацию собирается из `VK_APP_ID`.
      vkAppConfigured: Boolean(
        this.config.get<string>('VK_APP_ID') &&
        this.config.get<string>('VK_APP_CLIENT_SECRET'),
      ),
      // Отключённые не прячем: без них непонятно, куда делась группа, в
      // которую раньше уходили посты.
      groups: all,
      pending: all.filter((g) => g.status === 'pending_confirmation'),
      groupColor,
      groupLabel,
      formatDate,
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
      this.redirectFlash(res, 'groups', 'group-failed', reason);
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

  // ----- повторяющиеся шаблоны --------------------------------------------

  @Get('templates')
  @Render('layout')
  @UseGuards(AdminAuthGuard)
  @RequirePermissions('posts_manage')
  async templatesPage(
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Query('flash') flash?: string,
    @Query('reason') reason?: string,
  ) {
    return {
      ...this.shell(req, 'Повторяющиеся', admin, 'templates', flash, reason),
      page: 'templates',
      templates: await this.templates.listTemplates(LIST_LIMIT),
      listLimit: LIST_LIMIT,
      describeSchedule,
      templateColor,
      templateLabel,
      templateHint,
      formatDate,
    };
  }

  // До `templates/:id`: Nest сопоставляет маршруты по порядку объявления.
  @Get('templates/new')
  @Render('layout')
  @UseGuards(AdminAuthGuard)
  @RequirePermissions('posts_manage')
  async newTemplate(
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Query('flash') flash?: string,
  ) {
    return {
      ...this.shell(req, 'Новый повторяющийся', admin, 'templates', flash),
      page: 'template-form',
      groups: await this.activeGroups(),
      media: await this.recentMedia(),
      weekdays: WEEKDAYS,
      maxPresetMonthday: MAX_PRESET_MONTHDAY,
      draft: this.emptyTemplateDraft(),
      template: null,
      error: null,
    };
  }

  @Post('templates')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('posts_manage')
  async createTemplate(
    @Body() body: TemplateFormBody,
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Res() res: Response,
  ): Promise<void> {
    const draft = this.templateDraftFrom(body);
    try {
      const template = await this.templates.createTemplate({
        text: body.text ?? '',
        vkTextOverride: body.vkTextOverride?.trim() || undefined,
        maxTextOverride: body.maxTextOverride?.trim() || undefined,
        recurrenceRule: buildCron(draft.schedule),
        timezone: body.timezone?.trim() || undefined,
        groupIds: draft.groupIds,
        attachmentIds: draft.attachmentIds,
      });
      res.redirect(
        `${PANEL_PREFIX}/templates/${template.id}?flash=template-created`,
      );
    } catch (err: unknown) {
      await this.renderTemplateForm(res, req, admin, draft, null, err);
    }
  }

  @Get('templates/:id')
  @Render('layout')
  @UseGuards(AdminAuthGuard)
  @RequirePermissions('posts_manage')
  async templatePage(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Query('flash') flash?: string,
    @Query('reason') reason?: string,
  ) {
    return this.templateCard(req, admin, id, { flash, reason });
  }

  @Post('templates/:id')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('posts_manage')
  async updateTemplate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TemplateFormBody,
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Res() res: Response,
  ): Promise<void> {
    const draft = this.templateDraftFrom(body);
    try {
      const stored = await this.templates.getTemplate(id);
      await this.templates.updateTemplate(id, {
        text: body.text ?? '',
        // Поля формы — полная правда о тексте: пустое означает «снять
        // переопределение», а не «не трогать». Иначе снять его из панели
        // было бы нечем, и шаблон публиковал бы в VK текст, которого в
        // панели не видно.
        vkTextOverride: body.vkTextOverride?.trim() || null,
        maxTextOverride: body.maxTextOverride?.trim() || null,
        // Если расписание по смыслу то же, что сохранено, отдаём сохранённую
        // строку: пересобранная из полей могла бы отличаться записью
        // (`0 09` и `0 9`), и сервис принял бы это за смену расписания —
        // см. `sameSchedule`.
        recurrenceRule: sameSchedule(
          parseCron(stored.recurrenceRule ?? ''),
          draft.schedule,
        )
          ? (stored.recurrenceRule ?? buildCron(draft.schedule))
          : buildCron(draft.schedule),
        timezone: body.timezone?.trim() || this.defaultTimezone(),
        groupIds: draft.groupIds,
        attachmentIds: draft.attachmentIds,
      });
      res.redirect(`${PANEL_PREFIX}/templates/${id}?flash=template-saved`);
    } catch (err: unknown) {
      this.logger.warn({ err, templateId: id }, 'Не удалось сохранить шаблон');
      // Форма перерисовывается с набранным, как и при создании: переписанный
      // текст, новый выбор групп и расписание набираются долго, а редирект на
      // карточку показал бы сохранённое старое и выбросил бы всё это из-за
      // одной опечатки в cron.
      res.status(400).render(
        'layout',
        await this.templateCard(req, admin, id, {
          draft,
          error:
            err instanceof AppException
              ? err.message
              : 'Не удалось сохранить шаблон',
        }),
      );
    }
  }

  @Post('templates/:id/pause')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('posts_manage')
  async pauseTemplate(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.templates.setPaused(id, true);
    res.redirect(`${PANEL_PREFIX}/templates/${id}?flash=template-paused`);
  }

  @Post('templates/:id/resume')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('posts_manage')
  async resumeTemplate(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    try {
      await this.templates.setPaused(id, false);
      res.redirect(`${PANEL_PREFIX}/templates/${id}?flash=template-resumed`);
    } catch (err: unknown) {
      // Возобновление пересчитывает следующий запуск, то есть заново
      // разбирает правило — а разоружённый шаблон как раз тот, у кого оно
      // сломано. Общий экран ошибки показал бы сырое сообщение cron-parser
      // вместо страницы, где правило можно починить.
      this.logger.warn(
        { err, templateId: id },
        'Не удалось возобновить шаблон',
      );
      const reason =
        err instanceof AppException
          ? err.message
          : 'Не удалось возобновить шаблон';
      res.redirect(
        `${PANEL_PREFIX}/templates/${id}?flash=template-failed&reason=${encodeURIComponent(reason)}`,
      );
    }
  }

  /**
   * Всё, что нужно странице шаблона. Одно место для двух путей: обычного
   * показа и перерисовки после отказа при сохранении — иначе вторая копия
   * набора полей разошлась бы с первой на первом же добавленном поле.
   */
  private async templateCard(
    req: Request,
    admin: AdminUser,
    id: string,
    options: {
      draft?: TemplateDraft;
      error?: string | null;
      flash?: string;
      reason?: string;
    } = {},
  ) {
    const template = await this.templates.getTemplate(id);
    const occurrences = await this.templates.listOccurrences(id);
    const attachedIds = await this.templateAttachmentIds(id);
    return {
      ...this.shell(
        req,
        'Повторяющийся пост',
        admin,
        'templates',
        options.flash,
        options.reason,
      ),
      page: 'template',
      template,
      occurrences,
      occurrencesLimit: OCCURRENCE_PAGE_SIZE,
      // Список групп — все активные плюс те, что уже в целях шаблона:
      // неактивная цель остаётся в списке намеренно (группа может
      // восстановиться), и спрятать её из формы значило бы снимать её с
      // шаблона при каждом сохранении.
      groups: await this.groupsForTemplate(template.targets.map((g) => g.id)),
      media: await this.mediaWithPinned(attachedIds),
      weekdays: WEEKDAYS,
      maxPresetMonthday: MAX_PRESET_MONTHDAY,
      draft: options.draft ?? {
        text: template.text,
        vkTextOverride: template.vkTextOverride ?? '',
        maxTextOverride: template.maxTextOverride ?? '',
        timezone: template.timezone ?? this.defaultTimezone(),
        groupIds: template.targets.map((g) => g.id),
        attachmentIds: attachedIds,
        schedule: parseCron(template.recurrenceRule ?? ''),
      },
      describeSchedule,
      templateColor,
      templateLabel,
      templateHint,
      statusColor,
      statusLabel,
      formatDate,
      error: options.error ?? null,
    };
  }

  /**
   * Вложения для формы (поста или шаблона): уже выбранные — первыми и в
   * заданном порядке (у шаблона это `position`), затем свежие загрузки.
   *
   * Оба условия держат форму честной. Правка отправляет список вложений
   * целиком, а сервис заменяет их разом, поэтому прикреплённое, которого в
   * форме нет (шаблон завели давно, и картинка выпала из последних двадцати
   * загрузок), при первом же сохранении опечатки молча исчезло бы из всех
   * будущих публикаций. А порядок нужен потому, что браузер шлёт отмеченные
   * галочки в порядке страницы, и `position` по нему пересчитывается: без
   * этого каждое сохранение переставляло бы картинки местами.
   */
  private async mediaWithPinned(attachedIds: string[]) {
    const attached = attachedIds.length
      ? await this.prisma.mediaAsset.findMany({
          where: { id: { in: attachedIds } },
          select: { id: true, filename: true, kind: true },
        })
      : [];
    const byId = new Map(attached.map((asset) => [asset.id, asset]));
    const inOrder = attachedIds.flatMap((id) => byId.get(id) ?? []);
    const rest = (await this.recentMedia()).filter(
      (asset) => !byId.has(asset.id),
    );
    return [...inOrder, ...rest];
  }

  private defaultTimezone(): string {
    return this.config.getOrThrow<string>('DEFAULT_TIMEZONE');
  }

  private emptyTemplateDraft(): TemplateDraft {
    return {
      text: '',
      vkTextOverride: '',
      maxTextOverride: '',
      timezone: this.defaultTimezone(),
      groupIds: [],
      attachmentIds: [],
      schedule: DEFAULT_SCHEDULE,
    };
  }

  private templateDraftFrom(body: TemplateFormBody): TemplateDraft {
    return {
      text: body.text ?? '',
      vkTextOverride: body.vkTextOverride ?? '',
      maxTextOverride: body.maxTextOverride ?? '',
      timezone: body.timezone ?? this.defaultTimezone(),
      groupIds: asArray(body.groupIds),
      attachmentIds: asArray(body.attachmentIds),
      schedule: {
        mode: isSchedulePreset(body.mode) ? body.mode : 'daily',
        time: body.time ?? DEFAULT_SCHEDULE.time,
        weekday: Number(body.weekday ?? DEFAULT_SCHEDULE.weekday),
        monthday: Number(body.monthday ?? DEFAULT_SCHEDULE.monthday),
        custom: body.custom ?? '',
      },
    };
  }

  /** Активные группы плюс те, что уже в целях шаблона (даже неактивные). */
  private async groupsForTemplate(targetIds: string[]) {
    const all = await this.groups.listGroups();
    return all.filter(
      (group) => group.status === 'active' || targetIds.includes(group.id),
    );
  }

  private async templateAttachmentIds(id: string): Promise<string[]> {
    const attachments = await this.prisma.postAttachment.findMany({
      where: { postId: id },
      orderBy: { position: 'asc' },
      select: { mediaAssetId: true },
    });
    return attachments.map((a) => a.mediaAssetId);
  }

  private async renderTemplateForm(
    res: Response,
    req: Request,
    admin: AdminUser,
    draft: TemplateDraft,
    template: { id: string } | null,
    err: unknown,
  ): Promise<void> {
    this.logger.warn({ err }, 'Не удалось сохранить повторяющийся пост');
    // Форма перерисовывается с набранным: расписание, выбор групп и текст
    // набираются долго, и терять их из-за одной опечатки в cron незачем.
    res.status(400).render('layout', {
      ...this.shell(req, 'Новый повторяющийся', admin, 'templates'),
      page: 'template-form',
      groups: await this.activeGroups(),
      media: await this.recentMedia(),
      weekdays: WEEKDAYS,
      maxPresetMonthday: MAX_PRESET_MONTHDAY,
      draft,
      template,
      error:
        err instanceof AppException
          ? err.message
          : 'Не удалось сохранить повторяющийся пост',
    });
  }

  // ----- конкурсы ---------------------------------------------------------

  @Get('contests')
  @Render('layout')
  @UseGuards(AdminAuthGuard)
  @RequirePermissions('contests_manage')
  async contestsPage(
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Query('flash') flash?: string,
    @Query('reason') reason?: string,
  ) {
    return {
      ...this.shell(req, 'Конкурсы', admin, 'contests', flash, reason),
      page: 'contests',
      contests: await this.contests.listContests(LIST_LIMIT),
      listLimit: LIST_LIMIT,
      contestColor,
      contestLabel,
      formatDate,
    };
  }

  // Объявлен **до** `contests/:id`: Nest сопоставляет маршруты в порядке
  // объявления, и ниже `new` уехал бы в карточку конкурса как id.
  @Get('contests/new')
  @UseGuards(AdminAuthGuard)
  @RequirePermissions('contests_manage')
  async newContest(
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Res() res: Response,
    @Query('flash') flash?: string,
  ): Promise<void> {
    await this.renderNewContest(res, req, admin, this.emptyNewContestDraft(), {
      flash,
    });
  }

  /**
   * Создание конкурса вместе с анонс-постом — одной формой и одним
   * сабмитом. Раньше это были два экрана (создать пост, вернуться сюда,
   * найти его в списке): конкурс и его публикация — по сути одно действие
   * администратора, а не два независимых.
   *
   * Пост создаётся первым, только если отмечен хотя бы один канал — иначе
   * конкурс заводится без анонса, как и раньше. Если пост создался, а
   * следом отказал сам конкурс (даты, места) — пост остаётся черновиком-
   * сиротой без конкурса; тот же осознанный компромисс, что и у
   * `createDirectMessage`: переигрывать создание поста ради одной строки
   * не стоит, а перепроверить входные данные заранее (группы, вложения) и
   * так нечем — их провал ловится тем же catch.
   */
  @Post('contests')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('contests_manage')
  async createContest(
    @Body() body: NewContestFormBody,
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Res() res: Response,
  ): Promise<void> {
    const draft = this.newContestDraftFrom(body);

    const pendingFile = body.file?.trim();
    if (pendingFile) {
      await this.renderNewContest(res, req, admin, draft, {
        status: 400,
        error: `Вы выбрали файл «${pendingFile}», но не загрузили его. Выберите файл заново, нажмите «Загрузить», а потом создавайте.`,
      });
      return;
    }

    try {
      const title = body.title?.trim();
      if (!title) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Название конкурса обязательно',
        );
      }
      const description = body.description?.trim();
      if (!description) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Описание обязательно — это и есть текст анонса',
        );
      }
      // Те же правила, что у даты отправки поста: `datetime-local` без
      // пояса, читаем в поясе проекта, чтобы полночь по МСК не уехала на
      // сервере с другим TZ.
      const publishAt = this.parseSchedule(draft.publishAt);
      const endsAt = this.parseSchedule(draft.endsAt);
      const placesCount = draft.placesCount.trim()
        ? Number(draft.placesCount)
        : undefined;
      if (placesCount !== undefined && !Number.isInteger(placesCount)) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Количество мест — целое число',
        );
      }
      // Те же три проверки, что и в `ContestsService.createContest` —
      // продублированы намеренно, чтобы отловить их **до** создания
      // анонс-поста ниже. Без этого отказ уже внутри `createContest`
      // оставлял бы висеть черновик поста без единого конкурса — тот же
      // компромисс, что и у `createDirectMessage`, но там сироте просто
      // неоткуда взяться, если проверить всё заранее.
      if (publishAt && endsAt && publishAt >= endsAt) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Дата завершения должна быть позже даты начала',
        );
      }
      if (endsAt && endsAt.getTime() <= Date.now()) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Дата завершения не может быть в прошлом',
        );
      }
      if (endsAt && !placesCount) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Для авто-розыгрыша по дате нужно хотя бы одно призовое место — укажите «Кол. мест»',
        );
      }

      // Ничего не отмечено — конкурс без анонса, участники только вручную
      // (старое поведение). `publishAt` отдельным полем поста не становится:
      // отправку анонса при открытии приёма уже делает `schedulePostIfDraft`
      // (ручное и авто-открытие, см. panel.controller/contests.service) —
      // дублировать её здесь через `scheduledAt` поста значило бы завести
      // два independent триггера одной и той же отправки.
      let postId: string | undefined;
      if (draft.groupIds.length > 0) {
        const post = await this.posts.createPost({
          text: description,
          groupIds: draft.groupIds,
          attachmentIds: draft.attachmentIds,
        });
        postId = post.id;
      }

      const contest = await this.contests.createContest({
        title,
        description,
        postId,
        joinButtonLabel: body.joinButtonLabel?.trim() || undefined,
        resultsButtonLabel: body.resultsButtonLabel?.trim() || undefined,
        notifyWinners: draft.notifyWinners,
        publishResultsInPost: draft.publishResultsInPost,
        startsAt: publishAt,
        endsAt,
        placesCount,
      });
      res.redirect(
        `${PANEL_PREFIX}/contests/${contest.id}?flash=contest-created`,
      );
    } catch (err: unknown) {
      this.logger.warn({ err }, 'Не удалось создать конкурс');
      await this.renderNewContest(res, req, admin, draft, {
        status: 400,
        error:
          err instanceof AppException
            ? err.message
            : 'Не удалось создать конкурс',
      });
    }
  }

  /** Загрузка картинки для «Нового конкурса» — своя копия, тот же приём, что у `/panel/media`. */
  @Post('contests/media')
  @UseGuards(AdminAuthGuard)
  @RequirePermissions('contests_manage')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_BYTES },
    }),
    CsrfInterceptor,
  )
  async uploadNewContestMedia(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: NewContestFormBody,
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Res() res: Response,
  ): Promise<void> {
    const draft = this.newContestDraftFrom(body);

    if (!file) {
      await this.renderNewContest(res, req, admin, draft, {
        status: 400,
        error: 'Файл не выбран',
      });
      return;
    }

    let asset: MediaAsset;
    try {
      asset = await this.uploadFormFile(file);
    } catch (err: unknown) {
      if (!(err instanceof AppException)) {
        this.logger.error({ err }, 'Не удалось загрузить вложение');
      }
      await this.renderNewContest(res, req, admin, draft, {
        status: 400,
        error:
          err instanceof AppException
            ? err.message
            : 'Не удалось загрузить файл',
      });
      return;
    }

    const attachmentIds = [...new Set([...draft.attachmentIds, asset.id])];
    try {
      await this.posts.assertAttachmentsUsable(attachmentIds);
    } catch (err: unknown) {
      await this.renderNewContest(
        res,
        req,
        admin,
        { ...draft, attachmentIds },
        {
          status: 400,
          error:
            err instanceof AppException
              ? err.message
              : 'Не удалось загрузить файл',
        },
      );
      return;
    }

    await this.renderNewContest(
      res,
      req,
      admin,
      { ...draft, attachmentIds },
      { flash: 'uploaded' },
    );
  }

  private emptyNewContestDraft(): NewContestDraft {
    return {
      title: '',
      description: '',
      groupIds: [],
      attachmentIds: [],
      joinButtonLabel: '',
      resultsButtonLabel: '',
      notifyWinners: true,
      publishResultsInPost: true,
      publishAt: '',
      endsAt: '',
      placesCount: '',
    };
  }

  private newContestDraftFrom(body: NewContestFormBody): NewContestDraft {
    return {
      title: body.title ?? '',
      description: body.description ?? '',
      groupIds: asArray(body.groupIds),
      attachmentIds: asArray(body.attachmentIds),
      joinButtonLabel: body.joinButtonLabel ?? '',
      resultsButtonLabel: body.resultsButtonLabel ?? '',
      // Снятая галочка браузером не присылается вовсе, поэтому «выключено» —
      // это отсутствие поля, а не значение `false`.
      notifyWinners: body.notifyWinners !== undefined,
      publishResultsInPost: body.publishResultsInPost !== undefined,
      publishAt: body.publishAt ?? '',
      endsAt: body.endsAt ?? '',
      placesCount: body.placesCount ?? '',
    };
  }

  private async renderNewContest(
    res: Response,
    req: Request,
    admin: AdminUser,
    draft: NewContestDraft,
    options: { status?: number; flash?: string; error?: string | null } = {},
  ): Promise<void> {
    const [groups, media] = await Promise.all([
      this.activeGroups(),
      this.mediaWithPinned(draft.attachmentIds),
    ]);
    res.status(options.status ?? 200).render('layout', {
      ...this.shell(req, 'Новый конкурс', admin, 'contests', options.flash),
      page: 'new-contest',
      groups,
      media,
      draft,
      formatDate,
      error: options.error ?? null,
      mediaKindLabel,
    });
  }

  @Get('contests/:id')
  @Render('layout')
  @UseGuards(AdminAuthGuard)
  @RequirePermissions('contests_manage')
  async contestPage(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Query('flash') flash?: string,
    @Query('reason') reason?: string,
  ) {
    const contest = await this.contests.getContest(id);
    // Поле с подписями перенумеровывает места подряд и режет текст по
    // переносам строк. Для мест, заведённых через API «вразбежку» (1, 3, 5)
    // или с переносом в подписи, сохранение без единой правки молча
    // переписало бы их — такие места правятся только там, где заведены.
    const prizesEditable = contest.prizes.every(
      (prize, index) =>
        prize.place === index + 1 && !prize.label.includes('\n'),
    );
    return {
      ...this.shell(req, contest.title, admin, 'contests', flash, reason),
      page: 'contest',
      contest,
      prizesEditable,
      // Места, закреплённые вручную: пересохранение списка их снимет
      // (`setPrizes` удаляет места и создаёт заново), и человека надо
      // предупредить **до** клика, а не показывать ему зелёный баннер над
      // исчезнувшим закреплением.
      forcedPlaces: contest.prizes
        .filter((prize) => prize.isForced && prize.winnerParticipantId)
        .map((prize) => prize.place),
      // Подписи мест — одной строкой на место, в том же виде, в каком форма
      // их принимает обратно.
      prizesText: contest.prizes.map((prize) => prize.label).join('\n'),
      // Форма правки — не перерисовывается набранным при отказе (см.
      // комментарий у `editContestPanel`), поэтому всегда строится из
      // текущего состояния конкурса, как и остальные поля этой страницы.
      contestEditDraft: {
        title: contest.title,
        description: contest.description,
        joinButtonLabel: contest.joinButtonLabel,
        resultsButtonLabel: contest.resultsButtonLabel,
        notifyWinners: contest.notifyWinners,
        publishResultsInPost: contest.publishResultsInPost,
        startsAt: contest.startsAt
          ? utcToZoned(contest.startsAt, this.defaultTimezone())
          : '',
        endsAt: contest.endsAt
          ? utcToZoned(contest.endsAt, this.defaultTimezone())
          : '',
      },
      contestColor,
      contestLabel,
      notifyColor,
      notifyLabel,
      formatDate,
    };
  }

  /**
   * Правка условий конкурса — заголовок, описание, подписи кнопок, флаги
   * уведомлений и даты. Тот же лёгкий приём, что у остальных действий этой
   * страницы (`runContestAction`): при отказе — редирект с баннером-причиной,
   * без перерисовки формы набранным. Публичный текст анонса (сам пост)
   * правится отдельно, по ссылке «анонс-пост» — эта форма его не трогает.
   */
  @Post('contests/:id/edit')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('contests_manage')
  async editContestPanel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: {
      title?: string;
      description?: string;
      joinButtonLabel?: string;
      resultsButtonLabel?: string;
      notifyWinners?: string;
      publishResultsInPost?: string;
      startsAt?: string;
      endsAt?: string;
    },
    @Res() res: Response,
  ): Promise<void> {
    await this.runContestAction(
      res,
      id,
      `${PANEL_PREFIX}/contests/${id}?flash=contest-edited`,
      () => {
        const title = body.title?.trim();
        if (!title) {
          throw new AppException(
            ErrorCode.VALIDATION_ERROR,
            'Название конкурса обязательно',
          );
        }
        return this.contests.editContest(id, {
          title,
          description: body.description?.trim() ?? '',
          joinButtonLabel: body.joinButtonLabel?.trim() || undefined,
          resultsButtonLabel: body.resultsButtonLabel?.trim() || undefined,
          // Та же логика отсутствующего поля, что и у создания.
          notifyWinners: body.notifyWinners !== undefined,
          publishResultsInPost: body.publishResultsInPost !== undefined,
          startsAt: this.parseSchedule(body.startsAt),
          endsAt: this.parseSchedule(body.endsAt),
        });
      },
    );
  }

  @Post('contests/:id/open')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('contests_manage')
  async openContest(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.runContestAction(
      res,
      id,
      `${PANEL_PREFIX}/contests/${id}?flash=contest-opened`,
      async () => {
        const contest = await this.contests.openContest(id);
        if (!contest.postId) {
          return;
        }
        // Отдельным try: анонс-пост, всё ещё черновик, не должен блокировать
        // открытие приёма — участие и публикация независимы (см. комментарий
        // у `openContest` в сервисе), а неудачную отправку админ уже видит на
        // карточке самого поста.
        try {
          await this.posts.schedulePostIfDraft(contest.postId);
        } catch (err: unknown) {
          this.logger.warn(
            { err, contestId: id, postId: contest.postId },
            'Приём открыт, но анонс-пост отправить не удалось',
          );
        }
      },
    );
  }

  @Post('contests/:id/prizes')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('contests_manage')
  async setPrizes(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { prizes?: string },
    @Res() res: Response,
  ): Promise<void> {
    if (!(await this.prizesEditableFromPanel(id))) {
      // Та же защита, что и в шаблоне: форму там не рисуют, но запрос может
      // прийти и мимо неё — а перенумерация мест необратима.
      res.redirect(`${PANEL_PREFIX}/contests/${id}?flash=prizes-not-editable`);
      return;
    }

    const prizes = parsePrizes(body.prizes);
    if (prizes.length === 0) {
      // Пустой список сервис отвергает как `@ArrayNotEmpty`, но дойди он
      // туда — человек получил бы ошибку валидации DTO вместо внятного
      // «впишите хотя бы одно место».
      res.redirect(`${PANEL_PREFIX}/contests/${id}?flash=no-prizes`);
      return;
    }
    await this.runContestAction(
      res,
      id,
      `${PANEL_PREFIX}/contests/${id}?flash=prizes-saved`,
      () => this.contests.setPrizes(id, prizes),
    );
  }

  @Post('contests/:id/participants')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('contests_manage')
  async addParticipants(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { text?: string; platform?: string },
    @Res() res: Response,
  ): Promise<void> {
    // Проверяем на пустоту обрезанную копию, а в сервис отдаём набранное как
    // есть: номера строк он считает по полученной строке, и обрезка пустого
    // начала сдвинула бы их относительно того, что человек видит в поле.
    if (!body.text?.trim()) {
      res.redirect(`${PANEL_PREFIX}/contests/${id}?flash=no-participants`);
      return;
    }

    try {
      const result = await this.contests.addParticipantsFromText(
        id,
        body.text,
        // Платформа нужна только строкам без ссылки и ника: по ссылке она и
        // так видна. Без выбора все такие участники становились бы MAX — на
        // VK-конкурсе это молча неверная платформа у каждого ручного.
        body.platform === 'vk' ? 'vk' : 'max',
      );
      // Дубли — обычное дело при повторной вставке того же списка, и без
      // номеров строк не видно, что именно не добавилось.
      const reason = encodeURIComponent(
        result.duplicateLines.length > 0
          ? `Добавлено: ${result.added}. Уже были в списке, строки: ${formatLineNumbers(result.duplicateLines)}`
          : `Добавлено: ${result.added}`,
      );
      res.redirect(
        `${PANEL_PREFIX}/contests/${id}?flash=participants-added&reason=${reason}`,
      );
    } catch (err: unknown) {
      this.redirectContestFailure(
        res,
        id,
        err,
        'Не удалось добавить участников',
      );
    }
  }

  @Post('contests/:id/draw')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('contests_manage')
  async drawContest(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AdminUser,
    @Res() res: Response,
  ): Promise<void> {
    await this.runContestAction(
      res,
      id,
      `${PANEL_PREFIX}/contests/${id}?flash=contest-drawn`,
      () => this.contests.draw(id, admin.id),
    );
  }

  @Post('contests/:id/prizes/:prizeId/force-winner')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('contests_manage')
  async forceWinner(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('prizeId', ParseUUIDPipe) prizeId: string,
    @Body() body: { participantId?: string },
    @Res() res: Response,
  ): Promise<void> {
    const participantId = body.participantId?.trim();
    if (!participantId) {
      res.redirect(`${PANEL_PREFIX}/contests/${id}?flash=no-participant`);
      return;
    }
    if (!(await this.prizeBelongsToContest(id, prizeId))) {
      res.redirect(`${PANEL_PREFIX}/contests/${id}?flash=wrong-prize`);
      return;
    }
    await this.runContestAction(
      res,
      id,
      `${PANEL_PREFIX}/contests/${id}?flash=winner-forced`,
      () => this.contests.forceWinner(prizeId, participantId),
    );
  }

  @Post('contests/:id/prizes/:prizeId/override-winner')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('contests_manage')
  async overrideWinner(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('prizeId', ParseUUIDPipe) prizeId: string,
    @Body() body: { participantId?: string; note?: string },
    @CurrentAdmin() admin: AdminUser,
    @Res() res: Response,
  ): Promise<void> {
    const participantId = body.participantId?.trim();
    if (!participantId) {
      res.redirect(`${PANEL_PREFIX}/contests/${id}?flash=no-participant`);
      return;
    }
    if (!(await this.prizeBelongsToContest(id, prizeId))) {
      res.redirect(`${PANEL_PREFIX}/contests/${id}?flash=wrong-prize`);
      return;
    }
    await this.runContestAction(
      res,
      id,
      `${PANEL_PREFIX}/contests/${id}?flash=winner-replaced`,
      () =>
        this.contests.overrideWinner(
          prizeId,
          participantId,
          body.note?.trim() || undefined,
          admin.id,
        ),
    );
  }

  /**
   * Можно ли править места этого конкурса из панели: только пока они идут
   * подряд с первого и ни в одной подписи нет переноса строки. Всё прочее
   * поле с подписями воспроизвести не может — см. `contestPage`.
   */
  private async prizesEditableFromPanel(contestId: string): Promise<boolean> {
    const prizes = await this.prisma.contestPrize.findMany({
      where: { contestId },
      orderBy: { place: 'asc' },
      select: { place: true, label: true },
    });
    return prizes.every(
      (prize, index) =>
        prize.place === index + 1 && !prize.label.includes('\n'),
    );
  }

  /**
   * Приз из адреса обязан принадлежать конкурсу из того же адреса.
   *
   * Сервис проверяет только пару «приз ↔ участник», поэтому подделанный или
   * устаревший запрос сменил бы победителя в **чужом** конкурсе, записал бы
   * это в его журнал — а человек остался бы на странице своего конкурса с
   * зелёным «Победитель заменён» и без единого следа правки на экране.
   */
  private async prizeBelongsToContest(
    contestId: string,
    prizeId: string,
  ): Promise<boolean> {
    const prize = await this.prisma.contestPrize.findUnique({
      where: { id: prizeId },
      select: { contestId: true },
    });
    return prize?.contestId === contestId;
  }

  /**
   * Действие над конкурсом с человеческим отказом вместо общего экрана
   * ошибки. Отказ здесь — рядовое состояние, а не сбой: «розыгрыш уже
   * проведён», «участников меньше, чем мест», «менять места поздно».
   */
  private async runContestAction(
    res: Response,
    contestId: string,
    okUrl: string,
    action: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await action();
      res.redirect(okUrl);
    } catch (err: unknown) {
      this.redirectContestFailure(res, contestId, err);
    }
  }

  private redirectContestFailure(
    res: Response,
    contestId: string,
    err: unknown,
    fallback = 'Не удалось выполнить действие',
  ): void {
    this.logger.warn({ err, contestId }, 'Действие над конкурсом не выполнено');
    const reason = err instanceof AppException ? err.message : fallback;
    // Пропавший конкурс — единственный случай, когда возвращать человека на
    // его страницу нельзя: она сама ответит «не найдено», и причина отказа
    // пропадёт вместе с баннером.
    const back =
      err instanceof AppException && err.code === ErrorCode.NOT_FOUND
        ? `${PANEL_PREFIX}/contests`
        : `${PANEL_PREFIX}/contests/${contestId}`;
    res.redirect(
      `${back}?flash=contest-failed&reason=${encodeURIComponent(reason)}`,
    );
  }

  /**
   * Второй шаг подключения личного токена VK: админ вставляет адрес страницы,
   * на которой оказался после разрешения доступа. См. `parseVkAuthInput` о
   * том, почему код приходится передавать руками.
   *
   * Защита та же, что у `/vk/oauth/callback`: код принимается, только если
   * авторизация начата **в этом браузере** (кука со `state`, десять минут) и
   * `state` из вставленного текста совпадает с кукой — обязательно, даже
   * когда сам код распознан и без него. Иначе подсунутый чужой код молча
   * заменил бы загрузочный токен всего развёртывания. Форма при этом закрыта
   * CSRF-токеном, так что с чужого сайта её не отправить.
   */
  @Post('vk-token')
  @UseGuards(AdminAuthGuard, CsrfGuard)
  @RequirePermissions('groups_tokens_manage')
  async connectVkToken(
    @Body() body: { pasted?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const back = (flash: string, reason: string) =>
      this.redirectFlash(res, 'groups', flash, reason);

    const parsed = parseVkAuthInput(body.pasted ?? '');
    if (!parsed) {
      back(
        'vk-token-failed',
        'Не нашёл в тексте код авторизации. Вставьте адрес страницы целиком — из адресной строки браузера после того, как разрешили доступ.',
      );
      return;
    }
    if (parsed.kind === 'denied') {
      back('vk-token-failed', `VK не выдал доступ: ${parsed.description}`);
      return;
    }

    const expectedState = readCookie(req, VK_OAUTH_STATE_COOKIE);
    if (!expectedState) {
      back(
        'vk-token-failed',
        'Авторизация не была начата в этом браузере или прошло больше 10 минут. Нажмите «1. Открыть авторизацию VK» и пройдите её заново.',
      );
      return;
    }
    // `state` обязателен, даже если сам код распознан без него (см.
    // `parseVkAuthInput`): без него нечего сверять с кукой, а значит нечем
    // доказать, что именно этот код получен именно в этом потоке
    // авторизации, а не подсунут — та же защита, что и у
    // `/vk/oauth/callback`, где отсутствие `state` тоже отказ.
    if (parsed.state === null || parsed.state !== expectedState) {
      back(
        'vk-token-failed',
        parsed.state === null
          ? 'В скопированном тексте нет state — вставьте адрес страницы целиком, а не только код.'
          : 'Этот адрес относится к другой авторизации. Пройдите её заново, начав с кнопки «1. Открыть авторизацию VK».',
      );
      return;
    }

    try {
      const { expiresAt } = await this.vkToken.exchangeAuthorizationCode(
        parsed.code,
      );
      // Одноразовая кука своё отработала — не оставляем её лежать.
      res.clearCookie(VK_OAUTH_STATE_COOKIE);
      back('vk-token-ok', `Действует до ${formatDate(expiresAt)}`);
    } catch (err: unknown) {
      // Чужие сбои (не от самого VK и не бизнес-отказ) не глотаются —
      // тот же принцип, что и у `redirectSendFailure`: неисправность
      // инфраструктуры должна дойти до общего обработчика ошибок, а не
      // выглядеть как истёкший код.
      if (!(err instanceof VkApiError) && !(err instanceof AppException)) {
        throw err;
      }
      this.logger.warn({ err }, 'Не удалось подключить личный токен VK');
      back(
        'vk-token-failed',
        err instanceof VkApiError
          ? // Код одноразовый и недолговечный: типичная причина отказа —
            // не сбой, а то, что он уже использован или устарел.
            `${err.message}. Код одноразовый и живёт недолго: если ошибка повторяется, пройдите авторизацию заново с кнопки «1. Открыть авторизацию VK».`
          : err.message,
      );
    }
  }

  // ----- создание поста ---------------------------------------------------

  @Get('posts/new')
  @UseGuards(AdminAuthGuard)
  // Только `posts_manage`: список групп здесь — часть создания поста, а не
  // отдельная возможность. С двумя правами админ видел бы пункт меню и
  // получал 403 при каждом клике.
  @RequirePermissions('posts_manage')
  async newPost(
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Res() res: Response,
    @Query('flash') flash?: string,
  ): Promise<void> {
    // Через тот же `renderNewPost`, что и повторные показы формы: две копии
    // набора полей разошлись бы на первом же добавленном.
    await this.renderNewPost(res, req, admin, this.postDraftFrom({}), {
      flash,
    });
  }

  /**
   * Загрузка файла из multipart-формы — общее место для «Нового поста» и
   * правки опубликованного, обе грузят файл посреди себя же тем же приёмом.
   */
  private async uploadFormFile(file: Express.Multer.File): Promise<MediaAsset> {
    return this.media.upload({
      buffer: file.buffer,
      // Multer отдаёт имя в latin1; без перекодировки кириллица приезжает
      // кракозябрами — а это имя видит получатель документа.
      filename: Buffer.from(file.originalname, 'latin1').toString('utf8'),
      declaredMimeType: file.mimetype,
    });
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
    @Body() body: PostFormBody,
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Res() res: Response,
  ): Promise<void> {
    const draft = this.postDraftFrom(body);

    // Файл, выбранный в поле загрузки, но не загруженный кнопкой «Загрузить»,
    // к посту **не прикрепится**: эта форма уходит без тела файла. Молча
    // отправить пост без картинки, которую человек выбрал, нельзя — из VK его
    // потом не удалить. Поэтому отказываем и говорим, что сделать.
    const pendingFile = body.file?.trim();
    if (pendingFile) {
      await this.renderNewPost(res, req, admin, draft, {
        status: 400,
        error: `Вы выбрали файл «${pendingFile}», но не загрузили его, поэтому пост не создан. Выберите файл заново, нажмите «Загрузить», а потом отправляйте.`,
      });
      return;
    }

    let post: { id: string };
    try {
      const scheduledAt = this.parseSchedule(body.scheduledAt);
      post = await this.posts.createPost({
        text: draft.text,
        // Браузер шлёт одно значение строкой, а несколько — массивом. Без
        // приведения кампания с одной группой ушла бы с `groupIds: 'uuid'`,
        // и валидация отвергла бы её как не массив.
        groupIds: draft.groupIds,
        attachmentIds: draft.attachmentIds,
        scheduledAt,
      });
    } catch (err: unknown) {
      // Форма перерисовывается с тем, что человек набрал. Уронить его в
      // общий экран ошибки — значит потерять текст, выбор групп и
      // расписание из-за одной непоставленной галочки. Ничего не сохранено:
      // ошибка случилась до записи.
      await this.renderNewPost(res, req, admin, draft, {
        status: 400,
        error:
          err instanceof AppException ? err.message : 'Не удалось создать пост',
      });
      return;
    }

    if (body.action !== 'send') {
      res.redirect(`${PANEL_PREFIX}/campaigns?flash=draft`);
      return;
    }

    // Отправка — отдельным шагом, и отказ здесь **не** перерисовывает форму:
    // пост уже сохранён черновиком, и форма с ошибкой соблазняла бы нажать
    // «Отправить» ещё раз — то есть создать второй такой же. Человека ведут
    // на список, где черновик виден и откуда его можно отправить, когда
    // причина устранена (например, обновлён токен VK).
    try {
      await this.posts.schedulePost(post.id);
    } catch (err: unknown) {
      this.redirectSendFailure(
        res,
        err,
        'Пост сохранён черновиком — отправьте его из списка, когда причина будет устранена.',
      );
      return;
    }
    res.redirect(`${PANEL_PREFIX}/campaigns?flash=sent`);
  }

  /**
   * Отказ отправки как баннер на списке постов. Причина берётся из ошибки, а
   * для просроченного токена VK баннер получает кнопку «Обновить токен» —
   * раньше он говорил «обновите», не показывая, где и как.
   *
   * Чужие сбои (не `AppException`) не глотаются: это неисправность, а не
   * отказ по правилам, и ей место на странице ошибки.
   */
  private redirectSendFailure(
    res: Response,
    err: unknown,
    suffix?: string,
  ): void {
    if (!(err instanceof AppException)) {
      throw err;
    }
    const reason = suffix ? `${err.message}. ${suffix}` : err.message;
    const action =
      err.code === ErrorCode.VK_UPLOADER_TOKEN_EXPIRED ? 'vk-token' : undefined;
    this.redirectFlash(res, 'campaigns', 'send-failed', reason, action);
  }

  /**
   * `<страница>?flash=<вид>&reason=<причина>&action=<кнопка>` — этот адрес
   * складывали вручную в трёх местах, и он с лёгкостью может разойтись:
   * `reason` обязан идти через `encodeURIComponent` (это единственное
   * место, где в шаблон попадает строка из запроса), а `flash`/`action` —
   * всегда литералы из белого списка (`FLASHES`/`FLASH_ACTIONS`), поэтому
   * их не экранируют.
   */
  private redirectFlash(
    res: Response,
    page: string,
    flash: string,
    reason?: string,
    action?: string,
  ): void {
    let url = `${PANEL_PREFIX}/${page}?flash=${flash}`;
    if (reason) url += `&reason=${encodeURIComponent(reason)}`;
    if (action) url += `&action=${action}`;
    res.redirect(url);
  }

  private postDraftFrom(body: PostFormBody): PostDraft {
    return {
      text: body.text ?? '',
      groupIds: asArray(body.groupIds),
      attachmentIds: asArray(body.attachmentIds),
      scheduledAt: body.scheduledAt ?? '',
    };
  }

  /**
   * Карточка поста — общая для обычного показа и для повторного показа
   * после загрузки файла посреди правки опубликованного. Без общего метода
   * два места неизбежно разошлись бы в наборе полей, как уже было с формой
   * «Новый пост».
   */
  private async renderCampaign(
    res: Response,
    req: Request,
    admin: AdminUser,
    id: string,
    options: {
      status?: number;
      flash?: string;
      reason?: string;
      editDraft?: EditDraft;
      editError?: string | null;
      draftEdit?: DraftEditState;
      draftEditError?: string | null;
      dmQuery?: string;
    } = {},
  ): Promise<void> {
    // По умолчанию — то, что сейчас на посте; после загрузки файла или
    // отказа валидации вызывающий передаёт набранное в форме, чтобы не
    // потерять правки. Явный черновик не зависит от поста, и тогда пост и
    // список вложений поднимаются одним проходом, а не один за другим.
    const [post, editDraft, media] = options.editDraft
      ? await this.loadCampaignWith(id, options.editDraft)
      : await this.loadCampaignDefault(id);
    // Тот же приём, что у `editDraft` выше — набранное в форме переживает
    // перерисовку после загрузки файла или отказа валидации.
    const draftEdit = options.draftEdit ?? this.draftEditFromPost(post);
    const draftMedia = await this.mediaWithPinned(draftEdit.attachmentIds);
    // Пусто — поиск ещё не запускали, отличать от «запустили и никого не
    // нашли» (пустой массив): первое молчит, второе показывает «не нашлось».
    const dmQuery = options.dmQuery?.trim() || null;
    const [dmResults, activeGroups] = await Promise.all([
      // Только MAX: личные сообщения сейчас реально уходят только туда.
      dmQuery ? this.platformUsers.search('max', dmQuery) : null,
      this.activeGroups(),
    ]);
    // Тот же фильтр: группа VK в этом списке выглядела бы рабочим выбором,
    // а её участники молча осели бы в manual_required — воркер не может
    // слать личные сообщения через VK, только через MAX.
    const dmGroups = activeGroups.filter((group) => group.platform === 'max');
    res.status(options.status ?? 200).render('layout', {
      ...this.shell(
        req,
        'Пост',
        admin,
        'campaigns',
        options.flash,
        options.reason,
      ),
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
      editDraft,
      editError: options.editError ?? null,
      media,
      // Группы для формы правки черновика — все активные площадки, а не
      // только MAX: в отличие от рассылки в личку, обычный пост уходит и
      // в VK тоже.
      groups: activeGroups,
      draftEdit,
      draftEditError: options.draftEditError ?? null,
      draftMedia,
      dmQuery,
      dmResults,
      dmGroups,
      formatDate,
      statusColor,
      statusLabel,
      deliveryColor,
      deliveryLabel,
      mediaKindLabel,
    });
  }

  /** Черновик уже есть — пост и список вложений не зависят друг от друга. */
  private async loadCampaignWith(id: string, editDraft: EditDraft) {
    const [post, media] = await Promise.all([
      this.posts.getPostWithDeliveries(id),
      this.mediaWithPinned(editDraft.attachmentIds),
    ]);
    return [post, editDraft, media] as const;
  }

  /** Черновика нет — он строится из полей поста, и без поста его не собрать. */
  private async loadCampaignDefault(id: string) {
    const post = await this.posts.getPostWithDeliveries(id);
    const editDraft = this.editDraftFromPost(post);
    const media = await this.mediaWithPinned(editDraft.attachmentIds);
    return [post, editDraft, media] as const;
  }

  private editDraftFromPost(post: {
    text: string;
    vkTextOverride: string | null;
    maxTextOverride: string | null;
    autoDeleteAfterMinutes: number | null;
    attachments: { mediaAssetId: string }[];
  }): EditDraft {
    return {
      text: post.text,
      vkTextOverride: post.vkTextOverride ?? '',
      maxTextOverride: post.maxTextOverride ?? '',
      autoDeleteAfterMinutes:
        post.autoDeleteAfterMinutes != null
          ? String(post.autoDeleteAfterMinutes)
          : '',
      attachmentIds: post.attachments.map((a) => a.mediaAssetId),
    };
  }

  private editDraftFrom(body: EditPublishedFormBody): EditDraft {
    return {
      text: body.text ?? '',
      vkTextOverride: body.vkTextOverride ?? '',
      maxTextOverride: body.maxTextOverride ?? '',
      autoDeleteAfterMinutes: body.autoDeleteAfterMinutes ?? '',
      attachmentIds: asArray(body.attachmentIds),
    };
  }

  private draftEditFromPost(post: {
    text: string;
    vkTextOverride: string | null;
    maxTextOverride: string | null;
    scheduledAt: Date | null;
    attachments: { mediaAssetId: string }[];
    deliveries: { group: { id: string } }[];
  }): DraftEditState {
    return {
      text: post.text,
      vkTextOverride: post.vkTextOverride ?? '',
      maxTextOverride: post.maxTextOverride ?? '',
      groupIds: post.deliveries.map((d) => d.group.id),
      attachmentIds: post.attachments.map((a) => a.mediaAssetId),
      scheduledAt: post.scheduledAt
        ? utcToZoned(post.scheduledAt, this.defaultTimezone())
        : '',
    };
  }

  private draftEditFrom(body: EditDraftPostFormBody): DraftEditState {
    return {
      text: body.text ?? '',
      vkTextOverride: body.vkTextOverride ?? '',
      maxTextOverride: body.maxTextOverride ?? '',
      groupIds: asArray(body.groupIds),
      attachmentIds: asArray(body.attachmentIds),
      scheduledAt: body.scheduledAt ?? '',
    };
  }

  private async renderNewPost(
    res: Response,
    req: Request,
    admin: AdminUser,
    draft: PostDraft,
    options: { status?: number; flash?: string; error?: string | null } = {},
  ): Promise<void> {
    res.status(options.status ?? 200).render('layout', {
      ...this.shell(req, 'Новый пост', admin, 'new-post', options.flash),
      page: 'new-post',
      groups: await this.activeGroups(),
      media: await this.mediaWithPinned(draft.attachmentIds),
      draft,
      error: options.error ?? null,
    });
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

  /**
   * Картинка вместо имени файла в карточке поста и в списках вложений: имя
   * ничего не говорит о том, что на снимке, и пользователь путал файлы между
   * собой. `size=thumb` (по умолчанию) — для сеток и списков, `size=full` —
   * открыть как есть. Документы сюда не пускаются — `readPreview` сам
   * проверяет `kind` и отвечает `NOT_FOUND`, не открывая произвольный файл
   * под видом картинки.
   */
  @Get('media/:id/preview')
  @UseGuards(AdminAuthGuard)
  @RequirePermissions('posts_manage')
  async mediaPreview(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('size') size: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, mimeType } = await this.media.readPreview(
      id,
      size === 'full' ? 'full' : 'thumb',
    );
    res.set({
      'Content-Type': mimeType,
      // За гвардом входа и так, но кэшировать эти байты в общем/прокси-кэше
      // всё равно не место — только в браузере вошедшего админа.
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(buffer);
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
    @Body() body: PostFormBody,
    @Req() req: Request,
    @CurrentAdmin() admin: AdminUser,
    @Res() res: Response,
  ): Promise<void> {
    // Форма приходит целиком — со всем набранным, — и возвращается тем же:
    // раньше загрузка редиректила на пустую страницу, и текст, группы и срок
    // пропадали. Любой исход, в том числе отказ, рисуется с этим черновиком.
    const draft = this.postDraftFrom(body);

    if (!file) {
      await this.renderNewPost(res, req, admin, draft, {
        status: 400,
        error: 'Файл не выбран',
      });
      return;
    }

    let asset: MediaAsset;
    try {
      asset = await this.uploadFormFile(file);
    } catch (err: unknown) {
      if (!(err instanceof AppException)) {
        this.logger.error({ err }, 'Не удалось загрузить вложение');
      }
      await this.renderNewPost(res, req, admin, draft, {
        status: 400,
        error:
          err instanceof AppException
            ? err.message
            : 'Не удалось загрузить файл',
      });
      return;
    }

    // Отрисовка — вне `try`: сбой чтения списков после успешной загрузки не
    // должен выдаваться за сбой загрузки (файл уже сохранён, и повтор дал бы
    // копию).
    await this.renderNewPost(
      res,
      req,
      admin,
      // Новый файл отмечается сам: человек только что его выбрал, и
      // заставлять его искать и отмечать галочкой то же самое — лишний шаг,
      // на котором легко отправить пост без вложения.
      {
        ...draft,
        attachmentIds: [...new Set([...draft.attachmentIds, asset.id])],
      },
      { flash: 'uploaded' },
    );
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
      // Названия и цвета, нужные почти каждой странице (метка платформы у
      // группы встречается в шести шаблонах). Кладутся сюда, а не в каждый
      // обработчик: забытый в одном из десятка обработчиков помощник
      // превратил бы страницу в ошибку 500.
      platformLabel,
      platformColor,
      groupKindLabel,
      mediaKindLabel,
      active,
      // Значение берётся из куки: шаблон обязан положить его в скрытое поле,
      // а сторонний сайт прочитать чужую куку не может — в этом и смысл
      // double-submit.
      csrfToken: readCookie(req, CSRF_COOKIE) ?? '',
      // `Object.hasOwn`, а не прямой доступ: `?flash=constructor` вернул бы
      // унаследованное значение, и в шапке нарисовался бы пустой серый
      // баннер — ровно то, что список должен был исключить.
      flash: Object.hasOwn(FLASHES, flash ?? '') ? FLASHES[flash!] : null,
      ...this.flashAction(req, permissions),
      // Причина отказа приходит текстом в адресе, поэтому выводится
      // отдельно и **только** экранированной: это единственное место, где
      // в шаблон попадает строка из запроса.
      flashReason: typeof reason === 'string' ? reason.slice(0, 300) : null,
    };
  }

  /**
   * Кнопка в баннере — только тому, у кого есть право на само действие:
   * кнопка, ведущая в «недостаточно прав», хуже её отсутствия. Остальным
   * вместо кнопки — подсказка, к кому обратиться.
   */
  private flashAction(
    req: Request,
    permissions: Set<Permission>,
  ): {
    flashAction: { label: string; href: string } | null;
    flashHint: string | null;
  } {
    const key = typeof req.query.action === 'string' ? req.query.action : '';
    if (!Object.hasOwn(FLASH_ACTIONS, key)) {
      return { flashAction: null, flashHint: null };
    }
    const action = FLASH_ACTIONS[key];
    return permissions.has(action.permission)
      ? {
          flashAction: { label: action.label, href: action.href },
          flashHint: null,
        }
      : {
          flashAction: null,
          flashHint: 'Сделать это может только разработчик — попросите его.',
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

/**
 * Кнопки, которые баннер может показать. Ключ приходит в адресе (`?action=`),
 * поэтому, как и сами сообщения, берётся только из белого списка: подставить
 * туда произвольную ссылку через адрес нельзя.
 */
export const FLASH_ACTIONS: Record<
  string,
  { label: string; href: string; permission: Permission }
> = {
  'vk-token': {
    label: 'Обновить токен VK',
    href: '/panel/groups#vk-token',
    permission: 'groups_tokens_manage',
  },
};

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
  'template-created': { kind: 'success', message: 'Повторяющийся пост создан' },
  'template-saved': {
    kind: 'success',
    message: 'Сохранено — изменения коснутся будущих публикаций',
  },
  'template-paused': { kind: 'warning', message: 'Публикации приостановлены' },
  'template-resumed': { kind: 'success', message: 'Публикации возобновлены' },
  'template-failed': {
    kind: 'danger',
    message: 'Не удалось изменить повторяющийся пост',
  },
  'vk-token-ok': { kind: 'success', message: 'Личный токен VK подключён' },
  'vk-token-failed': {
    kind: 'danger',
    message: 'Не удалось подключить личный токен VK',
  },
  'send-failed': { kind: 'warning', message: 'Пост не отправлен' },
  'dm-sent': { kind: 'success', message: 'Рассылка в личку запущена' },
  'dm-failed': { kind: 'danger', message: 'Рассылка в личку не запущена' },
  'dm-no-selection': {
    kind: 'warning',
    message: 'Выберите получателя, группу или «всех в базе»',
  },
  'contest-created': { kind: 'success', message: 'Конкурс создан' },
  'contest-edited': { kind: 'success', message: 'Конкурс обновлён' },
  'contest-opened': { kind: 'success', message: 'Приём участников открыт' },
  'contest-drawn': { kind: 'success', message: 'Розыгрыш проведён' },
  'prizes-saved': { kind: 'success', message: 'Призовые места сохранены' },
  'participants-added': { kind: 'success', message: 'Список обработан' },
  'winner-forced': {
    kind: 'warning',
    message: 'Место закреплено за участником до розыгрыша',
  },
  'winner-replaced': { kind: 'warning', message: 'Победитель заменён' },
  'prizes-not-editable': {
    kind: 'danger',
    message:
      'Эти призовые места заведены через API и из панели не правятся — иначе сохранение перенумеровало бы их',
  },
  'no-prizes': {
    kind: 'danger',
    message: 'Впишите хотя бы одно призовое место',
  },
  'no-participants': { kind: 'danger', message: 'Список участников пуст' },
  'no-participant': { kind: 'danger', message: 'Участник не выбран' },
  'wrong-prize': {
    kind: 'danger',
    message: 'Это призовое место относится к другому конкурсу',
  },
  'contest-failed': {
    kind: 'danger',
    message: 'Действие над конкурсом не выполнено',
  },
  edited: { kind: 'success', message: 'Текст обновлён во всех группах' },
  'draft-edited': { kind: 'success', message: 'Черновик сохранён' },
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

/**
 * Призовые места из одного поля: строка — подпись, номер строки — место.
 *
 * Парой полей на место было бы точнее (API позволяет произвольные номера),
 * но добавление строк без JS означает перезагрузку страницы на каждое место,
 * а панель по замыслу работает и без него. Пустые строки выбрасываются, и
 * места нумеруются подряд: строка, случайно оставленная посередине, иначе
 * создала бы место с пустой подписью.
 */
/**
 * Номера строк-дублей для баннера. Список обрезается, потому что `shell`
 * режет причину по 300 символам: полторы сотни номеров уехали бы в адрес
 * целиком, а на экране оборвались бы посреди числа — и прочесть, какие
 * именно строки пропущены, стало бы нельзя.
 */
const MAX_SHOWN_LINES = 20;

export function formatLineNumbers(lines: number[]): string {
  if (lines.length <= MAX_SHOWN_LINES) {
    return lines.join(', ');
  }
  const shown = lines.slice(0, MAX_SHOWN_LINES).join(', ');
  return `${shown} и ещё ${lines.length - MAX_SHOWN_LINES}`;
}

export function parsePrizes(
  value: string | undefined,
): { place: number; label: string }[] {
  return (value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((label, index) => ({ place: index + 1, label }));
}

function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
