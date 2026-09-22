import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../queue/queue.constants';
import { PostsService } from './posts.service';
import { PostTemplatesService } from './post-templates.service';
import { PostModerationService } from './post-moderation.service';
import { ContestsService } from '../contests/contests.service';

const SWEEP_INTERVAL_MS = 60_000;

/**
 * Small delay before the first sweep. Starting it inside the bootstrap hook
 * raced with shutdown: an app stopped moments after booting (every e2e run,
 * and any fast restart) tore the Redis client and Prisma pool out from under a
 * sweep already in flight, which at best logged noise and at worst left a
 * command hanging so the process never exited. A cancellable timer means a
 * short-lived app simply never sweeps, and a real one is only a second late.
 */
const INITIAL_SWEEP_DELAY_MS = 1_000;

/**
 * How far ahead a scheduled post is handed to the queue. Anything further out
 * is picked up by a later sweep, so a long-dated campaign doesn't sit in Redis
 * for weeks where a flush would lose it.
 */
const SCHEDULE_HORIZON_MS = 15 * 60_000;

/**
 * A delivery still `sending` after this long belongs to a worker that died:
 * a real call is bounded by the clients' own 10s timeouts, so minutes here
 * mean nobody is coming back for it.
 */
const STUCK_SENDING_MS = 5 * 60_000;

const LOCK_KEY = 'lock:post-reconciler';
const LOCK_TTL_MS = 30_000;

/**
 * Keeps the queue in step with the database.
 *
 * Postgres holds the schedule; Redis only caches it as delayed jobs. This
 * closes the gap between them: recurring templates whose time has come are
 * fired, campaigns whose job was lost (or whose time passed while the app was
 * down) get re-queued, and deliveries abandoned mid-flight are resolved.
 * Contests due to open or be drawn (by `startsAt`/`endsAt`) ride the same
 * sweep for the reason in the comment above `openDueContests`.
 *
 * Runs behind a Redis lock so that adding a second app instance later doesn't
 * produce two reconcilers racing over the same rows.
 */
