import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { PrismaService } from '../prisma/prisma.service';
import { Post, PostDeliveryStatus } from '../generated/prisma/client';
import { VkUploaderTokenService } from '../vk/vk-uploader-token.service';
import {
  DispatchPostJob,
  JOB_DISPATCH_POST,
  POST_DELIVERY_QUEUE,
  dispatchJobId,
} from '../queue/queue.constants';

/** Statuses a delivery can still move on from — the campaign isn't finished while any exist. */
const IN_FLIGHT: PostDeliveryStatus[] = ['pending', 'sending'];

/**
 * Dispatch retries: the fan-out is idempotent, so a transient failure is worth
 * re-attempting rather than waiting on the reconciler.
 */
const DISPATCH_ATTEMPTS = 3;
const DISPATCH_BACKOFF_MS = 2_000;

/**
 * VK's wall.post accepts at most 10 attachments. Checked at creation so the
 * campaign fails while it's still a draft, rather than after the MAX targets
 * already received it and every VK target rejects it.
 */
const MAX_ATTACHMENTS_PER_POST = 10;

/** How long a failed dispatch stays in Redis for diagnosis (seconds). */
const DISPATCH_FAILURE_RETENTION_S = 24 * 60 * 60;

/** What "Отправить оставшимся" picks up: everything that didn't get through. */
const RESUMABLE: PostDeliveryStatus[] = ['failed', 'skipped_by_stop'];

export interface CampaignSummary {
  id: string;
  text: string;
  status: Post['status'];
  createdAt: Date;
  scheduledAt: Date | null;
  /** Всего целевых групп в кампании. */
  total: number;
  sent: number;
  failed: number;
  /** Ещё в работе: `pending` плюс `sending`. */
  pending: number;
  skipped: number;
  unknown: number;
}

export interface CreatePostInput {
  text: string;
  vkTextOverride?: string;
  maxTextOverride?: string;
  groupIds: string[];
  /** Files to attach, in the order they should appear. */
  attachmentIds?: string[];
  scheduledAt?: Date;
}

