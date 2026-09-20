import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { PostsService } from './posts.service';
import { VkUploaderTokenService } from '../vk/vk-uploader-token.service';

const post = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  text: `текст ${id}`,
  status: 'sent',
  createdAt: new Date('2026-09-20T10:00:00Z'),
  scheduledAt: null,
  recurrenceRule: null,
  ...overrides,
});

const count = (postId: string, status: string, n: number) => ({
  postId,
  status,
  _count: { _all: n },
});

function setup(
  posts: Record<string, unknown>[],
  counts: ReturnType<typeof count>[] = [],
) {
  const prisma = {
    post: { findMany: jest.fn().mockResolvedValue(posts) },
    postDelivery: { groupBy: jest.fn().mockResolvedValue(counts) },
  };
  const service = new PostsService(
    prisma as unknown as PrismaService,
    { add: jest.fn() } as never,
    {} as unknown as VkUploaderTokenService,
    { setContext: jest.fn() } as unknown as PinoLogger,
  );
  return { service, prisma };
}

describe('PostsService.listCampaigns', () => {
  it('counts deliveries per status', async () => {
    const { service } = setup(
      [post('p1')],
      [
        count('p1', 'sent', 3),
        count('p1', 'failed', 1),
        count('p1', 'pending', 2),
        count('p1', 'sending', 1),
        count('p1', 'skipped_by_stop', 4),
      ],
    );

    const [campaign] = await service.listCampaigns();

    expect(campaign.sent).toBe(3);
    expect(campaign.failed).toBe(1);
    // «В работе» — это pending и sending вместе: для человека в списке они
    // означают одно и то же, «ещё не доставлено».
    expect(campaign.pending).toBe(3);
    expect(campaign.skipped).toBe(4);
    expect(campaign.total).toBe(11);
  });

  it('reports zeroes for a campaign with no deliveries yet', async () => {
    const { service } = setup([post('p1', { status: 'draft' })]);

    const [campaign] = await service.listCampaigns();

    expect(campaign.total).toBe(0);
    expect(campaign.sent).toBe(0);
  });

  it('does not query deliveries when there are no posts', async () => {
    const { service, prisma } = setup([]);

    expect(await service.listCampaigns()).toEqual([]);
    // `in: []` — бессмысленный запрос, который Prisma всё равно отправит.
    expect(prisma.postDelivery.groupBy).not.toHaveBeenCalled();
  });

  it('leaves recurring templates out of the campaign list', async () => {
    const { service, prisma } = setup([post('p1')]);

    await service.listCampaigns();

    // Шаблоны живут своим списком; смешивать их с кампаниями — значит
    // показывать в истории рассылок то, что ничего не рассылало.
    const { where } = (
      prisma.post.findMany.mock.calls as unknown[][]
    )[0][0] as {
      where: { recurrenceRule: null };
    };
    expect(where.recurrenceRule).toBeNull();
  });

  it('keeps counts from different campaigns apart', async () => {
    const { service } = setup(
      [post('p1'), post('p2')],
      [count('p1', 'sent', 2), count('p2', 'sent', 5)],
    );

    const [first, second] = await service.listCampaigns();

    expect(first.sent).toBe(2);
    expect(second.sent).toBe(5);
  });
});
