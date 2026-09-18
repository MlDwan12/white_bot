import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';
import { PrismaService } from '../prisma/prisma.service';
import { Post, PostDeliveryStatus } from '../generated/prisma/client';
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

/** How long a failed dispatch stays in Redis for diagnosis (seconds). */
const DISPATCH_FAILURE_RETENTION_S = 24 * 60 * 60;

/** What "Отправить оставшимся" picks up: everything that didn't get through. */
const RESUMABLE: PostDeliveryStatus[] = ['failed', 'skipped_by_stop'];

export interface CreatePostInput {
  text: string;
  vkTextOverride?: string;
  maxTextOverride?: string;
  groupIds: string[];
  scheduledAt?: Date;
}

@Injectable()
export class PostsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(POST_DELIVERY_QUEUE) private readonly queue: Queue,
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
      },
    });
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
          select: {
            id: true,
            status: true,
            externalMessageId: true,
            error: true,
            sentAt: true,
            attemptsMade: true,
            group: { select: { id: true, title: true, platform: true } },
          },
        },
      },
    });
    if (!post) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Пост не найден');
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

  private async findOrThrow(id: string): Promise<Post> {
    const post = await this.prisma.post.findUnique({ where: { id } });
    if (!post) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Пост не найден');
    }
    return post;
  }
}