@Injectable()
export class PostReconcilerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private timer?: NodeJS.Timeout;
  private initialTimer?: NodeJS.Timeout;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly posts: PostsService,
    private readonly templates: PostTemplatesService,
    private readonly moderation: PostModerationService,
    private readonly contests: ContestsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PostReconcilerService.name);
  }

  onApplicationBootstrap(): void {
    // The first sweep matters most — it's what catches up schedules missed
    // while the app was down — but it is deferred so that shutting down
    // immediately cancels it instead of racing it.
    this.initialTimer = setTimeout(
      () => void this.runSweep(),
      INITIAL_SWEEP_DELAY_MS,
    );
    this.timer = setInterval(() => void this.runSweep(), SWEEP_INTERVAL_MS);
    // Don't hold the event loop open purely for the sweep timers.
    this.initialTimer.unref();
    this.timer.unref();
  }

  /**
   * Stops future sweeps. A sweep already in flight is *not* awaited: the Redis
   * client and Prisma pool are torn down by their own shutdown hooks, so
   * waiting here can deadlock against a sweep whose next command never
   * answers. The running one is left to fail, and `runSweep` recognises a
   * failure during shutdown for what it is instead of crying error.
   */
  onApplicationShutdown(): void {
    this.stopping = true;
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = undefined;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async runSweep(now: Date = new Date()): Promise<void> {
    if (this.stopping) {
      return;
    }
    try {
      // Inside the try on purpose: this is fired from a timer with no caller
      // to catch it, and the app installs no `unhandledRejection` handler — a
      // rejecting `redis.set` (a closed connection, the shutdown race below)
      // would take the whole process down.
      const locked = await this.acquireLock();
      if (!locked) {
        return;
      }
      // Recovery first, templates last. Firing is a sequential loop with a
      // transaction and a queue.add per template, so on the first sweep after
      // an outage — when every template is due — putting it first delayed the
      // work that rescues stuck campaigns and deliveries by the whole backlog.
      // Delaying a firing is harmless by comparison, but only because `now` is
      // passed down: lateness is judged from when this sweep started, so a long
      // recovery pass cannot push a template past the grace bound that would
      // abandon its window. (Called with no argument, as it was, the default
      // `new Date()` is read *after* recovery — which is what a 12-minute
      // backlog turned into "every template is 13 minutes stale, drop them
      // all". The next window is still computed from a fresh per-template
      // clock inside the loop, so nothing regresses there.)
      await this.requeueDueScheduledPosts(now);
      await this.resolveStuckCampaigns();
      await this.resolveStuckDeliveries(now);
      // Автоудаление живёт здесь же, а не в своём таймере: один
      // планировщик, один лок, одно место отказа.
      await this.moderation.sweepAutoDeletions(now);
      // Isolated as well: its own `findMany` sits outside the per-template
      // try/catch inside it, and a failure there must not look like a failed
      // sweep.
      try {
        await this.templates.fireDueTemplates(now);
      } catch (err: unknown) {
        this.logger.error({ err }, 'Не удалось поднять повторяющиеся посты');
      }
      // Изолировано так же: конкурсы — отдельный домен, и сбой здесь не
      // должен выглядеть сбоем всей сверки постов.
      try {
        await this.contests.openDueContests(now);
        // Не только что открытые в этом проходе — любой открытый конкурс с
        // анонсом, всё ещё лежащим черновиком. Так закрывается и сегодняшнее
        // открытие (участие без публикации и публикация без участия здесь
        // не расходятся молча), и повтор для того, чей `schedulePostIfDraft`
        // упал в прошлом проходе — раньше такая связка не подхватывалась
        // больше никогда, `openDueContests` смотрит только на `draft`-статус
        // самого конкурса. Провал одной отправки не должен отменять попытку
        // для остальных в этом же проходе.
        const stuck = await this.contests.openContestsWithUnsentAnnouncement();
        for (const contest of stuck) {
          try {
            await this.posts.schedulePostIfDraft(contest.postId, now);
          } catch (err: unknown) {
            this.logger.error(
              { err, contestId: contest.id, postId: contest.postId },
              'Приём открыт, но анонс-пост отправить не удалось',
            );
          }
        }
        await this.contests.drawDueContests(now);
      } catch (err: unknown) {
        this.logger.error({ err }, 'Не удалось обработать конкурсы по датам');
      }
    } catch (err: unknown) {
      // Never rethrow: this runs on a timer with nobody to catch it, and one
      // bad sweep must not stop all later ones.
      if (this.stopping) {
        // The app is going down underneath us — expected, not a fault.
        this.logger.info({ err }, 'Сверка прервана остановкой приложения');
        return;
      }
      this.logger.error({ err }, 'Ошибка сверки постов и очереди');
    }
  }

  /**
   * Re-queues campaigns whose dispatch job is missing. `enqueueDispatch` keys
   * on a stable job id, so a post that already has its job is untouched; a
   * post whose time has passed gets a zero delay and goes at once.
   */
  private async requeueDueScheduledPosts(now: Date): Promise<void> {
    const due = await this.prisma.post.findMany({
      where: {
        status: 'scheduled',
        // Templates are excluded everywhere they could be mistaken for a
        // schedulable post: a template has no deliveries of its own, and
        // dispatching one would publish nothing while marking it `sending`
        // forever.
        recurrenceRule: null,
        OR: [
          { scheduledAt: null },
          {
            scheduledAt: { lte: new Date(now.getTime() + SCHEDULE_HORIZON_MS) },
          },
        ],
      },
    });

    for (const post of due) {
      try {
        await this.posts.enqueueDispatch(post, now);
      } catch (err: unknown) {
        this.logger.error(
          { err, postId: post.id },
          'Не удалось поставить отложенный пост в очередь',
        );
      }
    }
  }

  /**
   * Re-queues deliveries of a campaign already flipped to `sending`.
   *
   * `dispatch` marks the post `sending` before it finishes adding the
   * per-group jobs, so a crash (or a flushed Redis, which the design treats as
   * a rebuildable cache) can leave `pending` rows with no job behind them.
   * Such a campaign is invisible to every other path: it isn't `scheduled`, so
   * the requeue above skips it; its rows aren't `sending`, so the stuck sweep
   * skips them; and `pending` isn't resumable. It would sit in `sending`
   * forever. Re-adding is safe because the job id is stable and the delivery
   * re-checks its own row before sending.
   */
  private async resolveStuckCampaigns(): Promise<void> {
    const stalled = await this.prisma.post.findMany({
      where: { status: 'sending', stopRequested: false, recurrenceRule: null },
      select: { id: true },
    });

    for (const post of stalled) {
      try {
        await this.posts.redispatchPending(post.id);
      } catch (err: unknown) {
        this.logger.error(
          { err, postId: post.id },
          'Не удалось до-поставить доставки зависшей кампании',
        );
      }
    }
  }

  /**
   * Moves abandoned deliveries to `unknown` — never back to `pending`.
   *
   * The row was committed as `sending` before the platform call, so there's no
   * way to tell whether the post went out before the worker died. Retrying
   * could publish it twice, and VK's wall.delete is unavailable to undo that,
   * so this asks the admin instead of guessing.
   */
  private async resolveStuckDeliveries(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - STUCK_SENDING_MS);
    const stuck = await this.prisma.postDelivery.findMany({
      where: { status: 'sending', updatedAt: { lt: cutoff } },
      select: { id: true, postId: true },
    });
    if (stuck.length === 0) {
      return;
    }

    await this.prisma.postDelivery.updateMany({
      where: { id: { in: stuck.map((delivery) => delivery.id) } },
      data: {
        status: 'unknown',
        error:
          'Доставка прервана: воркер не завершил отправку. Проверьте группу вручную.',
      },
    });
    this.logger.warn(
      { count: stuck.length },
      'Зависшие доставки переведены в unknown',
    );

    for (const postId of new Set(stuck.map((delivery) => delivery.postId))) {
      await this.posts.finalizeIfComplete(postId);
    }
  }

  /** NX+PX lock: whoever sets it first sweeps, and it frees itself if that instance dies. */
  private async acquireLock(): Promise<boolean> {
    const result = await this.redis.set(
      LOCK_KEY,
      String(process.pid),
      'PX',
      LOCK_TTL_MS,
      'NX',
    );
    return result === 'OK';
  }
}
