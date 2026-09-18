import { PinoLogger } from 'nestjs-pino';
import { Queue } from 'bullmq';
import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { Post, PostDeliveryStatus } from '../generated/prisma/client';
import { PostsService } from './posts.service';

function post(overrides: Partial<Post> = {}): Post {
  return {
    id: 'post-1',
    text: 'привет',
    vkTextOverride: null,
    maxTextOverride: null,
    attachments: null,
    createdAt: new Date(),
    scheduledAt: null,
    recurrenceRule: null,
    templatePaused: false,
    autoDeleteAt: null,
    autoDeleteAfterMinutes: null,
    status: 'draft',
    stopRequested: false,
    clonedFromPostId: null,
    recurringTemplateId: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Reads one argument of a recorded call as `T` — `mock.calls` is `any[][]`,
 * which trips the type-aware lint rules when indexed directly. */
function callArg<T>(mockFn: jest.Mock, callIndex: number, argIndex: number): T {
  const calls = mockFn.mock.calls as unknown[][];
  return calls[callIndex][argIndex] as T;
}

/** Shapes a groupBy result the way finalizeIfComplete reads it. */
function counts(map: Partial<Record<PostDeliveryStatus, number>>) {
  return Object.entries(map).map(([status, count]) => ({
    status,
    _count: { _all: count },
  }));
}

function buildService() {
  const prisma = {
    post: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: object }) => post(data)),
    },
    postDelivery: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    group: { findMany: jest.fn() },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const queue = {
    add: jest.fn().mockResolvedValue({}),
    getJob: jest.fn().mockResolvedValue(undefined),
  };
  const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new PostsService(
    prisma as unknown as PrismaService,
    queue as unknown as Queue,
    logger as unknown as PinoLogger,
  );
  return { service, prisma, queue, logger };
}

