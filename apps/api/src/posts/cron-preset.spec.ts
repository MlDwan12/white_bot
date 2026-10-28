import { AppException } from '../common/app-exception';
import {
  DEFAULT_SCHEDULE,
  buildCron,
  describeSchedule,
  parseCron,
  sameSchedule,
} from './cron-preset';

describe('buildCron', () => {
  it('собирает ежедневное расписание', () => {
    expect(
      buildCron({ ...DEFAULT_SCHEDULE, mode: 'daily', time: '10:00' }),
    ).toBe('0 10 * * *');
  });

  it('собирает еженедельное с днём недели', () => {
    expect(
      buildCron({
        ...DEFAULT_SCHEDULE,
        mode: 'weekly',
        time: '09:30',
        weekday: 1,
      }),
    ).toBe('30 9 * * 1');
  });

  it('собирает ежемесячное с числом', () => {
    expect(
      buildCron({
        ...DEFAULT_SCHEDULE,
        mode: 'monthly',
        time: '08:05',
        monthday: 15,
      }),
    ).toBe('5 8 15 * *');
  });

  it('своё выражение отдаётся как есть, без пробелов по краям', () => {
    expect(
      buildCron({
        ...DEFAULT_SCHEDULE,
        mode: 'custom',
        custom: '  */15 * * * *  ',
      }),
    ).toBe('*/15 * * * *');
  });

  it('пустое своё выражение — отказ, а не расписание «каждую минуту»', () => {
    // cron-parser читает пустую строку как «каждую минуту»: незамеченным это
    // дало бы пост в реальные сообщества раз в 60 секунд.
    expect(() =>
      buildCron({ ...DEFAULT_SCHEDULE, mode: 'custom', custom: '   ' }),
    ).toThrow(AppException);
  });

  it('негодное время отвергается до сборки строки', () => {
    // Иначе в правило уехало бы «NaN NaN * * *», и человек получил бы отказ
    // от cron-parser про его внутреннее устройство.
    expect(() => buildCron({ ...DEFAULT_SCHEDULE, time: '25:00' })).toThrow(
      AppException,
    );
    expect(() => buildCron({ ...DEFAULT_SCHEDULE, time: 'вечером' })).toThrow(
      AppException,
    );
  });

  it('число месяца позже 28-го в пресет не пускается', () => {
    // «Ежемесячно 31-го» пропускало бы короткие месяцы целиком — семь раз в
    // год вместо двенадцати.
    expect(() =>
      buildCron({ ...DEFAULT_SCHEDULE, mode: 'monthly', monthday: 31 }),
    ).toThrow(AppException);
  });
});

describe('parseCron', () => {
  it('раскладывает ежедневное обратно на поля формы', () => {
    expect(parseCron('0 10 * * *')).toMatchObject({
      mode: 'daily',
      time: '10:00',
    });
  });

  it('раскладывает еженедельное и ежемесячное', () => {
    expect(parseCron('30 9 * * 1')).toMatchObject({
      mode: 'weekly',
      time: '09:30',
      weekday: 1,
    });
    expect(parseCron('5 8 15 * *')).toMatchObject({
      mode: 'monthly',
      time: '08:05',
      monthday: 15,
    });
  });

  it('выражение, которое пресетом не выражается, остаётся своим', () => {
    // Показать `*/15` полем «время» значило бы соврать о том, когда выйдет
    // пост: подгонять под ближайший пресет нельзя.
    for (const rule of [
      '*/15 * * * *',
      '0 10 * * 1-5',
      '0 10,18 * * *',
      '0 10 31 * *',
    ]) {
      expect(parseCron(rule)).toMatchObject({ mode: 'custom', custom: rule });
    }
  });

  it('шестипольное выражение не притворяется пресетом', () => {
    // Шесть полей cron-parser читает с секундами, и сервис их отвергает —
    // форма не должна показывать такое как «ежедневно».
    expect(parseCron('0 0 10 * * *')).toMatchObject({ mode: 'custom' });
  });

  it('сборка и разбор сходятся друг с другом', () => {
    const form = {
      ...DEFAULT_SCHEDULE,
      mode: 'weekly' as const,
      time: '07:05',
      weekday: 6,
    };

    expect(parseCron(buildCron(form))).toMatchObject({
      mode: 'weekly',
      time: '07:05',
      weekday: 6,
    });
  });
});

describe('describeSchedule', () => {
  it('объясняет пресеты словами', () => {
    expect(describeSchedule('0 10 * * *')).toBe('ежедневно в 10:00');
    expect(describeSchedule('30 9 * * 1')).toBe(
      'еженедельно, понедельник, в 09:30',
    );
    expect(describeSchedule('5 8 15 * *')).toBe('ежемесячно, 15-го, в 08:05');
  });

  it('своё выражение показывается как есть', () => {
    expect(describeSchedule('*/15 * * * *')).toBe('*/15 * * * *');
  });
});

describe('sameSchedule', () => {
  it('запись правила с ведущим нулём совпадает по смыслу с канонической', () => {
    // Шаблон, заведённый через API с `0 09 * * *`, форма вернёт как
    // `0 9 * * *`. Строкой это разные правила, а по смыслу — одно и то же:
    // иначе правка опечатки пересчитывала бы следующий запуск и могла съесть
    // публикацию, назначенную через минуты.
    expect(sameSchedule(parseCron('0 09 * * *'), parseCron('0 9 * * *'))).toBe(
      true,
    );
  });

  it('разное время, день или число — разные расписания', () => {
    expect(sameSchedule(parseCron('0 9 * * *'), parseCron('0 10 * * *'))).toBe(
      false,
    );
    expect(sameSchedule(parseCron('0 9 * * 1'), parseCron('0 9 * * 2'))).toBe(
      false,
    );
    expect(sameSchedule(parseCron('0 9 1 * *'), parseCron('0 9 2 * *'))).toBe(
      false,
    );
  });

  it('разные режимы — разные расписания, даже если час совпадает', () => {
    expect(sameSchedule(parseCron('0 9 * * *'), parseCron('0 9 * * 1'))).toBe(
      false,
    );
  });

  it('своё выражение сравнивается без пробелов по краям', () => {
    expect(
      sameSchedule(parseCron('*/15 * * * *'), {
        ...DEFAULT_SCHEDULE,
        mode: 'custom',
        custom: '  */15 * * * *  ',
      }),
    ).toBe(true);
    expect(
      sameSchedule(parseCron('*/15 * * * *'), parseCron('*/30 * * * *')),
    ).toBe(false);
  });

  it('день недели у ежедневного и число у еженедельного не в счёт', () => {
    // Скрытые поля формы, не относящиеся к выбранному режиму, не должны
    // делать одинаковые расписания разными.
    expect(
      sameSchedule(
        { ...DEFAULT_SCHEDULE, mode: 'daily', time: '10:00', weekday: 1 },
        { ...DEFAULT_SCHEDULE, mode: 'daily', time: '10:00', weekday: 5 },
      ),
    ).toBe(true);
  });
});
