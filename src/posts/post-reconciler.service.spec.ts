import type Redis from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { PostReconcilerService } from './post-reconciler.service';
import { PostsService } from './posts.service';

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

  const service = new PostReconcilerService(
    prisma as unknown as PrismaService,
    posts as unknown as PostsService,
    redis as unknown as Redis,
    logger as unknown as PinoLogger,
  );
  return { service, prisma, posts, redis, logger };
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

  it('swallows a sweep failure so the timer keeps running', async () => {
    const { service, prisma, logger } = setup();
    prisma.post.findMany.mockRejectedValue(new Error('БД недоступна'));

    await expect(service.runSweep()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it('stops its timer on shutdown', () => {
    const { service } = setup();
    service.onApplicationBootstrap();

    expect(() => service.onApplicationShutdown()).not.toThrow();
  });
});
