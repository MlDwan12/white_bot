import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { MaxApiClient } from '../max/max-api.client';
import { MaxApiError } from '../max/max-api.error';
import { ContestSubscriptions } from './contest-subscriptions';

const CONTEST_ID = '11111111-1111-4111-8111-111111111111';

function setup(groups: { id: string; externalId: string; title: string }[]) {
  const prisma = {
    contestRequiredGroup: {
      findMany: jest.fn().mockResolvedValue(groups.map((group) => ({ group }))),
    },
  };
  const api = {
    chatMemberIds: jest.fn().mockResolvedValue(new Set<string>()),
    getChat: jest.fn().mockResolvedValue({ link: 'https://max.ru/join/x' }),
  };
  const logger = { setContext: jest.fn(), warn: jest.fn() };
  const service = new ContestSubscriptions(
    prisma as unknown as PrismaService,
    api as unknown as MaxApiClient,
    logger as unknown as PinoLogger,
  );
  return { service, prisma, api, logger };
}

const NEWS = { id: 'g-news', externalId: '-100', title: 'Новости' };
const SHOP = { id: 'g-shop', externalId: '-200', title: 'Магазин' };

describe('ContestSubscriptions', () => {
  it('берёт в условия только активные MAX-группы', async () => {
    const { service, prisma } = setup([]);

    await service.requiredChannels(CONTEST_ID);

    expect(prisma.contestRequiredGroup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          contestId: CONTEST_ID,
          group: { platform: 'max', status: 'active' },
        },
      }),
    );
  });

  it('возвращает только каналы без подписки, со ссылкой для кнопки', async () => {
    const { service, api } = setup([NEWS, SHOP]);
    api.chatMemberIds.mockImplementation((chatId: number) =>
      Promise.resolve(new Set(chatId === -100 ? ['42'] : [])),
    );

    const missing = await service.missingFor(CONTEST_ID, '42');

    expect(missing).toEqual([
      { title: 'Магазин', link: 'https://max.ru/join/x' },
    ]);
    expect(api.chatMemberIds).toHaveBeenCalledWith(-100, [42]);
    // Ссылку спрашиваем только для недостающего канала.
    expect(api.getChat).toHaveBeenCalledTimes(1);
    expect(api.getChat).toHaveBeenCalledWith(-200);
  });

  it('пропускает канал, где бота больше нет, — иначе закрылся бы весь конкурс', async () => {
    const { service, api, logger } = setup([NEWS]);
    api.chatMemberIds.mockRejectedValue(
      new MaxApiError(403, 'chat.denied', 'Chat is not accessible'),
    );

    await expect(service.missingFor(CONTEST_ID, '42')).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('пробрасывает прочие сбои MAX — условие не должно молча отключаться', async () => {
    const { service, api } = setup([NEWS]);
    api.chatMemberIds.mockRejectedValue(
      new MaxApiError(0, 'network.error', 'fetch failed'),
    );

    await expect(service.missingFor(CONTEST_ID, '42')).rejects.toThrow(
      MaxApiError,
    );
  });

  it('ссылку на канал запоминает — не спрашивает MAX на каждое нажатие', async () => {
    const { service, api } = setup([NEWS]);

    await service.missingFor(CONTEST_ID, '42');
    await service.missingFor(CONTEST_ID, '43');

    expect(api.getChat).toHaveBeenCalledTimes(1);
  });

  it('без ссылки на канал всё равно называет его', async () => {
    const { service, api } = setup([NEWS]);
    api.getChat.mockRejectedValue(new Error('timeout'));

    await expect(service.missingFor(CONTEST_ID, '42')).resolves.toEqual([
      { title: 'Новости', link: null },
    ]);
  });

  it('для розыгрыша отмечает тех, кто не подписан хотя бы на один канал', async () => {
    const { service, api } = setup([]);
    api.chatMemberIds.mockImplementation((chatId: number) =>
      Promise.resolve(new Set(chatId === -100 ? ['1', '2'] : ['1', '3'])),
    );

    const unsubscribed = await service.unsubscribedAmong(
      [
        { groupId: NEWS.id, externalId: NEWS.externalId, title: NEWS.title },
        { groupId: SHOP.id, externalId: SHOP.externalId, title: SHOP.title },
      ],
      ['1', '2', '3'],
    );

    expect([...unsubscribed].sort()).toEqual(['2', '3']);
  });

  it('называет каналы, которые при розыгрыше проверить не удалось', async () => {
    // Журнал розыгрыша не должен утверждать, что условие по такому каналу
    // применено к победителям.
    const { service, api } = setup([]);
    api.chatMemberIds.mockImplementation((chatId: number) =>
      chatId === -100
        ? Promise.reject(new MaxApiError(403, 'chat.denied', 'denied'))
        : Promise.resolve(new Set(['1'])),
    );
    const skipped = new Set<string>();

    await service.unsubscribedAmong(
      [
        { groupId: NEWS.id, externalId: NEWS.externalId, title: NEWS.title },
        { groupId: SHOP.id, externalId: SHOP.externalId, title: SHOP.title },
      ],
      ['1'],
      skipped,
    );

    expect([...skipped]).toEqual([NEWS.id]);
  });
});
