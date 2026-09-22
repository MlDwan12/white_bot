/**
 * Перевод «настенного» времени из формы в момент времени.
 *
 * `<input type="datetime-local">` присылает `2026-09-20T18:00` — без смещения:
 * браузер не сообщает, в каком поясе это набрали. `new Date()` истолковал бы
 * такую строку в поясе **сервера**, и админ в Москве, назначив 18:00, получил
 * бы отправку в 21:00 по Москве на UTC-сервере.
 *
 * Пояс берётся тот же, что у расписаний повторяющихся постов
 * (`DEFAULT_TIMEZONE`), — чтобы «18:00» в двух местах панели означало одно и
 * то же время.
 *
 * Отдельной библиотеки здесь нет намеренно: задача решается штатным `Intl`,
 * а лишняя зависимость в проекте — это ещё и лишняя поверхность для проверки
 * на безопасность при каждом обновлении.
 */

const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

export function zonedToUtc(local: string, timeZone: string): Date {
  if (!LOCAL_DATETIME.test(local)) {
    return new Date(NaN);
  }

  // Сначала читаем строку как если бы она была в UTC — получаем «примерный»
  // момент, от которого пляшем.
  const asUtc = new Date(`${local.length === 16 ? `${local}:00` : local}Z`);
  if (Number.isNaN(asUtc.getTime())) {
    return asUtc;
  }

  // Смещение зоны зависит от самого момента (летнее время), поэтому считаем
  // дважды: первая поправка может перебросить нас через границу перевода
  // часов, и тогда смещение уже другое.
  let result = new Date(asUtc.getTime() - offsetMs(asUtc, timeZone));
  result = new Date(asUtc.getTime() - offsetMs(result, timeZone));
  return result;
}

/**
 * Обратное направление: момент времени → строка для `value` в
 * `datetime-local`, в том же поясе, что и `zonedToUtc`. Нужна там, где форма
 * правки предзаполняется уже сохранённым временем (а не набирается с нуля,
 * как при создании) — без нёе редактирование расписания черновика показывало
 * бы время сервера вместо того, что реально набрал админ.
 */
export function utcToZoned(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);

  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '00';
  // Та же поправка на полночь, что и в `offsetMs`.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

/** Смещение зоны относительно UTC в данный момент, в миллисекундах. */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  // `Date.UTC` от локальных частей даёт «как если бы это было UTC»; разница с
  // настоящим моментом и есть смещение зоны.
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    // В некоторых локалях полночь форматируется как 24 — приводим к 0.
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return asIfUtc - instant.getTime();
}
