import { utcToZoned, zonedToUtc } from './zoned-time';

describe('zonedToUtc', () => {
  it('reads a wall-clock time in the given zone, not the server one', () => {
    // 18:00 в Москве — это 15:00 UTC, независимо от того, где стоит сервер.
    expect(zonedToUtc('2026-09-20T18:00', 'Europe/Moscow').toISOString()).toBe(
      '2026-09-20T15:00:00.000Z',
    );
  });

  it('handles a zone with daylight saving in summer', () => {
    // Берлин летом — UTC+2.
    expect(zonedToUtc('2026-07-01T12:00', 'Europe/Berlin').toISOString()).toBe(
      '2026-07-01T10:00:00.000Z',
    );
  });

  it('handles the same zone in winter', () => {
    // Он же зимой — UTC+1. Одна формула обязана давать оба ответа, иначе
    // половину года расписание уезжает на час.
    expect(zonedToUtc('2026-01-15T12:00', 'Europe/Berlin').toISOString()).toBe(
      '2026-01-15T11:00:00.000Z',
    );
  });

  it('accepts a value with seconds', () => {
    expect(zonedToUtc('2026-09-20T18:00:30', 'UTC').toISOString()).toBe(
      '2026-09-20T18:00:30.000Z',
    );
  });

  it('is a no-op for UTC', () => {
    expect(zonedToUtc('2026-09-20T18:00', 'UTC').toISOString()).toBe(
      '2026-09-20T18:00:00.000Z',
    );
  });

  it('rejects anything that is not a local date-time', () => {
    // Иначе подставленное значение доехало бы до Prisma как Invalid Date и
    // вернулось пятисоткой вместо внятного отказа.
    for (const bad of ['', 'вчера', '2026-09-20', '2026-13-45T99:99']) {
      expect(Number.isNaN(zonedToUtc(bad, 'UTC').getTime())).toBe(true);
    }
  });
});

describe('utcToZoned', () => {
  it('is the inverse of zonedToUtc', () => {
    const local = '2026-09-20T18:00';
    const roundTripped = utcToZoned(
      zonedToUtc(local, 'Europe/Moscow'),
      'Europe/Moscow',
    );
    expect(roundTripped).toBe(local);
  });

  it('handles a zone with daylight saving in summer', () => {
    expect(
      utcToZoned(new Date('2026-07-01T10:00:00.000Z'), 'Europe/Berlin'),
    ).toBe('2026-07-01T12:00');
  });

  it('handles the same zone in winter', () => {
    expect(
      utcToZoned(new Date('2026-01-15T11:00:00.000Z'), 'Europe/Berlin'),
    ).toBe('2026-01-15T12:00');
  });

  it('is a no-op for UTC', () => {
    expect(utcToZoned(new Date('2026-09-20T18:00:00.000Z'), 'UTC')).toBe(
      '2026-09-20T18:00',
    );
  });
});
