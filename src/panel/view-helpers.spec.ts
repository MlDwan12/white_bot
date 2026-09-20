import { PostStatus } from '../generated/prisma/enums';
import { formatDate, statusColor, statusLabel } from './view-helpers';

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
});