@Injectable()
export class PostsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(POST_DELIVERY_QUEUE) private readonly queue: Queue,
    private readonly vkUploaderToken: VkUploaderTokenService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PostsService.name);
  }

  /**
   * Creates the campaign together with one PostDelivery per target.
   *
   * Those rows *are* the frozen target list PLAN.md calls for: a group added
   * to a tag afterwards doesn't join a campaign that was already planned.
   * Writing them now, rather than when sending starts, also means the admin
   * sees exactly who will receive the post before it goes anywhere.
   */
  async createPost(input: CreatePostInput): Promise<Post> {
    const groupIds = [...new Set(input.groupIds)];
    await this.assertGroupsUsable(groupIds);

    const attachmentIds = input.attachmentIds ?? [];
    await this.assertAttachmentsUsable(attachmentIds);

    return this.prisma.post.create({
      data: {
        text: input.text,
        vkTextOverride: input.vkTextOverride,
        maxTextOverride: input.maxTextOverride,
        scheduledAt: input.scheduledAt,
        status: 'draft',
        deliveries: {
          create: groupIds.map((groupId) => ({ groupId })),
        },
        attachments: {
          // Position is stored explicitly: the order attachments appear in is
          // part of the post, not an accident of row ordering.
          create: attachmentIds.map((mediaAssetId, position) => ({
            mediaAssetId,
            position,
          })),
        },
      },
    });
  }

  /**
   * Target checks shared with recurring templates.
   *
   * A template pointed at a group that already can't receive posts looks
   * configured and never publishes: every firing skips it with a warning
   * nobody reads. Its target list stays editable, so the group can be added
   * back once it recovers.
   */
  async assertGroupsUsable(groupIds: string[]): Promise<void> {
    if (groupIds.length === 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Нужно выбрать хотя бы одну группу',
      );
    }
    const groups = await this.prisma.group.findMany({
      where: { id: { in: groupIds } },
      select: { id: true, status: true, title: true },
    });
    if (groups.length !== groupIds.length) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Часть групп не найдена');
    }
    const unusable = groups.filter((group) => group.status !== 'active');
    if (unusable.length > 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        `Группы недоступны для рассылки: ${unusable.map((g) => g.title).join(', ')}`,
      );
    }
  }

  /**
   * Attachment checks shared with recurring templates.
   *
   * Living in one place matters most for templates: a template that slips past
   * the VK limit doesn't fail once, it produces a broken occurrence on every
   * firing, for as long as the schedule runs.
   */
  async assertAttachmentsUsable(attachmentIds: string[]): Promise<void> {
    if (attachmentIds.length > MAX_ATTACHMENTS_PER_POST) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        `VK принимает не больше ${MAX_ATTACHMENTS_PER_POST} вложений в посте`,
      );
    }
    if (attachmentIds.length !== new Set(attachmentIds).size) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Один и тот же файл указан во вложениях дважды',
      );
    }
    if (attachmentIds.length === 0) {
      return;
    }
    const found = await this.prisma.mediaAsset.count({
      where: { id: { in: attachmentIds } },
    });
    if (found !== attachmentIds.length) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Часть файлов не найдена');
    }
  }

  /**
   * Hands the campaign to the queue: immediately, or at `scheduledAt`.
   *
   * Postgres stays the source of truth — the delayed job is only a cache of
   * the `scheduledAt` already stored here, and the reconciler rebuilds it if
   * Redis loses it.
   */
  async schedulePost(id: string, now: Date = new Date()): Promise<Post> {
    const post = await this.findOrThrow(id);
    if (post.status !== 'draft') {
      throw new AppException(
        ErrorCode.REQUEST_ERROR,
        `Пост нельзя запланировать из статуса «${post.status}»`,
      );
    }

    await this.assertVkAttachmentsUploadable(id);

    const updated = await this.prisma.post.update({
      where: { id },
      data: { status: 'scheduled' },
    });
    // The status is committed before the job is queued, and deliberately not
    // rolled back if queueing fails: the post then sits in `scheduled` with no
    // job, which is exactly what the reconciler looks for and repairs. The
    // reverse order would be worse — a queued job whose `add` response was
    // lost would fire against a post still marked `draft`. (Observed for real
    // in Step 6a: a failing `add` left this post recoverable, and the
    // reconciler delivered it on the next start.)
    await this.enqueueDispatch(updated, now);
    return updated;
  }

  /**
   * Adds the dispatch job. The stable job id keeps this idempotent, but BullMQ
   * also refuses to reuse an id still held by a *finished* job — so a previous
   * run left in `failed` would silently swallow the new request. Clearing a
   * finished job first is what makes "отправить оставшимся" work after a
   * dispatch failure.
   */
  async enqueueDispatch(post: Post, now: Date = new Date()): Promise<void> {
    const delay = post.scheduledAt
      ? Math.max(0, post.scheduledAt.getTime() - now.getTime())
      : 0;

    const existing = await this.queue.getJob(dispatchJobId(post.id));
    if (existing && (await existing.isCompleted().catch(() => false))) {
      await existing.remove().catch(() => undefined);
    } else if (existing && (await existing.isFailed().catch(() => false))) {
      await existing.remove().catch(() => undefined);
    }

    await this.queue.add(
      JOB_DISPATCH_POST,
      { postId: post.id } satisfies DispatchPostJob,
      {
        jobId: dispatchJobId(post.id),
        delay,
        // Dispatch is idempotent — it re-reads the pending rows and queues
        // them under stable ids — so retrying is free of side effects. Without
        // attempts a single blip (one failing `add` inside the fan-out, a
        // database hiccup) would kill the fan-out outright and leave recovery
        // to the reconciler up to a minute later.
        attempts: DISPATCH_ATTEMPTS,
        backoff: { type: 'exponential', delay: DISPATCH_BACKOFF_MS },
        removeOnComplete: true,
        // Failures are kept for diagnosis, but only for a while. `false` would
        // keep them forever, and there is a case nothing ever cleans up: a
        // dispatch that fails *after* queueing every delivery leaves no
        // pending rows, so the campaign finishes normally, no one re-dispatches
        // that post, and the cleanup below never runs for it.
        removeOnFail: { age: DISPATCH_FAILURE_RETENTION_S, count: 200 },
      },
    );
  }

  /**
   * Requests a stop. Deliveries not started yet are marked immediately, so a
   * job that runs before the queue is drained finds a non-pending row and
   * skips. Removing the queued jobs as well only makes it quicker.
   */
  async stopPost(id: string): Promise<Post> {
    const post = await this.findOrThrow(id);
    if (post.status !== 'sending' && post.status !== 'scheduled') {
      throw new AppException(
        ErrorCode.REQUEST_ERROR,
        `Нечего останавливать: пост в статусе «${post.status}»`,
      );
    }

    await this.prisma.$transaction([
      this.prisma.post.update({
        where: { id },
        data: { stopRequested: true },
      }),
      this.prisma.postDelivery.updateMany({
        where: { postId: id, status: 'pending' },
        data: { status: 'skipped_by_stop' },
      }),
    ]);

    await this.removeQueuedJobsForPost(id);
    return this.finalizeIfComplete(id);
  }

  /**
   * "Отправить оставшимся": re-runs only what didn't get through, on the
   * post's current content (edits made meanwhile therefore apply). No new
   * campaign is created — the same one continues.
   *
   * `unknown` deliveries are pointedly excluded: nobody knows whether those
   * were published, so resending could duplicate. They are resolved by hand.
   */
  async resumePost(id: string): Promise<Post> {
    const post = await this.findOrThrow(id);
    const resumable = await this.prisma.postDelivery.findMany({
      where: { postId: id, status: { in: RESUMABLE } },
      select: { id: true },
    });
    if (resumable.length === 0) {
      throw new AppException(
        ErrorCode.REQUEST_ERROR,
        'Нет доставок, которые можно отправить повторно',
      );
    }

    // Same gate as scheduling, and checked *before* anything is written:
    // without it a resume answers 200, flips the post to `sending`, and the
    // dispatch job then quietly returns — leaving the reconciler to re-offer
    // the campaign every minute while the admin sees no sign of the problem.
    // The statuses examined are the ones about to be resumed, since they are
    // not `pending` yet.
    await this.assertVkAttachmentsUploadable(id, RESUMABLE);

    await this.prisma.$transaction([
      this.prisma.postDelivery.updateMany({
        where: { postId: id, status: { in: RESUMABLE } },
        data: { status: 'pending', error: null },
      }),
      this.prisma.post.update({
        where: { id },
        data: { status: 'sending', stopRequested: false },
      }),
    ]);

    await this.enqueueDispatch({ ...post, scheduledAt: null });
    return this.findOrThrow(id);
  }

  /**
   * True when publishing this campaign needs the personal VK uploader token:
   * it has attachments and at least one VK target still to deliver to. MAX
   * uploads use the bot token and are unaffected.
   */
  async requiresVkUploaderToken(
    postId: string,
    statuses: PostDeliveryStatus[] = ['pending'],
  ): Promise<boolean> {
    const attachments = await this.prisma.postAttachment.findMany({
      where: { postId },
      select: { mediaAssetId: true },
    });
    // Answered without touching deliveries at all in the common case: a
    // text-only campaign never needs the uploader token.
    if (attachments.length === 0) {
      return false;
    }
    const vkTargets = await this.prisma.postDelivery.findMany({
      where: {
        postId,
        status: { in: statuses },
        group: { platform: 'vk' },
      },
      select: { groupId: true },
    });
    return this.needsVkUpload(
      attachments.map((a) => a.mediaAssetId),
      vkTargets.map((t) => t.groupId),
    );
  }

  /**
   * Which of these VK groups this post can actually reach right now — all of
   * them when the personal token is alive, and otherwise only those whose
   * files are already uploaded into them.
   *
   * A recurring template needs this *before* it creates an occurrence: creating
   * one and letting the processor discover the expired token would leave it
   * parked in `scheduled`, and every further firing would park another — until
   * re-authorization released a week of them into real communities at once.
   * That is exactly what `nextRunAfter`'s "never replay missed windows" rule
   * exists to prevent, and nothing can undo it while VK's wall.delete is
   * unavailable.
   */
  async publishableVkGroups(
    mediaAssetIds: string[],
    vkGroupIds: string[],
  ): Promise<string[]> {
    if (mediaAssetIds.length === 0 || vkGroupIds.length === 0) {
      return vkGroupIds;
    }
    if (await this.vkUploaderToken.isUsable()) {
      return vkGroupIds;
    }
    // Answered per group, not for the set. `needsVkUpload` asks the aggregate
    // question — "is any (file, group) pair still uncached" — which is the
    // right question for one campaign but the wrong one here: a template that
    // has been running for a month has every pair cached, and adding one new
    // VK group would otherwise drop the established groups too. Their files
    // are already on VK's side and need no token at all, which is the whole
    // point of the cache.
    const assetIds = [...new Set(mediaAssetIds)];
    const cached = await this.prisma.mediaPlatformUpload.findMany({
      where: {
        platform: 'vk',
        mediaAssetId: { in: assetIds },
        scope: { in: vkGroupIds },
      },
      select: { scope: true, mediaAssetId: true },
    });
    const cachedPerGroup = new Map<string, Set<string>>();
    for (const row of cached) {
      const forGroup = cachedPerGroup.get(row.scope) ?? new Set<string>();
      forGroup.add(row.mediaAssetId);
      cachedPerGroup.set(row.scope, forGroup);
    }
    return vkGroupIds.filter(
      (groupId) => cachedPerGroup.get(groupId)?.size === assetIds.length,
    );
  }

  private async needsVkUpload(
    mediaAssetIds: string[],
    vkGroupIds: string[],
  ): Promise<boolean> {
    if (mediaAssetIds.length === 0 || vkGroupIds.length === 0) {
      return false;
    }

    // Files already uploaded into those communities need no token at all —
    // and that is precisely the "отправить оставшимся" case, where a campaign
    // is resumed a day later with everything already uploaded and the
    // 24-hour token long gone. Counting cached references keeps that working
    // instead of refusing a campaign that has nothing left to upload.
    const cached = await this.prisma.mediaPlatformUpload.count({
      where: {
        platform: 'vk',
        mediaAssetId: { in: mediaAssetIds },
        scope: { in: vkGroupIds },
      },
    });
    return cached < mediaAssetIds.length * vkGroupIds.length;
  }

  /**
   * Refuses to start a campaign whose attachments can't be uploaded.
   *
   * VK issues no refresh_token, so an expired uploader token is renewed only
   * by the admin re-authorizing. Discovering that halfway through means some
   * communities already have the post and the rest don't — a state nobody
   * asked for. Better to say so before anything is published.
   */
  private async assertVkAttachmentsUploadable(
    postId: string,
    statuses?: PostDeliveryStatus[],
  ): Promise<void> {
    if (!(await this.requiresVkUploaderToken(postId, statuses))) {
      return;
    }
    if (await this.vkUploaderToken.isUsable()) {
      return;
    }
    throw new AppException(
      ErrorCode.VK_UPLOADER_TOKEN_EXPIRED,
      'Личный VK-токен для загрузки вложений истёк — обновите его, иначе пост с вложениями не опубликуется',
      undefined,
      { reauthorizeUrl: '/vk/oauth/authorize' },
    );
  }

  /**
   * Re-runs dispatch for a campaign that still has `pending` deliveries.
   *
   * Used by the reconciler to rescue a campaign whose fan-out was interrupted:
   * the dispatch job accepts a post already in `sending`, so it simply queues
   * whatever is still pending. Does nothing when there is nothing pending, so
   * a healthy campaign isn't disturbed by every sweep.
   */
  async redispatchPending(id: string): Promise<boolean> {
    const pending = await this.prisma.postDelivery.count({
      where: { postId: id, status: 'pending' },
    });
    if (pending === 0) {
      return false;
    }
    const post = await this.findOrThrow(id);
    await this.enqueueDispatch({ ...post, scheduledAt: null });
    return true;
  }

  /**
   * Recomputes the campaign status once nothing is in flight.
   *
   * `stopped` outranks `partially_failed`: if the admin stopped the campaign,
   * that is what explains the missing deliveries, and reporting it as a
   * failure would misattribute their own decision to a fault. PLAN.md lists
   * both statuses but not their precedence — this is where it's decided.
   *
   * Safe to run concurrently: several deliveries finishing at once all
   * compute the same answer from the same rows.
   */
  async finalizeIfComplete(postId: string): Promise<Post> {
    const counts = await this.prisma.postDelivery.groupBy({
      by: ['status'],
      where: { postId },
      _count: { _all: true },
    });
    const countOf = (status: PostDeliveryStatus) =>
      counts.find((row) => row.status === status)?._count._all ?? 0;

    const stillGoing = IN_FLIGHT.some((status) => countOf(status) > 0);
    if (stillGoing) {
      return this.findOrThrow(postId);
    }

    const status = countOf('skipped_by_stop')
      ? 'stopped'
      : countOf('failed') || countOf('unknown')
        ? 'partially_failed'
        : 'sent';

    return this.prisma.post.update({ where: { id: postId }, data: { status } });
  }

  /** Campaign plus its per-group delivery rows — the status view the panel will render. */
  async getPostWithDeliveries(id: string) {
    const post = await this.prisma.post.findUnique({
      where: { id },
      include: {
        deliveries: {
          orderBy: { group: { title: 'asc' } },
          select: {
            id: true,
            status: true,
            externalMessageId: true,
            error: true,
            sentAt: true,
            attemptsMade: true,
            // Панели нужно показать, что с опубликованным сообщением стало
            // дальше: удалено руками, удалится само или висит как есть.
            deletedAt: true,
            autoDeleteDueAt: true,
            group: { select: { id: true, title: true, platform: true } },
          },
        },
        attachments: {
          orderBy: { position: 'asc' },
          include: { mediaAsset: { select: { id: true, filename: true } } },
        },
      },
    });
    if (!post) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Пост не найден');
    }
    // The same guard `findOrThrow` applies, for the same reason: without it
    // `GET /posts/<templateId>` rendered a template as an ordinary campaign —
    // a draft with no targets — and the panel offered "Запланировать" on it,
    // which then 400s. Half a guard is worse than none: it invites the click.
    if (post.recurrenceRule) {
      throw new AppException(
        ErrorCode.REQUEST_ERROR,
        'Это повторяющийся шаблон — им управляют через /post-templates',
      );
    }
    return post;
  }

  /**
   * Drops the dispatch job so a campaign stopped before it fans out doesn't
   * fan out at all. Individual `deliver` jobs already queued are left alone on
   * purpose: each re-reads its row and finds it no longer `pending`, so it
   * exits without calling the platform. Hunting them down in the queue would
   * mean scanning it on every stop, to save work the jobs skip anyway.
   */
  private async removeQueuedJobsForPost(postId: string): Promise<void> {
    try {
      const dispatch = await this.queue.getJob(dispatchJobId(postId));
      // A job already running can't be removed; that's fine, since dispatch
      // re-checks stopRequested before enqueueing anything.
      await dispatch?.remove().catch(() => undefined);
    } catch (err: unknown) {
      this.logger.warn(
        { err, postId },
        'Не удалось снять джобы поста из очереди — остановка сработает по флагу',
      );
    }
  }

  /**
   * Список кампаний для панели: статус и прогресс по группам.
   *
   * Счётчики считаются в базе группировкой, а не выгрузкой всех доставок:
   * кампания на сотню групп иначе тянула бы сотню строк ради пяти чисел, и
   * список постов рос бы в памяти вместе с историей рассылок.
   *
   * Повторяющиеся шаблоны сюда не попадают — они живут своим списком, как и
   * везде в проекте.
   */
  async listCampaigns(limit = 50): Promise<CampaignSummary[]> {
    const posts = await this.prisma.post.findMany({
      where: { recurrenceRule: null },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    if (posts.length === 0) {
      return [];
    }

    const counts = await this.prisma.postDelivery.groupBy({
      by: ['postId', 'status'],
      where: { postId: { in: posts.map((post) => post.id) } },
      _count: { _all: true },
    });

    const byPost = new Map<string, Record<string, number>>();
    for (const row of counts) {
      const bucket = byPost.get(row.postId) ?? {};
      bucket[row.status] = row._count._all;
      byPost.set(row.postId, bucket);
    }

    return posts.map((post) => {
      const bucket = byPost.get(post.id) ?? {};
      const total = Object.values(bucket).reduce((sum, n) => sum + n, 0);
      return {
        id: post.id,
        text: post.text,
        status: post.status,
        createdAt: post.createdAt,
        scheduledAt: post.scheduledAt,
        total,
        sent: bucket.sent ?? 0,
        failed: bucket.failed ?? 0,
        pending: (bucket.pending ?? 0) + (bucket.sending ?? 0),
        skipped: bucket.skipped_by_stop ?? 0,
        unknown: bucket.unknown ?? 0,
      };
    });
  }

  /**
   * A campaign by id — never a recurring template.
   *
   * A template is stored as a `Post` too, and it is created `draft`, so
   * `POST /posts/<templateId>/schedule` used to sail through the status gate:
   * the template flipped to `scheduled`, dispatch found zero deliveries and
   * `finalizeIfComplete` settled it as `sent` — while it happily kept firing on
   * schedule. `stopPost` likewise set `stopRequested` on a row nothing on the
   * template path ever reads. The reconciler already excludes templates from
   * its recovery queries; the same exclusion belongs here, at the entry point.
   * Occurrences carry `recurringTemplateId`, not `recurrenceRule`, so they pass.
   */
  private async findOrThrow(id: string): Promise<Post> {
    const post = await this.prisma.post.findUnique({ where: { id } });
    if (!post) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Пост не найден');
    }
    if (post.recurrenceRule) {
      throw new AppException(
        ErrorCode.REQUEST_ERROR,
        'Это повторяющийся шаблон — им управляют через /post-templates',
      );
    }
    return post;
  }
}
