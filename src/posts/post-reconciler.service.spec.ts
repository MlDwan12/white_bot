import type Redis from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { PostReconcilerService } from './post-reconciler.service';
import { PostsService } from './posts.service';
import { PostTemplatesService } from './post-templates.service';
import { PostModerationService } from './post-moderation.service';
import { ContestsService } from '../contests/contests.service';

/** Reads one argument of a recorded call as `T` — `mock.calls` is `any[][]`,
 * which trips the type-aware lint rules when indexed directly. */
function callArg<T>(mockFn: jest.Mock, callIndex: number, argIndex: number): T {
  const calls = mockFn.mock.calls as unknown[][];
  return calls[callIndex][argIndex] as T;
}

function setup(lockAcquired = true) {
  const prisma = {
    post: { findMany: jest.fn().mockResolvedValue([]) },
    postDelivery: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const posts = {
    enqueueDispatch: jest.fn().mockResolvedValue(undefined),
    finalizeIfComplete: jest.fn().mockResolvedValue({}),
    redispatchPending: jest.fn().mockResolvedValue(false),
    schedulePostIfDraft: jest.fn().mockResolvedValue(undefined),
  };
  const templates = { fireDueTemplates: jest.fn().mockResolvedValue(0) };
  const contests = {
    openDueContests: jest.fn().mockResolvedValue({ opened: [] }),
    openContestsWithUnsentAnnouncement: jest.fn().mockResolvedValue([]),
    drawDueContests: jest.fn().mockResolvedValue({ drawn: 0 }),
  };
  const redis = {
    set: jest.fn().mockResolvedValue(lockAcquired ? 'OK' : null),
  };
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const moderation = { sweepAutoDeletions: jest.fn().mockResolvedValue(0) };

  const service = new PostReconcilerService(
    prisma as unknown as PrismaService,
    posts as unknown as PostsService,
    templates as unknown as PostTemplatesService,
    moderation as unknown as PostModerationService,
    contests as unknown as ContestsService,
    redis as unknown as Redis,
    logger as unknown as PinoLogger,
  );
  return {
    service,
    prisma,
    posts,
    templates,
    redis,
    logger,
    moderation,
    contests,
  };
}

describe('PostReconcilerService', () => {
  it('does nothing when another instance holds the lock', async () => {
    const { service, prisma } = setup(false);

    await service.runSweep();

    expect(prisma.post.findMany).not.toHaveBeenCalled();
  });

  it('takes the lock with NX and an expiry, so a crash cannot wedge it', async () => {
    const { service, redis } = setup();

    await service.runSweep();

    const args = redis.set.mock.calls[0] as unknown[];
    expect(args).toContain('NX');
    expect(args).toContain('PX');
  });

  it('re-queues a scheduled post whose job was lost', async () => {
    const { service, prisma, posts } = setup();
    const post = { id: 'post-1', status: 'scheduled', scheduledAt: new Date() };
    prisma.post.findMany.mockResolvedValue([post]);

    await service.runSweep();

    // Postgres is the source of truth; this rebuilds the Redis-side job.
    expect(posts.enqueueDispatch).toHaveBeenCalledWith(post, expect.any(Date));
  });

  it('moves an abandoned delivery to unknown rather than back to pending', async () => {
    const { service, prisma } = setup();
    prisma.postDelivery.findMany.mockResolvedValue([
      { id: 'd1', postId: 'post-1' },
    ]);

    await service.runSweep();

    const data = callArg<{ data: { status: string } }>(
      prisma.postDelivery.updateMany,
      0,
      0,
    ).data;
    // Whether the post went out before the worker died is unknowable, and
    // VK offers no way to delete a duplicate — so a human decides.
    expect(data.status).toBe('unknown');
  });

  it('only sweeps deliveries stuck well beyond a normal call', async () => {
    const { service, prisma } = setup();
    const now = new Date('2026-09-18T12:00:00Z');

    await service.runSweep(now);

    const where = callArg<{
      where: { status: string; updatedAt: { lt: Date } };
    }>(prisma.postDelivery.findMany, 0, 0).where;
    expect(where.status).toBe('sending');
    // The API clients time out in ~10s, so the cutoff must be far above that
    // to avoid grabbing a delivery that is merely slow.
    expect(now.getTime() - where.updatedAt.lt.getTime()).toBeGreaterThan(
      60_000,
    );
  });

  it('settles campaign status after resolving stuck deliveries', async () => {
    const { service, prisma, posts } = setup();
    prisma.postDelivery.findMany.mockResolvedValue([
      { id: 'd1', postId: 'post-1' },
      { id: 'd2', postId: 'post-1' },
    ]);

    await service.runSweep();

    // Once per campaign, not once per delivery.
    expect(posts.finalizeIfComplete).toHaveBeenCalledTimes(1);
  });

  it('rescues a campaign left in sending with nothing queued', async () => {
    const { service, prisma, posts } = setup();
    prisma.post.findMany
      .mockResolvedValueOnce([]) // no scheduled posts due
      .mockResolvedValueOnce([{ id: 'post-1' }]); // one stuck in `sending`

    await service.runSweep();

    // Dispatch flips the post to `sending` before queueing every group, so a
    // crash in between leaves `pending` rows that nothing else looks at:
    // not `scheduled`, not `sending` rows, not resumable.
    expect(posts.redispatchPending).toHaveBeenCalledWith('post-1');
  });

  it('does not take the whole process down when the lock call rejects', async () => {
    const { service, redis, logger } = setup();
    redis.set.mockRejectedValue(new Error('Redis закрыт'));

    // The sweep runs from a timer with no caller to catch it, and the app
    // installs no unhandledRejection handler — an escaping rejection would
    // terminate Node.
    await expect(service.runSweep()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it('judges template lateness from when the sweep started', async () => {
    const { service, templates } = setup();
    const startedAt = new Date('2026-09-18T07:00:00.000Z');

    await service.runSweep(startedAt);

    // Firing runs after the recovery passes, which can take minutes. Left to
    // default to `new Date()`, the lateness bound inside would charge every
    // template for that backlog and abandon windows that were on time — the
    // day's post dropped with only a warn. The *next* window is still computed
    // from a fresh per-template clock inside the loop.
    expect(templates.fireDueTemplates).toHaveBeenCalledWith(startedAt);
  });

  it('runs recovery before firing templates', async () => {
    const { service, prisma, templates } = setup();
    const order: string[] = [];
    prisma.post.findMany.mockImplementation(() => {
      order.push('recovery');
      return Promise.resolve([]);
    });
    templates.fireDueTemplates.mockImplementation(() => {
      order.push('templates');
      return Promise.resolve(0);
    });

    await service.runSweep(new Date('2026-09-18T07:00:00.000Z'));

    // Firing is a sequential loop with a transaction and a queue.add per
    // template. First in the sweep, a backlog of due templates delayed the work
    // that rescues stuck campaigns — and could outlive the sweep lock.
    // A late firing costs nothing: nextRunAt has passed, the window is not lost.
    expect(order[0]).toBe('recovery');
    expect(order[order.length - 1]).toBe('templates');
  });

  it('still runs the recovery steps when firing templates fails', async () => {
    const { service, templates, prisma, logger } = setup();
    templates.fireDueTemplates.mockRejectedValue(new Error('БД недоступна'));

    await service.runSweep(new Date('2026-09-18T07:00:00.000Z'));

    // Firing templates was added as the *first* step of the sweep. Unguarded,
    // a failure there cancelled the recovery work below — which existed first
    // and is what rescues stuck campaigns — for that whole minute.
    expect(prisma.post.findMany).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('never mistakes a recurring template for a schedulable post', async () => {
    const { service, prisma } = setup();

    await service.runSweep();

    // A template has no deliveries of its own: dispatching one would publish
    // nothing while marking it `sending` forever.
    const scheduledWhere = (
      prisma.post.findMany.mock.calls[0] as unknown[]
    )[0] as { where: { recurrenceRule: null } };
    const stalledWhere = (
      prisma.post.findMany.mock.calls[1] as unknown[]
    )[0] as { where: { recurrenceRule: null } };
    expect(scheduledWhere.where.recurrenceRule).toBeNull();
    expect(stalledWhere.where.recurrenceRule).toBeNull();
  });

  it('swallows a sweep failure so the timer keeps running', async () => {
    const { service, prisma, logger } = setup();
    prisma.post.findMany.mockRejectedValue(new Error('БД недоступна'));

    await expect(service.runSweep()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it('sends the draft announcement post of every open contest with one still pending', async () => {
    const { service, contests, posts } = setup();
    // Not `openDueContests`'s own `opened` list — a contest can reach this
    // state on a *later* sweep too, if its send failed the first time
    // (see the retry test below). `openContestsWithUnsentAnnouncement`
    // covers both by construction.
    contests.openContestsWithUnsentAnnouncement.mockResolvedValue([
      { id: 'c1', postId: 'post-1' },
    ]);

    await service.runSweep();

    expect(posts.schedulePostIfDraft).toHaveBeenCalledTimes(1);
    expect(posts.schedulePostIfDraft).toHaveBeenCalledWith(
      'post-1',
      expect.any(Date),
    );
  });

  it('does not let a failed announcement send cancel the rest of the sweep', async () => {
    const { service, contests, posts, logger } = setup();
    contests.openContestsWithUnsentAnnouncement.mockResolvedValue([
      { id: 'c1', postId: 'post-1' },
    ]);
    posts.schedulePostIfDraft.mockRejectedValue(new Error('MAX недоступен'));

    await expect(service.runSweep()).resolves.toBeUndefined();

    // The contest is already open in the database; a post that failed to go
    // out is a problem visible on its own campaign card, not a reason to
    // undo opening the contest or to abort the rest of the sweep.
    expect(logger.error).toHaveBeenCalled();
    // A failed send must not stop it from being retried on the next pass —
    // the whole point of sourcing this list fresh every sweep.
    expect(contests.drawDueContests).toHaveBeenCalled();
  });

  it('keeps retrying an announcement left over from an earlier failed pass', async () => {
    // `openDueContests` itself reports nothing new this time — the contest
    // opened on a *previous* sweep, and only its announcement send failed
    // back then. Before this fix, nothing would ever look at it again.
    const { service, contests, posts } = setup();
    contests.openDueContests.mockResolvedValue({ opened: [] });
    contests.openContestsWithUnsentAnnouncement.mockResolvedValue([
      { id: 'c1', postId: 'post-1' },
    ]);

    await service.runSweep();

    expect(posts.schedulePostIfDraft).toHaveBeenCalledWith(
      'post-1',
      expect.any(Date),
    );
  });

  it('draws due contests and keeps going when the contest sweep as a whole fails', async () => {
    const { service, contests, logger } = setup();
    contests.openDueContests.mockRejectedValue(new Error('база недоступна'));

    await expect(service.runSweep()).resolves.toBeUndefined();

    // Isolated from the rest of the sweep, like every other recovery step.
    expect(contests.drawDueContests).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('draws due contests independently of whether any contest opened', async () => {
    const { service, contests } = setup();

    await service.runSweep();

    expect(contests.drawDueContests).toHaveBeenCalledWith(expect.any(Date));
  });

  it('stops its timer on shutdown', () => {
    const { service } = setup();
    service.onApplicationBootstrap();

    expect(() => service.onApplicationShutdown()).not.toThrow();
  });
});
