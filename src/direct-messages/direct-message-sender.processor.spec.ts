import { DelayedError, Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { GroupRateLimiter } from '../queue/group-rate-limiter';
import { MaxApiClient } from '../max/max-api.client';
import { MaxApiError } from '../max/max-api.error';
import { AttachmentUploader } from '../posts/attachment-uploader';
import { DeliverDirectMessageJob } from '../queue/queue.constants';
import { DirectMessageSenderProcessor } from './direct-message-sender.processor';

/** Reads one argument of a recorded call as `T` — `mock.calls` is `any[][]`. */
function callArg<T>(mockFn: jest.Mock, callIndex = 0, argIndex = 0): T {
  const calls = mockFn.mock.calls as unknown[][];
  return calls[callIndex][argIndex] as T;
}

function deliveryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    status: 'pending',
    post: {
      id: 'post-1',
      text: 'привет',
      maxTextOverride: null,
      attachments: [],
    },
    platformUser: { platform: 'max', externalUserId: '42' },
    ...overrides,
  };
}

type ProcessorJob = Job<DeliverDirectMessageJob>;

function deliverJob(overrides: Partial<Job> = {}): ProcessorJob {
  return {
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
    directMessageDelivery: {
      findUnique: jest.fn().mockResolvedValue(deliveryRow()),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const max = {
    sendMessageToUser: jest.fn().mockResolvedValue({ messageId: 'm1' }),
  };
  const attachments = {
    maxAttachments: jest.fn().mockResolvedValue([]),
  };
  const rateLimiter = {
    reserve: jest.fn().mockResolvedValue({ acquired: true, waitMs: 0 }),
  };
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const processor = new DirectMessageSenderProcessor(
    prisma as unknown as PrismaService,
    max as unknown as MaxApiClient,
    attachments as unknown as AttachmentUploader,
    rateLimiter as unknown as GroupRateLimiter,
    logger as unknown as PinoLogger,
  );
  return { processor, prisma, max, attachments, rateLimiter, logger };
}

describe('DirectMessageSenderProcessor', () => {
  it('пропускает исчезнувшую доставку', async () => {
    const { processor, prisma, max } = setup();
    prisma.directMessageDelivery.findUnique.mockResolvedValue(null);

    await processor.process(deliverJob());

    expect(max.sendMessageToUser).not.toHaveBeenCalled();
  });

  it('пропускает доставку, уже не находящуюся в pending', async () => {
    const { processor, prisma, max } = setup();
    prisma.directMessageDelivery.findUnique.mockResolvedValue(
      deliveryRow({ status: 'sent' }),
    );

    await processor.process(deliverJob());

    expect(max.sendMessageToUser).not.toHaveBeenCalled();
  });

  it('помечает manual_required для не-MAX платформы, не пытаясь отправить', async () => {
    const { processor, prisma, max } = setup();
    prisma.directMessageDelivery.findUnique.mockResolvedValue(
      deliveryRow({ platformUser: { platform: 'vk', externalUserId: '42' } }),
    );

    await processor.process(deliverJob());

    expect(max.sendMessageToUser).not.toHaveBeenCalled();
    const call = callArg<{ where: unknown; data: Record<string, unknown> }>(
      prisma.directMessageDelivery.update,
    );
    expect(call.where).toEqual({ id: 'd1' });
    expect(call.data).toMatchObject({ status: 'manual_required' });
  });

  it('помечает manual_required для нечислового id (например, ник)', async () => {
    const { processor, prisma, max } = setup();
    prisma.directMessageDelivery.findUnique.mockResolvedValue(
      deliveryRow({
        platformUser: { platform: 'max', externalUserId: 'nick' },
      }),
    );

    await processor.process(deliverJob());

    expect(max.sendMessageToUser).not.toHaveBeenCalled();
    const call = callArg<{ data: Record<string, unknown> }>(
      prisma.directMessageDelivery.update,
    );
    expect(call.data).toMatchObject({ status: 'manual_required' });
  });

  it('переставляет джоб без траты слота, когда лимитер занят', async () => {
    const { processor, rateLimiter } = setup();
    rateLimiter.reserve.mockResolvedValue({ acquired: false, waitMs: 500 });
    const moveToDelayed = jest.fn().mockResolvedValue(undefined);
    const job = deliverJob({ moveToDelayed });

    await expect(processor.process(job)).rejects.toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalled();
  });

  it('коммитит sending до сетевого вызова и берёт текст поста с учётом maxTextOverride', async () => {
    const { processor, prisma, max } = setup();
    prisma.directMessageDelivery.findUnique.mockResolvedValue(
      deliveryRow({
        post: {
          id: 'post-1',
          text: 'общий',
          maxTextOverride: 'для MAX',
          attachments: [],
        },
      }),
    );

    await processor.process(deliverJob());

    const firstCall = callArg<{ where: unknown; data: unknown }>(
      prisma.directMessageDelivery.update,
      0,
    );
    expect(firstCall).toEqual({
      where: { id: 'd1' },
      data: { status: 'sending', attemptsMade: { increment: 1 } },
    });
    expect(max.sendMessageToUser).toHaveBeenCalledWith(42, 'для MAX', {
      attachments: [],
    });
  });

  it('прикладывает вложения поста, а не только текст', async () => {
    const { processor, prisma, max, attachments } = setup();
    const mediaAsset = { id: 'm1', kind: 'image' };
    prisma.directMessageDelivery.findUnique.mockResolvedValue(
      deliveryRow({
        post: {
          id: 'post-1',
          text: 'привет',
          maxTextOverride: null,
          attachments: [{ mediaAsset }],
        },
      }),
    );
    const built = [{ type: 'image', payload: { photos: [] } }];
    attachments.maxAttachments.mockResolvedValue(built);

    await processor.process(deliverJob());

    // The dedicated cache used by campaign deliveries — a personal message
    // must not silently drop to text-only just because it has its own
    // sender rather than PostSender.
    expect(attachments.maxAttachments).toHaveBeenCalledWith([mediaAsset]);
    expect(max.sendMessageToUser).toHaveBeenCalledWith(42, 'привет', {
      attachments: built,
    });
  });

  it('записывает id сообщения и sentAt при успехе', async () => {
    const { processor, prisma } = setup();

    await processor.process(deliverJob());

    const calls = prisma.directMessageDelivery.update.mock.calls as unknown[][];
    const lastCall = calls[calls.length - 1][0] as {
      where: unknown;
      data: Record<string, unknown>;
    };
    expect(lastCall.where).toEqual({ id: 'd1' });
    expect(lastCall.data).toMatchObject({
      status: 'sent',
      externalMessageId: 'm1',
      error: null,
    });
  });

  it('не роняет джоб, если запись "sent" не удалась после реальной отправки', async () => {
    const { processor, prisma } = setup();
    // Отправка уже случилась (max.sendMessageToUser выше замокан успешным) —
    // падает только сама запись результата в базу.
    prisma.directMessageDelivery.update
      .mockResolvedValueOnce({}) // status: 'sending'
      .mockRejectedValueOnce(new Error('база недоступна')) // status: 'sent'
      .mockResolvedValueOnce({}); // markUnknownAfterSend: status: 'unknown'

    // Бросок отсюда БullMQ засчитал бы как неудачную попытку — а сообщение
    // уже реально ушло получателю.
    await expect(processor.process(deliverJob())).resolves.toBeUndefined();

    const calls = prisma.directMessageDelivery.update.mock.calls as unknown[][];
    const lastCall = calls[calls.length - 1][0] as {
      where: unknown;
      data: Record<string, unknown>;
    };
    expect(lastCall.where).toEqual({ id: 'd1' });
    expect(lastCall.data).toMatchObject({
      status: 'unknown',
      externalMessageId: 'm1',
    });
  });

  describe('обработка ошибок', () => {
    function lastUpdateData(prisma: {
      directMessageDelivery: { update: jest.Mock };
    }): Record<string, unknown> {
      const calls = prisma.directMessageDelivery.update.mock
        .calls as unknown[][];
      return (calls[calls.length - 1][0] as { data: Record<string, unknown> })
        .data;
    }

    it('возвращает в pending и пробрасывает ошибку при retryable с оставшимися попытками', async () => {
      const { processor, prisma, max } = setup();
      max.sendMessageToUser.mockRejectedValue(
        new MaxApiError(429, 'rate.limit', 'rate limited'),
      );
      const job = deliverJob({ attemptsMade: 0, opts: { attempts: 3 } });

      await expect(processor.process(job)).rejects.toThrow();
      expect(lastUpdateData(prisma)).toMatchObject({ status: 'pending' });
    });

    it('помечает failed, когда retryable исчерпал попытки', async () => {
      const { processor, prisma, max } = setup();
      max.sendMessageToUser.mockRejectedValue(
        new MaxApiError(429, 'rate.limit', 'rate limited'),
      );
      const job = deliverJob({ attemptsMade: 2, opts: { attempts: 3 } });

      await processor.process(job);

      expect(lastUpdateData(prisma)).toMatchObject({ status: 'failed' });
    });

    it('помечает unknown при неоднозначном исходе — не failed, чтобы не задвоить ручным повтором', async () => {
      const { processor, prisma, max } = setup();
      max.sendMessageToUser.mockRejectedValue(
        new MaxApiError(0, 'transport', 'timeout'),
      );

      await processor.process(deliverJob());

      expect(lastUpdateData(prisma)).toMatchObject({ status: 'unknown' });
    });

    it('помечает failed при постоянной ошибке', async () => {
      const { processor, prisma, max } = setup();
      max.sendMessageToUser.mockRejectedValue(
        new MaxApiError(400, 'bad.request', 'bad request'),
      );

      await processor.process(deliverJob());

      expect(lastUpdateData(prisma)).toMatchObject({ status: 'failed' });
    });
  });
});
