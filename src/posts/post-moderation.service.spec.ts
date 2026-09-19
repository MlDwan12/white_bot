import { PinoLogger } from 'nestjs-pino';
import { ErrorCode } from '../common/error-code.enum';
import { PrismaService } from '../prisma/prisma.service';
import { PostSender } from './post-sender';
import { PostsService } from './posts.service';
import {
  PostModerationService,
  autoDeleteDueAt,
} from './post-moderation.service';

const POST_ID = '11111111-1111-4111-8111-111111111111';

const delivery = (overrides: Record<string, unknown> = {}) => ({
  id: 'd1',
  autoDeleteAttempts: 0,
  postId: POST_ID,
  groupId: 'g1',
  status: 'sent',
  externalMessageId: 'mid.1',
  sentAt: new Date('2026-09-20T10:00:00Z'),
  deletedAt: null,
  group: { id: 'g1', title: 'Канал', platform: 'max' },
  ...overrides,
});

function setup(
  options: {
    deliveries?: Record<string, unknown>[];
    post?: Record<string, unknown> | null;
  } = {},
) {
  const prisma = {
    post: {
      findUnique: jest.fn().mockResolvedValue(
        options.post === undefined
          ? {
              id: POST_ID,
              status: 'sent',
              autoDeleteAt: null,
              autoDeleteAfterMinutes: null,
            }
          : options.post,
      ),
      update: jest.fn().mockResolvedValue({
        id: POST_ID,
        text: 'новый текст',
        vkTextOverride: null,
        maxTextOverride: null,
        autoDeleteAt: null,
        autoDeleteAfterMinutes: null,
        attachments: [],
      }),
    },
    postDelivery: {
      findMany: jest.fn().mockResolvedValue(options.deliveries ?? [delivery()]),
      update: jest.fn().mockResolvedValue({}),
      // Дренаж активных доставок после стопа: по умолчанию их нет.
      count: jest.fn().mockResolvedValue(0),
    },
    contestParticipant: { count: jest.fn().mockResolvedValue(0) },
  };
  const sender = {
    delete: jest.fn().mockResolvedValue(undefined),
    edit: jest.fn().mockResolvedValue(undefined),
  };
  const posts = { stopPost: jest.fn().mockResolvedValue(undefined) };
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as PinoLogger;

  const service = new PostModerationService(
    prisma as unknown as PrismaService,
    sender as unknown as PostSender,
    posts as unknown as PostsService,
    logger,
  );
  return { service, prisma, sender, posts };
}

/** Читает `data` последнего обновления доставки. */
const lastUpdate = (prisma: ReturnType<typeof setup>['prisma']) => {
  const calls = prisma.postDelivery.update.mock.calls as unknown[][];
  return (calls[calls.length - 1][0] as { data: Record<string, unknown> }).data;
};

/** Собирает `data` всех обновлений доставок. */
const allUpdates = (prisma: ReturnType<typeof setup>['prisma']) =>
  (prisma.postDelivery.update.mock.calls as unknown[][]).map(
    (call) => (call[0] as { data: Record<string, unknown> }).data,
  );

describe('PostModerationService.deletePublished', () => {
  it('deletes the message and marks the delivery', async () => {
    const { service, sender, prisma } = setup();

    const outcome = await service.deletePublished(POST_ID);

    expect(sender.delete).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'g1' }),
      'mid.1',
    );
    expect(outcome.succeeded).toBe(1);
    expect(lastUpdate(prisma).deletedAt).toBeInstanceOf(Date);
  });

  it('clears the auto-delete deadline once deleted', async () => {
    const { service, prisma } = setup();

    await service.deletePublished(POST_ID);

    // Оставленная дата заставляла бы сверщик возвращаться к этой строке
    // снова и снова, пытаясь удалить уже удалённое.
    expect(lastUpdate(prisma).autoDeleteDueAt).toBeNull();
  });

  it('keeps going when one group fails and reports which', async () => {
    const { service, sender } = setup({
      deliveries: [
        delivery(),
        delivery({
          id: 'd2',
          groupId: 'g2',
          group: { id: 'g2', title: 'Второй', platform: 'max' },
        }),
      ],
    });
    sender.delete
      .mockRejectedValueOnce(new Error('сообщение слишком старое'))
      .mockResolvedValueOnce(undefined);

    const outcome = await service.deletePublished(POST_ID);

    // Жалоба касается одной площадки — остальные не должны страдать.
    expect(outcome.succeeded).toBe(1);
    expect(outcome.failed).toEqual([
      { groupId: 'g1', groupTitle: 'Канал', error: 'сообщение слишком старое' },
    ]);
  });

  it('deletes only the chosen groups', async () => {
    const { service, prisma } = setup();

    await service.deletePublished(POST_ID, ['g2']);

    const { where } = (
      prisma.postDelivery.findMany.mock.calls as unknown[][]
    )[0][0] as { where: { groupId?: { in: string[] } } };
    expect(where.groupId).toEqual({ in: ['g2'] });
  });

  it('says so when there is nothing published to delete', async () => {
    const { service } = setup({ deliveries: [] });

    await expect(service.deletePublished(POST_ID)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });
});

