import { AppException } from '../common/app-exception';
import { assertValidRecurrence, nextRunAfter } from './recurrence';

describe('nextRunAfter', () => {
  it('reads the expression in the given timezone, not the server one', () => {
    const from = new Date('2026-09-18T00:00:00.000Z');

    const moscow = nextRunAfter('0 10 * * *', 'Europe/Moscow', from);
    const utc = nextRunAfter('0 10 * * *', 'UTC', from);

    // 10:00 in Moscow is 07:00 UTC. Without the timezone the post would go out
    // three hours late every day, and nothing in the logs would say why.
    expect(moscow.toISOString()).toBe('2026-09-18T07:00:00.000Z');
    expect(utc.toISOString()).toBe('2026-09-18T10:00:00.000Z');
  });

  it('always moves forward, so a long outage cannot replay missed windows', () => {
    // Pretend the app was down for a day with an hourly schedule.
    const downSince = new Date('2026-09-17T09:00:00.000Z');
    const now = new Date('2026-09-18T09:30:00.000Z');

    const next = nextRunAfter('0 * * * *', 'UTC', now);

    // Computed from now, not from the last missed window: 24 posts arriving
    // at once in real communities could not be taken back, since VK's
    // wall.delete is unavailable.
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.getTime()).toBeGreaterThan(downSince.getTime());
    expect(next.toISOString()).toBe('2026-09-18T10:00:00.000Z');
  });

  it('returns a time strictly after the reference, never the reference itself', () => {
    const exactlyOnTheHour = new Date('2026-09-18T10:00:00.000Z');

    const next = nextRunAfter('0 * * * *', 'UTC', exactlyOnTheHour);

    // Otherwise a sweep landing exactly on the boundary would fire the same
    // window twice.
    expect(next.toISOString()).toBe('2026-09-18T11:00:00.000Z');
  });

  it('handles a weekly rule', () => {
    const wednesday = new Date('2026-09-16T12:00:00.000Z');

    // Mondays at 10:00 Moscow = 07:00 UTC.
    expect(
      nextRunAfter('0 10 * * 1', 'Europe/Moscow', wednesday).toISOString(),
    ).toBe('2026-09-21T07:00:00.000Z');
  });
});

describe('assertValidRecurrence', () => {
  it('accepts an ordinary expression', () => {
    expect(() => assertValidRecurrence('*/15 * * * *', 'UTC')).not.toThrow();
  });

  it.each(['не cron', '99 * * * *', ''])(
    'rejects %p at save time rather than at first firing',
    (rule) => {
      // A typo caught here is a 400 the admin sees; caught at firing time it
      // is a log line nobody watches, and the template simply never posts.
      expect(() => assertValidRecurrence(rule, 'UTC')).toThrow(AppException);
    },
  );

  it('rejects an unknown timezone', () => {
    expect(() => assertValidRecurrence('0 10 * * *', 'Mars/Olympus')).toThrow(
      AppException,
    );
  });

  it('names the offending rule in the message', () => {
    expect(() => assertValidRecurrence('плохое', 'UTC')).toThrow(/плохое/);
  });

  it('rejects a six-field expression instead of reading the extra field as seconds', () => {
    // cron-parser accepts `0 10 * * * *` and reads it as "second 0, minute 10,
    // every hour". The admin is told the format is five-field, so this is the
    // natural way to write "10:00 daily" — and it would publish 24 posts a day
    // onto walls wall.delete cannot clean up.
    expect(() => assertValidRecurrence('0 10 * * * *', 'UTC')).toThrow(
      AppException,
    );
    // The five-field spelling of the same intent still works.
    expect(
      nextRunAfter(
        '0 10 * * *',
        'UTC',
        new Date('2026-09-18T00:00:00.000Z'),
      ).toISOString(),
    ).toBe('2026-09-18T10:00:00.000Z');
  });

  it('rejects a rule that parses but can never fire', () => {
    // `.next()` raises "Out of the timespan range" for 30 February. Outside the
    // error wrapper this escaped as a raw Error — a 500 instead of the 400 that
    // tells the admin what is wrong.
    expect(() => assertValidRecurrence('0 0 30 2 *', 'UTC')).toThrow(
      AppException,
    );
  });

  it('rejects a blank timezone instead of quietly using the server zone', () => {
    // cron-parser treats a falsy tz as "server local" (or dies inside CronDate
    // with an unreadable message), so "10:00 Moscow" would silently become
    // 10:00 wherever the container happens to run.
    // Asserted on the message, not just on "it throws": cron-parser already
    // died here on its own, but with `CronDate: unhandled timestamp: Sat Sep
    // 19 2026 …` — parser internals shown to an admin who typed a form field.
    for (const blank of ['', '   ']) {
      expect(() => assertValidRecurrence('0 10 * * *', blank)).toThrow(
        AppException,
      );
      expect(() => assertValidRecurrence('0 10 * * *', blank)).toThrow(
        'Часовой пояс не задан',
      );
    }
  });
});
