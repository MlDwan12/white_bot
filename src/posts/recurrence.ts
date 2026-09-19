import { CronExpressionParser } from 'cron-parser';
import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';

/**
 * Cron handling for recurring templates.
 *
 * Kept as plain functions rather than a service: it has no dependencies and no
 * state, and the reconciler, the service layer and the tests all want the same
 * answer for the same inputs.
 */

/**
 * Next firing strictly after `from`, in the template's own timezone.
 *
 * Missed windows are never replayed: the next time is always computed forward
 * from now, so an app that was down for a day fires once on start rather than
 * publishing a day's worth of posts into real communities at once — which
 * nothing could undo, since VK's wall.delete is unavailable.
 */
export function nextRunAfter(
  recurrenceRule: string,
  timezone: string,
  from: Date = new Date(),
): Date {
  // `.next()` is computed inside the same wrapper as the parse, not after it:
  // cron-parser accepts a rule it can parse but never reach (a date that does
  // not occur, e.g. "0 0 30 2 *") and only raises "Out of the timespan range"
  // here. Left outside, that escaped as a raw Error and turned a bad schedule
  // into a 500 instead of the 400 the admin needs to see.
  return withRecurrenceErrors(recurrenceRule, timezone, () =>
    parse(recurrenceRule, timezone, from).next().toDate(),
  );
}

/**
 * Validates a rule/timezone pair, failing with a readable message.
 *
 * Done when the template is saved, not when it first fires: a typo in a cron
 * expression would otherwise surface hours later as a log line nobody is
 * watching, and the template would simply never publish.
 */
export function assertValidRecurrence(
  recurrenceRule: string,
  timezone: string,
): void {
  // Resolves one occurrence too, for the unreachable-date case above: parsing
  // alone would accept a rule that can never fire.
  nextRunAfter(recurrenceRule, timezone);
}

function parse(
  recurrenceRule: string,
  timezone: string,
  from: Date,
): ReturnType<typeof CronExpressionParser.parse> {
  return CronExpressionParser.parse(recurrenceRule, {
    currentDate: from,
    tz: timezone,
  });
}

function withRecurrenceErrors<T>(
  recurrenceRule: string,
  timezone: string,
  run: () => T,
): T {
  // cron-parser accepts an empty string and quietly reads it as "every
  // minute" — so a blank field would turn into a post every 60 seconds in
  // real communities. Rejected explicitly, because the service is also
  // reachable from places that don't run the HTTP DTO validation.
  const fields = recurrenceRule.trim().split(/\s+/).filter(Boolean);
  if (fields.length === 0) {
    throw new AppException(ErrorCode.VALIDATION_ERROR, 'Расписание не задано');
  }
  // cron-parser also accepts a six-field expression, reading the extra leading
  // field as *seconds*. The admin is told the format is five-field, so the
  // natural six-field spelling of "10:00 daily" — `0 10 * * * *` — parses
  // silently as "at :10 of every hour": 24 posts a day instead of one, onto
  // walls wall.delete cannot clean up. Only five fields are accepted.
  // A blank timezone reaches cron-parser as a falsy `tz`: without a
  // currentDate it silently falls back to the *server's* zone, and with one it
  // dies inside CronDate with "unhandled timestamp". Both are wrong answers to
  // give an admin, so it is named here instead.
  if (timezone.trim().length === 0) {
    throw new AppException(ErrorCode.VALIDATION_ERROR, 'Часовой пояс не задан');
  }
  if (fields.length !== 5) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      `Расписание должно состоять ровно из 5 полей (минуты часы день месяц день-недели), получено ${fields.length}: «${recurrenceRule}»`,
    );
  }

  try {
    return run();
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : 'неизвестная ошибка';
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      `Неверное расписание «${recurrenceRule}» (пояс «${timezone}»): ${reason}`,
    );
  }
}