describe('PostsService', () => {
  describe('createPost', () => {
    it('refuses a group that cannot receive posts', async () => {
      const { service, prisma } = buildService();
      prisma.group.findMany.mockResolvedValue([
        { id: 'g1', status: 'active', title: 'Живая' },
        { id: 'g2', status: 'bot_removed', title: 'Мёртвая' },
      ]);

      // Better to reject at creation than to schedule a campaign whose
      // failure is already known.
      await expect(
        service.createPost({ text: 'x', groupIds: ['g1', 'g2'] }),
      ).rejects.toBeInstanceOf(AppException);
      expect(prisma.post.create).not.toHaveBeenCalled();
    });

    it('rejects an unknown group id rather than silently dropping it', async () => {
      const { service, prisma } = buildService();
      prisma.group.findMany.mockResolvedValue([
        { id: 'g1', status: 'active', title: 'Живая' },
      ]);

      await expect(
        service.createPost({ text: 'x', groupIds: ['g1', 'missing'] }),
      ).rejects.toBeInstanceOf(AppException);
    });

    it('freezes the target list as delivery rows', async () => {
      const { service, prisma } = buildService();
      prisma.group.findMany.mockResolvedValue([
        { id: 'g1', status: 'active', title: 'A' },
        { id: 'g2', status: 'active', title: 'B' },
      ]);
      prisma.post.create.mockResolvedValue(post());

      // Duplicates in the request must not become duplicate deliveries.
      await service.createPost({ text: 'x', groupIds: ['g1', 'g2', 'g1'] });

      const args = callArg<{
        data: { deliveries: { create: { groupId: string }[] } };
      }>(prisma.post.create, 0, 0);
      expect(args.data.deliveries.create).toEqual([
        { groupId: 'g1' },
        { groupId: 'g2' },
      ]);
    });
  });

  describe('enqueueDispatch', () => {
    it('delays the job until scheduledAt', async () => {
      const { service, queue } = buildService();
      const now = new Date('2026-09-18T10:00:00Z');

      await service.enqueueDispatch(
        post({ scheduledAt: new Date('2026-09-18T10:05:00Z') }),
        now,
      );

      const opts = callArg<{ delay: number }>(queue.add, 0, 2);
      expect(opts.delay).toBe(5 * 60_000);
    });

    it('sends a past-due post immediately instead of computing a negative delay', async () => {
      const { service, queue } = buildService();

      await service.enqueueDispatch(
        post({ scheduledAt: new Date('2026-09-18T09:00:00Z') }),
        new Date('2026-09-18T10:00:00Z'),
      );

      const opts = callArg<{ delay: number }>(queue.add, 0, 2);
      expect(opts.delay).toBe(0);
    });

    it('clears a finished job holding the id, which would otherwise block re-dispatch', async () => {
      const { service, queue } = buildService();
      const remove = jest.fn().mockResolvedValue(undefined);
      queue.getJob.mockResolvedValue({
        isCompleted: jest.fn().mockResolvedValue(false),
        isFailed: jest.fn().mockResolvedValue(true),
        remove,
      });

      await service.enqueueDispatch(post());

      expect(remove).toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalled();
    });
  });

  describe('dispatch job options', () => {
    it('retries the fan-out, which is idempotent by construction', async () => {
      const { service, queue } = buildService();

      await service.enqueueDispatch(post());

      // Without attempts, one failing `add` inside the fan-out would kill the
      // whole campaign until the reconciler noticed a minute later.
      const opts = callArg<{ attempts: number }>(queue.add, 0, 2);
      expect(opts.attempts).toBeGreaterThan(1);
    });

    it('bounds how long failed dispatches linger in Redis', async () => {
      const { service, queue } = buildService();

      await service.enqueueDispatch(post());

      // `false` would keep them forever, and one case is never cleaned up: a
      // dispatch failing after every delivery was queued leaves no pending
      // rows, so nothing ever re-dispatches that post.
      const opts = callArg<{ removeOnFail: { age: number } }>(queue.add, 0, 2);
      expect(opts.removeOnFail).not.toBe(false);
      expect(opts.removeOnFail.age).toBeGreaterThan(0);
    });
  });

  describe('stopPost', () => {
    it('marks not-yet-started deliveries so queued jobs skip themselves', async () => {
      const { service, prisma } = buildService();
      prisma.post.findUnique.mockResolvedValue(post({ status: 'sending' }));
      prisma.postDelivery.groupBy.mockResolvedValue(counts({ sent: 1 }));

      await service.stopPost('post-1');

      expect(prisma.postDelivery.updateMany).toHaveBeenCalledWith({
        where: { postId: 'post-1', status: 'pending' },
        data: { status: 'skipped_by_stop' },
      });
    });

    it('refuses to stop a campaign that already finished', async () => {
      const { service, prisma } = buildService();
      prisma.post.findUnique.mockResolvedValue(post({ status: 'sent' }));

      await expect(service.stopPost('post-1')).rejects.toBeInstanceOf(
        AppException,
      );
    });
  });

  describe('resumePost', () => {
    it('picks up failed and stopped deliveries, but never unknown ones', async () => {
      const { service, prisma } = buildService();
      prisma.post.findUnique.mockResolvedValue(post({ status: 'stopped' }));
      prisma.postDelivery.findMany.mockResolvedValue([{ id: 'd1' }]);

      await service.resumePost('post-1');

      const where = callArg<{ where: { status: { in: string[] } } }>(
        prisma.postDelivery.findMany,
        0,
        0,
      ).where;
      // `unknown` means "may already be published" — resending could
      // duplicate it, so it stays for a human to resolve.
      expect(where.status.in).toEqual(['failed', 'skipped_by_stop']);
      expect(where.status.in).not.toContain('unknown');
    });

    it('clears stopRequested, or the resumed deliveries would skip again', async () => {
      const { service, prisma } = buildService();
      prisma.post.findUnique.mockResolvedValue(
        post({ status: 'stopped', stopRequested: true }),
      );
      prisma.postDelivery.findMany.mockResolvedValue([{ id: 'd1' }]);

      await service.resumePost('post-1');

      const updates = prisma.post.update.mock.calls as unknown[][];
      const clearedStop = updates.some(
        (call) =>
          (call[0] as { data: { stopRequested?: boolean } }).data
            .stopRequested === false,
      );
      expect(clearedStop).toBe(true);
    });

    it('says so when there is nothing to resend', async () => {
      const { service, prisma } = buildService();
      prisma.post.findUnique.mockResolvedValue(post({ status: 'sent' }));
      prisma.postDelivery.findMany.mockResolvedValue([]);

      await expect(service.resumePost('post-1')).rejects.toBeInstanceOf(
        AppException,
      );
    });
  });

  describe('redispatchPending', () => {
    it('re-queues a campaign that still has pending deliveries', async () => {
      const { service, prisma, queue } = buildService();
      prisma.postDelivery.count.mockResolvedValue(2);
      prisma.post.findUnique.mockResolvedValue(post({ status: 'sending' }));

      await expect(service.redispatchPending('post-1')).resolves.toBe(true);
      expect(queue.add).toHaveBeenCalled();
    });

    it('leaves a healthy campaign alone, so every sweep is not a re-dispatch', async () => {
      const { service, prisma, queue } = buildService();
      prisma.postDelivery.count.mockResolvedValue(0);

      await expect(service.redispatchPending('post-1')).resolves.toBe(false);
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('finalizeIfComplete', () => {
    it('leaves the campaign alone while deliveries are still in flight', async () => {
      const { service, prisma } = buildService();
      prisma.postDelivery.groupBy.mockResolvedValue(
        counts({ sent: 2, pending: 1 }),
      );
      prisma.post.findUnique.mockResolvedValue(post({ status: 'sending' }));

      await service.finalizeIfComplete('post-1');

      expect(prisma.post.update).not.toHaveBeenCalled();
    });

    it('reports a fully delivered campaign as sent', async () => {
      const { service, prisma } = buildService();
      prisma.postDelivery.groupBy.mockResolvedValue(counts({ sent: 3 }));

      const result = await service.finalizeIfComplete('post-1');

      expect(result.status).toBe('sent');
    });

    it('prefers stopped over partially_failed when the admin stopped it', async () => {
      const { service, prisma } = buildService();
      prisma.postDelivery.groupBy.mockResolvedValue(
        counts({ sent: 1, failed: 1, skipped_by_stop: 1 }),
      );

      // The admin's own decision explains the gap; calling it a failure
      // would blame the system for what the admin chose.
      const result = await service.finalizeIfComplete('post-1');

      expect(result.status).toBe('stopped');
    });

    it('reports partially_failed when some deliveries failed', async () => {
      const { service, prisma } = buildService();
      prisma.postDelivery.groupBy.mockResolvedValue(
        counts({ sent: 2, failed: 1 }),
      );

      expect((await service.finalizeIfComplete('post-1')).status).toBe(
        'partially_failed',
      );
    });

    it('does not call a campaign with unresolved deliveries fully sent', async () => {
      const { service, prisma } = buildService();
      prisma.postDelivery.groupBy.mockResolvedValue(
        counts({ sent: 2, unknown: 1 }),
      );

      expect((await service.finalizeIfComplete('post-1')).status).toBe(
        'partially_failed',
      );
    });
  });
});
