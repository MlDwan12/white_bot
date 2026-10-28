import { AppException } from '../common/app-exception';
import { ErrorCode } from '../common/error-code.enum';

/**
 * Расписание для человека и расписание для `cron-parser` — не одно и то же.
 *
 * Внутри шаблон всегда хранит пятипольное cron-выражение; форма панели даёт
 * выбрать «ежедневно в 10:00» и собирает строку сама. Своё выражение при
 * этом остаётся: пресеты покрывают три частых случая, а не весь cron, и
 * загонять человека в них значило бы отнять то, что API уже умеет.
 *
 * Разбор в обратную сторону нужен карточке: форму правки надо открыть в том
 * же виде, в каком её заполняли. Что не раскладывается на пресет —
 * показывается как своё выражение, а не подгоняется под ближайший.
 */
export type SchedulePreset = 'daily' | 'weekly' | 'monthly' | 'custom';

export interface ScheduleForm {
  mode: SchedulePreset;
  /** «10:00» — в том виде, в каком его принимает `input type="time"`. */
  time: string;
  /** 0 — воскресенье, как в cron. */
  weekday: number;
  monthday: number;
  custom: string;
}

export const DEFAULT_SCHEDULE: ScheduleForm = {
  mode: 'daily',
  time: '10:00',
  weekday: 1,
  monthday: 1,
  custom: '',
};

/**
 * Числа позже 28-го в пресет не попадают намеренно: `0 10 31 * *` пропускает
 * короткие месяцы целиком, и «ежемесячно» означало бы семь раз в год. Кому
 * нужно именно это — пишет своё выражение и видит, что делает.
 */
export const MAX_PRESET_MONTHDAY = 28;

export function buildCron(form: ScheduleForm): string {
  if (form.mode === 'custom') {
    const rule = form.custom.trim();
    if (!rule) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Впишите cron-выражение или выберите готовое расписание',
      );
    }
    return rule;
  }

  const { hour, minute } = parseTime(form.time);
  switch (form.mode) {
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekly':
      return `${minute} ${hour} * * ${requireWeekday(form.weekday)}`;
    case 'monthly':
      return `${minute} ${hour} ${requireMonthday(form.monthday)} * *`;
  }
}

/** Раскладывает правило обратно на поля формы; иначе — «своё выражение». */
export function parseCron(rule: string): ScheduleForm {
  const fields = rule.trim().split(/\s+/);
  const custom: ScheduleForm = {
    ...DEFAULT_SCHEDULE,
    mode: 'custom',
    custom: rule,
  };
  if (fields.length !== 5) {
    return custom;
  }

  const [minute, hour, monthday, month, weekday] = fields;
  // Только простые числа: `*/15`, `1-5` и `1,4` — тоже валидный cron, но
  // пресетом они не выражаются, и показать их полем «время» значило бы
  // соврать о том, когда пост выйдет.
  if (!isNumber(minute) || !isNumber(hour) || month !== '*') {
    return custom;
  }
  const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
  if (Number(hour) > 23 || Number(minute) > 59) {
    return custom;
  }

  if (monthday === '*' && weekday === '*') {
    return { ...DEFAULT_SCHEDULE, mode: 'daily', time };
  }
  if (monthday === '*' && isNumber(weekday) && Number(weekday) <= 6) {
    return {
      ...DEFAULT_SCHEDULE,
      mode: 'weekly',
      time,
      weekday: Number(weekday),
    };
  }
  if (
    weekday === '*' &&
    isNumber(monthday) &&
    Number(monthday) >= 1 &&
    Number(monthday) <= MAX_PRESET_MONTHDAY
  ) {
    return {
      ...DEFAULT_SCHEDULE,
      mode: 'monthly',
      time,
      monthday: Number(monthday),
    };
  }
  return custom;
}

/**
 * Совпадают ли два расписания **по смыслу** — то, что видит форма, а не
 * строка cron.
 *
 * Нужно панели при сохранении: форма пересобирает правило из полей, и
 * шаблон, заведённый через API с `0 09 * * *`, вернулся бы как `0 9 * * *`.
 * Сервис сравнивает правило строкой, увидел бы в этом смену расписания и
 * пересчитал бы следующий запуск от текущего момента — правка опечатки за
 * минуты до окна молча съела бы публикацию. Если по смыслу ничего не
 * изменилось, панель отдаёт сохранённую строку как есть.
 */
export function sameSchedule(a: ScheduleForm, b: ScheduleForm): boolean {
  if (a.mode !== b.mode) {
    return false;
  }
  switch (a.mode) {
    case 'daily':
      return a.time === b.time;
    case 'weekly':
      return a.time === b.time && a.weekday === b.weekday;
    case 'monthly':
      return a.time === b.time && a.monthday === b.monthday;
    case 'custom':
      return a.custom.trim() === b.custom.trim();
  }
}

export const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: 'понедельник' },
  { value: 2, label: 'вторник' },
  { value: 3, label: 'среда' },
  { value: 4, label: 'четверг' },
  { value: 5, label: 'пятница' },
  { value: 6, label: 'суббота' },
  // Воскресенье в cron — ноль, и в конце списка оно стоит потому, что неделя
  // у нас начинается с понедельника.
  { value: 0, label: 'воскресенье' },
];

/** Расписание словами — для списка, где cron-строка ничего не объясняет. */
export function describeSchedule(rule: string): string {
  const form = parseCron(rule);
  switch (form.mode) {
    case 'daily':
      return `ежедневно в ${form.time}`;
    case 'weekly': {
      const day = WEEKDAYS.find((d) => d.value === form.weekday);
      return `еженедельно, ${day?.label ?? form.weekday}, в ${form.time}`;
    }
    case 'monthly':
      return `ежемесячно, ${form.monthday}-го, в ${form.time}`;
    case 'custom':
      return rule;
  }
}

function parseTime(value: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  // Браузер шлёт из `type="time"` ровно «ЧЧ:ММ», но форма доходит и мимо
  // него — а `NaN` уехал бы в правило строкой «NaN NaN * * *», которое
  // cron-parser отверг бы уже сообщением про своё внутреннее устройство.
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour > 23 ||
    minute > 59
  ) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      `Не удалось разобрать время «${value}» — нужен вид ЧЧ:ММ`,
    );
  }
  return { hour, minute };
}

function requireWeekday(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 6) {
    throw new AppException(ErrorCode.VALIDATION_ERROR, 'Неверный день недели');
  }
  return value;
}

function requireMonthday(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_PRESET_MONTHDAY) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      `Число месяца — от 1 до ${MAX_PRESET_MONTHDAY}; для остальных впишите своё выражение`,
    );
  }
  return value;
}

function isNumber(value: string): boolean {
  return /^\d{1,2}$/.test(value);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
