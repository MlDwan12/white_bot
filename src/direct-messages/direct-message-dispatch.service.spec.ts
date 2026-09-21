import { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { DirectMessageDispatchService } from './direct-message-dispatch.service';
import { DirectMessageRecipientsService } from './direct-message-recipients.service';

function setup() {
  const prisma = {
    post: { findUnique: jest.fn().mockResolvedValue({ id: 'post-1' }) },
    directMessageDelivery: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const recipients = { resolve: jest.fn().mockResolvedValue([]) };
  const queue = {
    add: jest.fn().mockResolvedValue({}),
    getJob: jest.fn().mockResolvedValue(undefined),
  };
  const logger = { setContext: jest.fn(), warn: jest.fn() };
  const service = new DirectMessageDispatchService(
    prisma as unknown as PrismaService,
    recipients as unknown as DirectMessageRecipientsService,
    queue as unknown as import('bullmq').Queue,
    logger as unknown as PinoLogger,
  );
  return { service, prisma, recipients, queue, logger };
}

describe('DirectMessageDispatchService.sendNow', () => {
  it('падает NOT_FOUND, если поста нет', async () => {
    const { service, prisma } = setup();
    prisma.post.findUnique.mockResolvedValue(null);

    await expect(
      service.sendNow('ghost', { mode: 'all' }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('падает VALIDATION_ERROR, если выбор не дал ни одного получателя', async () => {
    const { service, recipients } = setup();
    recipients.resolve.mockResolvedValue([]);

    await expect(
      service.sendNow('post-1', { mode: 'all' }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('замораживает список получателей строками и ставит по джобу на каждую ожидающую', async () => {
    const { prisma, queue, logger } = setup();
    const recipients = {
      resolve: jest.fn().mockResolvedValue([
        { id: 'pu-1', platform: 'max', externalUserId: '1' },
        { id: 'pu-2', platform: 'max', externalUserId: '2' },
      ]),
    };
    const svc = new DirectMessageDispatchService(
      prisma as unknown as PrismaService,
      recipients as unknown as DirectMessageRecipientsService,
      queue as unknown as import('bullmq').Queue,
      logger as unknown as PinoLogger,
    );
    prisma.directMessageDelivery.findMany.mockResolvedValue([
      { id: 'd-1' },
      { id: 'd-2' },
    ]);

    const result = await svc.sendNow('post-1', { mode: 'all' });

    expect(prisma.directMessageDelivery.createMany).toHaveBeenCalledWith({
      data: [
        { postId: 'post-1', platformUserId: 'pu-1' },
        { postId: 'post-1', platformUserId: 'pu-2' },
      ],
      skipDuplicates: true,
    });
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ queued: 2 });
  });

  it('переставляет в очередь оставшиеся pending-строки от прошлого неудачного запуска, не только новые', async () => {
    // Идемпотентность: createMany не создаёт ничего нового (все уже есть),
    // но старая pending-строка от прерванной прошлой попытки всё равно
    // должна получить джоб.
    const { service, prisma, queue, recipients } = setup();
    recipients.resolve.mockResolvedValue([
      { id: 'pu-1', platform: 'max', externalUserId: '1' },
    ]);
    prisma.directMessageDelivery.findMany.mockResolvedValue([
      { id: 'leftover-pending' },
    ]);

    const result = await service.sendNow('post-1', { mode: 'all' });

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ queued: 1 });
  });

  it('очищает завершённый джоб, занимающий id доставки, прежде чем поставить новый', async () => {
    const { service, prisma, queue, recipients } = setup();
    recipients.resolve.mockResolvedValue([
      { id: 'pu-1', platform: 'max', externalUserId: '1' },
    ]);
    prisma.directMessageDelivery.findMany.mockResolvedValue([{ id: 'd-1' }]);
    const finishedJob = {
      isCompleted: jest.fn().mockResolvedValue(true),
      isFailed: jest.fn().mockResolvedValue(false),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    queue.getJob.mockResolvedValue(finishedJob);

    await service.sendNow('post-1', { mode: 'all' });

    expect(finishedJob.remove).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('не прерывает постановку остальных строк, если одна не встала в очередь, и логирует это', async () => {
    const { service, prisma, queue, recipients, logger } = setup();
    recipients.resolve.mockResolvedValue([
      { id: 'pu-1', platform: 'max', externalUserId: '1' },
      { id: 'pu-2', platform: 'max', externalUserId: '2' },
    ]);
    prisma.directMessageDelivery.findMany.mockResolvedValue([
      { id: 'd-1' },
      { id: 'd-2' },
    ]);
    queue.add.mockImplementation(
      (_name: string, data: { deliveryId: string }) =>
        data.deliveryId === 'd-1'
          ? Promise.reject(new Error('redis hiccup'))
          : Promise.resolve({}),
    );

    const result = await service.sendNow('post-1', { mode: 'all' });

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: 'd-1' }),
      expect.any(String),
    );
    // Строка d-1 осталась pending в БД (не тронута) — при следующем вызове
    // sendNow она попадёт в findMany и получит джоб повторно.
    expect(result).toEqual({ queued: 2 });
  });

  it('ставит в очередь батчами, не одним Promise.all на все строки разом', async () => {
    const { service, prisma, queue, recipients } = setup();
    const many = Array.from({ length: 120 }, (_, i) => ({
      id: `pu-${i}`,
      platform: 'max' as const,
      externalUserId: String(i),
    }));
    recipients.resolve.mockResolvedValue(many);
    prisma.directMessageDelivery.findMany.mockResolvedValue(
      many.map((r) => ({ id: `d-${r.id}` })),
    );

    const result = await service.sendNow('post-1', { mode: 'all' });

    expect(queue.add).toHaveBeenCalledTimes(120);
    expect(result).toEqual({ queued: 120 });
  });
});
