import { DelayedError, Job, Queue } from 'bullmq';
import { DeliverJob, DispatchPostJob } from '../queue/queue.constants';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { GroupRateLimiter } from '../queue/group-rate-limiter';
import { JOB_DELIVER, JOB_DISPATCH_POST } from '../queue/queue.constants';
import { VkApiError } from '../vk/vk-api.error';
import { MaxApiError } from '../max/max-api.error';
import { PostDeliveryProcessor } from './post-delivery.processor';
import { PostSender } from './post-sender';
import { PostsService } from './posts.service';

function deliveryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    postId: 'post-1',
    groupId: 'g1',
    status: 'pending',
    post: { id: 'post-1', stopRequested: false, text: 'привет' },
    group: { id: 'g1', platform: 'vk', externalId: '123' },
    ...overrides,
  };
}

type ProcessorJob = Job<DispatchPostJob | DeliverJob>;

function dispatchJob(postId: string): ProcessorJob {
  return {
    name: JOB_DISPATCH_POST,
    data: { postId },
  } as unknown as ProcessorJob;
}

function deliverJob(overrides: Partial<Job> = {}): ProcessorJob {
  return {
    name: JOB_DELIVER,
    data: { deliveryId: 'd1' },
    attemptsMade: 0,
    opts: { attempts: 3 },
    token: 'tok',
    moveToDelayed: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ProcessorJob;
}

function setup() {
  const prisma = {
    post: { findUnique: jest.fn(), update: jest.fn() },
    postDelivery: {
      findUnique: jest.fn().mockResolvedValue(deliveryRow()),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    group: { update: jest.fn().mockResolvedValue({}) },
  };
  const posts = { finalizeIfComplete: jest.fn().mockResolvedValue({}) };
  const sender = {
    send: jest.fn().mockResolvedValue({ externalMessageId: '42' }),
  };
  const rateLimiter = {
    reserve: jest.fn().mockResolvedValue({ acquired: true, waitMs: 0 }),
  };
  const queue = {
    add: jest.fn().mockResolvedValue({}),
    getJob: jest.fn().mockResolvedValue(undefined),
  };
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const processor = new PostDeliveryProcessor(
    prisma as unknown as PrismaService,
    posts as unknown as PostsService,
    sender as unknown as PostSender,
    rateLimiter as unknown as GroupRateLimiter,
    queue as unknown as Queue,
    logger as unknown as PinoLogger,
  );
  return { processor, prisma, posts, sender, rateLimiter, queue, logger };
}

/** Reads one argument of a recorded call as `T` — `mock.calls` is `any[][]`. */
function callArg<T>(mockFn: jest.Mock, callIndex: number, argIndex: number): T {
  const calls = mockFn.mock.calls as unknown[][];
  return calls[callIndex][argIndex] as T;
}

/** Reads the `data` of the nth postDelivery.update call. */
function updateData(prisma: { postDelivery: { update: jest.Mock } }, n = -1) {
  const calls = prisma.postDelivery.update.mock.calls as unknown[][];
  const call = n < 0 ? calls[calls.length + n] : calls[n];
  return (call[0] as { data: Record<string, unknown> }).data;
}

describe('PostDeliveryProcessor', () => {
  describe('dispatch', () => {
    it('fans the campaign out into one job per pending delivery', async () => {
      const { processor, prisma, queue } = setup();
      prisma.post.findUnique.mockResolvedValue({
        id: 'post-1',
        status: 'scheduled',
        stopRequested: false,
      });
      prisma.postDelivery.findMany.mockResolvedValue([
        { id: 'd1' },
        { id: 'd2' },
      ]);

      await processor.process(dispatchJob('post-1'));

      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(prisma.post.update).toHaveBeenCalledWith({
        where: { id: 'post-1' },
        data: { status: 'sending' },
      });
    });

    it('does not fan out a campaign stopped before it started', async () => {
      const { processor, prisma, queue } = setup();
      prisma.post.findUnique.mockResolvedValue({
        id: 'post-1',
        status: 'scheduled',
        stopRequested: true,
      });

      await processor.process(dispatchJob('post-1'));

      expect(queue.add).not.toHaveBeenCalled();
    });

    it('ignores a post that is no longer in a sending state', async () => {
      const { processor, prisma, queue } = setup();
      prisma.post.findUnique.mockResolvedValue({
        id: 'post-1',
        status: 'sent',
        stopRequested: false,
      });

      await processor.process(dispatchJob('post-1'));

      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('deliver', () => {
    it('records the platform message id needed for later edit/delete', async () => {
      const { processor, prisma, sender } = setup();

      await processor.process(deliverJob());

      expect(sender.send).toHaveBeenCalled();
      expect(updateData(prisma)).toMatchObject({
        status: 'sent',
        externalMessageId: '42',
      });
    });

    it('commits `sending` before calling the platform', async () => {
      const { processor, prisma, sender } = setup();
      let statusAtCallTime: unknown;
      sender.send.mockImplementation(() => {
        statusAtCallTime = updateData(prisma).status;
        return Promise.resolve({ externalMessageId: '42' });
      });

      await processor.process(deliverJob());

      // Without this, a worker dying mid-call would leave a row that looks
      // untouched and would be retried into a possible duplicate post.
      expect(statusAtCallTime).toBe('sending');
    });

    it('skips a delivery whose row is no longer pending', async () => {
      const { processor, prisma, sender } = setup();
      prisma.postDelivery.findUnique.mockResolvedValue(
        deliveryRow({ status: 'sent' }),
      );

      await processor.process(deliverJob());

      // Guards against a duplicate job re-publishing an already sent post.
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('marks the delivery skipped when a stop landed after queueing', async () => {
      const { processor, prisma, sender } = setup();
      prisma.postDelivery.findUnique.mockResolvedValue(
        deliveryRow({ post: { id: 'post-1', stopRequested: true } }),
      );

      await processor.process(deliverJob());

      expect(sender.send).not.toHaveBeenCalled();
      expect(updateData(prisma)).toMatchObject({ status: 'skipped_by_stop' });
    });

    it('requeues without consuming a slot when the group is busy', async () => {
      const { processor, rateLimiter, sender } = setup();
      rateLimiter.reserve.mockResolvedValue({ acquired: false, waitMs: 2000 });
      const moveToDelayed = jest.fn().mockResolvedValue(undefined);
      const job = deliverJob({ moveToDelayed });

      await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);

      expect(moveToDelayed).toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });
  });

  describe('after a successful publish', () => {
    it('never marks a published post failed when the result write fails', async () => {
      const { processor, prisma, sender } = setup();
      sender.send.mockResolvedValue({ externalMessageId: '42' });
      prisma.postDelivery.update
        .mockResolvedValueOnce({}) // the `sending` commit
        .mockRejectedValueOnce(new Error('пул БД недоступен')) // writing `sent`
        .mockResolvedValueOnce({}); // the fallback

      await processor.process(deliverJob());

      // `failed` is resumable, so calling it that would republish a post that
      // is already live — the exact duplicate this design prevents.
      const last = updateData(prisma);
      expect(last.status).toBe('unknown');
      expect(last.externalMessageId).toBe('42');
    });

    it('does not throw when even the fallback write fails, since a throw means a retry', async () => {
      const { processor, prisma, sender } = setup();
      sender.send.mockResolvedValue({ externalMessageId: '42' });
      prisma.postDelivery.update
        .mockResolvedValueOnce({})
        .mockRejectedValue(new Error('БД недоступна'));

      // Throwing here would be a failed attempt, and BullMQ would retry the
      // job — publishing a second time. The reconciler resolves the row later.
      await expect(processor.process(deliverJob())).resolves.toBeUndefined();
    });

    it('does not let a status recount throw the job into a retry', async () => {
      const { processor, posts, sender } = setup();
      sender.send.mockResolvedValue({ externalMessageId: '42' });
      posts.finalizeIfComplete.mockRejectedValue(new Error('БД недоступна'));

      await expect(processor.process(deliverJob())).resolves.toBeUndefined();
    });
  });

  describe('enqueueing deliveries', () => {
    it('does not keep failed jobs, which would make the id un-enqueueable forever', async () => {
      const { processor, prisma, queue } = setup();
      prisma.post.findUnique.mockResolvedValue({
        id: 'post-1',
        status: 'scheduled',
        stopRequested: false,
      });
      prisma.postDelivery.findMany.mockResolvedValue([{ id: 'd1' }]);

      await processor.process(dispatchJob('post-1'));

      // BullMQ refuses to add a job whose custom id still exists — including
      // one held by a finished job — so a retained failure would strand the
      // delivery in `pending` with no way back.
      const opts = callArg<{ removeOnFail: boolean }>(queue.add, 0, 2);
      expect(opts.removeOnFail).toBe(true);
    });

    it('clears a finished job squatting on the delivery id', async () => {
      const { processor, prisma, queue } = setup();
      const remove = jest.fn().mockResolvedValue(undefined);
      prisma.post.findUnique.mockResolvedValue({
        id: 'post-1',
        status: 'scheduled',
        stopRequested: false,
      });
      prisma.postDelivery.findMany.mockResolvedValue([{ id: 'd1' }]);
      queue.getJob.mockResolvedValue({
        isCompleted: jest.fn().mockResolvedValue(true),
        isFailed: jest.fn().mockResolvedValue(false),
        remove,
      });

      await processor.process(dispatchJob('post-1'));

      expect(remove).toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalled();
    });
  });

  describe('failure handling', () => {
    it('retries a rate limit by returning the row to pending', async () => {
      const { processor, prisma, sender } = setup();
      sender.send.mockRejectedValue(new VkApiError(6, 'Too many requests'));

      await expect(processor.process(deliverJob())).rejects.toBeInstanceOf(
        VkApiError,
      );

      // Back to `pending`, or the retry would hit the status guard and skip.
      expect(updateData(prisma)).toMatchObject({ status: 'pending' });
    });

    it('gives up on a rate limit once attempts run out', async () => {
      const { processor, prisma, sender } = setup();
      sender.send.mockRejectedValue(new VkApiError(6, 'Too many requests'));

      await processor.process(deliverJob({ attemptsMade: 2 } as Partial<Job>));

      expect(updateData(prisma)).toMatchObject({ status: 'failed' });
    });

    it('sends an ambiguous failure to unknown, never to a retry', async () => {
      const { processor, prisma, sender } = setup();
      sender.send.mockRejectedValue(
        new VkApiError(10, 'Internal server error'),
      );

      await processor.process(deliverJob());

      // The post may already be published; retrying could duplicate it.
      expect(updateData(prisma)).toMatchObject({ status: 'unknown' });
    });

    it('disables the group when its token stops working', async () => {
      const { processor, prisma, sender } = setup();
      sender.send.mockRejectedValue(new VkApiError(27, 'Group auth failed'));

      await processor.process(deliverJob());

      expect(updateData(prisma)).toMatchObject({ status: 'failed' });
      expect(prisma.group.update).toHaveBeenCalledWith({
        where: { id: 'g1' },
        data: { status: 'token_invalid' },
      });
    });

    it('does not disable a MAX group over an app-wide token problem', async () => {
      const { processor, prisma, sender } = setup();
      sender.send.mockRejectedValue(
        new MaxApiError(401, 'verify.token', 'Invalid token'),
      );

      await processor.process(deliverJob());

      expect(prisma.group.update).not.toHaveBeenCalled();
    });

    it('still settles the campaign status after a failure', async () => {
      const { processor, posts, sender } = setup();
      sender.send.mockRejectedValue(new VkApiError(10, 'Boom'));

      await processor.process(deliverJob());

      expect(posts.finalizeIfComplete).toHaveBeenCalledWith('post-1');
    });
  });

  it('refuses an unknown job type instead of retrying it forever', async () => {
    const { processor } = setup();

    await expect(
      processor.process({
        name: 'nonsense',
        data: {},
      } as unknown as ProcessorJob),
    ).rejects.toThrow(/Неизвестный тип джоба/);
  });
});
