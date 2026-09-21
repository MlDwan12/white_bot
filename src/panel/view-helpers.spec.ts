import { PostStatus } from '../generated/prisma/enums';
import { GroupStatus, PostDeliveryStatus } from '../generated/prisma/enums';
import {
  deliveryColor,
  deliveryLabel,
  groupColor,
  groupLabel,
  formatDate,
  statusColor,
  statusLabel,
  groupKindLabel,
  mediaKindLabel,
  platformColor,
  platformLabel,
} from './view-helpers';

describe('view-helpers', () => {
  it('has a label and a colour for every post status', () => {
    // Список берётся из enum в схеме, а не из самих таблиц: иначе проверка
    // сводилась бы к «таблица равна себе» и новый статус тихо показывался бы
    // человеку сырым именем из базы.
    for (const status of Object.values(PostStatus)) {
      expect(statusLabel(status)).not.toBe(status);
      expect(statusColor(status)).not.toBe('');
    }
  });

  it('does not paint a finished campaign the same as a broken one', () => {
    expect(statusColor('sent')).not.toBe(statusColor('partially_failed'));
    expect(statusColor('sent')).not.toBe(statusColor('stopped'));
  });

  it('formats a date the way a Russian reader expects', () => {
    expect(formatDate(new Date('2026-09-20T08:05:00Z'))).toMatch(
      /^20\.09\.2026/,
    );
  });

  it('has a label and a colour for every delivery status', () => {
    for (const status of Object.values(PostDeliveryStatus)) {
      const delivery = { status, deletedAt: null, autoDeleteDueAt: null };
      expect(deliveryLabel(delivery)).not.toBe(status);
      expect(deliveryColor(delivery)).not.toBe('');
    }
  });

  it('shows a deleted message as deleted, whatever its status was', () => {
    // Удаление — не статус, а то, что случилось с сообщением после отправки.
    // Факт отправки при этом остаётся историей, и статус его хранит.
    const delivery = {
      status: 'sent' as const,
      deletedAt: new Date(),
      autoDeleteDueAt: null,
    };

    expect(deliveryLabel(delivery)).toBe('удалено');
    expect(deliveryColor(delivery)).not.toBe(
      deliveryColor({ ...delivery, deletedAt: null }),
    );
  });

  it('has a label and a colour for every group status', () => {
    for (const status of Object.values(GroupStatus)) {
      expect(groupLabel(status)).not.toBe(status);
      expect(groupColor(status)).not.toBe('');
    }
  });

  it('does not paint a working group like a broken one', () => {
    // Иначе «токен не работает» потерялся бы среди активных, а это как раз
    // то, ради чего на страницу и заходят.
    expect(groupColor('active')).not.toBe(groupColor('token_invalid'));
    expect(groupColor('active')).not.toBe(groupColor('bot_removed'));
  });
});

describe('платформа и виды в интерфейсе', () => {
  it('называет платформы по-человечески', () => {
    // Раньше в списке групп стояло сырое `vk`/`max` в нечитаемой метке, и по
    // ней нельзя было понять, куда уйдёт пост.
    expect(platformLabel('vk')).toBe('VK');
    expect(platformLabel('max')).toBe('MAX');
  });

  it('красит платформы по-разному, чтобы их различал цвет ещё до чтения', () => {
    expect(platformColor('vk')).not.toBe(platformColor('max'));
  });

  it('незнакомую платформу показывает как есть и нейтрально', () => {
    // Новая платформа не должна ронять страницу или прятаться пустой меткой.
    expect(platformLabel('telegram')).toBe('telegram');
    expect(platformColor('telegram')).toBe('secondary');
  });

  it('переводит виды группы и вложения, незнакомое оставляет как есть', () => {
    expect(groupKindLabel('channel')).toBe('канал');
    expect(groupKindLabel('chat')).toBe('чат');
    expect(groupKindLabel('что-то')).toBe('что-то');
    expect(mediaKindLabel('image')).toBe('картинка');
    expect(mediaKindLabel('document')).toBe('документ');
    expect(mediaKindLabel('video')).toBe('видео');
    expect(mediaKindLabel('что-то')).toBe('что-то');
  });
});