describe('PostModerationService.editPublished', () => {
  it('stops an in-flight campaign before saving the new text', async () => {
    const { service, posts, prisma } = setup({
      post: {
        id: POST_ID,
        status: 'sending',
        autoDeleteAt: null,
        autoDeleteAfterMinutes: null,
      },
    });

    await service.editPublished(POST_ID, { text: 'новый текст' });

    // Иначе часть групп получила бы старый текст, а часть новый, и кампания
    // навсегда осталась бы с двумя версиями.
    expect(posts.stopPost.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.post.update.mock.invocationCallOrder[0],
    );
  });

  it('does not stop a campaign that already finished', async () => {
    const { service, posts } = setup();

    await service.editPublished(POST_ID, { text: 'новый текст' });

    expect(posts.stopPost).not.toHaveBeenCalled();
  });

  it('pushes the new content into every sent delivery', async () => {
    const { service, sender } = setup({
      deliveries: [
        delivery(),
        delivery({ id: 'd2', externalMessageId: 'mid.2' }),
      ],
    });

    const outcome = await service.editPublished(POST_ID, { text: 'новый' });

    expect(sender.edit).toHaveBeenCalledTimes(2);
    expect(outcome.succeeded).toBe(2);
  });

  it('records a per-group failure instead of failing the whole edit', async () => {
    const { service, sender } = setup();
    sender.edit.mockRejectedValue(new Error('VK не выдал права'));

    const outcome = await service.editPublished(POST_ID, { text: 'новый' });

    expect(outcome.succeeded).toBe(0);
    expect(outcome.failed[0].error).toBe('VK не выдал права');
  });

  it('keeps the contest button alive when editing the announcement', async () => {
    const { service, prisma, sender } = setup();
    prisma.post.update.mockResolvedValue({
      id: POST_ID,
      text: 'исправленная опечатка',
      vkTextOverride: null,
      maxTextOverride: null,
      autoDeleteAt: null,
      autoDeleteAfterMinutes: null,
      attachments: [],
      contest: { id: 'c1', joinButtonLabel: 'Участвовать' },
    });
    prisma.contestParticipant.count.mockResolvedValue(12);

    await service.editPublished(POST_ID, { text: 'исправленная опечатка' });

    // В MAX клавиатура — такое же вложение: правка без неё снесла бы кнопку
    // «Участвовать» во всех группах, и записаться стало бы негде.
    const [, , , , button] = sender.edit.mock.calls[0] as unknown[];
    expect(button).toEqual({ contestId: 'c1', label: 'Участвовать (12)' });
  });

  it('waits for in-flight deliveries before taking its snapshot', async () => {
    const { service, prisma } = setup({
      post: {
        id: POST_ID,
        status: 'sending',
        autoDeleteAt: null,
        autoDeleteAfterMinutes: null,
      },
    });
    prisma.postDelivery.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await service.editPublished(POST_ID, { text: 'новый' });

    // Доставка, чей вызов уже в полёте, допишется `sent` после снимка — и
    // осталась бы со старым текстом навсегда, вопреки смыслу правки.
    expect(prisma.postDelivery.count).toHaveBeenCalledTimes(2);
  });

  it('recomputes the auto-delete deadline even when the platform edit fails', async () => {
    const { service, prisma, sender } = setup();
    prisma.post.update.mockResolvedValue({
      id: POST_ID,
      text: 'тот же',
      vkTextOverride: null,
      maxTextOverride: null,
      autoDeleteAt: new Date('2026-09-20T18:00:00Z'),
      autoDeleteAfterMinutes: null,
      attachments: [],
      contest: null,
    });
    sender.edit.mockRejectedValue(new Error('VK не выдал права'));

    await service.editPublished(POST_ID, {
      autoDeleteAt: new Date('2026-09-20T18:00:00Z'),
    });

    // Срок не требует похода на платформу. Привяжи его к успеху правки — и
    // правка ради одной лишь смены срока (в VK она сейчас всегда падает) не
    // меняла бы ничего вовсе.
    expect(allUpdates(prisma)[0].autoDeleteDueAt).toEqual(
      new Date('2026-09-20T18:00:00Z'),
    );
  });

  it('refuses to edit a recurring template', async () => {
    const { service } = setup({
      post: { id: POST_ID, status: 'draft', recurrenceRule: '0 10 * * *' },
    });

    // Иначе правка тихо переписала бы шаблон и вернула «успешно ничего»:
    // доставок у него нет.
    await expect(
      service.editPublished(POST_ID, { text: 'x' }),
    ).rejects.toMatchObject({ code: ErrorCode.REQUEST_ERROR });
  });

  it('refuses to edit a post that does not exist', async () => {
    const { service } = setup({ post: null });

    await expect(
      service.editPublished(POST_ID, { text: 'x' }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });
});

describe('PostModerationService.sweepAutoDeletions', () => {
  const now = new Date('2026-09-20T12:00:00Z');

  it('deletes what is due and counts it', async () => {
    const { service, sender } = setup();

    expect(await service.sweepAutoDeletions(now)).toBe(1);
    expect(sender.delete).toHaveBeenCalled();
  });

  it('asks only for deliveries whose deadline has passed', async () => {
    const { service, prisma } = setup();

    await service.sweepAutoDeletions(now);

    const { where } = (
      prisma.postDelivery.findMany.mock.calls as unknown[][]
    )[0][0] as {
      where: { status: string; deletedAt: null; autoDeleteDueAt: unknown };
    };
    expect(where.status).toBe('sent');
    expect(where.deletedAt).toBeNull();
    expect(where.autoDeleteDueAt).toEqual({ not: null, lte: now });
  });

  it('takes the longest-overdue deliveries first', async () => {
    const { service, prisma } = setup();

    await service.sweepAutoDeletions(now);

    // Без явного порядка строка, которую удалить нельзя в принципе,
    // навсегда занимала бы место в окне и вытесняла удаляемые.
    const { orderBy } = (
      prisma.postDelivery.findMany.mock.calls as unknown[][]
    )[0][0] as { orderBy: unknown };
    expect(orderBy).toEqual({ autoDeleteDueAt: 'asc' });
  });

  it('gives up after repeated failures so the row leaves the window', async () => {
    const { service, sender, prisma } = setup({
      deliveries: [delivery({ autoDeleteAttempts: 4 })],
    });
    sender.delete.mockRejectedValue(new Error('VK не выдал права'));

    await service.sweepAutoDeletions(now);

    expect(lastUpdate(prisma).autoDeleteDueAt).toBeNull();
    expect(lastUpdate(prisma).autoDeleteAttempts).toBe(5);
  });

  it('stops chasing a delivery whose message id was lost', async () => {
    const { service, sender, prisma } = setup({
      deliveries: [delivery({ externalMessageId: null })],
    });

    await service.sweepAutoDeletions(now);

    expect(sender.delete).not.toHaveBeenCalled();
    // Иначе строка занимала бы слот в окне на каждом проходе, ничего не
    // двигая и ничего не сообщая.
    expect(lastUpdate(prisma).autoDeleteDueAt).toBeNull();
  });

  it('survives a database failure while recording the outcome', async () => {
    const { service, prisma } = setup();
    prisma.postDelivery.update.mockRejectedValue(new Error('база недоступна'));

    // Сообщение с платформы уже удалено; уронить здесь всё — значит потерять
    // сводку и знание о том, что удаление состоялось.
    await expect(service.sweepAutoDeletions(now)).resolves.toBe(1);
  });

  it('keeps the deadline when deletion fails, so the next pass retries', async () => {
    const { service, sender, prisma } = setup();
    sender.delete.mockRejectedValue(new Error('сеть недоступна'));

    expect(await service.sweepAutoDeletions(now)).toBe(0);
    // Причина может быть временной; снять срок значило бы оставить пост
    // висеть вечно вопреки обещанию.
    expect(lastUpdate(prisma).autoDeleteDueAt).toBeUndefined();
    expect(lastUpdate(prisma).error).toBe('сеть недоступна');
  });
});

describe('autoDeleteDueAt', () => {
  const sentAt = new Date('2026-09-20T10:00:00Z');

  it('prefers an absolute date over a relative one', () => {
    const absolute = new Date('2026-09-20T18:00:00Z');

    // «В 18:00» звучит определённее, чем «через час»; выбирать между ними
    // по какому-то другому правилу было бы сюрпризом.
    expect(
      autoDeleteDueAt(
        { autoDeleteAt: absolute, autoDeleteAfterMinutes: 60 },
        sentAt,
      ),
    ).toBe(absolute);
  });

  it('counts a relative deadline from this delivery, not the campaign', () => {
    expect(
      autoDeleteDueAt(
        { autoDeleteAt: null, autoDeleteAfterMinutes: 90 },
        sentAt,
      ),
    ).toEqual(new Date('2026-09-20T11:30:00Z'));
  });

  it('has no deadline when the post asks for none', () => {
    expect(
      autoDeleteDueAt(
        { autoDeleteAt: null, autoDeleteAfterMinutes: null },
        sentAt,
      ),
    ).toBeNull();
  });

  it('has no relative deadline without a send time', () => {
    expect(
      autoDeleteDueAt({ autoDeleteAt: null, autoDeleteAfterMinutes: 60 }, null),
    ).toBeNull();
  });
});
