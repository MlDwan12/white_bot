import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { DelayedError, Job, Queue, UnrecoverableError } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { GroupRateLimiter } from '../queue/group-rate-limiter';
import {
  DeliverJob,
  DispatchPostJob,
  JOB_DELIVER,
  JOB_DISPATCH_POST,
  POST_DELIVERY_QUEUE,
  deliverJobId,
} from '../queue/queue.constants';
import { PostsService } from './posts.service';
import { PostSender } from './post-sender';
import { classifyDeliveryError } from './delivery-outcome';

/**
 * How many times a rate-limited delivery is re-attempted. Only rate limits get
 * here at all (see classifyDeliveryError), and those resolve by waiting.
 */
const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 5_000;

/**
 * Executes the campaign: `dispatch-post` fans a campaign out into per-group
 * jobs, `deliver` performs exactly one of them.
 *
 * One job per group, because the groups are independent — a failure in one
 * must not abandon the rest, and each needs its own retry count and its own
 * rate-limit budget.
 */
@Processor(POST_DELIVERY_QUEUE, {
  // Groups are independent, so several can be in flight at once; pacing within
  // a group is the rate limiter's job, not this number's.
  concurrency: 5,
})
export class PostDeliveryProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posts: PostsService,
    private readonly sender: PostSender,
    private readonly rateLimiter: GroupRateLimiter,
    @InjectQueue(POST_DELIVERY_QUEUE) private readonly queue: Queue,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(PostDeliveryProcessor.name);
  }

  async process(job: Job<DispatchPostJob | DeliverJob>): Promise<void> {
    if (job.name === JOB_DISPATCH_POST) {
      return this.dispatch((job as Job<DispatchPostJob>).data.postId);
    }
    if (job.name === JOB_DELIVER) {
      return this.deliver(job as Job<DeliverJob>);
    }
    // An unknown job name is a bug, not a transient fault — retrying it would
    // just spin.
    throw new UnrecoverableError(`Неизвестный тип джоба: ${job.name}`);
  }

  private async dispatch(postId: string): Promise<void> {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post) {
      this.logger.warn({ postId }, 'Пост исчез до начала рассылки');
      return;
    }
    if (post.stopRequested) {
      this.logger.info({ postId }, 'Рассылка остановлена до начала — пропуск');
      return;
    }
    if (post.status !== 'scheduled' && post.status !== 'sending') {
      this.logger.warn(
        { postId, status: post.status },
        'Пост не в состоянии рассылки — пропуск',
      );
      return;
    }

    await this.prisma.post.update({
      where: { id: postId },
      data: { status: 'sending' },
    });

    const pending = await this.prisma.postDelivery.findMany({
      where: { postId, status: 'pending' },
      select: { id: true },
    });

    await Promise.all(
      pending.map((delivery) => this.enqueueDelivery(delivery.id)),
    );

    // A campaign with nothing left to send (every target already resolved)
    // must still reach a terminal status.
    await this.posts.finalizeIfComplete(postId);
  }

  /**
   * Queues one delivery under a stable job id.
   *
   * BullMQ refuses to add a job whose custom id already exists — including an
   * id still held by a *finished* job. Keeping failures around would therefore
   * make a delivery permanently un-enqueueable: every later dispatch would
   * silently no-op, the row would stay `pending`, and the campaign would never
   * leave `sending` (a `pending` row is neither resumable nor swept). Failures
   * are dropped from Redis because the reason for one is stored on the
   * delivery row itself, where the admin actually reads it.
   *
   * A job still *running* under this id can't be removed, so the add is
   * ignored and the row stays `pending`. That resolves itself: the running job
   * finishes and — completed or failed — is removed, and the reconciler's next
   * sweep re-dispatches the still-pending row against a now-free id.
   */
  private async enqueueDelivery(deliveryId: string): Promise<void> {
    const jobId = deliverJobId(deliveryId);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const finished = await Promise.all([
        existing.isCompleted().catch(() => false),
        existing.isFailed().catch(() => false),
      ]);
      if (finished.some(Boolean)) {
        await existing.remove().catch(() => undefined);
      }
    }

    await this.queue.add(JOB_DELIVER, { deliveryId } satisfies DeliverJob, {
      jobId,
      attempts: RETRY_ATTEMPTS,
      backoff: { type: 'exponential', delay: RETRY_BACKOFF_MS },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  private async deliver(job: Job<DeliverJob>): Promise<void> {
    const { deliveryId } = job.data;
    const delivery = await this.prisma.postDelivery.findUnique({
      where: { id: deliveryId },
      include: { post: true, group: true },
    });
    if (!delivery) {
      this.logger.warn({ deliveryId }, 'Доставка исчезла — пропуск');
      return;
    }

    // Re-read rather than trust the job: the row is the authority on whether
    // this delivery still needs doing. A stop marks it `skipped_by_stop`, and
    // a duplicate job finds it already `sent`.
    if (delivery.status !== 'pending') {
      this.logger.info(
        { deliveryId, status: delivery.status },
        'Доставка уже не в статусе pending — пропуск',
      );
      return;
    }
    if (delivery.post.stopRequested) {
      await this.prisma.postDelivery.update({
        where: { id: deliveryId },
        data: { status: 'skipped_by_stop' },
      });
      await this.safeFinalize(delivery.postId);
      return;
    }

    const slot = await this.rateLimiter.reserve(
      delivery.groupId,
      delivery.group.platform,
    );
    if (!slot.acquired) {
      // Nothing was consumed, so the job can come back later without having
      // burned a slot. `DelayedError` tells BullMQ this isn't a failed attempt.
      await job.moveToDelayed(Date.now() + slot.waitMs, job.token);
      throw new DelayedError();
    }
    if (slot.waitMs > 0) {
      await sleep(slot.waitMs);
    }

    // Committed *before* the network call, so a worker that dies mid-flight
    // leaves evidence: the reconciler later moves a stuck `sending` row to
    // `unknown` rather than retrying it into a possible duplicate post.
    await this.prisma.postDelivery.update({
      where: { id: deliveryId },
      data: { status: 'sending', attemptsMade: { increment: 1 } },
    });

    // Only the platform call is guarded here. Recording the *result* must be
    // outside: a database hiccup while writing "sent" would otherwise be
    // classified as a plain error ("never reached the network, so nothing was
    // published") and mark the row `failed` — which "отправить оставшимся"
    // happily republishes, producing exactly the duplicate this whole design
    // exists to prevent.
    let externalMessageId: string;
    try {
      ({ externalMessageId } = await this.sender.send(
        delivery.post,
        delivery.group,
      ));
    } catch (err: unknown) {
      await this.handleDeliveryError(job, deliveryId, delivery.groupId, err);
      await this.safeFinalize(delivery.postId);
      return;
    }

    // Past this line the post exists on the platform. Nothing below may throw
    // out of this job: a thrown error would be a failed attempt, and BullMQ
    // would retry it into a second publication.
    try {
      await this.prisma.postDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'sent',
          externalMessageId,
          sentAt: new Date(),
          error: null,
        },
      });
    } catch (err: unknown) {
      this.logger.error(
        { err, deliveryId, externalMessageId },
        'Пост опубликован, но результат не записан в БД',
      );
      await this.markUnknownAfterPublish(deliveryId, externalMessageId);
    }

    await this.safeFinalize(delivery.postId);
  }

  /**
   * Recomputing the campaign status must never fail the job. A throw here
   * would count as a failed attempt and BullMQ would run the delivery again;
   * the row's own status guard would stop a second publication, but the retry
   * is pure noise, and on the success path the status has already been
   * written.
   */
  private async safeFinalize(postId: string): Promise<void> {
    try {
      await this.posts.finalizeIfComplete(postId);
    } catch (err: unknown) {
      this.logger.error(
        { err, postId },
        'Не удалось пересчитать статус кампании',
      );
    }
  }

  /**
   * Last resort after a successful publish whose result couldn't be stored.
   * `unknown` is the honest state: the post is out there, but we may have lost
   * its id, so it must never be resent automatically. If even this write
   * fails, the row stays in `sending` and the reconciler's stuck sweep turns
   * it into `unknown` a few minutes later — the same destination, slower.
   */
  private async markUnknownAfterPublish(
    deliveryId: string,
    externalMessageId: string,
  ): Promise<void> {
    try {
      await this.prisma.postDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'unknown',
          externalMessageId,
          error:
            'Пост опубликован, но запись результата не удалась. Проверьте группу вручную.',
        },
      });
    } catch (err: unknown) {
      this.logger.error(
        { err, deliveryId },
        'Не удалось пометить доставку как unknown — останется на сверщике',
      );
    }
  }

  private async handleDeliveryError(
    job: Job<DeliverJob>,
    deliveryId: string,
    groupId: string,
    err: unknown,
  ): Promise<void> {
    const outcome = classifyDeliveryError(err);
    const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

    if (outcome.kind === 'retryable' && !isLastAttempt) {
      // Back to `pending` so the retry passes the status guard above. The
      // thrown error is what asks BullMQ for another attempt.
      await this.prisma.postDelivery.update({
        where: { id: deliveryId },
        data: { status: 'pending', error: outcome.message },
      });
      throw err;
    }

    const status =
      outcome.kind === 'ambiguous' ? ('unknown' as const) : ('failed' as const);
    await this.prisma.postDelivery.update({
      where: { id: deliveryId },
      data: { status, error: outcome.message },
    });

    if (outcome.kind === 'permanent' && outcome.groupProblem) {
      // PLAN.md: an auth/access failure disables the group rather than being
      // retried, so the next campaign doesn't repeat it against a dead token.
      await this.prisma.group.update({
        where: { id: groupId },
        data: { status: outcome.groupProblem },
      });
    }

    this.logger.warn(
      { deliveryId, groupId, outcome: outcome.kind, err },
      'Доставка не выполнена',
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
