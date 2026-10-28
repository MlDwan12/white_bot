// Даты в панели — в поясе сервера (`DEFAULT_TIMEZONE`, приходит в `/auth/me`),
// в нём же сервер читает ввод дат: админ в другом поясе видит то же время, что
// уйдёт в анонс.
let dateTime: Intl.DateTimeFormat;
let dateOnly: Intl.DateTimeFormat;
let inputParts: Intl.DateTimeFormat;

export function setTimeZone(timeZone: string): void {
  dateTime = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  dateOnly = new Intl.DateTimeFormat('ru-RU', { timeZone, day: '2-digit', month: '2-digit' });
  inputParts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}
setTimeZone('Europe/Moscow');

/** «30.10 в 12:00». */
export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso)).replace(', ', ' в ');
}

/** «20.10». */
export function formatDate(iso: string): string {
  return dateOnly.format(new Date(iso));
}

/** plural(3, ['место', 'места', 'мест']) → «места». */
export function plural(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
}

/** Сколько осталось до момента: «2 дня 6 ч», «3 ч 20 мин», «меньше минуты». */
export function timeLeft(iso: string, now = Date.now()): string {
  const minutes = Math.floor((new Date(iso).getTime() - now) / 60_000);
  if (minutes < 1) return 'меньше минуты';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) {
    const d = `${days} ${plural(days, ['день', 'дня', 'дней'])}`;
    return hours > 0 ? `${d} ${hours} ч` : d;
  }
  const rest = minutes % 60;
  if (hours === 0) return `${rest} мин`;
  return rest > 0 ? `${hours} ч ${rest} мин` : `${hours} ч`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('ru-RU');
}

/** Значение для `<input type="datetime-local">` — в поясе сервера, как он его читает. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const p = Object.fromEntries(inputParts.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Обратное к `toLocalInput`: «настенное» время в поясе сервера → ISO. */
export function fromLocalInput(local: string): string {
  const wall = Date.parse(`${local}:00Z`);
  let t = wall;
  // Два шага: смещение в момент `t` может отличаться от смещения в `wall` (переход на летнее время).
  for (let i = 0; i < 2; i++) t = wall - (Date.parse(`${toLocalInput(new Date(t).toISOString())}:00Z`) - t);
  return new Date(t).toISOString();
}
