/**
 * Время в поясе проекта, а не процесса. В контейнере на сервере пояс
 * процесса — UTC, и панель показывала «08:19» при московских 11:19, хотя
 * поля ввода дат читаются в `DEFAULT_TIMEZONE` (прод, 23.09.2026; на машине
 * разработки пояс московский, и расхождения не было видно). Запасное
 * значение — то же, что у проверки конфига.
 */
export function formatDate(value: Date): string {
  // Один форматтер на процесс, а не на вызов; создаётся при первом вызове —
  // к этому времени конфиг уже загружен.
  dateFormat ??= new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: process.env.DEFAULT_TIMEZONE || 'Europe/Moscow',
  });
  return dateFormat.format(value);
}

let dateFormat: Intl.DateTimeFormat | undefined;
